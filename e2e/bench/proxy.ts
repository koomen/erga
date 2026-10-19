// The network between the browser and erga.dev, in front of a local server:
// a proxy that every request of the browser goes through. It does three things.
//
//   1. It compresses text (gzip), as Cloudflare's edge does (brotli there, a
//      little smaller). The dev server compresses nothing.
//   2. It adds the network's delay: half a round trip (rtt) before the request
//      goes on, half before the answer comes back, and half each way for each
//      WebSocket message. The first request to each host in a browser profile
//      also pays `handshake` round trips (TCP and TLS), and so does each
//      WebSocket. reset() starts a new profile: no connection is open.
//   3. It records each request: when it started and ended, its bytes over the
//      wire (compressed body and headers), and what the browser asked for
//      (sec-fetch-dest: a document, a frame, a script...). A request the browser
//      takes from its cache never reaches it, so it is not counted.
//
// The Host header goes on as the browser sent it, so the addresses the Worker
// makes (the pages origins too) point at the proxy.

import { constants as zlib, createGzip } from "node:zlib";
import { freePort } from "../server";

export interface Hit {
  url: string;
  /** What the browser asked for (sec-fetch-dest): document, iframe, script, style, empty (fetch), websocket... */
  dest: string;
  status: number;
  /** ms, on this process's clock (performance.timeOrigin + performance.now()). */
  start: number;
  end: number;
  /** Bytes sent to the browser: the status line, the headers and the (compressed) body. */
  bytes: number;
}

export interface Proxy {
  root: string;
  /** Every request so far. */
  hits: Hit[];
  /** A new browser profile: no connection open, so the next request to each host pays the handshake. */
  reset(): void;
  stop(): void;
}

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => (ms > 0 ? Bun.sleep(ms) : Promise.resolve());
const COMPRESS = /^(text\/|application\/(javascript|json|xml|wasm)|image\/svg)/;

export async function startProxy(target: string, opts: { rtt: number; handshake: number }): Promise<Proxy> {
  const port = await freePort();
  const to = new URL(target);
  const hits: Hit[] = [];
  let open = new Set<string>();
  /** What a request waits before it goes on: half a round trip, and the handshake if its host has no connection yet. */
  const delayFor = (host: string, socket: boolean) => {
    let ms = opts.rtt / 2;
    if (socket || !open.has(host)) ms += opts.handshake * opts.rtt;
    if (!socket) open.add(host);
    return ms;
  };
  const headerBytes = (h: Headers) => { let n = 17; h.forEach((v, k) => { n += k.length + v.length + 4; }); return n + 2; };

  const server = Bun.serve<{ url: string; headers: Record<string, string>; hit: Hit; up?: WebSocket; queue: (string | Buffer)[] }>({
    hostname: "127.0.0.1", port,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const host = req.headers.get("host") ?? url.host;
      const there = `${to.protocol}//${to.host}${url.pathname}${url.search}`;
      const hit: Hit = { url: `${url.protocol}//${host}${url.pathname}${url.search}`, dest: req.headers.get("sec-fetch-dest") ?? "", status: 0, start: now(), end: 0, bytes: 0 };
      hits.push(hit);
      if (req.headers.get("upgrade")?.toLowerCase() == "websocket") {
        hit.dest = "websocket";
        await sleep(delayFor(host, true) + opts.rtt / 2);
        const headers: Record<string, string> = {};
        for (const k of ["host", "origin", "cookie", "user-agent", "sec-websocket-protocol"]) { const v = req.headers.get(k); if (v) headers[k] = v; }
        hit.status = 101; hit.end = now();
        return srv.upgrade(req, { data: { url: there.replace(/^http/, "ws"), headers, hit, queue: [] } }) ? undefined : new Response("no upgrade", { status: 400 });
      }
      await sleep(delayFor(host, false));
      const headers = new Headers(req.headers);
      headers.set("host", host);
      headers.delete("accept-encoding");
      let res: Response;
      try {
        res = await fetch(there, { method: req.method, headers, body: req.method == "GET" || req.method == "HEAD" ? undefined : await req.arrayBuffer(), redirect: "manual" });
      } catch (e) {
        hit.status = 502; hit.end = now();
        return new Response(`proxy: ${(e as Error).message}`, { status: 502 });
      }
      await sleep(opts.rtt / 2);
      hit.status = res.status;
      const out = new Headers(res.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      const gzip = !!res.body && /gzip/.test(req.headers.get("accept-encoding") ?? "") && COMPRESS.test(out.get("content-type") ?? "");
      if (gzip) out.set("content-encoding", "gzip");
      hit.bytes = headerBytes(out);
      if (!res.body) { hit.end = now(); return new Response(null, { status: res.status, statusText: res.statusText, headers: out }); }
      const reader = res.body.getReader();
      const counted = (b: Uint8Array) => { hit.bytes += b.byteLength; return b; };
      let body: ReadableStream<Uint8Array>;
      if (gzip) {
        // Each chunk flushed as it arrives: a page sent in parts reaches the browser in parts.
        const gz = createGzip({ level: 6, flush: zlib.Z_SYNC_FLUSH });
        body = new ReadableStream<Uint8Array>({
          start(c) {
            gz.on("data", (b: Buffer) => c.enqueue(counted(new Uint8Array(b))));
            gz.on("end", () => { hit.end = now(); c.close(); });
            gz.on("error", (e) => c.error(e));
            (async () => { for (;;) { const { done, value } = await reader.read(); if (done) { gz.end(); return; } gz.write(value); } })().catch((e) => c.error(e));
          },
        });
      } else {
        body = new ReadableStream<Uint8Array>({
          async pull(c) {
            const { done, value } = await reader.read();
            if (done) { hit.end = now(); c.close(); } else c.enqueue(counted(value));
          },
          cancel() { hit.end = now(); reader.cancel().catch(() => {}); },
        });
      }
      return new Response(body, { status: res.status, statusText: res.statusText, headers: out });
    },
    websocket: {
      open(ws) {
        const d = ws.data;
        const protocols = d.headers["sec-websocket-protocol"]?.split(",").map((p) => p.trim());
        // Bun's WebSocket takes headers: the browser's Host, Origin and cookies go on as they came.
        const up = new WebSocket(d.url, { headers: d.headers, protocols } as any);
        up.binaryType = "arraybuffer";
        d.up = up;
        up.onopen = () => { for (const m of d.queue.splice(0)) up.send(m as any); };
        up.onmessage = (e) => {
          const m = e.data as string | ArrayBuffer;
          d.hit.bytes += typeof m == "string" ? m.length : m.byteLength;
          setTimeout(() => { try { ws.send(m as any); } catch { /* closed */ } }, opts.rtt / 2);
        };
        up.onclose = (e) => setTimeout(() => { try { ws.close(e.code >= 4000 || e.code == 1000 ? e.code : 1000, e.reason); } catch { /* closed */ } }, opts.rtt / 2);
        up.onerror = () => { try { ws.close(1011, "upstream failed"); } catch { /* closed */ } };
      },
      message(ws, m) {
        const d = ws.data;
        setTimeout(() => { if (d.up?.readyState == 1) d.up.send(m as any); else d.queue.push(m); }, opts.rtt / 2);
      },
      close(ws) { setTimeout(() => { try { ws.data.up?.close(); } catch { /* closed */ } }, opts.rtt / 2); },
    },
  });
  return {
    root: `http://127.0.0.1:${port}`,
    hits,
    reset() { open = new Set(); },
    stop() { server.stop(true); },
  };
}

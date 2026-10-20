// The network between the browser and erga.dev, in front of a local server:
// a proxy that every request of the browser goes through. It does three things.
//
//   1. It compresses text (gzip), as Cloudflare's edge does (brotli there, a
//      little smaller). The dev server compresses nothing.
//   2. It adds the network's delay: half a round trip (rtt) before the request
//      goes on, half before the answer comes back, and half each way for each
//      WebSocket message. The first request to each host in a browser profile
//      also pays `handshake` round trips (TCP and TLS), and so does each
//      WebSocket. A WebSocket's upgrade is answered once the server has
//      answered it (the server's work is inside the round trip, as on the
//      internet), and what the server sends at once comes back with that
//      answer. reset() starts a new profile: no connection is open.
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
/** A WebSocket through the proxy: the server's end (open before the browser's is), what it sent before the browser's end was up, and that end. */
type Socket = { hit: Hit; up: WebSocket; early: (string | ArrayBuffer)[]; queue: (string | Buffer)[]; client?: import("bun").ServerWebSocket<Socket> };
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

  const server = Bun.serve<Socket>({
    hostname: "127.0.0.1", port,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const host = req.headers.get("host") ?? url.host;
      const there = `${to.protocol}//${to.host}${url.pathname}${url.search}`;
      const hit: Hit = { url: `${url.protocol}//${host}${url.pathname}${url.search}`, dest: req.headers.get("sec-fetch-dest") ?? "", status: 0, start: now(), end: 0, bytes: 0 };
      hits.push(hit);
      if (req.headers.get("upgrade")?.toLowerCase() == "websocket") {
        // The way there (with the connection's handshake), the server's own upgrade (what it does before it answers
        // counts, as it would), then the way back: the 101 and whatever the server sends at once come back together.
        hit.dest = "websocket";
        await sleep(delayFor(host, true));
        const headers: Record<string, string> = {};
        for (const k of ["host", "origin", "cookie", "user-agent", "sec-websocket-protocol"]) { const v = req.headers.get(k); if (v) headers[k] = v; }
        const up = new WebSocket(there.replace(/^http/, "ws"), { headers, protocols: headers["sec-websocket-protocol"]?.split(",").map((p) => p.trim()) } as any);
        up.binaryType = "arraybuffer";
        const data: Socket = { hit, up, early: [], queue: [] };
        up.onmessage = (e) => {
          const m = e.data as string | ArrayBuffer;
          hit.bytes += typeof m == "string" ? m.length : m.byteLength;
          setTimeout(() => { if (data.client) { try { data.client.send(m as any); } catch { /* closed */ } } else data.early.push(m); }, opts.rtt / 2);
        };
        const opened = await new Promise<boolean>((done) => { up.onopen = () => done(true); up.onerror = up.onclose = () => done(false); });
        await sleep(opts.rtt / 2);
        hit.end = now();
        if (!opened) { hit.status = 502; return new Response("the server refused the WebSocket", { status: 502 }); }
        hit.status = 101;
        return srv.upgrade(req, { data }) ? undefined : new Response("no upgrade", { status: 400 });
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
        const d = ws.data, up = d.up;
        d.client = ws;
        for (const m of d.early.splice(0)) ws.send(m as any);
        const closed = (code: number, reason: string) => setTimeout(() => { try { ws.close(code >= 4000 || code == 1000 ? code : 1000, reason); } catch { /* closed */ } }, opts.rtt / 2);
        if (up.readyState >= WebSocket.CLOSING) { closed(1000, ""); return; }
        up.onclose = (e) => closed(e.code, e.reason);
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

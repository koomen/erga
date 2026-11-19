// Checks, in real browsers, what the gate's hand-off needs of a browser's cookies (gate/core.ts): `bun dev/gate-browsers.ts`.
// Not a part of the suite: it runs Chromium, Firefox and WebKit (Playwright's builds, headless, each with a new
// profile), against the gate's own Worker mount (gate/mounts/worker.ts) on this machine, with a pretend Erga behind
// it and a pretend issuer. Three sites, all this one server, behind a proxy that sends every host here:
//
//   erga.example.com            the shell
//   <doc>.pages.example.net     the documents (another site), with accept.pages.example.net
//   idp.example.org             the issuer
//
// For each browser it prints what the server saw: whether __Host-member came with the vouch (the frame's request to
// the shell, from the other site's page), whether the Lax shell cookie did, whether the partitioned cookies set in the
// frame came back (the nonce at the accept, the member cookie at the page), and whether the frame's own requests after
// that carry the member cookie (a file, the room's socket). Then the second document (no hand-off), and sign-out's
// frame. GATE_REDIRECTS=1 runs each step of the hand-off as a 302 instead; GATE_ONLY=WebKit runs one browser;
// GATE_TRAIL=1 prints every request. GATE_WORKER=1: the document's page registers a service worker on its origin, as
// Erga's editor does elsewhere; GATE_WORKER=open lets the worker's script through the gate with no proof, to see what
// the worker's own requests carry.
//
// Seen on 2026-11-18 (Playwright 1.63: Chromium 153, Firefox 155, WebKit 26.6, on macOS 15):
//   - Chromium and Firefox: every row yes, 4 requests for the first document's page, 1 for the second.
//   - With 302s, Chromium sends the Lax shell cookie with the vouch and Firefox does not; with the pages, neither does.
//   - WebKit, with 302s: no cookie at all with the vouch. With the pages: __Host-member comes with the vouch.
//   - This WebKit build keeps no cookie that a frame on another site sets, Partitioned or not: the nonce is not kept,
//     and no document opens there. The frame shows the gate's page for an unsupported browser, after 3 requests, for
//     each document, and asks nothing more. Not confirmed on Safari 26.2 or later, which has partitioned cookies.
//   - A service worker on the document's origin (GATE_WORKER), Chromium and Firefox: the request for the worker's
//     script carries no cookie (the gate answers 401, and the worker does not register). With the script let through
//     (open), the worker registers, and a request that it passes on carries no cookie: a 401 for the page's file. So
//     Erga's pages ask for no worker there (server/documents/pages-origin.ts, workerFor).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit, type BrowserType } from "playwright-core";
import { ASK } from "../gate/core.ts";
import { handle, parseCookies, readCaller } from "../gate/mounts/web.ts";
import { mountOf } from "../gate/mounts/worker.ts";
import { webPort } from "../gate/port.ts";

const SHELL = "erga.example.com";
const CONTENT = "pages.example.net";
const IDP = "idp.example.org";
const DOC = (n: number) => `doc${n}.${CONTENT}`;

/** Every request the server saw: its host and path, the gate's cookies it carried, and the answer's status. */
let seen: { at: string; cookies: string[]; status: number; who?: string }[] = [];

const page = (body: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><body>${body}`, { headers: { "content-type": "text/html; charset=utf-8" } });

/** The pretend Erga, behind the gate. */
async function erga(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const who = readCaller(request, webPort);
  if (url.host == SHELL && url.pathname == "/editor") {
    const n = url.searchParams.get("doc") ?? "1";
    return page(`<p id="who">${who.kind}</p><iframe id="doc" src="https://${DOC(Number(n))}/t/pass/"></iframe>
<script>addEventListener("message", (e) => { window.result = e.data; });</script>`);
  }
  if (url.host == SHELL && url.pathname == "/signed-out") {
    const out = new Response(`<!doctype html><body><iframe id="out" src="https://accept.${CONTENT}/_edge/sign-out"></iframe>`, {
      headers: { "content-type": "text/html", [ASK]: "out" },
    });
    return out;
  }
  // GATE_WORKER: a service worker on the document's origin, which passes each request on as its own (as Erga's does).
  if (url.host.endsWith(`.${CONTENT}`) && url.pathname == "/erga-sw.js")
    return new Response(
      `addEventListener("install", () => skipWaiting());
addEventListener("activate", (e) => e.waitUntil(clients.claim()));
addEventListener("fetch", (e) => e.respondWith(fetch(e.request).then((r) => new Response(r.body, { status: r.status, headers: { "x-by-worker": "1" } }))));`,
      { headers: { "content-type": "text/javascript" } }
    );
  if (url.host.endsWith(`.${CONTENT}`) && url.pathname == "/t/pass/")
    return page(`<script>
(async () => {
  const out = { cookie: document.cookie, file: 0, socket: "", worker: "" };
  out.file = (await fetch("/t/pass/file.txt")).status;
  if (${!!process.env.GATE_WORKER})
    out.worker = await Promise.race([
      navigator.serviceWorker.register("/erga-sw.js").then(async () => {
        if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r));
        const file = await fetch("/t/pass/file.txt?worker");
        return "registered; a file " + (file.headers.get("x-by-worker") ? "through it: " : "past it: ") + file.status;
      }, (e) => "NO: " + e.message),
      new Promise((r) => setTimeout(() => r("NO: it did not start"), 8000)),
    ]);
  out.socket = await new Promise((done) => {
    const ws = new WebSocket("wss://" + location.host + "/t/pass/room");
    ws.onopen = () => { done("open"); ws.close(); };
    ws.onerror = () => done("refused");
  });
  parent.postMessage(out, "*");
})();
</script>`);
  if (url.pathname == "/t/pass/file.txt") return new Response(who.kind);
  return new Response("not found", { status: 404 });
}

/** The pretend issuer: its page sends the browser straight back with a code; its token endpoint names Ada. */
const idToken = () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ iss: `https://${IDP}`, aud: "client-1", exp: Date.now() / 1000 + 300, sub: "sub-ada", email: "ada@example.com", email_verified: true, name: "Ada" })}.x`;
};
const issuer = (async () => Response.json({ id_token: idToken() })) as unknown as typeof fetch;

const mount = mountOf(
  {
    ERGA: { fetch: erga },
    EDGE_KEY: "an-edge-key-of-thirty-two-characters!",
    GATE_KEY: "the-key-that-the-gate-sends-to-erga!",
    SHELL,
    CONTENT,
    IDP: JSON.stringify({
      name: "sso",
      issuer: `https://${IDP}`,
      authorize: `https://${IDP}/authorize`,
      token: `https://${IDP}/token`,
      client: "client-1",
    }),
    IDP_SECRET: "secret",
  },
  issuer
);

const dir = mkdtempSync(join(tmpdir(), "erga-gate-tls-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=erga-gate-test",
    "-days",
    "2",
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
  ],
  { stdio: "ignore" }
);

const server = Bun.serve({
  port: 0,
  tls: { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
  async fetch(request, srv) {
    const url = new URL(request.url);
    const note = (status: number, who?: string) =>
      seen.push({
        at: `${url.host}${url.pathname}${url.search == "?worker" ? " (worker)" : ""}`,
        cookies: Object.keys(parseCookies(request.headers.get("cookie"))).sort(),
        status,
        who,
      });
    if (url.host == IDP) {
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", "good");
      back.searchParams.set("state", url.searchParams.get("state")!);
      return Response.redirect(back.toString(), 302);
    }
    // The room's socket: the gate first, as for any request; only a member's goes on.
    if (request.headers.get("upgrade")?.toLowerCase() == "websocket") {
      let who = "refused";
      const answer = await handle(request, { ...mount, upstream: async (r) => ((who = readCaller(r, webPort).kind), new Response("ok")) });
      note(answer.status == 200 ? 101 : answer.status, who);
      if (who == "member" && srv.upgrade(request)) return undefined as unknown as Response;
      return new Response("refused", { status: 401 });
    }
    // GATE_WORKER=open: the worker's script passes the gate with no proof, to see what the worker's own requests carry.
    const open = process.env.GATE_WORKER == "open" && url.pathname == "/erga-sw.js";
    let answer = open ? await erga(request) : await handle(request, mount);
    note(answer.status);
    // GATE_REDIRECTS=1: each step of the hand-off as a 302, in place of the page that goes on by itself: what the
    // gate did first, and why it does not (WebKit then sends no cookie with the vouch).
    const page =
      process.env.GATE_REDIRECTS && answer.headers.get("content-type")?.startsWith("text/html") ? await answer.clone().text() : "";
    const to = /http-equiv="refresh" content="0;url=([^"]*)"/.exec(page)?.[1].replace(/&amp;/g, "&");
    if (to) {
      const headers = new Headers(answer.headers);
      headers.set("location", to);
      answer = new Response(null, { status: 302, headers });
    }
    return answer;
  },
  websocket: {
    message() {},
    open(ws) {
      ws.send("hello");
    },
  },
});

/** The proxy: every host is this server. */
const proxy = net.createServer((socket) => {
  socket.once("data", (first) => {
    if (!first.toString().startsWith("CONNECT ")) return socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    const up = net.connect(server.port!, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
});
await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
const proxyPort = (proxy.address() as net.AddressInfo).port;

const has = (at: string, cookie: string, from = 0) => {
  const hit = seen.slice(from).find((s) => s.at == at);
  return hit ? (hit.cookies.includes(cookie) ? "yes" : "NO") : "not asked";
};

async function check(name: string, type: BrowserType): Promise<Record<string, string>> {
  seen = [];
  const out: Record<string, string> = { browser: name };
  // (Chromium checks the certificate of a worker's script whatever the context says: the flag is for that.)
  const args = name == "Chromium" ? ["--ignore-certificate-errors"] : [];
  const browser = await type.launch({ headless: true, proxy: { server: `http://127.0.0.1:${proxyPort}` }, args });
  try {
    out.version = browser.version();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const tab = await context.newPage();
    // 1. Sign-in in the tab, through the issuer; then the editor, whose frame is a document on the other site.
    await tab.goto(`https://${SHELL}/editor?doc=1`, { waitUntil: "load" });
    out["signed in (shell cookie)"] = (await tab.locator("#who").textContent()) == "person" ? "yes" : "NO";
    const result = (await tab
      .waitForFunction(() => (window as unknown as { result?: unknown }).result, null, { timeout: 15_000 })
      .then(
        (h) => h.jsonValue(),
        () => null
      )) as { cookie: string; file: number; socket: string; worker: string } | null;
    out["__Host-member (SameSite=None) sent with the vouch"] = has(`${SHELL}/_edge/vouch`, "__Host-member");
    out["Lax shell cookie sent with the vouch (not needed)"] = has(`${SHELL}/_edge/vouch`, "__Host-erga");
    out["nonce (Partitioned, set in the frame) sent to the accept"] = has(`accept.${CONTENT}/_edge/accept`, "nonce");
    const pages = seen.filter((s) => s.at == `${DOC(1)}/t/pass/`);
    out["member cookie (Partitioned, set in the frame) sent to the page"] = pages.at(-1)?.cookies.includes("member") ? "yes" : "NO";
    out["requests for the first document's page"] = String(
      seen.filter((s) => /pages\.example\.net|_edge\/vouch/.test(s.at) && !/file|room/.test(s.at)).length
    );
    out["the page loaded in the frame"] = result ? "yes" : "NO";
    /** A browser that keeps no cookie of the frame's: the frame shows the gate's page for it, and stays there. */
    const told = async () => {
      const text = await tab
        .frameLocator("#doc")
        .locator("body")
        .innerText({ timeout: 5000 })
        .catch(() => "");
      return text.includes("This browser can't open documents on this server") ? "yes" : `NO: ${text.slice(0, 60) || "nothing"}`;
    };
    out["else: the frame shows the page for an unsupported browser"] = result ? "-" : await told();
    out["a document's script reads no cookie"] = result ? (result.cookie == "" ? "yes" : `NO: ${result.cookie}`) : "-";
    out["the frame's file request carries the member cookie"] = result ? (result.file == 200 ? "yes" : `NO (${result.file})`) : "-";
    out["the room's socket carries the member cookie"] = result ? (result.socket == "open" ? "yes" : "NO") : "-";
    if (process.env.GATE_WORKER) {
      out["the worker's script request carries the member cookie"] = has(`${DOC(1)}/erga-sw.js`, "member");
      out["the worker"] = result?.worker ?? "-";
      out["a request that the worker passes on carries the member cookie"] = has(`${DOC(1)}/t/pass/file.txt (worker)`, "member");
    }
    // 2. A second document: the member cookie is the whole content domain's.
    const before = seen.length;
    await tab.goto(`https://${SHELL}/editor?doc=2`, { waitUntil: "load" });
    await tab.waitForFunction(() => (window as unknown as { result?: unknown }).result, null, { timeout: 15_000 }).catch(() => null);
    out["requests for the second document's page"] = String(
      seen.slice(before).filter((s) => /pages\.example\.net|_edge\/vouch/.test(s.at) && !/file|room/.test(s.at)).length
    );
    out["else: the second document's frame shows that page too"] = result ? "-" : await told();
    // 3. Sign-out: the shell's cookies end, and the accept host's frame ends the content's copy.
    await tab.goto(`https://${SHELL}/signed-out`, { waitUntil: "load" });
    await tab
      .frameLocator("#out")
      .locator("body")
      .waitFor({ state: "attached" })
      .catch(() => null);
    const after = seen.length;
    const frame = await context.newPage();
    await frame.goto(`https://${SHELL}/editor?doc=3`, { waitUntil: "load" }).catch(() => null);
    out["after sign-out, the shell asks for sign-in again"] = seen.slice(after).some((s) => s.at == `${SHELL}/_edge/sign-in`)
      ? "yes"
      : "NO";
    // (The tab signs in again at once, at the pretend issuer; the content's old member cookie must be gone all the same.)
    await frame.waitForFunction(() => (window as unknown as { result?: unknown }).result, null, { timeout: 15_000 }).catch(() => null);
    const third = seen.slice(after).filter((s) => s.at == `${DOC(3)}/t/pass/`);
    out["after sign-out, the content's member cookie is gone"] = third.length
      ? third[0].cookies.includes("member")
        ? "NO"
        : "yes"
      : "not asked";
    if (process.env.GATE_TRAIL) for (const s of seen) console.log(`  ${name}: ${s.status} ${s.at} [${s.cookies.join(", ")}]`);
  } catch (e) {
    out.error = String(e).split("\n")[0];
  } finally {
    await browser.close();
  }
  return out;
}

const results = [];
for (const [name, type] of (
  [
    ["Chromium", chromium],
    ["Firefox", firefox],
    ["WebKit", webkit],
  ] as const
).filter(([n]) => !process.env.GATE_ONLY || process.env.GATE_ONLY == n)) {
  results.push(await check(name, type).catch((e) => ({ browser: name, error: String(e).split("\n")[0] })));
}
const rows = [...new Set(results.flatMap((r) => Object.keys(r)))];
for (const row of rows)
  console.log(`${row.padEnd(62)} ${results.map((r) => String((r as Record<string, string>)[row] ?? "-").padEnd(18)).join(" ")}`);
server.stop(true);
proxy.close();
process.exit(0);

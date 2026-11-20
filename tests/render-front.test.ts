// view_page and eval_in_page with a gate in front of the server (server/identity/mode.ts, the mode "gate"): the whole
// app in memory, as its Worker runs with GATE_KEY set, and the render (cloudflare/render.ts) in a real browser, the
// tests' Chromium. The browser has no proof for a gate. Here there is no gate to ask, and no network: nothing listens
// at the app's address or at the documents', so a request that went out would fail. Erga answers each in process, as
// the person who called the tool where the viewer's own page asks, and as nobody everywhere else.
import { afterAll, expect, test } from "bun:test";
import { rendering } from "../cloudflare/render";
import { ASK, type Caller } from "../gate/core.ts";
import { FRONT } from "../server/identity/caller";
import { sessionOf } from "../server/identity/index.ts";
import { calling, MANIFEST, server as app, textOf } from "./helpers/app";
import { chromium, stopBrowser } from "./helpers/browser";
import { quietConsole } from "./helpers/quiet";

const KEY = "front-gate-key-".repeat(3);
const ORIGIN = "https://erga.example";
const ADA: Caller = {
  kind: "person",
  p: "corp-oidc",
  sub: "sub-ada",
  email: "ada@example.com",
  name: "Ada",
  i: Date.now(),
  e: Date.now() / 1000 + 3600,
};
const PAGE = `<!doctype html><html><head><title>Notes</title><link rel="stylesheet" href="style.css"></head><body><h1>Notes behind the gate</h1><p>One.</p></body></html>`;
const WHOAMI = `fetch("/api/tools/whoami", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json())`;

// (Each render logs its time.)
quietConsole();
afterAll(stopBrowser);

/**
 * A server behind a gate, with Ada (an admin) and a document of hers. `tool` runs an operation as the gate sends her
 * request on; `asked` is each request the server's browser made, as the app got it in process. `allow`: null for a
 * browser that pauses only Erga's own addresses (Cloudflare's), else our own (cloudflare/render.ts). `content`: the
 * documents' domain (under the app's own name: one site, and one process in the browser).
 */
async function front(allow: string[] | null = [], content = "localhost") {
  const asked: { at: string; who: string | null }[] = [];
  /** What each request said it is for, and from where (Sec-Fetch-Dest and Sec-Fetch-Site), by its `at`. */
  const said: Record<string, string> = {};
  /** The sockets that the app accepted (at the test's own address: the server in memory has none): who asked, and what came. */
  const sockets: { who: string | null; origin: string | null; got: unknown[] }[] = [];
  const s = app({
    render: (server) =>
      rendering(chromium, {
        platform: server.platform,
        allow,
        erga: async (request) => {
          const url = new URL(request.url);
          const who = (await sessionOf(server.platform, request))?.login ?? null;
          const at = `${request.method} ${url.host}${url.pathname.replace(/^\/t\/[^/]+/, "/t/<pass>")}`;
          asked.push({ at, who });
          said[at] = `${request.headers.get("sec-fetch-dest")}, ${request.headers.get("sec-fetch-site")}`;
          // The test's own address for a body: its bytes back, with what an app's answer may carry for a gate and a cookie.
          if (url.pathname.endsWith("/test/body"))
            return Response.json(
              { who, bytes: [...new Uint8Array(await request.arrayBuffer())] },
              { headers: { [ASK]: "out", "Set-Cookie": "kept=1; Path=/" } }
            );
          if (!url.pathname.endsWith("/test/socket") || request.headers.get("upgrade") != "websocket") return server.erga(request);
          // An echo: text comes back as it is, bytes come back in reverse.
          const got: unknown[] = [];
          const heard: Record<string, (e: { data?: unknown; code?: number; reason?: string }) => void> = {};
          const webSocket = {
            accept() {},
            addEventListener: (type: string, f: (e: object) => void) => void (heard[type] = f),
            send(data: string | Uint8Array) {
              got.push(typeof data == "string" ? data : [...data]);
              queueMicrotask(() =>
                heard.message({ data: typeof data == "string" ? `echo ${data}` : new Uint8Array([...data].reverse()).buffer })
              );
            },
            close: (code?: number, reason?: string) => queueMicrotask(() => heard.close({ code: code ?? 1005, reason: reason ?? "" })),
          };
          sockets.push({ who, origin: request.headers.get("origin"), got });
          return { status: 101, webSocket } as unknown as Response;
        },
      }),
  });
  const admin = { login: "tester", admin: true };
  await s.dir.setAnyone(admin, "write");
  await s.dir.config.set(admin, "auto_usernames", true);
  (s.platform as { signIn: unknown }).signIn = { mode: "gate", key: KEY, devLogin: null, encryptionKey: "local:secret" };
  s.platform.pagesDomain = () => content;
  // The editor's built files: empty ones (the tests' server has no build), so the viewer's page loads without an error.
  s.platform.assets = async (request) => {
    const path = new URL(request.url).pathname;
    if (path == "/manifest.json") return Response.json(MANIFEST);
    return new Response("", { headers: { "Content-Type": path.endsWith(".css") ? "text/css" : "text/javascript" } });
  };
  const ask = (path: string, init: RequestInit = {}) =>
    s.fetch(ORIGIN + path, {
      redirect: "manual",
      ...init,
      headers: { [FRONT]: KEY, ...calling(ADA), ...(init.headers as Record<string, string>) },
    });
  const tool = async (name: string, args: object) => {
    const r = await ask(`/api/tools/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(args),
    });
    const body = (await r.json()) as { ok?: boolean; result?: unknown; error?: string };
    return { ok: r.ok && body.ok !== false, text: body.error ?? textOf(body.result), result: body.result as { type: string }[] };
  };
  await ask("/auth/sso");
  await s.dir.users.setRole(admin, "ada", "admin");
  const at = (await ask("/new")).headers.get("location")!.replace(/[?&]edit=?$/, "");
  const id = ((await (await ask(`${at}/api/doc`)).json()) as { docName: { id: string } }).docName.id;
  expect((await tool("write", { document: id, files: { "index.html": PAGE, "style.css": "h1 { color: rgb(1, 2, 3) }" } })).ok).toBe(true);
  /** An expression's value in the document's page, or (`shell`) in the viewer's own window. */
  const evaluate = async (expression: string, shell = false) => {
    const r = await tool("eval_in_page", { document: id, expression, ...(shell ? { shell: true } : {}) });
    expect(r.ok, r.text).toBe(true);
    return JSON.parse(r.text.split("\n\n")[0]);
  };
  return { s, tool, evaluate, id, pages: `https://${id}-ada.${content}`, asked, said, sockets };
}

/** The documents on another site than the app's, and on the app's own (a name under it). */
const SITES = ["localhost", "pages.erga.example"];

for (const [browser, allow, content] of [
  ["our own browser", [], SITES[0]],
  ["Cloudflare's browser", null, SITES[0]],
  ["our own browser, the documents on the app's site", [], SITES[1]],
] as const)
  test(`view_page with a gate in front, in ${browser}: the page shows in Erga's viewer, with its files, and nothing goes to the network`, async () => {
    const { tool, evaluate, pages, asked, said } = await front(allow && [...allow], content);
    const view = await tool("view_page", { document: pages.slice(8, 16), at_ms: 0 });
    expect(view.ok, view.text).toBe(true);
    expect(view.text).toContain("Shown as its user sees it, in Erga's viewer.");
    expect(view.text).toContain("No script errors.");
    expect(view.result.some((c) => c.type == "image")).toBe(true);
    // The viewer's page was Ada's; the document's page and its stylesheet came by the pass, as nobody's.
    const id = pages.slice(8, 16);
    expect(asked).toContainEqual({ at: `GET erga.example/d/${id}`, who: "ada" });
    expect(asked).toContainEqual({ at: `GET ${pages.slice(8)}/t/<pass>/index.html`, who: null });
    expect(asked).toContainEqual({ at: `GET ${pages.slice(8)}/t/<pass>/style.css`, who: null });
    // Each said what a browser says of it: the window's page, the frame's page, the viewer's own request.
    expect(said[`GET erga.example/d/${id}`]).toBe("document, none");
    expect(said[`GET ${pages.slice(8)}/t/<pass>/index.html`]).toBe("iframe, null");
    expect(said[`GET erga.example/d/${id}/api/doc`]).toBe("null, same-origin");
    // The page itself: on the document's own origin, a secure one, with the stylesheet's colour.
    expect(
      await evaluate(
        `({ h1: document.querySelector("h1").textContent, color: getComputedStyle(document.querySelector("h1")).color, at: location.origin, secure: isSecureContext })`
      )
    ).toEqual({ h1: "Notes behind the gate", color: "rgb(1, 2, 3)", at: pages, secure: true });
  }, 30_000);

for (const content of SITES)
  test(`who asks, the documents under ${content}: the viewer's own page is the person, on this document, with no admin power; the document's page is nobody`, async () => {
    const { s, evaluate, id, pages, asked } = await front([], content);
    // Ada is an admin. In the viewer's window her agent's code is her, by the server's browser, without that power.
    const me = await evaluate(WHOAMI, true);
    expect(me.result).toMatchObject({ login: "ada", adminPower: false });
    expect(me.result.via).toContain("view of the page");
    // And only on this document: her list and the admin pages send it to sign in, and it has no page of tokens.
    expect(
      await evaluate(
        `Promise.all(["/d/${id}/api/doc", "/documents", "/admin", "/tokens"].map((p) => fetch(p, { redirect: "manual" }).then((r) => [r.status, r.type])))`,
        true
      )
    ).toEqual([
      [200, "basic"],
      [0, "opaqueredirect"],
      [0, "opaqueredirect"],
      [404, "basic"],
    ]);
    // A body goes on with its bytes, a Blob's too. The answer brings the page no cookie, and nothing meant for a gate.
    expect(
      await evaluate(
        `fetch("/d/${id}/test/body", { method: "POST", body: new Blob([new Uint8Array([0, 255, 1]), "é"]) }).then(async (r) => ({ ...(await r.json()), ask: r.headers.get("${ASK}"), cookie: document.cookie }))`,
        true
      )
    ).toEqual({ who: "ada", bytes: [0, 255, 1, 195, 169], ask: null, cookie: "" });
    // The document's page is its authors' code: what it asks of the app is nobody's, and the app's answer is not for it to read.
    asked.length = 0;
    const tried = await evaluate(
      `Promise.all([
      fetch("${ORIGIN}/d/${id}/api/doc").then((r) => r.status, () => "refused"),
      fetch("${ORIGIN}/d/${id}/api/doc", { mode: "no-cors" }).then((r) => r.type, () => "refused"),
      fetch("/d/${id}/api/doc", { headers: { "x-erga-caller": "${calling(ADA)["x-erga-caller"]}", Authorization: "Bearer x" } }).then((r) => r.status),
    ])`
    );
    expect(tried).toEqual(["refused", "opaque", 404]);
    // (The viewer's own page asks for the same address, and that one is Ada's.)
    const doc = asked.filter((a) => a.at.endsWith("/api/doc"));
    expect(doc.filter((a) => a.who).map((a) => a.at)).toEqual([`GET erga.example/d/${id}/api/doc`]);
    expect(
      doc
        .filter((a) => !a.who)
        .map((a) => a.at)
        .sort()
    ).toEqual([`GET erga.example/d/${id}/api/doc`, `GET erga.example/d/${id}/api/doc`, `GET ${pages.slice(8)}/d/${id}/api/doc`].sort());
    // (The gate's own way in still wants its key.)
    expect((await s.fetch(`${ORIGIN}/d/${id}/api/doc`)).status).toBe(403);
  }, 30_000);

for (const content of SITES)
  test(`a page's socket to Erga, the documents under ${content}: answered in process too; the viewer's is the person's, the document's page's is nobody's`, async () => {
    const { evaluate, id, pages, sockets } = await front([], content);
    const talk = (address: string) => `new Promise((done) => {
    const ws = new WebSocket("${address}"), heard = [];
    ws.binaryType = "arraybuffer";
    ws.onopen = () => (ws.send("hi"), ws.send(new Uint8Array([1, 2, 3])));
    ws.onmessage = (e) => {
      heard.push(typeof e.data == "string" ? e.data : [...new Uint8Array(e.data)]);
      if (heard.length == 2) ws.close(1000, "done");
    };
    ws.onclose = (e) => done({ heard, code: e.code, reason: e.reason, state: ws.readyState });
  })`;
    const said = { heard: ["echo hi", [3, 2, 1]], code: 1000, reason: "done", state: 3 };
    // (An address of the document's own: the viewer's page is its person only there.)
    expect(await evaluate(talk(`wss://erga.example/d/${id}/test/socket`), true)).toEqual(said);
    expect(await evaluate(talk(`wss://erga.example/d/${id}/test/socket`))).toEqual(said);
    // The document's page calls the render itself, with no socket of the page's, and by the class's other name: nobody's too.
    const direct = `__ergaSocket(JSON.stringify({ op: "open", id: 99, url: "wss://erga.example/d/${id}/test/socket" }))`;
    const named = talk(`wss://erga.example/d/${id}/test/socket`).replace("new WebSocket(", "new WebSocket.prototype.constructor(");
    expect(await evaluate(`(${direct}, ${named})`)).toEqual(said);
    expect(sockets).toEqual([
      { who: "ada", origin: ORIGIN, got: ["hi", [1, 2, 3]] },
      { who: null, origin: pages, got: ["hi", [1, 2, 3]] },
      { who: null, origin: pages, got: [] },
      { who: null, origin: pages, got: ["hi", [1, 2, 3]] },
    ]);
    // The room's socket, which the server in memory does not accept: the page hears that it closed, as from a network.
    expect(
      await evaluate(
        `new Promise((done) => { const ws = new WebSocket("wss://erga.example/api/news"); ws.onclose = (e) => done(e.code); })`,
        true
      )
    ).toBe(1006);
  }, 30_000);

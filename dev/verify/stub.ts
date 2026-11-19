// The verify harness's origin (dev/verify.ts): a Worker that stands in for Erga behind the gate. It answers every
// address, and says who the gate told it is calling (x-erga-caller), which cookies and tokens reached it, and, for
// each request of the harness (x-verify-id, or ?_v=), keeps a row in a log. So a check asks afterwards what the
// origin saw: a request that the gate refused has no row.
//
//   <shell>/editor?doc=N[&page=hostile]   the "editor": who is here, and a frame with document N
//   <shell>/signed-out[?on]               asks the gate to sign out; then the content's sign-out frame, then a document.
//                                         ?on: no document; it goes on as Erga's own sign-out page does
//                                         (server/identity/sign-in.ts), to where the gate says a sign-out ends
//                                         (gate/core.ts, signOutAt): behind Access, Access's own sign-out
//   <shell>/oauth/authorize               GET: the consent page. POST: asks the gate for a code (or `deny`)
//   <shell>/tokens/new                    POST: asks the gate for an agent token, as the page of tokens does
//   <shell>/auth/sign-in                  OAuth mode's page of providers: one link
//   <shell>/_stub/seen                    POST, a JSON list of IDs: the log's rows of them
//   <doc>.<content>/t/pass/               a document's page: it reads its cookies, a file and the room's socket, all
//                                         on its own origin, and tells the editor
//   <doc>.<content>/t/pass/hostile        a document whose script tries to reach the shell with the browser's cookies,
//                                         and sets a cookie of the member cookie's name
//   any other address                     JSON: what the origin saw
//
// GATE = "front": the gate's own Worker is in front (gate/mounts/worker.ts), and this Worker has no address of its
// own. GATE = "inside": the gate is this Worker's first call (gate/mounts/web.ts), as in OAuth mode.

import { ASK, type Caller, type Config, signOutAt } from "../../gate/core.ts";
import { oidcExchange } from "../../gate/mounts/oidc.ts";
import { handle, parseCookies, readCaller } from "../../gate/mounts/web.ts";
import { webPort } from "../../gate/port.ts";

interface Storage {
  put(key: string, value: unknown): Promise<void>;
  get(keys: string[]): Promise<Map<string, unknown>>;
}
interface Env {
  SHELL: string;
  CONTENT: string;
  GATE: "front" | "inside";
  LOG: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> } };
  /** GATE = "inside": the gate's values (gate/mounts/worker.ts has the same). */
  EDGE_KEY?: string;
  IDP?: string;
  IDP_SECRET?: string;
}
declare const WebSocketPair: new () => { 0: WebSocket; 1: WebSocket & { accept(): void } };

/** The log: one row for each request of the harness that reached this Worker. */
export class Log {
  constructor(private state: { storage: Storage }) {}
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as { put?: { id: string }; get?: string[] };
    if (body.put) await this.state.storage.put(body.put.id, body.put);
    const out: Record<string, unknown> = {};
    const ids = body.get ?? [];
    for (let i = 0; i < ids.length; i += 100) Object.assign(out, Object.fromEntries(await this.state.storage.get(ids.slice(i, i + 100))));
    return Response.json(out);
  }
}

const HEAD = { "cache-control": "no-store", "x-stub": "1" };
const page = (body: string, headers: Record<string, string> = {}) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>stub</title><body>${body}`, {
    headers: { ...HEAD, "content-type": "text/html; charset=utf-8", ...headers },
  });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** A document's page: every request of it is to its own origin. */
const DOCUMENT = `<p>document</p><script>
(async () => {
  const out = { cookie: document.cookie, who: "", file: 0, socket: "" };
  out.who = (await (await fetch("whoami")).json()).caller.kind;
  out.file = (await fetch("file.txt")).status;
  out.socket = await new Promise((done) => {
    const ws = new WebSocket("wss://" + location.host + location.pathname + "room");
    ws.onmessage = (e) => { done(e.data); ws.close(); };
    ws.onerror = () => done("refused");
  });
  parent.postMessage(out, "*");
})();
</script>`;

/** A document with a script that attacks: the shell with the browser's cookies, and the member cookie's name. */
const hostile = (env: Env, id: string) => `<p>hostile</p><script>
(async () => {
  const shell = "https://${env.SHELL}", toss = "member=bogus; Domain=${env.CONTENT}; Path=/t/pass; Secure; SameSite=None; Partitioned";
  const out = { cookie: document.cookie };
  out.read = await fetch(shell + "/api/me?_v=${id}-read", { credentials: "include" }).then((r) => r.status, () => "blocked");
  out.send = await fetch(shell + "/api/me?_v=${id}-send", { method: "POST", credentials: "include", mode: "no-cors" }).then((r) => r.type, () => "blocked");
  document.cookie = toss;
  out.tossed = document.cookie;
  out.after = (await fetch("file.txt")).status;
  document.cookie = toss + "; Max-Age=0";
  parent.postMessage(out, "*");
})();
</script>`;

const listen = `addEventListener("message", (e) => { window.result = e.data; });`;

async function erga(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const who: Caller = readCaller(request, webPort);
  const path = url.pathname;
  const id = request.headers.get("x-verify-id") ?? url.searchParams.get("_v");
  const log = (body: object) =>
    env.LOG.get(env.LOG.idFromName("log")).fetch("https://log/", { method: "POST", body: JSON.stringify(body) });
  const saw = {
    stub: true,
    id,
    method: request.method,
    host: url.host,
    path,
    caller: who,
    cookies: Object.keys(parseCookies(request.headers.get("cookie"))),
    authorization: request.headers.has("authorization"),
  };
  if (id) await log({ put: saw });
  const content = url.host.endsWith(`.${env.CONTENT}`);
  const other = !`.${env.CONTENT}`.endsWith(`.${env.SHELL}`);
  const doc = (n: string, more = "") => `https://d${n}.${env.CONTENT}/t/pass/${more}`;

  if (request.headers.get("upgrade")?.toLowerCase() == "websocket" && path.endsWith("/room")) {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].send(who.kind);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }
  if (content && request.method == "GET") {
    if (path == "/t/pass/") return page(DOCUMENT);
    if (path == "/t/pass/hostile") return page(hostile(env, (url.searchParams.get("id") ?? "").replace(/[^\w-]/g, "")));
    if (path == "/t/pass/file.txt") return new Response(who.kind, { headers: HEAD });
  }
  if (!content && request.method == "GET") {
    const q = url.searchParams;
    if (path == "/editor") {
      const n = /^[1-9]$/.test(q.get("doc") ?? "") ? q.get("doc")! : "1";
      const src = q.get("page") == "hostile" ? doc(n, `hostile?id=${encodeURIComponent(q.get("id") ?? "")}`) : doc(n);
      return page(`<pre id="who">${esc(JSON.stringify(who))}</pre><iframe id="doc" src="${esc(src)}"></iframe><script>${listen}</script>`);
    }
    if (path == "/signed-out")
      return page(
        `<p id="out">signed out</p><script>${listen}
const add = (id, src) => new Promise((done) => { const f = document.createElement("iframe"); f.id = id; f.onload = done; f.src = src; document.body.append(f); setTimeout(done, 2000); });
(async () => {
  ${other ? `await add("out", "https://accept.${env.CONTENT}/_edge/sign-out");` : ""}
  ${q.has("on") ? `location.replace(${JSON.stringify(signOutAt(who) ?? "/")});` : `await add("doc", "${doc("1")}");`}
})();
</script>`,
        { [ASK]: "out" }
      );
    if (path == "/oauth/authorize")
      return page(
        `<form method="post"><button id="approve" name="do" value="approve">Approve</button><button name="do" value="deny">Deny</button></form>`
      );
    if (path == "/auth/sign-in")
      return page(`<a id="go" href="/_edge/sign-in?next=${encodeURIComponent(q.get("next") ?? "/")}">Sign in with the test issuer</a>`);
  }
  if (!content && request.method == "POST") {
    // (Erga decides here whether this person may; the stub lets every person.)
    if (path == "/oauth/authorize") {
      const approve = new URLSearchParams(await request.text()).get("do") == "approve";
      return new Response("asked", { headers: { ...HEAD, [ASK]: approve ? `code grant-${crypto.randomUUID().slice(0, 8)}` : "deny" } });
    }
    if (path == "/tokens/new")
      return new Response("asked", { headers: { ...HEAD, [ASK]: `token grant-page ${Math.floor(Date.now() / 1000) + 600}` } });
    if (path == "/_stub/seen") return new Response((await log({ get: await request.json() })).body, { headers: HEAD });
  }
  return Response.json(saw, { headers: HEAD });
}

/** GATE = "inside": the gate's settings, as Erga's own Worker has them in OAuth mode. */
function inside(env: Env) {
  const idp = JSON.parse(env.IDP!) as { name: string; issuer: string; authorize: string; token: string; client: string };
  const config: Config = {
    key: env.EDGE_KEY!,
    shell: env.SHELL,
    content: env.CONTENT,
    https: true,
    open: true,
    idp: { [idp.name]: { authorize: idp.authorize, client: idp.client, scope: "openid email profile" } },
    chooser: "/auth/sign-in",
    oauth: true,
  };
  return {
    config: () => config,
    port: webPort,
    exchange: async (x: { code: string; verifier: string; redirect: string }) => {
      const identity = await oidcExchange(idp.name, { ...idp, secret: env.IDP_SECRET! }, x);
      return identity ? { identity } : new Response("Sign-in didn't work. Try again.", { status: 400 });
    },
    upstream: (request: Request) => erga(request, env),
  };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.GATE == "inside" ? handle(request, inside(env)) : erga(request, env);
  },
};

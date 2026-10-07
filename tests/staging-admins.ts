#!/usr/bin/env bun
// Staging is for admins only (worker/admins-only.ts), in the real Worker: a
// dev server plays staging (ERGA_DEPLOY_TARGET=staging, ERGA_DEPLOY_MOCK=1),
// and another plays a server with no deploy target, which is unchanged.
//
//   - signed out: a page says to sign in (with the button), the API says 403;
//   - someone who isn't an admin: refused everywhere, a document they own
//     (made while they were an admin), its frame on the pages origin, MCP and
//     a git clone included;
//   - an admin's session and an admin token: in, the pages origin's frame too;
//     an admin's documents token: refused (no admin power); a pages token that
//     names nobody: refused;
//   - still open: signing in, the deploy hook (with its secret), the version
//     check, the snapshot endpoint and the factory VMs' callbacks (each
//     answered by its own door, which checks its own credential);
//   - no deploy target: everything as before.
//
//   bun tests/staging-admins.ts
// covers: worker/admins-only.ts worker/index.ts worker/platform.ts deploy/targets.json deploy/targets.ts front.ts

import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { pagesToken } from "../front";
import { startHost, type Host } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const SECRET = `staging-admins-${crypto.randomUUID()}`;
const HOOK = "mock-hook-secret-0123456789abcdef";

const [staging, plain] = await Promise.all([
  startHost(null, { env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "staging", SESSION_SECRET: SECRET } }),
  startHost(null, { env: { SESSION_SECRET: SECRET } }),
]);
// Signed out on either server: locally each names its cookies for its port (worker/cookies.ts).
const SIGNED_OUT = `erga_signed_out_${staging.port}=1; erga_signed_out_${plain.port}=1`;

const at = (host: Host) => {
  const root = host.root;
  const get = (path: string, init: RequestInit = {}) => fetch(path.startsWith("http") ? path : root + path, { redirect: "manual", ...init });
  return {
    root, get,
    page: (path: string, headers: Record<string, string> = {}) => get(path, { headers: { Accept: "text/html", ...headers } }),
    async signIn(as: string | null): Promise<string> {
      const r = await get(`/auth/github?${as ? `as=${as}&` : ""}next=/docs`);
      return r.headers.getSetCookie().map((x) => x.split(";")[0]).find((x) => /^erga_session(_\d+)?=/.test(x))!;
    },
    async mint(cookie: string, fields: Record<string, string>): Promise<string> {
      const html = await (await get("/tokens/new", { method: "POST", headers: { Cookie: cookie, Origin: root }, body: new URLSearchParams(fields) })).text();
      const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(html)?.[1] ?? "";
      expect(token, `a ${fields.scope} token is made`, html.slice(0, 300));
      return token;
    },
    tool: (token: string, name: string, args: unknown = {}) => fetch(`${root}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) }),
    publish: async (token: string, title: string) => (await (await fetch(`${root}/api/publish`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title, files: { "index.html": `<h1>${title}</h1>` } }) })).json()) as { id: string; address: string },
  };
};

/** The editor's frame on the pages origin, as the document's page names it (Bun's fetch is told the host: browsers send *.localhost here). */
const frameOf = (html: string) => /<meta name="erga-pages" content="([^"]+)">/.exec(html)?.[1] ?? "";
const pagesFetch = (u: string) => { const url = new URL(u); return fetch(u.replace(url.host, `localhost:${url.port}`), { headers: { Host: url.host }, redirect: "manual" }); };
const mcp = (root: string, headers: Record<string, string>) => fetch(`${root}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
/**
 * What a WebSocket upgrade gets: its status (101: the socket opens), or "closed" when the server shuts the
 * connection instead of answering, as the dev server does when the Worker refuses an upgrade. Through node:http, not
 * fetch: Bun 1.2's fetch dropped the Upgrade header (it saw a plain 403), Bun 1.4's resets.
 */
const upgrade = (url: string, headers: Record<string, string>) => new Promise<number | "closed">((resolve, reject) => {
  const req = request(url, { headers: { ...headers, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" }, timeout: 10_000 });
  req.on("response", (r) => { r.resume(); resolve(r.statusCode ?? 0); });
  req.on("upgrade", (r, socket) => { socket.destroy(); resolve(r.statusCode ?? 101); });
  req.on("timeout", () => req.destroy(new Error("no answer to the upgrade in 10s")));
  req.on("error", (e: NodeJS.ErrnoException) => (e.code == "ECONNRESET" ? resolve("closed") : reject(e)));
  req.end();
});
const refusedJson = async (r: Response) => r.status == 403 && ((await r.json().catch(() => ({}))) as { adminsOnly?: boolean }).adminsOnly == true;

try {
  const s = at(staging);
  const tester = await s.signIn(null), bo = await s.signIn("bo");

  // ---------------------------------------------------------------- signed out
  let r = await s.page("/docs", { Cookie: SIGNED_OUT });
  let html = await r.text();
  expect(r.status == 403 && html.includes("Staging is for admins: sign in") && html.includes('href="/auth/github?next=%2Fdocs"'), "signed out: /docs is the sign-in page, with its button", r.status, html.slice(0, 600));
  r = await s.page("/", { Cookie: SIGNED_OUT });
  expect(r.status == 403 && (await r.text()).includes("Staging is for admins: sign in"), "and so is the front page");
  expect(await refusedJson(await s.get("/api/deploys", { headers: { Cookie: SIGNED_OUT } })), "the API: JSON 403");
  expect(await refusedJson(await mcp(s.root, { Cookie: SIGNED_OUT })), "MCP: JSON 403");
  r = await s.get("/auth/github?next=/docs", { headers: { Cookie: SIGNED_OUT } });
  expect(r.status == 302, "signing in still works", r.status);
  expect((await s.get("/style.css", { headers: { Cookie: SIGNED_OUT } })).status == 200 && (await s.get("/fonts/inter.css", { headers: { Cookie: SIGNED_OUT } })).status == 200, "the static files load");
  r = await s.get("/git/erga.git/info/refs?service=git-upload-pack");
  expect(r.status == 401 && r.headers.get("www-authenticate")?.startsWith("Basic"), "an anonymous git read: 401, asking for a token", r.status);
  const clone = spawnSync("git", ["ls-remote", `${s.root}/git/erga.git`], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" }, timeout: 30_000 });
  expect(clone.status != 0, "git ls-remote with no token fails", clone.stdout, clone.stderr);
  ok("signed out: the sign-in page, JSON 403 for the API and MCP, git asks for a token; sign-in and static files open");

  // ---------------------------------------------------------------- admins: a session, an admin token
  expect((await s.page("/docs", { Cookie: tester })).status == 200, "an admin's session opens /docs");
  const admin = await s.mint(tester, { label: "Admin", scope: "admin" });
  const docs = await s.mint(tester, { label: "Docs", scope: "documents" });
  expect((await s.get("/api/deploys", { headers: { Authorization: `Bearer ${admin}` } })).status == 200, "an admin token reads the deploys");
  expect((await mcp(s.root, { Authorization: `Bearer ${admin}` })).status == 200, "and opens MCP");
  r = await s.get("/git/erga.git/info/refs?service=git-upload-pack", { headers: { Authorization: `Basic ${btoa(`token:${admin}`)}` } });
  expect(r.status != 401 && r.status != 403, "and passes the guard for git (as Basic's password)", r.status);
  expect(await refusedJson(await s.get("/api/deploys", { headers: { Authorization: `Bearer ${docs}` } })), "an admin's documents token: refused, it has no admin power");
  expect(await refusedJson(await s.tool(docs, "list_documents")), "everywhere (the tools)");
  expect(await refusedJson(await mcp(s.root, { Authorization: `Bearer ${docs}` })), "and MCP");
  ok("an admin's session and admin token are in; their documents token is refused");

  // An admin's document: its frame on the pages origin opens for them.
  const mine = await s.publish(admin, "Tester's");
  html = await (await s.page(new URL(mine.address, s.root).pathname, { Cookie: tester })).text();
  const myFrame = frameOf(html);
  expect(myFrame, "the editor names its frame", html.slice(0, 400));
  expect((await pagesFetch(myFrame)).status == 200, "the admin's frame opens on the pages origin");
  r = await pagesFetch(`${myFrame}doc/index.html`);
  expect(r.status == 200 && (await r.text()).includes("Tester's"), "and its files", r.status);
  const { host: pagesHost } = new URL(myFrame);
  const nobody = await pagesToken(SECRET, "tester", mine.id, s.root);
  r = await pagesFetch(`http://${pagesHost}/t/${nobody}/doc/index.html`);
  expect(r.status == 403, "a pages token that names nobody (another server's, or older): refused", r.status);
  ok("the pages origin serves an admin's frame, and not a token that names no admin");

  // ---------------------------------------------------------------- someone who isn't an admin
  // (Locally anyone signed in is a user, from their first request.)
  expect((await s.page("/docs", { Cookie: bo })).status == 403, "Bo, a user, is refused /docs");
  r = await s.tool(admin, "set_user_role", { login: "bo", role: "admin" });
  expect(r.status == 200, "Bo is made an admin for a moment", await r.text());
  await until(async () => (await s.page("/docs", { Cookie: bo })).status == 200, 20_000, "Bo's role reaches every isolate");
  const bosAdmin = await s.mint(bo, { label: "Bo's", scope: "admin" });
  const bos = await s.publish(bosAdmin, "Bo's own");
  const bosPath = new URL(bos.address, s.root).pathname;
  const bosFrame = frameOf(await (await s.page(bosPath, { Cookie: bo })).text());
  expect(bos.id && bosFrame && (await pagesFetch(`${bosFrame}doc/index.html`)).status == 200, "while an admin, Bo makes a document and opens its frame", bos);
  expect((await s.tool(admin, "set_user_role", { login: "bo", role: "user" })).status == 200, "and is made a user again");
  // Each isolate remembers a user for ten seconds (users.ts).
  await until(async () => (await pagesFetch(`${bosFrame}doc/index.html`)).status == 403 && (await s.page("/docs", { Cookie: bo })).status == 403, 20_000, "Bo's role reaches every isolate");

  r = await s.page(bosPath, { Cookie: bo });
  html = await r.text();
  expect(r.status == 403 && html.includes("Staging is for Erga's admins only"), "Bo's own document: the admins-only page", r.status, html.slice(0, 400));
  expect(html.includes('href="https://erga.dev"'), "with a link to erga.dev");
  for (const path of ["/", "/docs", "/new", "/deploy", "/settings", "/tokens", "/admin"]) expect((await s.page(path, { Cookie: bo })).status == 403, `Bo: ${path} refused`);
  expect(await refusedJson(await s.get(`${bosPath}/api/doc`, { headers: { Cookie: bo } })), "his document's API");
  const room = await upgrade(`${s.root}/d/${bos.id}/api/room`, { Cookie: bo });
  expect(room == 403 || room == "closed", "its room's socket doesn't open", room);
  expect((await pagesFetch(bosFrame)).status == 403 && (await pagesFetch(`${bosFrame}doc/index.html`)).status == 403, "its frame on the pages origin, though its token was good while he was an admin");
  expect(await refusedJson(await mcp(s.root, { Cookie: bo })), "MCP with his session");
  expect(await refusedJson(await mcp(s.root, { Authorization: `Bearer ${bosAdmin}` })), "MCP with his old admin token");
  r = await s.get("/git/erga.git/info/refs?service=git-upload-pack", { headers: { Authorization: `Basic ${btoa(`token:${bosAdmin}`)}` } });
  expect(r.status == 403, "a git clone with his token", r.status);
  ok("someone who isn't an admin: refused everywhere, their own document, its pages frame, MCP and git included");

  // ---------------------------------------------------------------- what stays open
  r = await s.get("/api/deploys/version", { headers: { Cookie: SIGNED_OUT } });
  expect(r.status == 200 && ((await r.json()) as { target: string }).target == "staging", "the version check answers anyone");
  r = await s.get("/api/deploys/staging/hook", { method: "POST", headers: { Authorization: `Bearer ${HOOK}`, "Content-Type": "application/json", Cookie: SIGNED_OUT }, body: JSON.stringify({ branch: "staging", commit: "5e7a9e1c0ffee5e7a9e1c0ffee5e7a9e1c0ffee5" }) });
  expect(r.status == 200 && ((await r.json()) as { ok: boolean }).ok, "the deploy hook, with its secret, is taken", r.status);
  // The (mock) deploy it starts runs to its end (this checkout may have no release for the mock builder: then it fails
  // at the build, which is fine here), as an admin sees: the server stops cleanly only after it.
  const stagingTarget = async () => ((await (await s.get("/api/deploys", { headers: { Authorization: `Bearer ${admin}` } })).json()) as { targets: { name: string; state: string }[] }).targets.find((t) => t.name == "staging")!;
  await until(async () => ["deployed", "failed"].includes((await stagingTarget()).state), 90_000, "the pushed commit's deploy ends", async () => JSON.stringify(await stagingTarget()));
  expect((await s.get("/api/deploys/staging/hook", { method: "POST", body: "{}" })).status == 404, "and without it, its own door says no");
  r = await s.get("/api/deploys/staging/log", { headers: { Authorization: `Bearer ${HOOK}` } });
  expect(r.status == 200, "another of Erga's servers reads the log with the secret", r.status);
  r = await s.get("/api/gate", { headers: { Authorization: `Bearer ${HOOK}`, Cookie: SIGNED_OUT } });
  expect(r.status == 200, "production reads staging's test runs with the secret (the production gate)", r.status);
  expect((await s.get("/api/gate", { headers: { Cookie: SIGNED_OUT } })).status != 200, "and without it, the test runs are refused");
  expect((await s.get("/api/snapshot/docs", { method: "POST", body: "{}" })).status == 404, "the snapshot endpoint is its own door's (SNAPSHOT_TOKEN)");
  r = await s.get("/api/factory/tasks/1/brief", { headers: { Authorization: "Bearer fct.1.9999999999.0000000000000000000000000000000000000000000000000000000000000000" } });
  let body = (await r.json().catch(() => ({}))) as { error?: string; adminsOnly?: boolean };
  expect(r.status == 403 && !body.adminsOnly && /token/.test(body.error ?? ""), "a factory VM's callback reaches the factory, which checks its task token", r.status, body);
  r = await s.get("/git/erga.git/info/refs?service=git-upload-pack", { headers: { Authorization: `Basic ${btoa("x:fgt.e30.0000000000000000000000000000000000000000000000000000000000000000")}` } });
  expect(r.status == 401 && (await r.text()).includes("factory token"), "a factory VM's git token reaches the Git endpoint, which checks it", r.status);
  ok("open without an admin: the version check, the hook, peer reads and the test runs with the secret, snapshots, the factory VMs' callbacks and git token");

  // ---------------------------------------------------------------- no deploy target: as before
  const p = at(plain);
  r = await p.page("/docs", { Cookie: SIGNED_OUT });
  expect(r.status == 302 && r.headers.get("location")?.startsWith("/auth/github"), "with no deploy target, /docs signed out sends you to sign in, as before", r.status);
  r = await p.get("/git/erga.git/info/refs?service=git-upload-pack");
  expect(r.status != 401 && r.status != 403, "anonymous git reads aren't refused", r.status);
  const pBo = await p.signIn("bo");
  expect((await p.page("/docs", { Cookie: pBo })).status == 200, "a user who isn't an admin opens /docs");
  const pAdmin = await p.mint(await p.signIn(null), { label: "Admin", scope: "admin" });
  const pDoc = await p.publish(pAdmin, "Plain");
  const pFrame = frameOf(await (await p.page(new URL(pDoc.address, p.root).pathname)).text());
  const claims = JSON.parse(atob(/\/t\/([^/.]+)\./.exec(pFrame)![1].replace(/-/g, "+").replace(/_/g, "/")));
  expect(!("a" in claims) && (await pagesFetch(`${pFrame}doc/index.html`)).status == 200, "its pages tokens name nobody, and work", claims);
  ok("a server with no deploy target is unchanged");
} finally {
  await Promise.all([staging.dispose(), plain.dispose()]);
}

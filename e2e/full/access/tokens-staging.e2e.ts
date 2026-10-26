// Staging: an admin's token without the admin scope reaches the API, MCP and its documents,
// within its own scope, while its person is an admin; nothing of the admins' (pages, APIs, settings, deploys, Git).
import { expect, servers, test, until } from "../../helpers/fixtures";
import { mockGithubId } from "../../../dev/github-mock";
import { getter, mint, publish, tool } from "./access";

const staging = () => servers.of("staging-tokens", { env: { ERGA_DEPLOY_TARGET: "staging" } });
await staging();

const mcp = async (root: string, token: string, name: string, args: unknown) => {
  const r = await fetch(`${root}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const body = r.status == 200 ? (await r.json()) as { result?: { content?: { text: string }[]; isError?: boolean } } : null;
  return { status: r.status, text: body?.result?.content?.[0]?.text ?? "", isError: !!body?.result?.isError };
};

/** Each of these needs an admin with admin power: a token of another scope gets 403 from the guard. */
const ADMINS = (doc: { id: string; address: string }) => [
  ["GET", "/admin"], ["GET", "/admin/credentials"], ["GET", "/admin/users"], ["GET", "/admin/ops"], ["POST", "/admin/settings"],
  ["GET", "/api/admin/agent"], ["GET", "/api/admin/guide"], ["GET", "/api/deploys"], ["GET", "/api/source/state"], ["GET", "/api/events"],
  ["GET", "/settings"], ["GET", "/tokens"], ["POST", "/tokens/new"], ["GET", "/docs"], ["GET", "/new"], ["GET", "/deploy"],
  ["GET", `/api/docs/${doc.id}/home`], ["GET", doc.address], ["GET", "/git/erga.git/info/refs?service=git-upload-pack"],
] as const;

test("on staging an admin's document token reads and edits its document (API, MCP, its routes), and nothing else; the share token, its documents", async () => {
  const root = (await staging()).root, get = getter(root);
  const docs = await mint(root, null, { label: "Docs", scope: "documents" });
  expect(docs.token).toBeTruthy();
  const one = await publish(root, docs.token, "Staging one"), two = await publish(root, docs.token, "Staging two");
  expect(one.id && two.id).toBeTruthy();
  const token = (await mint(root, null, { label: "One", scope: "document", doc: one.id })).token;

  expect((await tool(root, token, "read", { document: one.id, path: "index.html" })).text).toContain("Staging one");
  expect((await tool(root, token, "write", { document: one.id, path: "index.html", content: "<h1>Edited on staging</h1>" })).status).toBe(200);
  expect((await mcp(root, token, "read", { document: one.id, path: "index.html" })).text).toContain("Edited on staging");
  expect((await mcp(root, token, "write", { document: one.id, path: "notes.md", content: "Over MCP" })).isError).toBe(false);
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  expect(await until(async () => (await (await get(`/d/${one.id}/doc/notes.md`, auth)).text()).includes("Over MCP"), 5000, "the note on the document's route")).toBe(true);
  expect((await get(`/api/docs/${one.id}/versions`, auth)).status).toBe(200);

  // Its scope, as on production: not the other document, no list.
  expect((await tool(root, token, "read", { document: two.id, path: "index.html" })).status).toBe(403);
  expect((await get(`/d/${two.id}/doc/index.html`, auth)).status).toBe(403);
  expect((await tool(root, token, "list_documents")).status).toBe(403);

  // The editor's Share card token (documents): the admin's documents, no admin tools.
  const at = (await get(`${one.address}/api/share`, { method: "POST", headers: { Origin: root, "Content-Type": "application/json" }, body: "{}" }));
  const share = ((await at.json()) as { token: string }).token;
  expect(share).toMatch(/^erga_/);
  // The Share card's prompt, step by step: the document's guide at its address, then its tools.
  const bearer = { Authorization: `Bearer ${share}` };
  const guide = await get(`${one.address}/api/ext`, { headers: bearer });
  expect(guide.status).toBe(200);
  const base = /curl -s -X POST (\S+)\/api\/ext\/tools\/read/.exec(await guide.text())?.[1] ?? "";
  expect(base.startsWith(root)).toBe(true);
  const run = (name: string, args: unknown) => fetch(`${base}/api/ext/tools/${name}`, { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const read = await run("read", { path: "index.html" });
  expect(`${read.status} ${await read.text()}`).toContain("Edited on staging");
  expect((await run("edit", { path: "index.html", edits: [{ oldText: "Edited on staging", newText: "Edited by the Share prompt" }] })).status).toBe(200);
  expect((await (await run("read", { path: "index.html" })).text())).toContain("Edited by the Share prompt");
  expect((await get("/api/ext", { headers: bearer })).status).toBe(200);
  expect((await tool(root, share, "list_documents")).text).toContain("Staging two");
  expect((await tool(root, share, "set_user_role", { login: "tester", role: "write" })).status).toBe(403);

  for (const t of [token, share]) {
    for (const [method, path] of ADMINS(one)) {
      const r = await get(path, { method, headers: { Authorization: `Bearer ${t}`, ...(method == "POST" ? { Origin: root } : {}) } });
      expect(`${method} ${path}: ${r.status}`).toBe(`${method} ${path}: 403`);
    }
  }
});

test("on staging a token works only while its person is an admin: refused once they aren't, and a non-admin can't make one", async () => {
  const root = (await staging()).root, get = getter(root);
  const admin = (await mint(root, null, { label: "Admin", scope: "admin" })).token;
  expect(admin).toBeTruthy();
  // Added by their GitHub login, as an admin, before their first sign-in; then that sign-in (the pretend provider, with
  // the id the pretend GitHub gives the login) and the username step make their account, an admin's.
  const login = `bo${crypto.randomUUID().slice(0, 6)}`;
  expect((await tool(root, admin, "add_user", { provider: "github", handle: login, role: "admin" })).status).toBe(200);
  const joining = await get(`/auth/dev?provider=github&subject=${mockGithubId(login)}&handle=${login}&next=/docs`);
  expect(joining.headers.get("location")).toBe("/auth/username");
  const join = joining.headers
    .getSetCookie()
    .map((x) => x.split(";")[0])
    .find((x) => x.includes("erga_join"))!;
  const made = await get("/auth/username", {
    method: "POST",
    headers: { Cookie: join, Origin: root },
    body: new URLSearchParams({ username: login }),
  });
  const cookie = made.headers
    .getSetCookie()
    .map((x) => x.split(";")[0])
    .find((x) => /^erga_session(_\d+)?=/.test(x))!;
  expect(cookie).toBeTruthy();
  const theirs = await until(async () => (await mint(root, cookie, { label: "Bo's", scope: "documents" })).token, 15_000, "a token for the new admin");
  const doc = await publish(root, theirs, "Bo on staging");
  expect((await tool(root, theirs, "read", { document: doc.id, path: "index.html" })).text).toContain("Bo on staging");

  expect((await tool(root, admin, "set_user_role", { login, role: "write" })).status).toBe(200);
  await until(
    async () => (await tool(root, theirs, "read", { document: doc.id, path: "index.html" })).status == 403,
    15_000,
    "the token refused"
  );
  const refused = await get("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${theirs}`, "Content-Type": "application/json" },
    body: "{}",
  });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { adminsOnly?: boolean }).adminsOnly).toBe(true);
  // Not an admin: staging lets them make no token at all.
  expect((await mint(root, cookie, { label: "Again", scope: "documents" })).token).toBe("");
});

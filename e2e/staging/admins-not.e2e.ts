// Someone who isn't an admin on staging: refused everywhere, a document they made while
// they were an admin, its frame on the pages origin, its room, MCP and git included.
import { expect, servers, test, until } from "../fixtures";
import { frameOf, get, mcp, page, pagesFetch, publish, refusedJson, tool, upgrade } from "./admins";
import { mint, signIn } from "./staging";

await servers.staging();

// Each isolate remembers a user's role for ten seconds (users.ts): two role changes wait up to 20 s each to reach them all.
test("a user who was an admin for a moment is refused everywhere, their own document and its frame included", { timeout: 60_000 }, async () => {
  const s = await servers.staging();
  // A login of this test's own: locally anyone signed in is a user, from their first request.
  const login = `bo${crypto.randomUUID().slice(0, 8)}`;
  const admin = await mint(s.root, await signIn(s.root), "admin"), bo = await signIn(s.root, login);
  expect((await page(s, "/docs", { Cookie: bo })).status).toBe(403);
  expect((await tool(s, admin, "set_user_role", { login, role: "admin" })).status).toBe(200);
  await until(async () => (await page(s, "/docs", { Cookie: bo })).status == 200, 20_000, "the new role reaches every isolate");
  const bosAdmin = await mint(s.root, bo, "admin");
  const doc = await publish(s, bosAdmin, "Bo's own");
  const path = new URL(doc.address, s.root).pathname;
  const frame = frameOf(await (await page(s, path, { Cookie: bo })).text());
  expect(frame).toBeTruthy();
  expect((await pagesFetch(`${frame}doc/index.html`)).status, "while an admin, their frame opens").toBe(200);
  expect((await tool(s, admin, "set_user_role", { login, role: "user" })).status).toBe(200);
  await until(async () => (await pagesFetch(`${frame}doc/index.html`)).status == 403 && (await page(s, "/docs", { Cookie: bo })).status == 403, 20_000, "the role reaches every isolate");

  const r = await page(s, path, { Cookie: bo });
  const html = await r.text();
  expect(r.status).toBe(403);
  expect(html).toContain("Staging is for Erga's admins only");
  expect(html).toContain('href="https://erga.dev"');
  for (const p of ["/", "/docs", "/new", "/deploy", "/settings", "/tokens", "/admin"]) expect((await page(s, p, { Cookie: bo })).status, p).toBe(403);
  expect(await refusedJson(await get(s, `${path}/api/doc`, { headers: { Cookie: bo } })), "the document's API").toBe(true);
  expect(["closed", 403], "its room's socket doesn't open").toContain(await upgrade(`${s.root}/d/${doc.id}/api/room`, { Cookie: bo }));
  expect((await pagesFetch(frame)).status, "its frame, though its token was good while they were an admin").toBe(403);
  expect(await refusedJson(await mcp(s, { Cookie: bo })), "MCP with the session").toBe(true);
  expect(await refusedJson(await mcp(s, { Authorization: `Bearer ${bosAdmin}` })), "MCP with the old admin token").toBe(true);
  const git = await get(s, "/git/erga.git/info/refs?service=git-upload-pack", { headers: { Authorization: `Basic ${btoa(`token:${bosAdmin}`)}` } });
  expect(git.status, "a git clone with the old token").toBe(403);
});

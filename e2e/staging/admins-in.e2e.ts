// Admins on staging ("admins"): an admin's session and admin token are in, the pages
// origin's frame too; their documents token has no admin power, and a pages token that names nobody is refused.
import { pagesToken } from "../../front";
import { expect, servers, STAGING_SESSION_SECRET, test } from "../fixtures";
import { frameOf, get, mcp, page, pagesFetch, publish, refusedJson, tool } from "./admins";
import { mint, signIn } from "./staging";

await servers.staging();

test("an admin's session and admin token are in (the API, MCP, git); their documents token is refused everywhere", async () => {
  const s = await servers.staging();
  const tester = await signIn(s.root);
  expect((await page(s, "/docs", { Cookie: tester })).status).toBe(200);
  const admin = await mint(s.root, tester, "admin"), docs = await mint(s.root, tester, "documents");
  expect((await get(s, "/api/deploys", { headers: { Authorization: `Bearer ${admin}` } })).status).toBe(200);
  expect((await mcp(s, { Authorization: `Bearer ${admin}` })).status).toBe(200);
  const r = await get(s, "/git/erga.git/info/refs?service=git-upload-pack", { headers: { Authorization: `Basic ${btoa(`token:${admin}`)}` } });
  expect([401, 403], "an admin token passes the guard for git, as Basic's password").not.toContain(r.status);
  expect(await refusedJson(await get(s, "/api/deploys", { headers: { Authorization: `Bearer ${docs}` } })), "a documents token: the API").toBe(true);
  expect(await refusedJson(await tool(s, docs, "list_documents")), "the tools").toBe(true);
  expect(await refusedJson(await mcp(s, { Authorization: `Bearer ${docs}` })), "MCP").toBe(true);
});

test("the pages origin serves an admin's frame and its files, and refuses a token that names no admin", async () => {
  const s = await servers.staging();
  const tester = await signIn(s.root), admin = await mint(s.root, tester, "admin");
  const mine = await publish(s, admin, "Tester's");
  const html = await (await page(s, new URL(mine.address, s.root).pathname, { Cookie: tester })).text();
  const frame = frameOf(html);
  expect(frame, html.slice(0, 400)).toBeTruthy();
  expect((await pagesFetch(frame)).status).toBe(200);
  const file = await pagesFetch(`${frame}doc/index.html`);
  expect(file.status).toBe(200);
  expect(file.text).toContain("Tester's");
  // A pages token as another server (or an older one) makes it: it names nobody.
  const nobody = await pagesToken(STAGING_SESSION_SECRET, "tester", mine.id, s.root);
  expect((await pagesFetch(`http://${new URL(frame).host}/t/${nobody}/doc/index.html`)).status).toBe(403);
});

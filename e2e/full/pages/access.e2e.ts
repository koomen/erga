// Who may use the tree.
import { expect, servers, test } from "../../helpers/fixtures";
import { person, someone } from "../versions/versions";
import { paths, site } from "./tree";

await servers.short();

test("editors change the tree, viewers only read it, strangers and other sites get nothing; tokens work too", async () => {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  const ada = await person(server, someone("ada"));
  expect((await s.readTree(ada.get)).status).toBe(404);
  // (Locally, no cookie is DEV_LOGIN; a token that isn't one signs in nobody.)
  expect((await fetch(`${server.root}/api/docs/${s.id}/tree`, { headers: { Authorization: "Bearer erga_nothing" } })).status).toBe(401);
  expect((await s.owner.share(s.id, ada.login, "viewer")).ok).toBe(true);
  const viewing = await s.readTree(ada.get);
  expect(viewing.status).toBe(200);
  expect(viewing.body.canEdit).toBe(false);
  expect(paths(viewing.body.entries)).toContain("blog/post.html");
  const refused = await s.treeOp({ op: "new_page", path: "ada.html" }, ada.get);
  expect(refused.status).toBe(403);
  expect(refused.body.error).toMatch(/only view/);
  expect((await s.treeOp({ op: "new_page", path: "x.html" }, s.get, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  const byToken = await fetch(`${server.root}/api/docs/${s.id}/tree`, { headers: s.auth });
  expect(byToken.ok).toBe(true);
  expect(paths(((await byToken.json()) as { entries: [] }).entries)).toContain("about.html");
  expect((await s.get(`/d/${s.id}/api/tree`)).ok).toBe(true);
});

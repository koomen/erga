// Who may use the tree.
import { expect, servers, test } from "../../helpers/fixtures";
import { person, someone } from "../versions/versions";
import { paths, site } from "./tree";

await servers.short();

test("editors change the tree, viewers only read it, strangers and other sites get nothing; tokens work too", async () => {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  const ada = await person(server, someone("ada"));
  expect((await s.readTree(ada)).status).toBe(403);
  // (Locally, no cookie is DEV_LOGIN; a token that isn't one signs in nobody.)
  const asToken = (token: string) =>
    fetch(`${server.root}/api/tools/ls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ document: s.id }),
    });
  expect((await asToken("erga_nothing")).status).toBe(401);
  expect((await s.owner.share(s.id, ada.login, "viewer")).ok).toBe(true);
  const viewing = await s.readTree(ada);
  expect(viewing.status).toBe(200);
  expect(viewing.body.canEdit).toBe(false);
  expect(paths(viewing.body.entries)).toContain("blog/post.html");
  const refused = await s.treeOp({ op: "new_page", path: "ada.html" }, ada);
  expect(refused.status).toBe(403);
  expect(refused.body.error).toMatch(/can't edit/);
  // Another site's page, with the owner's cookie: refused.
  expect((await s.treeOp({ op: "new_page", path: "x.html" }, s.owner, "https://elsewhere.example")).status).toBe(403);
  const byToken = await asToken(s.token);
  expect(byToken.ok).toBe(true);
  expect(paths(((await byToken.json()) as { result: { entries: [] } }).result.entries)).toContain("about.html");
});

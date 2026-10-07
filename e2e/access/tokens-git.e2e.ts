// Scoped tokens and Git (tests/scoped-tokens.ts, Git: who may push). Asking to push (info/refs for
// git-receive-pack) is enough to see who may: nothing is pushed. The second person has a name of this test's own,
// so making them an admin and a user again touches no one else on the worker's server.
import { expect, servers, test } from "../fixtures";
import { getter, mint, signIn, tool, unique } from "./access";

await servers.main();

test("git push: no token 401 saying where to make one, a documents token 403, a non-admin's admin token 403, an admin's admin token in; a user can't make an admin token", async () => {
  const root = (await servers.main()).root;
  const push = (auth?: string) => getter(root)("/git/erga.git/info/refs?service=git-receive-pack", auth ? { headers: { Authorization: `Basic ${btoa(`anyone:${auth}`)}` } } : {});
  const name = unique("Bo"), login = name.toLowerCase();
  const tester = await signIn(root, null), bo = await signIn(root, name);
  let r = await push();
  expect(r.status).toBe(401);
  expect(await r.text()).toContain(`${root}/tokens`);
  const admin = await mint(root, tester, { label: "Git", scope: "admin" });
  expect(admin.token, admin.page.slice(0, 300)).toBeTruthy();
  const docs = await mint(root, tester, { label: "Docs", scope: "documents" });
  r = await push(docs.token);
  expect(r.status).toBe(403);
  expect(await r.text()).toContain("admin scope");
  expect((await mint(root, bo, { label: "Bo's", scope: "admin" })).page).toContain("Only an admin can make an admin token");
  expect((await tool(root, admin.token, "set_user_role", { login, role: "admin" })).status).toBe(200);
  const bos = await mint(root, bo, { label: "Bo's git", scope: "admin" });
  expect(bos.token).toBeTruthy();
  expect((await push(bos.token)).status, "an admin pushes with their admin token").toBe(200);
  expect((await tool(root, admin.token, "set_user_role", { login, role: "user" })).status).toBe(200);
  r = await push(bos.token);
  expect(r.status, "a non-admin's admin token").toBe(403);
  expect(await r.text()).toContain("Only admins");
  r = await push(admin.token);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type") ?? "").toContain("git-receive-pack");
});

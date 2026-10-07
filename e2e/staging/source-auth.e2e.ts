// Who may reach Erga's Git endpoint on staging ("Who may reach the Git endpoint"): no token 401 (even
// a read: staging is for admins only), a token that isn't one 401, a documents token 403, an admin's admin token in;
// an anonymous clone and push, and a push with a documents token, are refused.
import { expect, servers, test } from "../fixtures";
import { admin, clone, commit, git, heads, mint, remote, scratch, seed, signIn } from "./staging";

await servers.staging();

test("the Git endpoint: no token 401, asking for Basic credentials; a documents token 403; an admin's token, any username, in", async () => {
  const s = await servers.staging();
  const docs = await mint(s.root, await signIn(s.root), "documents"), a = await admin(s);
  const get = (path: string, init: RequestInit = {}) => fetch(s.root + path, { redirect: "manual", ...init });
  const basic = (user: string, token: string) => ({ headers: { Authorization: `Basic ${btoa(`${user}:${token}`)}` } });
  for (const path of ["/git/erga.git/info/refs?service=git-upload-pack", "/git/erga.git/info/refs?service=git-receive-pack"]) {
    const r = await get(path);
    expect(r.status, path).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Basic/);
  }
  expect((await get("/git/erga.git/git-receive-pack", { method: "POST", body: "0000" })).status).toBe(401);
  expect((await get("/git/erga.git/info/refs?service=git-receive-pack", basic("x", "erga_not_a_token"))).status).toBe(401);
  const push = await get("/git/erga.git/info/refs?service=git-receive-pack", basic("x", docs));
  expect(push.status).toBe(403);
  expect(await push.text()).toContain("admin scope");
  expect((await get("/git/erga.git/info/refs?service=git-upload-pack", basic("x", docs))).status).toBe(403);
  const r = await get("/git/erga.git/info/refs?service=git-upload-pack", basic("anyone", a.token));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("git-upload-pack");
});

test("an admin token clones and lists the branches; an anonymous clone and push, and a push with a documents token, are refused", async () => {
  const s = await servers.staging(), a = await admin(s);
  const docs = await mint(s.root, a.cookie, "documents");
  await seed(s, a.token);
  const refused = git(s.scratch, "clone", "-q", remote(s, null), `${scratch(s)}/refused`);
  expect(refused.ok).toBe(false);
  expect(refused.err).toMatch(/401|Authentication failed|could not read Username/i);
  const c = clone(s, a.token);
  expect(git(c, "ls-remote", remote(s, a.token)).out).toContain("refs/heads/staging");
  const before = heads(s, a.token).staging;
  commit(c, "anon.txt", `${crypto.randomUUID()}\n`, "Anonymous");
  const anon = git(c, "push", remote(s, null), "HEAD:staging");
  expect(anon.ok).toBe(false);
  expect(anon.err).toMatch(/401|Authentication failed|could not read Username/i);
  expect(git(c, "push", remote(s, docs), "HEAD:staging").err).toContain("403");
  expect(heads(s, a.token).staging, "staging didn't move").toBe(before);
});

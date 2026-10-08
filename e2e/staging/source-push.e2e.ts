// Pushing to Erga's repository: main only follows staging, and only to a commit whose tests passed
// (the production gate); staging keeps main's commits; main never moves back; no other branches; a fetch brings what
// another pushed. staging moves only by the factory's Merge: a push is refused unless its admin allowed pushes, in a
// browser, with a reason that the change log keeps (admin() does that for the tests that push).
import { expect, servers, test } from "../fixtures";
import { admin, allowPushes, clone, commit, gateGreen, git, mint, must, remote, scratch, seed, signIn } from "./staging";

await servers.staging();

test("main only follows staging, once the commit's tests passed; staging keeps main's commits; main never moves back; no other branches", { timeout: 30_000 /* a test run of the gate's fake (about 2 s) and three pushes, each starting a deploy */ }, async () => {
  const s = await servers.staging(), a = await admin(s);
  await seed(s, a.token);
  const c = clone(s, a.token);
  must(c, "fetch", "-q", "origin", "main");
  commit(c, "third.txt", `${crypto.randomUUID()}\n`, "Third");
  const early = git(c, "push", "origin", "HEAD:main");
  expect(early.ok).toBe(false);
  expect(early.err).toContain("main only follows staging");
  const both = git(c, "push", "origin", "HEAD:staging", "HEAD:main");
  expect(both.ok, "staging lands, main waits for the commit's tests").toBe(false);
  expect(both.err).toContain("Erga: staging is now");
  expect(both.err).toMatch(/no test run|still running/);
  await gateGreen(s, a.token, must(c, "rev-parse", "HEAD"));
  const later = git(c, "push", "origin", "HEAD:main");
  expect(later.ok, later.err).toBe(true);
  expect(later.err).toContain("Erga: main is now");
  must(c, "reset", "-q", "--hard", "HEAD~1");
  commit(c, "app.ts", `export const x = "${crypto.randomUUID()}";\n`, "Rewritten");
  const dropped = git(c, "push", "--force", "origin", "HEAD:staging");
  expect(dropped.ok).toBe(false);
  expect(dropped.err).toContain("staging is always at or ahead of main");
  const back = git(c, "push", "--force", "origin", "HEAD~1:main");
  expect(back.ok).toBe(false);
  expect(back.err).toContain("only moves forward");
  expect(git(c, "push", "origin", "HEAD:feature").err).toContain("two branches");
});

test("a fetch brings what another pushed", async () => {
  const s = await servers.staging(), a = await admin(s);
  await seed(s, a.token);
  const one = clone(s, a.token), two = clone(s, a.token);
  commit(one, "notes.txt", `${crypto.randomUUID()}\n`, "Fourth");
  const fifth = commit(one, "app.ts", `export const x = "${crypto.randomUUID()}";\n`, "Fifth");
  must(one, "push", "-q", "origin", "HEAD:staging");
  must(two, "fetch", "-q");
  expect(must(two, "rev-parse", "origin/staging")).toBe(fifth);
  expect(must(two, "log", "-1", "--format=%s", "origin/staging")).toBe("Fifth");
});

test("staging moves only by the factory's Merge: a push is refused until its admin allows pushes in a browser, with a reason (never with a token); the change log keeps it", async () => {
  const s = await servers.staging(), a = await admin(s);
  await seed(s, a.token);
  // An admin of the test's own: no other test's override is theirs.
  const login = `rule-${crypto.randomUUID().slice(0, 6)}`;
  const added = await fetch(`${s.root}/admin/users`, { method: "POST", headers: { Cookie: a.cookie, Origin: s.root }, body: new URLSearchParams({ do: "add", login, role: "admin" }) });
  expect(added.ok, await added.text()).toBe(true);
  const cookie = await signIn(s.root, login), token = await mint(s.root, cookie, "admin", "Git");
  const c = `${scratch(s)}/c`;
  must(s.scratch, "clone", "-q", "-b", "staging", remote(s, token), c);
  const sha = commit(c, "rule.txt", `${crypto.randomUUID()}\n`, "Past the staging rule");
  const refused = git(c, "push", "origin", "HEAD:staging");
  expect(refused.ok).toBe(false);
  expect(refused.err).toContain("staging moves only by the factory's Merge");
  expect((await allowPushes(s, null, "An agent asks with a token", token)).status).toBe(403);
  expect((await allowPushes(s, cookie, "too short")).status).toBe(400);
  const reason = `Hotfix ${crypto.randomUUID().slice(0, 6)}: the factory is down`;
  const open = await allowPushes(s, cookie, reason);
  expect(open.status).toBe(200);
  expect(open.body).toMatchObject({ login, reason });
  expect(open.body.until! - Date.now()).toBeGreaterThan(9 * 60_000);
  const landed = git(c, "push", "origin", "HEAD:staging");
  expect(landed.ok, landed.err).toBe(true);
  expect(landed.err).toContain(`Erga: staging is now ${sha.slice(0, 7)}`);
  const changes = await (await fetch(`${s.root}/admin/changes`, { headers: { Cookie: a.cookie } })).text();
  expect(changes).toContain(reason);
  expect(changes).toContain("staging rule overridden");
});

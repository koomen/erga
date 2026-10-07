// Pushing to Erga's repository (tests/source.ts): main only follows staging, and only to a commit whose tests passed
// (the production gate); staging keeps main's commits; main never moves back; no other branches; a fetch brings what
// another pushed.
import { expect, servers, test } from "../fixtures";
import { admin, clone, commit, gateGreen, git, must, seed } from "./staging";

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

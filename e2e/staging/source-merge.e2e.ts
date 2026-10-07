// The source API ("The API: branches and merging"): staging's commits and which main has; merging is
// always a fast-forward of main, to staging's head or a chosen commit; admins only, from this site only.
import { expect, servers, test } from "../fixtures";
import { admin, clone, commit, gateGreen, heads, merge, mint, must, seed } from "./staging";

await servers.staging();

type View = { branches: { name: string; commit: string; ahead?: number; commits: { sha: string; subject: string; inMain: boolean }[] }[]; mirror: { error: string | null; lastPushAt: number | null }; remote: string };

test("GET /api/source/branches: staging's commits, newest first, which main has, how far ahead; a non-admin can't read or merge", async () => {
  const s = await servers.staging(), a = await admin(s);
  await seed(s, a.token);
  const c = clone(s, a.token);
  const one = commit(c, "a.txt", `${crypto.randomUUID()}\n`, "Ahead one"), two = commit(c, "b.txt", `${crypto.randomUUID()}\n`, "Ahead two");
  must(c, "push", "-q", "origin", "HEAD:staging");
  const view = await (await fetch(`${s.root}/api/source/branches`, { headers: { Authorization: `Bearer ${a.token}` } })).json() as View;
  const [staging, main] = view.branches;
  expect([staging.name, main.name]).toEqual(["staging", "main"]);
  expect(staging.commits.slice(0, 2).map((x) => [x.sha, x.subject, x.inMain])).toEqual([[two, "Ahead two", false], [one, "Ahead one", false]]);
  expect(staging.commits.find((x) => x.sha == main.commit)?.inMain).toBe(true);
  expect(staging.ahead).toBeGreaterThanOrEqual(2);
  expect(view.remote).toBe(`${s.root}/git/erga.git`);
  const docs = await mint(s.root, a.cookie, "documents");
  expect((await fetch(`${s.root}/api/source/branches`, { headers: { Authorization: `Bearer ${docs}` } })).status).toBe(403);
  expect((await fetch(`${s.root}/api/source/merge`, { method: "POST", headers: { Authorization: `Bearer ${docs}`, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  const evil = await fetch(`${s.root}/api/source/merge`, { method: "POST", headers: { Cookie: a.cookie, Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
  expect(evil.status, "a merge POSTed from another site").toBe(403);
  expect((await merge(s, a, "token", { from: "main", to: "staging" })).status, "merging the other way").toBe(400);
});

test("main fast-forwards to a chosen staging commit, never to one staging doesn't have, then to staging's head; then nothing to merge", { timeout: 25_000 /* two test runs of the gate's fake, about 2 s each */ }, async () => {
  const s = await servers.staging(), a = await admin(s);
  await seed(s, a.token);
  const c = clone(s, a.token);
  const chosen = commit(c, "a.txt", `${crypto.randomUUID()}\n`, "Chosen"), head = commit(c, "b.txt", `${crypto.randomUUID()}\n`, "Head");
  must(c, "push", "-q", "origin", "HEAD:staging");
  await gateGreen(s, a.token, chosen);
  await gateGreen(s, a.token, head);
  let m = await merge(s, a, "token", { commit: chosen });
  expect([m.status, m.body.commit, m.body.fastForward]).toEqual([200, chosen, true]);
  expect((await merge(s, a, "token", { commit: "1".repeat(40) })).status).toBe(409);
  m = await merge(s, a, "cookie");
  expect([m.status, m.body.commit, m.body.fastForward], "from the page's own session").toEqual([200, head, true]);
  expect((await merge(s, a, "token")).body.upToDate).toBe(true);
  must(c, "fetch", "-q");
  expect(heads(s, a.token).main).toBe(heads(s, a.token).staging);
  expect(must(c, "log", "--merges", "--format=%s", "origin/main")).toBe("");
});

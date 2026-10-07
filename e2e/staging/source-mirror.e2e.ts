// The GitHub mirror (tests/source.ts): each move is pushed to a pretend GitHub (dev/mirror.ts, dev/git-server.ts).
import { expect, servers, test } from "../fixtures";
import { admin, clone, commit, git, heads, must, seed } from "./staging";

await servers.staging();

test("GitHub's staging follows Erga's, and the mirror says it is up to date", async () => {
  const s = await servers.staging(), a = await admin(s);
  await seed(s, a.token);
  const c = clone(s, a.token);
  const sha = commit(c, "mirror.txt", `${crypto.randomUUID()}\n`, "For the mirror");
  must(c, "push", "-q", "origin", "HEAD:staging");
  const github = `http://x:erga-dev-github-token@127.0.0.1:${s.port}/__github/koomen/erga.git`;
  await expect.poll(() => git(c, "ls-remote", github, "staging").out.split("\t")[0], { timeout: 10_000 }).toBe(sha);
  expect(git(c, "ls-remote", github, "main").out.split("\t")[0]).toBe(heads(s, a.token).main);
  await expect.poll(async () => {
    const { mirror } = await (await fetch(`${s.root}/api/source/branches`, { headers: { Authorization: `Bearer ${a.token}` } })).json() as { mirror: { error: string | null; lastPushAt: number | null } };
    return mirror.error == null && !!mirror.lastPushAt;
  }).toBe(true);
});

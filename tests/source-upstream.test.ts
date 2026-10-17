// A downstream's repository (an Erga on its own domain, forked from
// erga.dev's): where it stands against upstream, and Update from upstream
// into staging: a fast-forward, a merge commit made here, or a merge that
// conflicts and waits on its branch, resolved by the admin's agent (through
// the repository) or by a person (a merge pushed to staging). And seeding a
// fork. Real git against Erga's endpoint, in front of pretend Artifacts.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, must, startFixture, type Fixture } from "./source-fixture.ts";

setDefaultTimeout(30_000);
const scratch = () => mkdtempSync(join(tmpdir(), "erga-down-"));
const ada = { login: "ada", name: "Ada" };

describe("a downstream of erga.dev", () => {
  let f: Fixture, up: string, down: string;
  const file = (dir: string, name: string, content: string) => writeFileSync(join(dir, name), content);
  const commit = async (dir: string, message: string) => { await must(dir, "add", "."); await must(dir, "commit", "-qm", message); return must(dir, "rev-parse", "HEAD"); };
  beforeAll(async () => {
    f = startFixture({ upstream: true });
    // Upstream: three commits on main, the first release tagged. The downstream: a fork at that point (main and staging).
    up = scratch();
    await must(up, "init", "-q", "-b", "main");
    file(up, "a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    file(up, "README.md", "# Erga\n");
    await commit(up, "First");
    file(up, "b.txt", "bee\n");
    await commit(up, "Second");
    file(up, "a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
    await commit(up, "Third");
    await must(up, "tag", "-a", "v0.1.0", "-m", "Release v0.1.0");
    await must(up, "push", "-q", f.upstream, "main", "--tags");
    down = scratch();
    await must(down, "clone", "-q", f.upstream, "copy");
    down = join(down, "copy");
    await must(down, "remote", "add", "erga", f.erga);
    expect((await git(down, "push", "erga", "main:main", "main:staging")).ok).toBe(true);
  });
  afterAll(() => f.stop());

  test("the position: level with upstream's release, nothing of its own", async () => {
    const view = await f.repo.branches();
    expect(view.upstream).toMatchObject({ origin: "https://ops.erga.test", channel: "stable", release: { tag: "v0.1.0" }, behind: 0, own: 0, error: null });
    expect(view.conflict).toBeNull();
    expect(view.upstream!.main).toBe(await must(up, "rev-parse", "main"));
    expect(view.upstream!.target).toBe(view.upstream!.release!.commit);
    expect(view.upstream!.version).toBe("v0.1.0");
    expect(await f.repo.update(ada)).toEqual({ result: "up-to-date", commit: await must(up, "rev-parse", "main") });
  });

  test("upstream moves on: behind by its new commits (stable: the newest tag's), and a fast-forward brings them into staging only", async () => {
    file(up, "u.txt", "from upstream\n");
    const fourth = await commit(up, "Fourth, upstream");
    file(up, "u2.txt", "more\n");
    const fifth = await commit(up, "Fifth, upstream, not released");
    await must(up, "tag", "-a", "v0.2.0", "-m", "Release v0.2.0", fourth);
    await must(up, "push", "-q", f.upstream, "main", "--tags");
    let view = await f.repo.branches();
    // stable: the release's commit, not main's head beyond it.
    expect(view.upstream).toMatchObject({ release: { tag: "v0.2.0", commit: fourth }, target: fourth, version: "v0.2.0", behind: 1, own: 0 });
    expect(view.upstream!.main).toBe(fifth);
    expect(view.upstream!.commits.map((c) => c.subject)).toEqual(["Fourth, upstream"]);
    // edge: main's head.
    f.channel = "edge";
    view = await f.repo.branches();
    expect(view.upstream).toMatchObject({ target: fifth, version: fifth.slice(0, 12), behind: 2 });
    expect(view.upstream!.commits.map((c) => c.subject)).toEqual(["Fifth, upstream, not released", "Fourth, upstream"]);
    f.channel = "stable";
    const r = await f.repo.update(ada);
    expect(r).toEqual({ result: "fast-forward", commit: fourth, version: "v0.2.0", brought: 1 });
    expect(f.moves.at(-1)).toMatchObject({ branch: "staging", new: fourth, how: "update", by: "ada" });
    // staging has it, main doesn't (production follows through Merge), and a clone sees both.
    await must(down, "fetch", "-q", "erga");
    expect(await must(down, "rev-parse", "erga/staging")).toBe(fourth);
    expect(await must(down, "rev-parse", "erga/main")).toBe(await must(up, "rev-parse", "main~2"));
    expect((await f.repo.branches()).upstream).toMatchObject({ behind: 0, own: 0 });
  });

  test("own commits and upstream's: a merge commit made here, clean", async () => {
    await must(down, "checkout", "-q", "-B", "work", "erga/staging");
    file(down, "o.txt", "our own\n");
    const own = await commit(down, "Our own change");
    expect((await git(down, "push", "erga", "HEAD:staging")).ok).toBe(true);
    file(up, "b.txt", "bee\nwasp\n");
    const sixth = await commit(up, "Sixth, upstream");
    await must(up, "tag", "-a", "v0.3.0", "-m", "Release v0.3.0");
    await must(up, "push", "-q", f.upstream, "main", "--tags");
    const view = await f.repo.branches();
    expect(view.upstream).toMatchObject({ target: sixth, version: "v0.3.0", behind: 2, own: 1 });
    const r = await f.repo.update(ada);
    expect(r).toMatchObject({ result: "merged", version: "v0.3.0", brought: 2 });
    const merged = (r as { commit: string }).commit;
    await must(down, "fetch", "-q", "erga");
    expect(await must(down, "rev-parse", "erga/staging")).toBe(merged);
    expect((await must(down, "log", "-1", "--format=%P", merged)).split(" ")).toEqual([own, sixth]);
    expect(await must(down, "log", "-1", "--format=%s%n%an", merged)).toBe("Update from ops.erga.test v0.3.0\nAda");
    await must(down, "checkout", "-q", "-B", "work", merged);
    expect(readFileSync(join(down, "b.txt"), "utf8")).toBe("bee\nwasp\n");
    expect(readFileSync(join(down, "o.txt"), "utf8")).toBe("our own\n");
    expect(readFileSync(join(down, "u2.txt"), "utf8")).toBe("more\n");
    expect((await git(down, "fsck", "--connectivity-only")).ok).toBe(true);
    expect((await f.repo.branches()).upstream).toMatchObject({ behind: 0, own: 2 });
  });

  test("a conflict: staging stays, the merge waits on its branch with the markers; the agent resolves and finishes it", async () => {
    file(down, "a.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
    const ours = await commit(down, "Our edit of a.txt");
    expect((await git(down, "push", "erga", "HEAD:staging")).ok).toBe(true);
    file(up, "a.txt", "uno\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
    const seventh = await commit(up, "Seventh, upstream, conflicting");
    await must(up, "tag", "-a", "v0.4.0", "-m", "Release v0.4.0");
    await must(up, "push", "-q", f.upstream, "main", "--tags");
    const r = await f.repo.update(ada);
    expect(r).toMatchObject({ result: "conflicts", conflict: { branch: "upstream-merge/v0.4.0", version: "v0.4.0", target: seventh, ours, files: [{ path: "a.txt", kind: "content" }], by: "ada" } });
    expect(f.moves.at(-1)!.new).toBe(ours);
    const view = await f.repo.branches();
    expect(view.conflict).toMatchObject({ kind: "upstream", branch: "upstream-merge/v0.4.0" });
    expect(view.branches.find((b) => b.name == "staging")!.commit).toBe(ours);
    // The branch, from a checkout: the merge with Git's markers.
    await must(down, "fetch", "-q", "erga", "upstream-merge/v0.4.0");
    await must(down, "checkout", "-q", "-B", "fix", "FETCH_HEAD");
    expect((await must(down, "log", "-1", "--format=%P")).split(" ")).toEqual([ours, seventh]);
    expect(readFileSync(join(down, "a.txt"), "utf8")).toBe("<<<<<<< staging\nONE\n=======\nuno\n>>>>>>> ops.erga.test v0.4.0\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
    // The agent's way out: the file written whole, then the merge finished.
    await expect(f.repo.finishUpdate(ada)).rejects.toThrow(/still carries conflict markers: a.txt/);
    const half = await f.repo.resolveUpdate(ada, "a.txt", "<<<<<<< staging\nUNO\n");
    expect(half.remaining).toEqual(["a.txt"]);
    const done = await f.repo.resolveUpdate(ada, "./a.txt", "UNO\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
    expect(done).toEqual({ branch: "upstream-merge/v0.4.0", path: "a.txt", remaining: [] });
    const finished = await f.repo.finishUpdate({ ...ada, via: "their admin agent" });
    expect(finished.version).toBe("v0.4.0");
    expect(f.moves.at(-1)).toMatchObject({ branch: "staging", old: ours, new: finished.commit, how: "update", via: "their admin agent" });
    await must(down, "fetch", "-q", "erga");
    expect(await must(down, "rev-parse", "erga/staging")).toBe(finished.commit);
    expect((await must(down, "log", "-1", "--format=%P", finished.commit)).split(" ")).toEqual([ours, seventh]);
    await must(down, "checkout", "-q", "-B", "work", finished.commit);
    expect(readFileSync(join(down, "a.txt"), "utf8")).toBe("UNO\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
    // The branch is gone, and so is the conflict.
    expect(await must(down, "ls-remote", "--heads", f.erga)).not.toContain("upstream-merge/");
    const after = await f.repo.branches();
    expect(after.upstream).toMatchObject({ behind: 0 });
    expect(after.conflict).toBeNull();
  });

  test("a person's way out: the merge made in a checkout and pushed to staging ends the conflict", async () => {
    file(down, "a.txt", "UNO\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
    await commit(down, "Our second edit of a.txt");
    expect((await git(down, "push", "erga", "HEAD:staging")).ok).toBe(true);
    file(up, "a.txt", "uno\ndos\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
    const eighth = await commit(up, "Eighth, upstream, conflicting again");
    await must(up, "tag", "-a", "v0.5.0", "-m", "Release v0.5.0");
    await must(up, "push", "-q", f.upstream, "main", "--tags");
    expect(await f.repo.update(ada)).toMatchObject({ result: "conflicts", conflict: { branch: "upstream-merge/v0.5.0" } });
    // A push to the merge branch is refused, with the way out.
    const pushed = await git(down, "push", "erga", "HEAD:upstream-merge/v0.5.0");
    expect(pushed.ok).toBe(false);
    expect(pushed.err).toContain("merge in your checkout and push the result to staging");
    // In the checkout: merge upstream's commit (the tracking branch has it), resolve, push staging.
    await must(down, "fetch", "-q", "erga", "erga-upstream/main");
    expect(await must(down, "rev-parse", "FETCH_HEAD")).toBe(eighth);
    const merge = await git(down, "merge", "--no-edit", "FETCH_HEAD");
    expect(merge.ok).toBe(false);
    file(down, "a.txt", "UNO\nDOS\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
    await must(down, "add", "a.txt");
    await must(down, "commit", "-qm", "Merge erga.dev v0.5.0");
    expect((await git(down, "push", "erga", "HEAD:staging")).ok).toBe(true);
    await f.settle();
    const view = await f.repo.branches();
    expect(view.upstream).toMatchObject({ behind: 0 });
    expect(view.conflict).toBeNull();
    expect(await must(down, "ls-remote", "--heads", f.erga)).not.toContain("upstream-merge/");
    // Abandon, when asked: the branch goes, staging stays.
    file(up, "a.txt", "uno\ndos\ntres\nfour\nfive\nsix\nseven\neight\nnine\n");
    await commit(up, "Ninth, upstream");
    await must(up, "tag", "-a", "v0.6.0", "-m", "Release v0.6.0");
    await must(up, "push", "-q", f.upstream, "main", "--tags");
    expect(await f.repo.update(ada)).toMatchObject({ result: "conflicts" });
    const staging = (await f.repo.branches()).branches.find((b) => b.name == "staging")!.commit;
    await f.repo.abandonUpdate();
    expect(await f.repo.branches()).toMatchObject({ upstream: { behind: 1 }, conflict: null });
    expect((await f.repo.branches()).branches.find((b) => b.name == "staging")!.commit).toBe(staging);
    expect(await must(down, "ls-remote", "--heads", f.erga)).not.toContain("upstream-merge/");
  });

  test("seeding a fork: main and staging at a commit, the whole history, nothing unpacked here", async () => {
    const fork = f.remoteOf("fork-1");
    const view = await f.repo.branches();
    const main = view.branches.find((b) => b.name == "main")!.commit!;
    await f.repo.seedFork(fork, main);
    const refs = await must(down, "ls-remote", "--heads", fork.cli);
    expect(refs).toContain(`${main}\trefs/heads/main`);
    expect(refs).toContain(`${main}\trefs/heads/staging`);
    const c = scratch();
    await must(c, "clone", "-q", fork.cli, "copy");
    expect(await must(join(c, "copy"), "log", "--format=%s", "-3")).toBe("Third\nSecond\nFirst");
    // A commit that isn't a branch's head (an older one) seeds too; a fork with branches isn't seeded twice.
    const second = await must(up, "rev-parse", "main~7");
    await f.repo.seedFork(f.remoteOf("fork-2"), second);
    expect(await must(down, "ls-remote", "--heads", f.remoteOf("fork-2").cli)).toContain(`${second}\trefs/heads/main`);
    await expect(f.repo.seedFork(fork, main)).rejects.toThrow(/already has branches/);
    expect(await must(down, "ls-remote", "--heads", f.erga)).not.toContain("erga-merge/");
  });
});

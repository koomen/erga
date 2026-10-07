// Erga's own repository without the Worker (source/): Git's formats against
// real git, then pushes, fast-forward rules, merges and the GitHub mirror,
// with the real git CLI against Erga's endpoint in front of pretend
// Artifacts and GitHub (tests/source-fixture.ts).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

// git against a local server: quick, but a machine busy with other tests slows it.
setDefaultTimeout(30_000);
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { hashObject, inflate, parseCommit, parseTree, readPack, tar, text, treeBytes, utf8, writePack } from "../source/git.ts";
import { git, must, startFixture, type Fixture } from "./source-fixture.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "erga-src-"));

/** A repository with a little history: three commits on main. */
async function seedRepo(): Promise<string> {
  const d = scratch();
  await must(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
  writeFileSync(join(d, "bin.dat"), new Uint8Array([0, 1, 2, 3, 255]));
  await must(d, "add", "."); await must(d, "commit", "-qm", "First");
  writeFileSync(join(d, "b.txt"), "bee\n".repeat(200));
  await must(d, "add", "."); await must(d, "commit", "-qm", "Second");
  writeFileSync(join(d, "b.txt"), "bee\n".repeat(199) + "wasp\n");
  await must(d, "add", "."); await must(d, "commit", "-qm", "Third");
  return d;
}

describe("Git's formats", () => {
  test("reads a pack git made (deltas included), and every object hashes as git says", async () => {
    const d = await seedRepo();
    const revs = (await must(d, "rev-list", "--objects", "--all")).split("\n").map((l) => l.split(" ")[0]);
    const r = spawnSync("git", ["pack-objects", "--stdout", "--delta-base-offset"], { cwd: d, input: revs.join("\n") + "\n" });
    const objects = await readPack(new Uint8Array(r.stdout));
    expect([...objects.keys()].sort()).toEqual([...revs].sort());
    for (const [sha, o] of objects) expect(await hashObject(o)).toBe(sha);
    const head = await must(d, "rev-parse", "HEAD");
    const c = parseCommit(objects.get(head)!.data);
    expect(c.message.trim()).toBe("Third");
    expect(c.parents).toEqual([await must(d, "rev-parse", "HEAD~1")]);
    // Only commits, when that's all that's wanted.
    const commits = await readPack(new Uint8Array(r.stdout), (t) => t == "commit");
    expect(commits.size).toBe(3);
  });

  test("reads deltas whose base comes later, named by id and itself a delta (Artifacts sends such packs)", async () => {
    const d = await seedRepo();
    // Each version changes the next 40 of 400 lines, so each is nearest the one before: chains of deltas.
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(i % 50)}`);
    for (let i = 0; i < 6; i++) {
      for (let j = i * 40; j < (i + 1) * 40; j++) lines[j] = `changed ${i} ${j} ${"y".repeat((j * 7) % 60)}`;
      writeFileSync(join(d, "c.txt"), lines.join("\n") + "\n");
      await must(d, "add", "c.txt"); await must(d, "commit", "-qm", `More ${i}`);
    }
    const revs = (await must(d, "rev-list", "--objects", "--all")).split("\n").map((l) => l.split(" ")[0]);
    // No --delta-base-offset: every delta names its base by id (REF_DELTA).
    const pack = new Uint8Array(spawnSync("git", ["pack-objects", "--stdout", "--depth=10"], { cwd: d, input: revs.join("\n") + "\n" }).stdout);
    // Each object's place in the pack, from git itself; then the same objects, in reverse order: every base after its deltas.
    const idx = join(d, "p.idx");
    writeFileSync(join(d, "p.pack"), pack);
    await must(d, "index-pack", "-o", idx, join(d, "p.pack"));
    const rows = (await must(d, "verify-pack", "-v", idx)).split("\n").map((l) => l.split(/\s+/)).filter((c) => /^[0-9a-f]{40}$/.test(c[0]) && c.length >= 5);
    expect(rows.some((c) => Number(c[5]) >= 2)).toBe(true); // some deltas are over a delta
    const parts = rows.map((c) => pack.subarray(Number(c[4]), Number(c[4]) + Number(c[3]))).reverse();
    const reordered = new Uint8Array(12 + parts.reduce((n, p) => n + p.length, 0) + 20);
    reordered.set(pack.subarray(0, 12));
    let at = 12;
    for (const p of parts) { reordered.set(p, at); at += p.length; }
    const objects = await readPack(reordered);
    expect([...objects.keys()].sort()).toEqual([...revs].sort());
    // Keeping commits only, the rest dropped unread.
    const commits = await readPack(reordered, (t) => t == "commit");
    expect(commits.size).toBe(9);
  });

  test("git takes a pack Erga writes", async () => {
    const d = scratch();
    await must(d, "init", "-q", "--bare");
    const blob = { type: "blob" as const, data: utf8("hello\n") };
    const sha = await hashObject(blob);
    const tree = { type: "tree" as const, data: treeBytes([{ mode: "100644", name: "hi.txt", sha }]) };
    const pack = await writePack([blob, tree]);
    const r = spawnSync("git", ["index-pack", "--stdin", "--fix-thin"], { cwd: d, input: pack });
    expect(r.status).toBe(0);
    expect(await must(d, "cat-file", "-p", sha)).toBe("hello");
    expect(parseTree(tree.data)[0].name).toBe("hi.txt");
    expect(await must(d, "cat-file", "-p", await hashObject(tree))).toContain("hi.txt");
  });

  test("inflate finds where a stream ends, over stored and compressed blocks", async () => {
    for (const data of [utf8(""), utf8("x".repeat(70000)), crypto.getRandomValues(new Uint8Array(5000))]) {
      const z = new Uint8Array(zlib.deflateSync(data, { level: data.length > 6000 ? 9 : 0 }));
      const padded = new Uint8Array([...z, 9, 9, 9]);
      const { data: out, end } = inflate(padded, 0, data.length);
      expect(out).toEqual(data);
      expect(end).toBe(z.length);
    }
  });

  test("tar", () => {
    const t = tar([{ path: "a/b.txt", mode: "100644", data: utf8("hi") }]);
    expect(t.length % 512).toBe(0);
    expect(text(t.subarray(0, 7))).toBe("a/b.txt");
  });

});

describe("Erga's Git endpoint", () => {
  let f: Fixture, src: string;
  beforeAll(async () => { f = startFixture(); src = await seedRepo(); });
  afterAll(() => f.stop());

  test("a push seeds main and staging; a clone gets them back", async () => {
    await must(src, "remote", "add", "erga", f.erga);
    const pushed = await git(src, "push", "erga", "main:main", "main:staging");
    expect(pushed.ok).toBe(true);
    expect(pushed.err).toContain("Erga: main is now");
    const c = scratch();
    await must(c, "clone", "-q", f.erga, "copy");
    expect(await must(join(c, "copy"), "log", "--format=%s")).toBe("Third\nSecond\nFirst");
    expect(await must(join(c, "copy"), "ls-remote", "origin")).not.toContain("erga-incoming");
    expect(f.moves.map((m) => m.branch).sort()).toEqual(["main", "staging"]);
    await f.settle();
    // The mirror has both.
    expect(await must(src, "ls-remote", f.github)).toContain("refs/heads/staging");
    expect(f.repo.mirrorStatus().error).toBeNull();
  });

  test("main only follows staging; staging always keeps what main has", async () => {
    const ada = { login: "ada", name: "Ada" };
    writeFileSync(join(src, "c.txt"), "c\n");
    await must(src, "add", "."); await must(src, "commit", "-qm", "Fourth");
    // Straight to main, before staging has it: refused.
    const early = await git(src, "push", "erga", "main");
    expect(early.ok).toBe(false);
    expect(early.err).toContain("main only follows staging");
    // To staging, then main: both land. Both at once lands too.
    expect((await git(src, "push", "erga", "HEAD:staging")).ok).toBe(true);
    expect((await git(src, "push", "erga", "HEAD:main")).ok).toBe(true);
    writeFileSync(join(src, "d.txt"), "d\n");
    await must(src, "add", "."); await must(src, "commit", "-qm", "Fifth");
    expect((await git(src, "push", "erga", "HEAD:staging", "HEAD:main")).ok).toBe(true);
    // A rewrite of staging that drops main's commits: refused, even forced.
    await must(src, "reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(src, "x.txt"), "x\n");
    await must(src, "add", "."); await must(src, "commit", "-qm", "Rewritten");
    const dropped = await git(src, "push", "--force", "erga", "HEAD:staging");
    expect(dropped.ok).toBe(false);
    expect(dropped.err).toContain("staging is always at or ahead of main");
    // Main backwards: refused.
    expect((await git(src, "push", "--force", "erga", "HEAD~1:main")).err).toContain("only moves forward");
    // A rewrite of what's only on staging is fine.
    await must(src, "fetch", "-q", "erga");
    await must(src, "reset", "-q", "--hard", "erga/main");
    for (const n of ["Sixth", "Seventh", "Eighth"]) { writeFileSync(join(src, n), n); await must(src, "add", "."); await must(src, "commit", "-qm", n); }
    expect((await git(src, "push", "erga", "HEAD:staging")).ok).toBe(true);
    await must(src, "commit", "-q", "--amend", "-m", "Eighth, amended");
    expect((await git(src, "push", "--force", "erga", "HEAD:staging")).ok).toBe(true);
    // Other branches, and deleting, are refused.
    expect((await git(src, "push", "erga", "HEAD:feature")).err).toContain("two branches");
    expect((await git(src, "push", "erga", ":staging")).ok).toBe(false);
    // Merge: main moves to a chosen staging commit, then to staging's head; never anywhere else.
    const sixth = await must(src, "rev-parse", "HEAD~2");
    let r = await f.repo.merge({ ...ada, via: "their admin agent" }, sixth);
    // The move is the person's, with how they did it (#69, attribution.ts).
    expect(f.moves.at(-1)).toMatchObject({ branch: "main", by: "ada", via: "their admin agent" });
    expect(r).toEqual({ commit: sixth, fastForward: true, upToDate: false });
    await expect(f.repo.merge(ada, "0".repeat(39) + "1")).rejects.toThrow(/isn't one of staging's commits/);
    r = await f.repo.merge(ada);
    expect(r.commit).toBe(await must(src, "rev-parse", "HEAD"));
    // What that move brought main, newest first (the change log's production deploy): at most `limit`, of how many.
    const moved = f.moves.at(-1)!;
    expect([moved.branch, moved.old, moved.new]).toEqual(["main", sixth, r.commit]);
    const seventh = await must(src, "rev-parse", "HEAD~1");
    expect(f.repo.newCommits(moved.old, moved.new)).toEqual({ commits: [{ sha: r.commit, subject: "Eighth, amended" }, { sha: seventh, subject: "Seventh" }], total: 2 });
    expect(f.repo.newCommits(moved.old, moved.new, 1)).toEqual({ commits: [{ sha: r.commit, subject: "Eighth, amended" }], total: 2 });
    expect(f.repo.newCommits("0".repeat(40), moved.new, 3).total).toBeGreaterThan(3);
    expect((await f.repo.merge(ada)).upToDate).toBe(true);
    const c = scratch();
    await must(c, "clone", "-q", f.erga, "copy");
    expect(await must(join(c, "copy"), "rev-parse", "origin/main")).toBe(await must(join(c, "copy"), "rev-parse", "origin/staging"));
    expect(await must(join(c, "copy"), "log", "-1", "--format=%s", "origin/main")).toBe("Eighth, amended");
  });

  test("the mirror catches up, and a diverged GitHub main stops it without blocking pushes", async () => {
    await f.settle();
    const c = scratch();
    await must(c, "clone", "-q", f.erga, "copy");
    const w = join(c, "copy");
    expect((await must(w, "ls-remote", f.github, "main")).split("\t")[0]).toBe(await must(w, "rev-parse", "origin/main"));
    expect(f.repo.mirrorStatus().lastPushAt).toBeGreaterThan(0);
    // Someone pushes to GitHub's main directly.
    await must(w, "checkout", "-q", "-B", "gh", "origin/main");
    writeFileSync(join(w, "gh.txt"), "only on GitHub\n");
    await must(w, "add", "."); await must(w, "commit", "-qm", "GitHub only");
    await must(w, "push", "-q", f.github, "gh:main");
    // A push to Erga's main still lands; the mirror says what's wrong.
    await must(w, "checkout", "-q", "-B", "main", "origin/main");
    writeFileSync(join(w, "e.txt"), "e\n");
    await must(w, "add", "."); await must(w, "commit", "-qm", "Ninth");
    expect((await git(w, "push", "origin", "HEAD:staging", "HEAD:main")).ok).toBe(true);
    await f.settle();
    expect(f.repo.mirrorStatus().error).toContain("GitHub's main has commits Erga doesn't");
    // Staging still mirrors.
    expect((await must(w, "ls-remote", f.github, "staging")).split("\t")[0]).toBe((await must(w, "ls-remote", "origin", "staging")).split("\t")[0]);
  });

  test("the Source page's view: the latest commits, and which main has", async () => {
    const view = await f.repo.branches();
    const [staging, main] = view.branches;
    expect(main.commits[0].subject).toBe("Ninth");
    expect(staging.commits[0].sha).toBe(main.commit!);
    expect(main.commits.every((x) => x.inMain)).toBe(true);
    expect(staging.commits.length).toBeGreaterThan(3);
    expect(view.moves.length).toBeGreaterThan(0);
    const files = await f.repo.files(main.commit!);
    expect(files.map((x) => x.path)).toContain("e.txt");
  });

  test("a factory VM's token: its own task branch (made, moved, deleted), staging only for a merge, never main; task branches stay out of sight", async () => {
    const moves = f.moves.length;
    const task = f.factory({ scope: "task", branch: "task/7-the-factory" });
    const c = scratch();
    await must(c, "clone", "-q", task, "vm");
    const vm = join(c, "vm");
    await must(vm, "checkout", "-q", "-b", "task/7-the-factory", "origin/staging");
    writeFileSync(join(vm, "task.txt"), "made by the factory\n");
    await must(vm, "add", "."); await must(vm, "commit", "-qm", "Factory work");
    // Its branch: made, then moved.
    const made = await git(vm, "push", "origin", "HEAD:refs/heads/task/7-the-factory");
    expect(made.ok).toBe(true);
    expect(made.err).toContain("Erga: task/7-the-factory is now");
    writeFileSync(join(vm, "task.txt"), "more\n");
    await must(vm, "commit", "-qam", "More factory work");
    expect((await git(vm, "push", "origin", "HEAD:refs/heads/task/7-the-factory")).ok).toBe(true);
    // Nothing else: not staging, not main, not another task's branch.
    expect((await git(vm, "push", "origin", "HEAD:staging")).err).toContain("may push task/7-the-factory only");
    expect((await git(vm, "push", "origin", "HEAD:main")).ok).toBe(false);
    expect((await git(vm, "push", "origin", "HEAD:refs/heads/task/8-other")).err).toContain("not refs/heads/task/8-other");
    // An admin's view doesn't show it; the Source page lists staging and main only; no moves, no deploys.
    expect(await must(src, "ls-remote", "erga")).toContain("refs/heads/task/7-the-factory"); // an admin's clone sees every branch Artifacts has
    // Another task's branch: out of this VM's sight (listed or fetched by name), as its own token reads staging, main and its own only.
    const other = f.factory({ scope: "task", branch: "task/8-another" });
    await must(vm, "push", other, "HEAD:refs/heads/task/8-another");
    expect(await must(src, "ls-remote", "erga")).toContain("refs/heads/task/8-another");
    const seen = await must(vm, "ls-remote", task);
    expect(seen).toContain("refs/heads/staging");
    expect(seen).toContain("refs/heads/task/7-the-factory");
    expect(seen).not.toContain("task/8-another");
    expect((await git(vm, "fetch", task, "refs/heads/task/8-another")).ok).toBe(false);
    expect((await git(vm, "-c", "protocol.version=0", "ls-remote", task)).out).not.toContain("task/8-another");
    expect((await git(vm, "push", other, "--delete", "task/8-another")).ok).toBe(true);
    expect((await f.repo.branches()).branches.map((b) => b.name)).toEqual(["staging", "main"]);
    expect(f.moves.length).toBe(moves);
    // A bad or other secret's token: refused.
    expect((await git(vm, "push", task.replace(/fgt\.[^.]+\.[0-9a-f]{4}/, (m) => m.slice(0, -4) + "0000"), "HEAD:refs/heads/task/7-the-factory")).ok).toBe(false);
    // The merge: a merge token moves staging, once, to the merge itself (as factory/vm/merge.ts makes it), recorded
    // as the admin's push; never deletes it, never main, never another commit.
    const merge = f.factory({ scope: "merge", branch: "task/7-the-factory", by: "ada", id: "merge-1" });
    await must(vm, "fetch", "-q", "origin");
    const base = await must(vm, "rev-parse", "origin/staging"), head = await must(vm, "rev-parse", "origin/task/7-the-factory");
    const shaped = (tree: string, ...parents: string[]) => must(vm, "commit-tree", tree, ...parents.flatMap((x) => ["-p", x]), "-m", "Merge task/7-the-factory: the factory");
    // Not the merge: other files (a change no one saw), staging alone on top, the parents the other way, an older token.
    writeFileSync(join(vm, "sneaky.txt"), "not in the branch\n");
    await must(vm, "add", "sneaky.txt");
    const otherTree = await must(vm, "write-tree");
    await must(vm, "reset", "-q", "--hard");
    const sneaky = await git(vm, "push", merge, `${await shaped(otherTree, base, head)}:refs/heads/staging`);
    expect(sneaky.ok).toBe(false);
    expect(sneaky.err).toContain("must have the files of task/7-the-factory");
    expect((await git(vm, "push", merge, `${await shaped(`${head}^{tree}`, base)}:refs/heads/staging`)).err).toContain("two parents");
    expect((await git(vm, "push", merge, `${await shaped(`${head}^{tree}`, head, base)}:refs/heads/staging`)).err).toContain("two parents");
    expect((await git(vm, "push", merge, `${head}:refs/heads/staging`)).ok).toBe(false);
    const old = f.factory({ scope: "merge", branch: "task/7-the-factory", by: "ada" });
    expect((await git(vm, "push", old, `${await shaped(`${head}^{tree}`, base, head)}:refs/heads/staging`)).err).toContain("older one");
    expect(await must(src, "ls-remote", "erga", "staging")).toContain(base);
    // The merge itself.
    const merged = await shaped(`${head}^{tree}`, base, head);
    expect((await git(vm, "push", merge, `${merged}:refs/heads/staging`)).ok).toBe(true);
    expect(f.moves.at(-1)).toMatchObject({ branch: "staging", how: "push", by: "ada", new: merged });
    // Once: the same token can't move staging again, even to a new merge of the branch.
    await must(vm, "checkout", "-q", "-B", "task/7-the-factory", merged);
    writeFileSync(join(vm, "task.txt"), "after the merge\n");
    await must(vm, "commit", "-qam", "After the merge");
    expect((await git(vm, "push", task, "HEAD:refs/heads/task/7-the-factory")).ok).toBe(true);
    const again = await git(vm, "push", merge, `${await shaped("HEAD^{tree}", merged, "HEAD")}:refs/heads/staging`);
    expect(again.err).toContain("moved staging already");
    // What factory/vm/merge.ts tells apart: a refusal (back to ready to merge) from staging having moved (it tries again).
    const stale = /fetch first|non-fast-forward|stale info/;
    expect(again.err).not.toMatch(stale);
    expect(sneaky.err).not.toMatch(stale);
    const fresh = f.factory({ scope: "merge", branch: "task/7-the-factory", by: "ada", id: "merge-2" });
    expect((await git(vm, "push", fresh, `${await must(vm, "commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "A merge made before staging moved")}:refs/heads/staging`)).err).toMatch(stale);
    expect((await git(vm, "push", merge, ":refs/heads/staging")).ok).toBe(false);
    expect((await git(vm, "push", merge, "HEAD:main")).ok).toBe(false);
    // Then the task's branch is deleted, and gone.
    const del = await git(vm, "push", task, "--delete", "task/7-the-factory");
    expect(del.ok).toBe(true);
    expect(await must(src, "ls-remote", "erga")).not.toContain("task/7-the-factory");
    expect(f.moves.filter((m) => m.branch != "staging" && m.branch != "main")).toEqual([]);
    // The tests after this one carry on from staging as the merge left it.
    await must(src, "fetch", "-q", "erga");
    await must(src, "reset", "-q", "--hard", "erga/staging");
  });
});

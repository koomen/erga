// Erga's own repository without the Worker (source/): Git's formats against
// real git, then pushes, fast-forward rules, merges and the GitHub mirror,
// with the real git CLI against Erga's endpoint in front of pretend
// Artifacts and GitHub (tests/source-fixture.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { hashObject, inflate, parseCommit, parseTree, readPack, tar, text, treeBytes, utf8, writePack } from "../source/git.ts";
import { mergeText } from "../source/merge.ts";
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

  test("three-way text merge: separate changes merge, the same lines conflict", () => {
    const base = utf8("1\n2\n3\n4\n5\n6\n7\n");
    expect(text(mergeText(base, utf8("one\n2\n3\n4\n5\n6\n7\n"), utf8("1\n2\n3\n4\n5\n6\nseven\n"))!)).toBe("one\n2\n3\n4\n5\n6\nseven\n");
    expect(mergeText(base, utf8("1\nTWO\n3\n4\n5\n6\n7\n"), utf8("1\ntwo\n3\n4\n5\n6\n7\n"))).toBeNull();
    expect(text(mergeText(base, utf8("1\nX\n3\n4\n5\n6\n7\n"), utf8("1\nX\n3\n4\n5\n6\n7\n"))!)).toBe("1\nX\n3\n4\n5\n6\n7\n");
    expect(mergeText(base, utf8("\0"), utf8("1\n"))).toBeNull();
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

  test("main takes fast-forward pushes, and refuses the rest; staging takes either", async () => {
    writeFileSync(join(src, "c.txt"), "c\n");
    await must(src, "add", "."); await must(src, "commit", "-qm", "Fourth");
    expect((await git(src, "push", "erga", "main")).ok).toBe(true);
    await must(src, "reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(src, "d.txt"), "d\n");
    await must(src, "add", "."); await must(src, "commit", "-qm", "Rewritten");
    const forced = await git(src, "push", "--force", "erga", "main");
    expect(forced.ok).toBe(false);
    expect(forced.err).toContain("non-fast-forward");
    expect((await git(src, "push", "--force", "erga", "HEAD:staging")).ok).toBe(true);
    // Other branches, and deleting, are refused.
    expect((await git(src, "push", "erga", "HEAD:feature")).err).toContain("two branches");
    expect((await git(src, "push", "erga", ":staging")).ok).toBe(false);
    // A pull brings what's there.
    const c = scratch();
    await must(c, "clone", "-q", f.erga, "copy");
    expect(await must(join(c, "copy"), "log", "-1", "--format=%s", "origin/staging")).toBe("Rewritten");
    expect(await must(join(c, "copy"), "log", "-1", "--format=%s", "origin/main")).toBe("Fourth");
  });

  test("merging staging into main: a merge commit when both moved, and a conflict refused", async () => {
    // staging has "Rewritten" (d.txt), main has "Fourth" (c.txt): they meet at Third.
    const r = await f.repo.merge("staging", "main", { login: "ada", name: "Ada" });
    expect(r.fastForward).toBe(false);
    const c = scratch();
    await must(c, "clone", "-q", f.erga, "copy");
    const w = join(c, "copy");
    expect(await must(w, "log", "-1", "--format=%s %p")).toContain("Merge staging into main");
    expect((await must(w, "ls-files")).split("\n").sort()).toEqual(["a.txt", "b.txt", "bin.dat", "c.txt", "d.txt"]);
    await must(w, "fsck", "--strict");
    // Merging again: nothing to do.
    expect((await f.repo.merge("staging", "main", { login: "ada", name: "Ada" })).upToDate).toBe(true);
    // The same line, changed both ways: refused, naming the file.
    await must(w, "checkout", "-q", "-B", "staging", "origin/main");
    writeFileSync(join(w, "a.txt"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    await must(w, "commit", "-qam", "Staging edit");
    await must(w, "push", "-q", "origin", "staging");
    await must(w, "checkout", "-q", "-B", "main", "origin/main");
    writeFileSync(join(w, "a.txt"), "uno\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    await must(w, "commit", "-qam", "Main edit");
    await must(w, "push", "-q", "origin", "main");
    await expect(f.repo.merge("staging", "main", { login: "ada", name: "Ada" })).rejects.toThrow(/a\.txt/);
    // Different lines of the same file merge cleanly.
    writeFileSync(join(w, "a.txt"), "uno\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\n");
    await must(w, "commit", "-qam", "Main edit, bottom");
    await must(w, "checkout", "-q", "-B", "staging", "origin/main");
    writeFileSync(join(w, "a.txt"), "uno\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight\n");
    await must(w, "commit", "-qam", "Staging edit, middle");
    await must(w, "push", "-q", "--force", "origin", "staging");
    await must(w, "checkout", "-q", "main");
    await must(w, "push", "-q", "origin", "main");
    const m = await f.repo.merge("staging", "main", { login: "ada", name: "Ada" });
    await must(w, "fetch", "-q", "origin");
    expect(await must(w, "show", `${m.commit}:a.txt`)).toBe("uno\ntwo\nthree\nFOUR\nfive\nsix\nseven\nEIGHT");
    // A fast-forward: main into staging.
    expect((await f.repo.merge("main", "staging", { login: "ada", name: "Ada" })).fastForward).toBe(true);
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
    await must(w, "add", "."); await must(w, "commit", "-qm", "Fifth");
    expect((await git(w, "push", "origin", "main")).ok).toBe(true);
    await f.settle();
    expect(f.repo.mirrorStatus().error).toContain("GitHub's main has commits Erga doesn't");
    // Staging still mirrors.
    expect((await must(w, "ls-remote", f.github, "staging")).split("\t")[0]).toBe((await must(w, "ls-remote", "origin", "staging")).split("\t")[0]);
  });

  test("the Source page's view: the latest commits, and which main has", async () => {
    const view = await f.repo.branches();
    const [staging, main] = view.branches;
    expect(main.commits[0].subject).toBe("Fifth");
    expect(main.commits.every((x) => x.inMain)).toBe(true);
    expect(staging.commits.length).toBeGreaterThan(3);
    expect(view.moves.length).toBeGreaterThan(0);
    const files = await f.repo.files(main.commit!);
    expect(files.map((x) => x.path)).toContain("e.txt");
  });
});

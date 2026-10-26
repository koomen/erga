// The three-way merge (control/source/merge.ts) against real git: the tree
// git's own merge makes, `git merge-file` for the text, and a pack git takes.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  hashObject,
  parseTree,
  readPack,
  text,
  treeBytes,
  utf8,
  writePack,
  type GitObject,
  type TreeEntry,
} from "../control/source/git.ts";
import { isBinary, mergeText, mergeTrees, type ObjectReader } from "../control/source/merge.ts";

const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" };
const scratch = () => mkdtempSync(join(tmpdir(), "erga-merge-"));
function git(cwd: string, args: string[], input?: Uint8Array | string): Uint8Array {
  const r = spawnSync("git", args, { cwd, input, env, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return new Uint8Array(r.stdout);
}
const run = (cwd: string, ...args: string[]) => text(git(cwd, args)).trim();

/** Writes (or with null, deletes) files and commits them. */
function commit(d: string, files: Record<string, string | Uint8Array | null>, message: string) {
  for (const [path, data] of Object.entries(files)) {
    if (data === null) rmSync(join(d, path), { recursive: true });
    else { mkdirSync(dirname(join(d, path)), { recursive: true }); writeFileSync(join(d, path), data); }
  }
  run(d, "add", "-A"); run(d, "commit", "-qm", message);
}

/** Every object of the repository, as the repo code gets them: a pack git writes, read by git.ts. */
async function reader(d: string): Promise<ObjectReader & { all: Map<string, GitObject> }> {
  const revs = run(d, "rev-list", "--objects", "--all").split("\n").map((l) => l.split(" ")[0]);
  const all = await readPack(git(d, ["pack-objects", "--stdout"], revs.join("\n") + "\n"));
  return { all, get: (sha) => all.get(sha) };
}
const treeOf = (d: string, rev: string) => run(d, "rev-parse", `${rev}^{tree}`);
const labels = { ours: "ours", theirs: "theirs", base: "base" };
const entryMap = (o: GitObject | undefined) => new Map(parseTree(o!.data).map((e) => [e.name, e]));

/** `git merge-file -p`: its output and how many conflicts it saw (its exit status). */
function gitMergeFile(base: string, ours: string, theirs: string): { text: string; conflicts: number } {
  const d = scratch();
  for (const [name, data] of [["base", base], ["ours", ours], ["theirs", theirs]]) writeFileSync(join(d, name), data);
  const r = spawnSync("git", ["merge-file", "-p", "-L", "ours", "-L", "base", "-L", "theirs", "ours", "base", "theirs"], { cwd: d, env });
  if (r.status === null || r.status < 0 || r.status == 255) throw new Error(`git merge-file: ${r.stderr}`);
  return { text: r.stdout.toString(), conflicts: r.status };
}
/** The lines of each marker block's two sides, sorted: what a conflict says, whatever its exact boundaries. */
function blockLines(s: string): { ours: string[]; theirs: string[] } {
  const ours: string[] = [], theirs: string[] = [];
  for (const m of s.matchAll(/<<<<<<< ours\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> theirs\n/g)) {
    ours.push(...m[1].split("\n").filter(Boolean)); theirs.push(...m[2].split("\n").filter(Boolean));
  }
  return { ours: ours.sort(), theirs: theirs.sort() };
}

describe("mergeTrees", () => {
  test("a clean merge makes the tree git makes, of objects git takes", async () => {
    const d = scratch();
    run(d, "init", "-q", "-b", "main");
    const readme = (edit: Record<number, string> = {}) => Array.from({ length: 10 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
    commit(d, { "README.md": readme(), "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n", "old.txt": "old\n", "data.bin": new Uint8Array([0, 1, 2, 3]) }, "Base");
    run(d, "checkout", "-qb", "ours");
    commit(d, { "README.md": readme({ 2: "line 2 (ours)" }), "src/a.ts": "export const a = 10;\n", "new-ours.txt": "ours\n", "old.txt": null, "nested/deep/x.txt": "x\n", "same.txt": "both add this\n" }, "Ours");
    run(d, "checkout", "-qb", "theirs", "main");
    commit(d, { "README.md": readme({ 9: "line 9 (theirs)" }), "src/b.ts": "export const b = 20;\n", "new-theirs.txt": "theirs\n", "lib/util/y.txt": "y\n", "data.bin": new Uint8Array([0, 9, 9]), "same.txt": "both add this\n" }, "Theirs");
    // Theirs alone makes the README executable: the merged file keeps that mode.
    chmodSync(join(d, "README.md"), 0o755);
    run(d, "update-index", "--chmod=+x", "README.md"); run(d, "commit", "-qm", "Theirs: mode");
    const r = await reader(d);
    const [base, ours, theirs] = [treeOf(d, "main"), treeOf(d, "ours"), treeOf(d, "theirs")];
    const m = await mergeTrees(r, base, ours, theirs, labels);
    expect(m.conflicts).toEqual([]);
    run(d, "checkout", "-q", "ours"); run(d, "merge", "--no-ff", "-q", "-m", "Merge", "theirs");
    expect(m.tree).toBe(treeOf(d, "HEAD"));
    // The merged README is new (both sides edited it) and so are the trees above it; each is a valid object.
    const shas = await Promise.all(m.objects.map(hashObject));
    expect(shas).toContain(m.tree);
    expect(shas).toContain(run(d, "rev-parse", "HEAD:README.md"));
    expect(entryMap(r.all.get(m.tree) ?? m.objects[shas.indexOf(m.tree)]).get("README.md")!.mode).toBe("100755");
    expect(m.objects.every((o) => !r.all.has(shas[m.objects.indexOf(o)]))).toBe(true);
    // git takes them as a pack.
    const bare = scratch();
    run(bare, "init", "-q", "--bare");
    git(bare, ["index-pack", "--stdin", "--fix-thin"], await writePack(m.objects));
    for (const [i, o] of m.objects.entries()) expect(run(bare, "cat-file", "-t", shas[i])).toBe(o.type);
  });

  test("conflicts: each kind named at its path, markers in the text, the rest merged", async () => {
    const d = scratch();
    run(d, "init", "-q", "-b", "main");
    const five = (third: string) => `one\ntwo\n${third}\nfour\nfive\n`;
    commit(d, { "conflict.txt": five("three"), "md.txt": "md\n", "dm.txt": "dm\n", "pic.bin": new Uint8Array([0, 1]), "clean.txt": "clean\n", "other.txt": "other\n", fd: "a file\n" }, "Base");
    run(d, "checkout", "-qb", "ours");
    commit(d, { "conflict.txt": five("three (ours)"), "md.txt": "md ours\n", "dm.txt": null, "pic.bin": new Uint8Array([0, 2]), "clean.txt": "clean ours\n", fd: null, "fd/inner.txt": "inner\n", "new.txt": "ours version\n" }, "Ours");
    run(d, "checkout", "-qb", "theirs", "main");
    commit(d, { "conflict.txt": five("three (theirs)"), "md.txt": null, "dm.txt": "dm theirs\n", "pic.bin": new Uint8Array([0, 3]), "other.txt": "other theirs\n", fd: "a file, edited\n", "new.txt": "theirs version\n" }, "Theirs");
    const r = await reader(d);
    const m = await mergeTrees(r, treeOf(d, "main"), treeOf(d, "ours"), treeOf(d, "theirs"), labels);
    expect(m.conflicts).toEqual([
      { path: "conflict.txt", kind: "content" }, { path: "dm.txt", kind: "delete-modify" }, { path: "fd", kind: "file-directory" },
      { path: "md.txt", kind: "modify-delete" }, { path: "new.txt", kind: "add-add" }, { path: "pic.bin", kind: "binary" },
    ]);
    const made = new Map(await Promise.all(m.objects.map(async (o) => [await hashObject(o), o] as const)));
    const root = entryMap(made.get(m.tree));
    const side = (rev: string, path: string) => run(d, "rev-parse", `${rev}:${path}`);
    // The conflicted text is what git merge-file writes, labels and both sides included.
    const conflicted = text(made.get(root.get("conflict.txt")!.sha)!.data);
    expect(conflicted).toBe(gitMergeFile(five("three"), five("three (ours)"), five("three (theirs)")).text);
    expect(conflicted).toBe("one\ntwo\n<<<<<<< ours\nthree (ours)\n=======\nthree (theirs)\n>>>>>>> theirs\nfour\nfive\n");
    expect(text(made.get(root.get("new.txt")!.sha)!.data)).toBe("<<<<<<< ours\nours version\n=======\ntheirs version\n>>>>>>> theirs\n");
    // One side's change, the modified side of a modify/delete, ours for a binary, ours's folder over theirs's file.
    expect(root.get("clean.txt")!.sha).toBe(side("ours", "clean.txt"));
    expect(root.get("other.txt")!.sha).toBe(side("theirs", "other.txt"));
    expect(root.get("md.txt")!.sha).toBe(side("ours", "md.txt"));
    expect(root.get("dm.txt")!.sha).toBe(side("theirs", "dm.txt"));
    expect(root.get("pic.bin")!.sha).toBe(side("ours", "pic.bin"));
    expect(root.get("fd")).toMatchObject({ mode: "40000", sha: side("ours", "fd") });
    expect([...root.keys()].sort()).toEqual(["clean.txt", "conflict.txt", "dm.txt", "fd", "md.txt", "new.txt", "other.txt", "pic.bin"]);
  });

  test("no common ancestor: both sides' files meet as add/add", async () => {
    const all = new Map<string, GitObject>();
    const put = async (o: GitObject) => { const sha = await hashObject(o); all.set(sha, o); return sha; };
    const blob = (s: string) => put({ type: "blob", data: utf8(s) });
    const tree = (entries: TreeEntry[]) => put({ type: "tree", data: treeBytes(entries) });
    const file = async (name: string, s: string): Promise<TreeEntry> => ({ mode: "100644", name, sha: await blob(s) });
    const ours = await tree([await file("same.txt", "same\n"), await file("diff.txt", "ours\n"), await file("only-ours.txt", "o\n"),
      { mode: "40000", name: "dir", sha: await tree([await file("a.txt", "a\n"), await file("b.txt", "b ours\n")]) }]);
    const theirs = await tree([await file("same.txt", "same\n"), await file("diff.txt", "theirs\n"), await file("only-theirs.txt", "t\n"),
      { mode: "40000", name: "dir", sha: await tree([await file("a.txt", "a\n"), await file("b.txt", "b theirs\n")]) }]);
    const m = await mergeTrees({ get: (sha) => all.get(sha) }, null, ours, theirs, labels);
    expect(m.conflicts).toEqual([{ path: "diff.txt", kind: "add-add" }, { path: "dir/b.txt", kind: "add-add" }]);
    const made = new Map(await Promise.all(m.objects.map(async (o) => [await hashObject(o), o] as const)));
    // Two blobs with markers, the folder and the root: nothing else is new.
    expect(m.objects.length).toBe(4);
    const root = entryMap(made.get(m.tree));
    expect([...root.keys()].sort()).toEqual(["diff.txt", "dir", "only-ours.txt", "only-theirs.txt", "same.txt"]);
    expect(text(made.get(root.get("diff.txt")!.sha)!.data)).toBe("<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n");
    const dir = entryMap(made.get(root.get("dir")!.sha));
    expect(all.has(dir.get("a.txt")!.sha)).toBe(true);
    expect(text(made.get(dir.get("b.txt")!.sha)!.data)).toContain("=======\nb theirs\n");
  });
});

describe("mergeText", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join("");
  const edited = (s: string, line: number, to: string) => s.split(/(?<=\n)/).map((l, i) => (i == line - 1 ? to : l)).join("");
  const cases: Record<string, [string, string, string]> = {
    "identical sides": [ten, edited(ten, 2, "two\n"), edited(ten, 2, "two\n")],
    "ours unchanged": [ten, ten, edited(ten, 5, "five\n")],
    "theirs unchanged": [ten, edited(ten, 5, "five\n"), ten],
    "a change at the start and one at the end": [ten, edited(ten, 1, "first\n"), edited(ten, 10, "last\n")],
    "neighbouring lines changed": [ten, edited(ten, 4, "four\n"), edited(ten, 6, "six\n")],
    "a conflict": [ten, edited(ten, 2, "two (ours)\n"), edited(ten, 2, "two (theirs)\n")],
    "theirs deletes lines ours edits": [ten, edited(ten, 3, "three (ours)\n"), ten.split(/(?<=\n)/).filter((_, i) => i < 1 || i > 3).join("")],
    "ours deletes lines theirs leaves": [ten, ten.split(/(?<=\n)/).filter((_, i) => i < 2 || i > 5).join(""), edited(ten, 9, "nine\n")],
    "both add different lines at the end": [ten, `${ten}ours\n`, `${ten}theirs\n`],
    "the same line added by both": [ten, `${ten}same\n`, `${ten}same\n`],
    "both add the same lines at the end, theirs one more": [ten, `${ten}same\n`, `${ten}same\nmore\n`],
    "no final newline anywhere": ["a\nb", "a\nb", "a\nb\nc"],
    "ours drops the final newline, theirs adds a line": ["a\nb\n", "a\nb", "a\nb\nc\n"],
    "theirs drops the final newline, ours edits the start": ["a\nb\n", "A\nb\n", "a\nb"],
    "ours adds a final newline": ["a\nb", "a\nb\n", "a\nb"],
    "empty base, both add": ["", "ours\n", "theirs\n"],
    "empty base, both add the same": ["", "same\n", "same\n"],
    "ours empties the file, theirs edits it": [ten, "", edited(ten, 1, "first\n")],
  };
  for (const [name, [base, ours, theirs]] of Object.entries(cases)) {
    test(name, () => {
      const got = mergeText(base, ours, theirs, labels), want = gitMergeFile(base, ours, theirs);
      expect(got.conflicts).toBe(want.conflicts);
      if (!want.conflicts) expect(got.text).toBe(want.text);
      else expect(blockLines(got.text)).toEqual(blockLines(want.text));
    });
  }

  test("isBinary: a NUL in the first 8000 bytes", () => {
    expect(isBinary(utf8("plain text\n"))).toBe(false);
    expect(isBinary(new Uint8Array([65, 0, 66]))).toBe(true);
    expect(isBinary(new Uint8Array(9000).fill(65).fill(0, 8500))).toBe(false);
  });
});

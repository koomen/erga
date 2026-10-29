// Merges into staging made here (from upstream, or from GitHub), and the one
// that waits when files conflict: staging stays as it is, and the merge with
// Git's conflict markers goes on a branch (upstream-merge/<version>,
// github-merge/<commit>) for an admin (or their agent) to resolve: the agent
// writes the files and finishes the merge from here (resolveUpdate,
// finishUpdate); a person merges in a checkout and pushes staging, which ends
// the conflict too. One merge waits at a time, from either side.

import {
  commitBytes,
  emptyPack,
  hashObject,
  isTreeMode,
  parseCommit,
  parseTree,
  readPack,
  text,
  treeBytes,
  utf8,
  writePack,
  ZERO,
  type GitObject,
  type TreeEntry,
} from "./git.ts";
import { fetchPack, lsRefs, receivePack, type RefUpdate, type Remote } from "./remote.ts";
import { cleanPath } from "./browse.ts";
import { isBinary, mergeTrees, type Conflict } from "./merge.ts";
import { isMergeBranch, REF, SCRATCH, SourceError } from "./refs.ts";
import type { Actor, SourceRepo } from "./repo.ts";
import { byLine, SYSTEM } from "../../shared/attribution.ts";
import { TARGETS } from "../../deploy/targets.ts";
import { plural } from "../../shared/time.ts";

/** Git's conflict markers, at a line's start: a file that still has one isn't resolved. */
const MARKER = /^(<{7}|={7}|>{7})(?: |$)/m;
/** A merge into staging that stopped on conflicts (from upstream, or from GitHub): the branch that holds it with Git's markers, what it merges, and the files. */
export interface MergeConflict {
  kind: "upstream" | "github";
  /** The branch's short name (upstream-merge/v0.15.0, github-merge/<commit>), and what it brings (the version, or GitHub's commit). */
  branch: string; version: string;
  /** The other side's commit being merged, staging's head it is merged into, and their common ancestor (null: none). */
  target: string; ours: string; base: string | null;
  files: Conflict[];
  at: number; by: string;
}

export class Conflicts {
  constructor(private repo: SourceRepo) {}

  /** The common ancestor of `a` and `b` to merge over: the newest of the best ones (one of several is enough: a criss-cross is rare here). */
  mergeBase(a: string, b: string): string | null {
    const ofA = this.repo.ancestors(a),
      nodes = this.repo.nodes();
    // Walk b's history newest first; the first commits met that are a's ancestors too, and not ancestors of one already found, are the candidates.
    const found: string[] = [], seen = new Set<string>(), frontier = [b];
    while (frontier.length) {
      frontier.sort((x, y) => (nodes.get(x)?.committed ?? 0) - (nodes.get(y)?.committed ?? 0));
      const s = frontier.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      if (ofA.has(s)) { found.push(s); continue; }
      for (const p of nodes.get(s)?.parents ?? []) if (!seen.has(p) && nodes.has(p)) frontier.push(p);
    }
    const best = found.filter((c) => !found.some((d) => d != c && this.repo.isAncestor(c, d)));
    return best.sort((x, y) => (nodes.get(y)?.committed ?? 0) - (nodes.get(x)?.committed ?? 0))[0] ?? null;
  }
  /**
   * A three-way merge of `theirs` into staging (at `ours`), over `base`, made here (control/source/merge.ts). No
   * conflicts: the merge commit moves staging. Conflicts: staging stays, the merge with Git's markers goes on `branch`
   * (an older merge branch goes), and the conflict is kept for the Ops page and the agent. Inside the lock.
   */
  async threeWay(
    remote: Remote,
    o: {
      ours: string;
      theirs: string;
      base: string | null;
      who: Actor;
      labels: { ours: string; theirs: string };
      kind: MergeConflict["kind"];
      version: string;
      branch: string;
      message: string;
    }
  ): Promise<{ result: "merged"; commit: string } | { result: "conflicts"; conflict: MergeConflict }> {
    const { ours, theirs, base } = o;
    // The three trees, read whole (a scratch ref for the base, which isn't a branch's head).
    const scratch = `${SCRATCH}${crypto.randomUUID().slice(0, 8)}`;
    if (base) await receivePack(remote, [{ ref: scratch, old: ZERO, new: base }], await emptyPack());
    let objects: Map<string, GitObject>;
    try {
      objects = await readPack(await fetchPack(remote, { wants: [ours, theirs, ...(base ? [base] : [])], deepen: 1 }));
    } finally {
      if (base) await receivePack(remote, [{ ref: scratch, old: base, new: ZERO }], null).catch(() => {});
    }
    const treeOf = (sha: string) => {
      const x = objects.get(sha);
      if (!x || x.type != "commit") throw new SourceError({ message: `Artifacts didn't send commit ${sha.slice(0, 7)}`, status: 502 });
      return parseCommit(x.data).tree;
    };
    const merged = await mergeTrees({ get: (sha) => objects.get(sha) }, base ? treeOf(base) : null, treeOf(ours), treeOf(theirs), o.labels);
    const files = merged.conflicts;
    const message = files.length
      ? `${o.message}: ${plural(files.length, "file")} conflict\n\n${files.map((f) => `${f.path} (${f.kind})`).join("\n")}\n`
      : `${o.message}\n`;
    const commit = this.commitObject({ tree: merged.tree, parents: [ours, theirs], who: o.who, message });
    const sha = await hashObject(commit);
    const pack = await writePack([...merged.objects, commit]);
    if (!files.length) {
      await this.repo.moveBranch(remote, "staging", ours, sha, pack, o.who, o.kind == "upstream" ? "update" : "github");
      return { result: "merged", commit: sha };
    }
    // Conflicts: the merge on its branch, staging as it was; an older conflict branch goes.
    const { refs } = await lsRefs(remote);
    const old = refs.get(o.branch) ?? ZERO;
    const drop: RefUpdate[] = [...refs].filter(([r]) => isMergeBranch(r) && r != o.branch).map(([ref, s]) => ({ ref, old: s, new: ZERO }));
    const r = await receivePack(remote, [{ ref: o.branch, old, new: sha }, ...drop], pack);
    const said = r.unpack != "ok" ? r.unpack : r.refs.get(o.branch) ?? "no answer";
    if (said != "ok") throw new SourceError({ message: `Artifacts refused the merge branch: ${said}`, status: 502 });
    const conflict: MergeConflict = {
      kind: o.kind,
      branch: o.branch.slice("refs/heads/".length),
      version: o.version,
      target: theirs,
      ours,
      base,
      files,
      at: this.repo.now(),
      by: byLine(o.who.login, o.who.via),
    };
    this.repo.setState("conflict", conflict);
    this.repo.index(sha, parseCommit(commit.data));
    this.repo.deps.changed();
    return { result: "conflicts", conflict };
  }

  /** A commit object by `who`, now. */
  private commitObject(o: { tree: string; parents: string[]; who: Actor; message: string }): GitObject {
    const time = Math.floor(this.repo.now() / 1000);
    const person = { name: o.who.name || o.who.login, email: o.who.login == SYSTEM ? `noreply@${TARGETS.production.host}` : `${o.who.login}@users.noreply.github.com`, time, tz: "+0000" };
    return { type: "commit", data: commitBytes({ tree: o.tree, parents: o.parents, author: person, committer: person, message: o.message }) };
  }

  /** The waiting merge, or null: the one that conflicted (from upstream, or from GitHub). */
  conflict(): MergeConflict | null {
    return this.repo.state<MergeConflict>("conflict");
  }

  /** The conflict branch's head and its files, for resolving: the conflict, the head, and the objects of its tree. */
  private async conflictHead(remote: Remote): Promise<{ conflict: MergeConflict; head: string; objects: Map<string, GitObject> }> {
    const conflict = this.repo.state<MergeConflict>("conflict");
    if (!conflict) throw new SourceError({ message: "No merge is waiting on conflicts.", status: 409 });
    const { refs } = await lsRefs(remote);
    const head = refs.get(`refs/heads/${conflict.branch}`);
    if (!head) {
      this.repo.setState("conflict", null);
      throw new SourceError({
        message: `The branch ${conflict.branch} is gone: ${conflict.kind == "upstream" ? "run Update again" : "Sync now runs the merge again"}.`,
        status: 409,
      });
    }
    const objects = await readPack(await fetchPack(remote, { wants: [head], deepen: 1 }));
    return { conflict, head, objects };
  }

  /** The conflicted files that still carry Git's markers, in the tree `root` of `objects`. */
  private unresolved(conflict: MergeConflict, objects: Map<string, GitObject>, root: string): string[] {
    return conflict.files.filter((f) => { const data = blobAt(objects, root, f.path); return !!data && !isBinary(data) && MARKER.test(text(data)); }).map((f) => f.path);
  }

  /**
   * One file of the waiting merge, as `who` (an admin's agent) resolved it: the branch gets a commit with it (`content`
   * null deletes the file). Returns the files that still carry conflict markers.
   */
  async resolveUpdate(who: Actor, path: string, content: string | null): Promise<{ branch: string; path: string; remaining: string[] }> {
    const clean = cleanPath(path);
    if (!clean) throw new SourceError({ message: "Which file? Give its path, as the conflict lists it." });
    return this.repo.locked(async () => {
      const remote = await this.repo.deps.artifacts();
      const { conflict, head, objects } = await this.conflictHead(remote);
      const headCommit = parseCommit(objects.get(head)!.data);
      const blob: GitObject | null = content == null ? null : { type: "blob", data: utf8(content) };
      const edit = await editTree(objects, headCommit.tree, clean, blob);
      if (edit.tree == headCommit.tree) return { branch: conflict.branch, path: clean, remaining: this.unresolved(conflict, objects, headCommit.tree) };
      const commit = this.commitObject({ tree: edit.tree, parents: [head], who, message: `Resolve ${clean}\n` });
      const sha = await hashObject(commit);
      const r = await receivePack(remote, [{ ref: `refs/heads/${conflict.branch}`, old: head, new: sha }], await writePack([...edit.objects, commit]));
      const said = r.unpack != "ok" ? r.unpack : r.refs.get(`refs/heads/${conflict.branch}`) ?? "no answer";
      if (said != "ok") throw new SourceError({ message: `Artifacts refused it: ${said}`, status: 502 });
      for (const o of edit.objects) objects.set(await hashObject(o), o);
      return { branch: conflict.branch, path: clean, remaining: this.unresolved(conflict, objects, edit.tree) };
    });
  }

  /**
   * Finishes the waiting merge: a merge commit of staging and the other side's commit with the branch's tree (every
   * conflict resolved) moves staging; the branch goes. Refused while a file still carries markers, or when staging moved since.
   */
  async finishUpdate(who: Actor): Promise<{ commit: string; version: string }> {
    return this.repo.locked(async () => {
      const remote = await this.repo.deps.artifacts();
      const { conflict, head, objects } = await this.conflictHead(remote);
      const { refs } = await lsRefs(remote);
      const staging = refs.get(REF("staging"));
      if (staging != conflict.ours)
        throw new SourceError({
          message: `staging moved since this merge started (it was at ${conflict.ours.slice(0, 7)}): ${conflict.kind == "upstream" ? "run Update again" : "Sync now runs the merge again"}.`,
          status: 409,
        });
      const tree = parseCommit(objects.get(head)!.data).tree;
      const left = this.unresolved(conflict, objects, tree);
      if (left.length)
        throw new SourceError({
          message: `${left.length} file${left.length == 1 ? " still carries" : "s still carry"} conflict markers: ${left.join(", ")}.`,
          status: 409,
        });
      const what =
        conflict.kind == "upstream"
          ? `Update from ${this.repo.deps.upstream?.()?.origin.replace(/^https?:\/\//, "") ?? "upstream"} ${conflict.version}`
          : `Merge GitHub's staging (${conflict.target.slice(0, 7)})`;
      const commit = this.commitObject({
        tree,
        parents: [conflict.ours, conflict.target],
        who,
        message: `${what}\n\nConflicts in ${conflict.files.map((f) => f.path).join(", ")} resolved.\n`,
      });
      const sha = await hashObject(commit);
      await this.repo.moveBranch(
        remote,
        "staging",
        conflict.ours,
        sha,
        await writePack([commit]),
        who,
        conflict.kind == "upstream" ? "update" : "github"
      );
      return { commit: sha, version: conflict.version };
    });
  }

  /** Drops the waiting merge: its branch goes, staging stays. */
  async abandonUpdate(): Promise<void> {
    await this.repo.locked(async () => {
      const conflict = this.repo.state<MergeConflict>("conflict");
      if (!conflict) return;
      const remote = await this.repo.deps.artifacts();
      const { refs } = await lsRefs(remote);
      const drop: RefUpdate[] = [...refs].filter(([r]) => isMergeBranch(r)).map(([ref, s]) => ({ ref, old: s, new: ZERO }));
      if (drop.length) await receivePack(remote, drop, null).catch(() => {});
      this.repo.setState("conflict", null);
      this.repo.deps.changed();
    });
  }

  /** After staging moved: a waiting merge whose other commit staging now has is over (a person merged in a checkout and pushed). */
  settleConflict(staging: string): void {
    const conflict = this.repo.state<MergeConflict>("conflict");
    if (!conflict || !this.repo.known(conflict.target) || !this.repo.isAncestor(conflict.target, staging)) return;
    this.repo.setState("conflict", null);
    this.repo.deps.background(
      (async () => {
        const remote = await this.repo.deps.artifacts();
      const { refs } = await lsRefs(remote);
      const drop: RefUpdate[] = [...refs].filter(([r]) => isMergeBranch(r)).map(([ref, s]) => ({ ref, old: s, new: ZERO }));
      if (drop.length) await receivePack(remote, drop, null);
    })().catch(() => {}));
  }
}

/**
 * The tree `root` with the file at `path` replaced by `blob` (null: removed): the new trees along the path, and the
 * new root. A folder along the way that isn't there is made; one left empty is dropped. Nothing changes if the file
 * is already that blob.
 */
export async function editTree(objects: Map<string, GitObject>, root: string, path: string, blob: GitObject | null): Promise<{ tree: string; objects: GitObject[] }> {
  const made: GitObject[] = [];
  const blobSha = blob ? await hashObject(blob) : null;
  if (blob) made.push(blob);
  const edit = async (tree: string | null, parts: string[]): Promise<string | null> => {
    const entries: TreeEntry[] = tree ? parseTree(objects.get(tree)?.data ?? new Uint8Array()) : [];
    const [name, ...rest] = parts;
    const at = entries.findIndex((e) => e.name == name);
    const was = at >= 0 ? entries[at] : null;
    let next: TreeEntry | null;
    if (rest.length) {
      const sub = await edit(was && isTreeMode(was.mode) ? was.sha : null, rest);
      next = sub ? { mode: "40000", name, sha: sub } : null;
    } else next = blobSha ? { mode: was && !isTreeMode(was.mode) ? was.mode : "100644", name, sha: blobSha } : null;
    if ((was?.sha ?? null) == (next?.sha ?? null) && (was?.mode ?? null) == (next?.mode ?? null)) return tree;
    const kept = entries.filter((_, i) => i != at);
    if (next) kept.push(next);
    if (!kept.length) return null;
    const o: GitObject = { type: "tree", data: treeBytes(kept) };
    const sha = await hashObject(o);
    made.push(o);
    objects.set(sha, o);
    return sha;
  };
  const tree = await edit(root, path.split("/"));
  if (tree) return { tree, objects: made };
  const empty: GitObject = { type: "tree", data: new Uint8Array() };
  made.push(empty);
  return { tree: await hashObject(empty), objects: made };
}

/** The file at `path` in the tree `root`, from `objects`; null when there's none (or it's a folder). */
export function blobAt(objects: Map<string, GitObject>, root: string, path: string): Uint8Array | null {
  let tree = root;
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const t = objects.get(tree);
    if (!t || t.type != "tree") return null;
    const e = parseTree(t.data).find((x) => x.name == parts[i]);
    if (!e) return null;
    if (i == parts.length - 1) return isTreeMode(e.mode) ? null : objects.get(e.sha)?.data ?? null;
    if (!isTreeMode(e.mode)) return null;
    tree = e.sha;
  }
  return null;
}

// A downstream (an Erga installed on its own domain: control/install/install.ts) has a
// repository of this same shape, forked from erga.dev's, and an upstream:
// erga.dev's Git endpoint, which anyone may read. It stands behind upstream
// (commits of erga.dev it doesn't have) and ahead of it (its own commits).
// Update brings upstream in: the newest release tag's commit (the stable
// channel) or main's head (edge) is merged into staging, a fast-forward where
// it can be, else a merge commit made here (control/source/conflicts.ts); production
// follows through the instance's own Merge, as always. Upstream's objects come
// into this repository under a tracking branch, erga-upstream/main, so the
// merge can read them. And erga.dev seeds each install's fork from here (seedFork).

import { emptyPack, isSha, parseCommit, parseTag, readPack, ZERO } from "./git.ts";
import { fetchPack, lsRefs, receivePack, RemoteError, type Remote } from "./remote.ts";
import { LOG, MERGE_BRANCH, REF, SCRATCH, SourceError, TAGS, TRACK } from "./refs.ts";
import { compareVersions, isReleaseTag } from "./releases.ts";
import type { MergeConflict } from "./conflicts.ts";
import type { Actor, CommitInfo, Row, SourceRepo } from "./repo.ts";

/** A downstream's upstream: erga.dev's Git endpoint (read for anyone), and the channel it follows: stable (the newest release tag) or edge (main). */
export interface UpstreamSource { remote: Remote; origin: string; channel: "stable" | "edge" }
/** Where a downstream stands against upstream (the Ops page shows it above the git log). */
export interface UpstreamView {
  origin: string; channel: "stable" | "edge";
  /** Upstream's main, and its newest release tag. */
  main: string | null; release: { tag: string; commit: string } | null;
  /** What Update brings in: the release's commit (stable), or main's head (edge). */
  target: string | null;
  /** The version Update brings: the tag, or main's short id on edge. */
  version: string | null;
  /** Upstream's commits (behind `target`) that staging doesn't have: how many, and the newest LOG of them, newest first. */
  behind: number; commits: CommitInfo[];
  /** Staging's commits that upstream's main doesn't have: this instance's own. */
  own: number;
  checkedAt: number | null; error: string | null;
}
export type UpdateResult =
  | { result: "up-to-date"; commit: string }
  | { result: "fast-forward" | "merged"; commit: string; version: string; brought: number }
  | { result: "conflicts"; conflict: MergeConflict };

export class Upstream {
  constructor(private repo: SourceRepo) {}

  /** Upstream's refs as last read: main's head, the newest release tag and its commit, and when. */
  private upstreamRefs(): { main: string | null; release: { tag: string; commit: string } | null; checkedAt: number | null; error: string | null } {
    return this.repo.state("upstream") ?? { main: null, release: null, checkedAt: null, error: null };
  }

  /**
   * Reads upstream's main and release tags, and indexes their commits (no files), so the position can be counted. An
   * upstream that doesn't answer leaves the last reading, with the error. Inside the lock.
   */
  private async syncUpstream(): Promise<ReturnType<Upstream["upstreamRefs"]>> {
    const up = this.repo.deps.upstream?.();
    const last = this.upstreamRefs();
    if (!up) return last;
    try {
      const [{ refs }, { refs: tagRefs }] = await Promise.all([lsRefs(up.remote), lsRefs(up.remote, TAGS)]);
      const main = refs.get("refs/heads/main") ?? null;
      const tags = [...tagRefs].filter(([ref]) => isReleaseTag(ref.slice(TAGS.length))).sort(([a], [b]) => compareVersions(b.slice(TAGS.length), a.slice(TAGS.length)));
      const newest = tags[0] ?? null;
      const wants = [...new Set([main, newest?.[1]].filter((s): s is string => !!s && !this.repo.known(s)))];
      let release: { tag: string; commit: string } | null = newest ? { tag: newest[0].slice(TAGS.length), commit: last.release?.tag == newest[0].slice(TAGS.length) ? last.release.commit : "" } : null;
      if (wants.length) {
        const haves = [...new Set([...this.repo.heads(), last.main ?? "", last.release?.commit ?? ""])].filter(
          (s) => s && this.repo.known(s)
        );
        const objects = await readPack(
          await fetchPack(up.remote, { wants, haves, filter: "blob:none" }),
          (t) => t == "commit" || t == "tag"
        );
        for (const [sha, o] of objects) if (o.type == "commit") this.repo.index(sha, parseCommit(o.data));
        if (newest && release && !release.commit) {
          const o = objects.get(newest[1]);
          release.commit = o?.type == "tag" ? parseTag(o.data).object : newest[1];
        }
      } else if (newest && release && !release.commit) release.commit = this.repo.known(newest[1]) ? newest[1] : "";
      if (release && !release.commit) release = null;
      const now = { main, release, checkedAt: this.repo.now(), error: null };
      this.repo.setState("upstream", now);
      return now;
    } catch (e) {
      const error = e instanceof RemoteError || e instanceof SourceError ? e.message : `upstream didn't answer: ${(e as Error).message}`;
      const now = { ...last, error };
      this.repo.setState("upstream", now);
      return now;
    }
  }

  /** What Update brings in, from the last reading of upstream: the release's commit on stable, main's head on edge; and the version's name. */
  private upstreamTarget(refs: ReturnType<Upstream["upstreamRefs"]>): { target: string | null; version: string | null } {
    const up = this.repo.deps.upstream?.();
    if (!up) return { target: null, version: null };
    if (up.channel == "stable") return refs.release ? { target: refs.release.commit, version: refs.release.tag } : { target: null, version: null };
    return refs.main ? { target: refs.main, version: refs.main.slice(0, 12) } : { target: null, version: null };
  }

  /** The position against upstream, for the Ops page. Inside the lock. */
  async upstreamView(staging: string | null): Promise<UpstreamView> {
    const up = this.repo.deps.upstream!()!;
    const refs = await this.syncUpstream();
    const { target, version } = this.upstreamTarget(refs);
    const ours = staging ? this.repo.ancestors(staging) : new Set<string>();
    const commit = (r: Row): CommitInfo => ({ sha: r.sha, subject: r.subject, author: r.author, email: r.email, at: r.at, parents: r.parents ? r.parents.split(" ") : [], inMain: false });
    let behind = 0, commits: CommitInfo[] = [];
    if (target && this.repo.known(target)) {
      behind = [...this.repo.ancestors(target)].filter((s) => !ours.has(s)).length;
      let seen = 0;
      const order = this.repo
        .order(target, (o) => {
          if (o.length && !ours.has(o[o.length - 1])) seen++;
          return seen >= Math.min(behind, LOG);
        })
        .filter((s) => !ours.has(s));
      commits = this.repo.rows(order).map(commit);
    }
    const theirs = refs.main && this.repo.known(refs.main) ? this.repo.ancestors(refs.main) : null;
    const own = theirs ? [...ours].filter((s) => !theirs.has(s)).length : 0;
    return { origin: up.origin, channel: up.channel, main: refs.main, release: refs.release, target, version, behind, commits, own, checkedAt: refs.checkedAt, error: refs.error };
  }
  /**
   * Update from upstream: brings the channel's commit (the newest release tag's on stable, main's head on edge) into
   * staging. A fast-forward when staging has no commits of its own past it; else a merge commit made here; and when
   * files conflict, staging stays, and the merge with Git's markers goes on upstream-merge/<version> (the result says
   * which files). `who`: the admin, or the system (an install that follows the channel by itself).
   */
  async update(who: Actor): Promise<UpdateResult> {
    const up = this.repo.deps.upstream?.();
    if (!up) throw new SourceError("This repository has no upstream to update from: it is not an install's fork.", 409);
    return this.repo.locked(async () => {
      const remote = await this.repo.deps.artifacts();
      const { refs } = await lsRefs(remote);
      const staging = refs.get(REF("staging")), main = refs.get(REF("main"));
      if (!staging) throw new SourceError("staging has no commits yet.", 409);
      await this.repo.sync(remote, [staging, ...(main ? [main] : [])]);
      const read = await this.syncUpstream();
      if (read.error) throw new SourceError(`${up.origin} didn't answer: ${read.error}`, 502);
      const { target, version } = this.upstreamTarget(read);
      if (!target || !version || !this.repo.known(target)) throw new SourceError(`${up.origin} has no release on ${up.channel} yet.`, 409);
      // Upstream was read again: the page's position may have changed even when nothing moves here.
      this.repo.deps.changed();
      if (this.repo.isAncestor(target, staging)) return { result: "up-to-date", commit: staging };
      const waiting = this.repo.state<MergeConflict>("conflict");
      if (waiting) throw new SourceError(`A merge already waits on conflicts (${waiting.branch}): resolve or drop it first.`, 409);
      const base = this.repo.conflicts.mergeBase(staging, target);
      // Upstream's objects into this repository, under the tracking branch: what it has past what we had of it.
      const tracked = refs.get(TRACK) ?? null;
      if (tracked != target) {
        const haves = [...new Set([tracked, base].filter((s): s is string => !!s))];
        const pack = await fetchPack(up.remote, { wants: [target], haves });
        const r = await receivePack(remote, [{ ref: TRACK, old: tracked ?? ZERO, new: target }], pack);
        const said = r.unpack != "ok" ? r.unpack : r.refs.get(TRACK) ?? "no answer";
        if (said != "ok") throw new SourceError(`Artifacts didn't take upstream's objects: ${said}`, 502);
      }
      const brought = [...this.repo.ancestors(target)].filter((s) => !this.repo.isAncestor(s, staging)).length;
      if (this.repo.isAncestor(staging, target)) {
        await this.repo.moveBranch(remote, "staging", staging, target, null, who, "update");
        return { result: "fast-forward", commit: target, version, brought };
      }
      const label = `${up.origin.replace(/^https?:\/\//, "")} ${version}`;
      const merged = await this.repo.conflicts.threeWay(remote, {
        ours: staging,
        theirs: target,
        base,
        who,
        labels: { ours: "staging", theirs: label },
        kind: "upstream",
        version,
        branch: `${MERGE_BRANCH}${version}`,
        message: `Update from ${label}`,
      });
      return merged.result == "merged" ? { result: "merged", commit: merged.commit, version, brought } : merged;
    });
  }
  /**
   * Seeds a fork: every object behind `commit` (one of this repository's commits) pushed to `fork`, as its main and
   * staging. The pack goes through as Artifacts sends it: nothing is unpacked here (the whole history is some 20MB).
   */
  async seedFork(fork: Remote, commit: string): Promise<void> {
    if (!isSha(commit)) throw new SourceError("Name the commit by its full id (40 hex digits).");
    await this.repo.locked(async () => {
      const remote = await this.repo.deps.artifacts();
      const { refs } = await lsRefs(remote);
      await this.repo.sync(
        remote,
        [commit].filter(() => [...refs.values()].includes(commit))
      );
      if (!this.repo.known(commit)) throw new SourceError(`${commit.slice(0, 7)} isn't one of this repository's commits.`, 409);
      const { refs: theirs } = await lsRefs(fork);
      if (theirs.has(REF("main")) || theirs.has(REF("staging"))) throw new SourceError("That fork already has branches.", 409);
      // A commit that isn't a branch's head can't be asked for: a scratch ref on it, for the fetch.
      const head = [...refs.values()].includes(commit);
      const scratch = `${SCRATCH}${crypto.randomUUID().slice(0, 8)}`;
      if (!head) await receivePack(remote, [{ ref: scratch, old: ZERO, new: commit }], await emptyPack());
      try {
        const pack = await fetchPack(remote, { wants: [commit] });
        const r = await receivePack(fork, [{ ref: REF("main"), old: ZERO, new: commit }, { ref: REF("staging"), old: ZERO, new: commit }], pack);
        const said = r.unpack != "ok" ? r.unpack : [REF("main"), REF("staging")].map((ref) => r.refs.get(ref) ?? "no answer").find((s) => s != "ok") ?? "ok";
        if (said != "ok") throw new SourceError(`The fork's repository refused the seed: ${said}`, 502);
      } finally { if (!head) await receivePack(remote, [{ ref: scratch, old: commit, new: ZERO }], null).catch(() => {}); }
    });
  }
}

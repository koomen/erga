// Feature branches: any branch but staging, main and Erga's own (refs.ts featureOf). An admin or their agent pushes
// larger work to one (git push erga HEAD:<name>); a feature branch never deploys. The Ops page lists them above the
// git log, each with whether it merges cleanly into staging. Merge adds ONE commit on staging with all the branch's
// changes (a squash: a three-way merge over the branch's merge base, with staging's head as its only parent), so
// staging deploys it as after a push; then the branch goes. Delete drops a branch. Both are operations
// (operations.ts: feature_branch), so agents do them too.
//
// Whether a branch merges cleanly needs the three trees whole, so it's found in the background, once for each pair
// of staging's head and the branch's head, and kept in memory: until then the branch shows "checking".
//
// A merge takes seconds. Each Merge and Delete is kept in memory (`actions`: running, then done or failed, for
// ACTION_KEPT) and sent as an event ({type: "feature"} on /api/events), so each Ops page open, and one loaded again,
// shows it in the branch's row.

import { hashObject, writePack, ZERO } from "./git.ts";
import { lsRefs, receivePack, type Remote } from "./remote.ts";
import type { Conflict } from "./merge.ts";
import { featureOf, REF, SourceError } from "./refs.ts";
import type { Actor, SourceRepo } from "./repo.ts";
import { plural } from "../../shared/time.ts";

export interface FeatureInfo {
  name: string;
  commit: string;
  /** Commits on the branch that staging doesn't have, and commits on staging the branch doesn't have. */
  ahead: number;
  behind: number;
  /** The branch's head commit. */
  last: { subject: string; author: string; at: number } | null;
  /** "merged": staging has all of it. "checking": not known yet (an event says when it is). "failed": the check couldn't run (error). */
  merge: { state: "clean" | "conflicts" | "checking" | "merged" | "failed"; files?: Conflict[]; error?: string };
  /** The squash commit's message, unless one is given: the newest commit's subject, and the branch's commit subjects. */
  message: string;
}

/** A Merge or Delete of a feature branch: running, then done or failed (error). */
export interface FeatureAction {
  branch: string;
  action: "merge" | "delete";
  state: "running" | "done" | "failed";
  /** Who asked (a login), and when the state began. */
  by: string;
  at: number;
  /** Done: the squash commit on staging (a Merge), or the head deleted (a Delete); and the branch's head it took. */
  commit?: string;
  head?: string;
  error?: string;
}

type Check = { files: Conflict[] } | { error: string };

/** How long a finished Merge or Delete stays in branches' answer. */
const ACTION_KEPT = 10 * 60_000;

export class Features {
  /** Whether a branch's head merges cleanly into staging's head: by `${staging}:${head}`. */
  private checks = new Map<string, Check | "running">();
  /** The latest Merge or Delete of each branch. */
  private actions = new Map<string, FeatureAction>();

  constructor(private repo: SourceRepo) {}

  /** The feature branches in `refs`, newest commit first; their commits must be indexed. Starts the checks not done yet. */
  list(remote: Remote, refs: Map<string, string>): FeatureInfo[] {
    const staging = refs.get(REF("staging")) ?? null;
    const onStaging = staging ? this.repo.ancestors(staging) : new Set<string>();
    const out: FeatureInfo[] = [];
    for (const [ref, head] of refs) {
      const name = featureOf(ref);
      if (!name || !this.repo.known(head)) continue;
      const mine = this.repo.ancestors(head);
      const ahead = [...mine].filter((s) => !onStaging.has(s)).length;
      const behind = [...onStaging].filter((s) => !mine.has(s)).length;
      const [row] = this.repo.rows([head]);
      out.push({
        name,
        commit: head,
        ahead,
        behind,
        last: row ? { subject: row.subject, author: row.author, at: row.at } : null,
        merge: !ahead || !staging ? { state: "merged" } : this.state(remote, staging, head),
        message: staging ? this.message(name, staging, head) : "",
      });
    }
    return out.sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));
  }

  private state(remote: Remote, staging: string, head: string): FeatureInfo["merge"] {
    const key = `${staging}:${head}`,
      known = this.checks.get(key);
    if (known == "running") return { state: "checking" };
    if (known)
      return "error" in known
        ? { state: "failed", error: known.error }
        : known.files.length
          ? { state: "conflicts", files: known.files }
          : { state: "clean" };
    this.checks.set(key, "running");
    this.repo.deps.background(
      this.conflicts(remote, staging, head)
        .then(
          (files): Check => ({ files }),
          (e: unknown): Check => ({ error: (e as Error).message })
        )
        .then((c) => {
          this.checks.set(key, c);
          this.repo.deps.changed();
        })
    );
    return { state: "checking" };
  }

  /** The files that conflict when `head` merges into `staging`: none when it merges cleanly. */
  private async conflicts(remote: Remote, staging: string, head: string): Promise<Conflict[]> {
    const base = this.repo.conflicts.mergeBase(staging, head);
    return (await this.repo.conflicts.mergeOf(remote, staging, head, base, { ours: "staging", theirs: head.slice(0, 7) })).conflicts;
  }

  /** The default squash message: the newest commit's subject; with more than one commit, the subjects below it. */
  private message(name: string, staging: string, head: string): string {
    const { commits, total } = this.repo.newCommits(staging, head);
    if (!commits.length) return "";
    if (total == 1) return commits[0].subject;
    const more = total > commits.length ? `\n- … and ${total - commits.length} more` : "";
    return `${commits[0].subject}\n\nThe branch ${name}, ${plural(total, "commit")}:\n${commits.map((c) => `- ${c.subject}`).join("\n")}${more}`;
  }

  /** The branch `name`'s head, refused with a reason when it isn't a feature branch there is. */
  private async head(remote: Remote, name: string): Promise<{ ref: string; head: string; refs: Map<string, string> }> {
    const ref = `refs/heads/${String(name ?? "")
      .trim()
      .replace(/^refs\/heads\//, "")}`;
    if (!featureOf(ref))
      throw new SourceError({
        message: `"${name}" isn't a feature branch: staging, main and Erga's own branches can't be merged or deleted here.`,
      });
    const { refs } = await lsRefs(remote);
    const head = refs.get(ref);
    if (!head) throw new SourceError({ message: `There's no feature branch "${featureOf(ref)}".`, status: 404 });
    return { ref, head, refs };
  }

  /**
   * Merges the feature branch `name` into staging as ONE commit (a squash), by `who`, with `message` (default: the
   * branch's, as listed). Staging deploys it; the branch goes. Refused when it conflicts, or brings nothing.
   */
  merge(who: Actor, name: string, message?: string): Promise<{ commit: string; branch: string; commits: number }> {
    return this.track("merge", who.login, name, (saw) => this.squash(who, name, message, saw));
  }

  private squash(who: Actor, name: string, message: string | undefined, saw: (head: string) => void) {
    return this.repo.locked(async () => {
      const remote = await this.repo.deps.artifacts();
      const { ref, head, refs } = await this.head(remote, name);
      saw(head);
      const branch = featureOf(ref)!;
      const staging = refs.get(REF("staging"));
      if (!staging) throw new SourceError({ message: "staging has no commits yet.", status: 409 });
      await this.repo.sync(remote, [staging, head]);
      if (this.repo.isAncestor(head, staging))
        throw new SourceError({ message: `staging has every commit of ${branch} already: delete the branch instead.`, status: 409 });
      const base = this.repo.conflicts.mergeBase(staging, head);
      const merged = await this.repo.conflicts.mergeOf(remote, staging, head, base, { ours: "staging", theirs: branch });
      if (merged.conflicts.length)
        throw new SourceError({
          message: `${branch} conflicts with staging in ${plural(merged.conflicts.length, "file")} (${merged.conflicts.map((f) => f.path).join(", ")}): in a checkout, rebase it onto staging, resolve them, and push the branch again (git push --force erga HEAD:${branch}).`,
          status: 409,
        });
      if (merged.tree == merged.ourTree)
        throw new SourceError({ message: `${branch} changes nothing that staging doesn't have: delete the branch instead.`, status: 409 });
      const commits = this.repo.newCommits(staging, head, 1).total;
      const text = message?.trim() || this.message(branch, staging, head);
      const commit = this.repo.conflicts.commitObject({ tree: merged.tree, parents: [staging], who, message: `${text}\n` });
      const sha = await hashObject(commit);
      await this.repo.moveBranch(remote, "staging", staging, sha, await writePack([...merged.objects, commit]), who, "merge");
      await receivePack(remote, [{ ref, old: head, new: ZERO }], null).catch(() => {});
      this.repo.deps.changed();
      return { commit: sha, branch, commits };
    });
  }

  /** Deletes the feature branch `name`. Its head is in the answer: a push of it brings the branch back. */
  remove(name: string, who: Actor): Promise<{ branch: string; commit: string }> {
    return this.track("delete", who.login, name, (saw) => this.drop(name, saw));
  }

  private drop(name: string, saw: (head: string) => void) {
    return this.repo.locked(async () => {
      const remote = await this.repo.deps.artifacts();
      const { ref, head } = await this.head(remote, name);
      saw(head);
      const r = await receivePack(remote, [{ ref, old: head, new: ZERO }], null);
      const said = r.unpack != "ok" ? r.unpack : (r.refs.get(ref) ?? "no answer");
      if (said != "ok") throw new SourceError({ message: `Artifacts refused it: ${said}`, status: 502 });
      this.repo.deps.changed();
      return { branch: featureOf(ref)!, commit: head };
    });
  }

  /** The Merges and Deletes running, and those that ended in the last ACTION_KEPT. */
  recent(): FeatureAction[] {
    const now = this.repo.deps.now?.() ?? Date.now();
    for (const [k, a] of this.actions) if (a.state != "running" && now - a.at > ACTION_KEPT) this.actions.delete(k);
    return [...this.actions.values()];
  }

  /** Runs a Merge or Delete of `name`, kept in `actions` and told to the Ops pages as it starts and as it ends. */
  private async track<T extends { commit: string }>(
    action: FeatureAction["action"],
    by: string,
    name: string,
    work: (saw: (head: string) => void) => Promise<T>
  ): Promise<T> {
    const branch = String(name ?? "")
      .trim()
      .replace(/^refs\/heads\//, "");
    const now = () => this.repo.deps.now?.() ?? Date.now();
    const set = (a: Omit<FeatureAction, "branch" | "action" | "by" | "at">) => {
      const kept: FeatureAction = { branch, action, by, at: now(), ...a };
      this.actions.set(branch, kept);
      this.repo.deps.changed({ type: "feature", ...kept });
    };
    let head: string | undefined;
    set({ state: "running" });
    try {
      const r = await work((h) => (head = h));
      set({ state: "done", commit: r.commit, ...(head ? { head } : {}) });
      return r;
    } catch (e) {
      set({ state: "failed", error: (e as Error).message });
      throw e;
    }
  }
}

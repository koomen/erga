// Erga's own repository: the canonical copy is a Cloudflare Artifacts repo
// (one repo, "erga", two branches, staging and main), and this is Erga's side
// of it. Every push and merge comes through here, so Erga can hold the line
// Artifacts doesn't, and knows each time a branch moves (an event for the
// Ops page, the deploy hook, the sync with GitHub).
//
// The model is strict: only two branches, ever; staging is always at or
// ahead of main; main only follows staging. A push to main must be one of
// staging's commits (and forward of main); a push to staging must keep every
// commit main has. Merging is moving main forward to staging's head, or to
// one of staging's commits. So the two never diverge, and there are no merge
// commits or conflicts between them.
//
// Releases are tags: an annotated tag vX.Y.Z (a semantic version) on a
// commit of main. The tag is the release; the newest one is stable
// (deploy/releases.ts). Cut release on the Ops page (POST
// /api/source/release) makes one here; `git push erga vX.Y.Z` does the same.
// A release tag is never moved or deleted, each is newer than the last, and
// nothing but release tags is taken.
//
// A downstream (an Erga installed on its own domain: deploy/install.ts) has a
// repository of this same shape, forked from erga.dev's, and an upstream:
// erga.dev's Git endpoint, which anyone may read. It stands behind upstream
// (commits of erga.dev it doesn't have) and ahead of it (its own commits).
// Update brings upstream in: the newest release tag's commit (the stable
// channel) or main's head (edge) is merged into staging, a fast-forward where
// it can be, else a merge commit made here (server/source/merge.ts); production
// follows through the instance's own Merge, as always. When files conflict,
// staging stays as it is, and the merge with Git's conflict markers goes on a
// branch, upstream-merge/<version>, for an admin (or their agent) to resolve:
// the agent writes the files and finishes the merge from here (resolveUpdate,
// finishUpdate); a person merges in a checkout and pushes staging, which ends
// the conflict too. Upstream's objects come into this repository under a
// tracking branch, erga-upstream/main, so the merge can read them.
//
// GitHub: an admin connects a repository there (Connect GitHub on the Ops
// page: github.ts, the App), and the two sync (syncGithub): after each move
// here, staging, main and the release tags go to GitHub; after each push
// there (the App's webhook), what GitHub has comes in, the same way upstream
// does: staging fast-forwards, or gets a merge commit, or the merge waits on
// github-merge/<commit> with its conflicts; main moves only to a commit of
// staging. One merge waits at a time, from either side.
//
// A push is staged before it lands: its objects go to Artifacts under a
// quarantine branch, Erga reads the new
// commits back and checks them, and only then moves the real branches, each
// only from where it was (Artifacts refuses a move whose old value is stale,
// so two pushes at once can't lose one), and drops the quarantine branches.
//
// Erga keeps an index of the commits (their parents, subjects, authors and
// times) so it can answer "is this a fast-forward", "is this on staging"
// and "the last 25 commits" without asking Artifacts each
// time. Commits never change, so the index is a cache that's always right;
// whatever's missing is fetched from Artifacts when it's needed.
//
// Platform-neutral: storage is a small synchronous SQL interface (a Durable
// Object's SQLite, or bun:sqlite in tests), and the repository, upstream and
// GitHub are smart HTTP remotes.

import {
  commitBytes, concat, emptyPack, FLUSH, hashObject, isSha, isTreeMode, parseCommit, parseTag, parseTree, pkt, readPack, readPkts, subjectOf, tagBytes, text, treeBytes,
  toSideBand, utf8, writePack, ZERO, type Commit, type GitObject, type TreeEntry,
} from "./git.ts";
import { fetchPack, lsRefs, receiveAdvert, receivePack, RemoteError, type RefUpdate, type Remote } from "./remote.ts";
import { BrowseError, cleanPath, list, read, search, snapshotOf, view, type Snapshot, type SourceAnswer, type SourceRead } from "./browse.ts";
import { isBinary, mergeTrees, type Conflict } from "./merge.ts";
import { GithubError, githubRemote as asRemote, type GithubLink, type PushEvent } from "./github.ts";
import { byLine, SYSTEM, VIA } from "../../shared/attribution.ts";
import { TARGETS } from "../../deploy/targets.ts";

export const BRANCHES = ["staging", "main"] as const;
export type Branch = (typeof BRANCHES)[number];
const REF = (b: Branch) => `refs/heads/${b}`;
const QUARANTINE = "refs/heads/erga-incoming/";
const TAGS = "refs/tags/";
/** A downstream's copy of upstream's main: the objects Update brings in live under it. */
const TRACK = "refs/heads/erga-upstream/main";
/** A downstream's merge that conflicted: upstream-merge/<version>, with Git's markers in the files, for an admin or their agent. */
const MERGE_BRANCH = "refs/heads/upstream-merge/";
/** A merge from GitHub that conflicted: github-merge/<commit>, the same way. */
const GITHUB_MERGE_BRANCH = "refs/heads/github-merge/";
const isMergeBranch = (ref: string) => ref.startsWith(MERGE_BRANCH) || ref.startsWith(GITHUB_MERGE_BRANCH);
/** GitHub's branches as last taken in: the objects a sync brings from GitHub live under these. */
const GITHUB_TRACK = "refs/heads/erga-github/";
/** Temporary refs a merge sets so Artifacts sends the trees it needs (a commit that isn't a branch's head can't be asked for). */
const SCRATCH = "refs/heads/erga-merge/";
/** Git's conflict markers, at a line's start: a file that still has one isn't resolved. */
const MARKER = /^(<{7}|={7}|>{7})(?: |$)/m;
/** A release tag: a semantic version, v first. */
export const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
export const isReleaseTag = (name: string) => RELEASE_TAG.test(name);
/** Semantic version order (newest last): vX.Y.Z by its numbers. */
export function compareVersions(a: string, b: string): number {
  const x = RELEASE_TAG.exec(a), y = RELEASE_TAG.exec(b);
  if (!x || !y) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) != Number(y[i])) return Number(x[i]) - Number(y[i]);
  return 0;
}
/** The version after `latest` (its patch number up), or the first. */
export const nextVersion = (latest: string | null) => { const m = latest ? RELEASE_TAG.exec(latest) : null; return m ? `v${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "v0.1.0"; };
/** How many commits each branch shows. */
export const LOG = 100;
/** At most how many commits a task's card holds. */
export const TASK_COMMITS = 100;
/** A task's merge commit, by the factory: "Merge task/<id>-<slug>: title". */
const TASK_MERGE = /^Merge (task\/(\d+)-[^\s:]*): (.+)$/;
/** How many of staging's commits just after main's head the Ops page gets (BranchInfo.afterMain). */
export const AFTER_MAIN = 5;

export interface Db { exec<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] }

/** Someone acting on the repository: an admin, by their GitHub login, and how when not in person (shared/attribution.ts: "their admin agent", "a shared agent (label)", "the factory (task #3)"). */
export interface Actor { login: string; name: string; via?: string }

/** GitHub, as the Ops page shows it: the repository connected (or none), the sync's state, and how its last run went. */
export interface GithubStatus {
  connected: boolean;
  link: GithubLink | null;
  /** off (not connected), idle, syncing. */
  state: "off" | "idle" | "syncing";
  /** When the last sync went through whole (ms), and for whom ("ada, via their admin agent"; "bo, via a push on GitHub"). */
  lastSyncAt: number | null;
  lastSyncBy: string | null;
  /** What stopped the last sync (part of it may have gone through), or null. */
  error: string | null;
  /** What GitHub's branches pointed to after the last sync. */
  refs?: Partial<Record<Branch, string>>;
}
/** The sync's record, kept: the status without the link and the state. */
type SyncRecord = Pick<GithubStatus, "lastSyncAt" | "lastSyncBy" | "error" | "refs">;

export interface CommitInfo {
  sha: string; subject: string; author: string; email: string; at: number; parents: string[]; /** Reachable from main. */ inMain: boolean;
  /** A task's merge ("Merge task/<id>-<slug>: title"): the task, and the commits that came in with it (from its second parent's side), newest first. */
  task?: { id: number; branch: string; title: string; commits: string[] };
  /** One of a task's commits: the sha of the task's merge. */
  inTask?: string;
  /** A downstream: this commit isn't on upstream's main (the instance's own). */
  own?: boolean;
}
/** A release: its tag, the commit it marks, who cut it and when, its message. */
export interface TagInfo { name: string; sha: string; commit: string; tagger: string; at: number; message: string }
/** A release cut: the tag, its commit, who did it. */
export interface Released { tag: string; commit: string; sha: string; by: string; via?: string | null; at: number; message: string }
export interface BranchInfo {
  name: Branch; commit: string | null; commits: CommitInfo[];
  /** Commits on it that main doesn't have (staging only). */
  ahead?: number;
  /** The AFTER_MAIN commits only on staging that come just after main's head, newest first (staging only): the Ops page shows them below its break, when staging is far ahead. */
  afterMain?: CommitInfo[];
}
/** A downstream's upstream: erga.dev's Git endpoint (read for anyone), and the channel it follows: stable (the newest release tag) or edge (main). */
export interface UpstreamSource { remote: Remote; origin: string; channel: "stable" | "edge" }
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

/** A branch moved: `by` (a login) did it, `via` how when not in person. "update": an Update from upstream (a downstream); "github": a push on GitHub, synced in. */
export interface Move {
  branch: Branch; old: string; new: string; how: "push" | "merge" | "update" | "github"; by: string; via?: string | null; at: number;
  /** main moved past the production gate (a merge's emergency override, before the gate was removed): the reason given, and what the gate said. */
  override?: { reason: string; gate: string };
}

export class SourceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface RepoDeps {
  db: Db;
  /** The Artifacts repo, with a write token. */
  artifacts(): Promise<Remote>;
  /** The Artifacts repo with a read token, for reading the source (`read`); the write token's if not given. */
  reader?(): Promise<Remote>;
  /** GitHub, as the App: an installation token for the repository connected (github.ts installationToken; an install's control Worker asks erga.dev). Absent: this server can't reach GitHub. */
  githubToken?(installationId: number): Promise<{ token: string; expiresAt: number }>;
  /** The App uninstalled from the account (Disconnect). */
  githubUninstall?(installationId: number): Promise<void>;
  /** A branch moved (after a push or a merge). */
  moved(move: Move): void;
  /** A release cut: a tag made here, or pushed. */
  released?(release: Released): void;
  /** A downstream: where upstream's repository is, and the channel followed (null, or absent: this is erga.dev's own). */
  upstream?(): UpstreamSource | null;
  /** Something the Ops page shows changed (a branch, the sync's status). */
  changed(): void;
  /** Work that outlives the request (the sync with GitHub). */
  background(work: Promise<unknown>): void;
  now?(): number;
}

interface Row { sha: string; tree: string; parents: string; author: string; email: string; at: number; committed: number; subject: string }
interface Node { parents: string[]; committed: number }

export class SourceRepo {
  private chain: Promise<unknown> = Promise.resolve();
  private graph: Map<string, Node> | null = null;
  private syncing: Promise<GithubStatus> | null = null;
  private syncAgain = false;
  /** Whom the next sync with GitHub is for (byLine): whoever moved a branch, pushed on GitHub, or asked for it; and the actor of a merge it makes. */
  private syncBy = SYSTEM;
  private syncWho: Actor | null = null;
  /** The installation token in use (githubRemote). */
  private githubToken: { installationId: number; token: string; expiresAt: number } | null = null;
  /** The commits `read` read last, the newest last: a few, as each holds every file. */
  private snapshots = new Map<string, Promise<Snapshot>>();

  constructor(private deps: RepoDeps) {
    const db = deps.db;
    db.exec("CREATE TABLE IF NOT EXISTS commits (sha TEXT PRIMARY KEY, tree TEXT NOT NULL, parents TEXT NOT NULL, author TEXT NOT NULL, email TEXT NOT NULL, at INTEGER NOT NULL, committed INTEGER NOT NULL, subject TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS moves (id INTEGER PRIMARY KEY AUTOINCREMENT, branch TEXT NOT NULL, old TEXT NOT NULL, new TEXT NOT NULL, how TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Release tags, as Artifacts has them: the tag object (or the commit, for a plain tag), the commit, who, when, the message.
    db.exec("CREATE TABLE IF NOT EXISTS tags (name TEXT PRIMARY KEY, sha TEXT NOT NULL, commit_sha TEXT NOT NULL, tagger TEXT NOT NULL, at INTEGER NOT NULL, message TEXT NOT NULL)");
    // #69: how the mover did it, when not in person.
    if (!db.exec<{ name: string }>("PRAGMA table_info(moves)").some((c) => c.name == "via")) db.exec("ALTER TABLE moves ADD COLUMN via TEXT");
  }

  private now() { return this.deps.now?.() ?? Date.now(); }

  /** One at a time: pushes and merges each see the branches as the last one left them. */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => {});
    return run;
  }

  private state<T>(key: string): T | null {
    const [row] = this.deps.db.exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key);
    return row ? (JSON.parse(row.value) as T) : null;
  }
  private setState(key: string, value: unknown) {
    this.deps.db.exec("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  // ---- The commit index ------------------------------------------------------

  private nodes(): Map<string, Node> {
    if (!this.graph) {
      this.graph = new Map();
      for (const r of this.deps.db.exec<{ sha: string; parents: string; committed: number }>("SELECT sha, parents, committed FROM commits")) {
        this.graph.set(r.sha, { parents: r.parents ? r.parents.split(" ") : [], committed: r.committed });
      }
    }
    return this.graph;
  }

  private index(sha: string, c: Commit) {
    if (this.nodes().has(sha)) return;
    this.deps.db.exec("INSERT OR IGNORE INTO commits (sha, tree, parents, author, email, at, committed, subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      sha, c.tree, c.parents.join(" "), c.author.name, c.author.email, c.author.time * 1000, c.committer.time * 1000, subjectOf(c.message));
    this.nodes().set(sha, { parents: c.parents, committed: c.committer.time * 1000 });
  }

  /** Whether Erga's index has this commit (and so everything it comes from). */
  known(sha: string) { return this.nodes().has(sha); }

  /**
   * Indexes the commits behind `tips` that the index doesn't have yet,
   * fetching them from Artifacts (each tip must be a branch there, so it can
   * be asked for). What Erga already has is said as "have", so only what's new comes.
   */
  private async sync(remote: Remote, tips: string[]) {
    const missing = [...new Set(tips.filter((t) => t != ZERO && !this.known(t)))];
    if (!missing.length) return;
    const haves = [...new Set([...this.heads(), ...Object.values(this.state<Record<string, string>>("tips") ?? {})])].filter((s) => this.known(s));
    // No files (the index needs commits only): far smaller, where the remote takes a filter (Artifacts takes blob:none).
    const objects = await readPack(await fetchPack(remote, { wants: missing, haves, filter: "blob:none" }), (t) => t == "commit");
    for (const [sha, o] of objects) this.index(sha, parseCommit(o.data));
    const still = missing.filter((t) => !this.known(t));
    if (still.length) throw new SourceError(`Artifacts didn't send commit ${still[0].slice(0, 7)}`, 502);
  }

  /** The branches' last known heads (as the index last saw them). */
  private heads(): string[] { return Object.values(this.state<Record<string, string>>("tips") ?? {}); }

  /** Every commit `tip` comes from, itself included. */
  private ancestors(tip: string): Set<string> {
    const seen = new Set<string>(), nodes = this.nodes(), todo = [tip];
    while (todo.length) {
      const s = todo.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      for (const p of nodes.get(s)?.parents ?? []) todo.push(p);
    }
    return seen;
  }

  /** Whether `a` is `b` or one of the commits it comes from. */
  isAncestor(a: string, b: string): boolean {
    if (a == b) return true;
    const nodes = this.nodes(), seen = new Set<string>(), todo = [b];
    while (todo.length) {
      const s = todo.pop()!;
      if (s == a) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      for (const p of nodes.get(s)?.parents ?? []) todo.push(p);
    }
    return false;
  }

  /** The newest `limit` commits behind `tip`, newest first (by commit time, as `git log` lists them). */
  log(tip: string, limit = LOG): Row[] {
    return this.rows(this.order(tip, (order) => order.length >= limit));
  }

  /** What a branch's move from `old` (ZERO: none) to `tip` brought: the newest `limit` of the commits `old` doesn't have, newest first, and how many there are. */
  newCommits(old: string, tip: string, limit = 50): { commits: { sha: string; subject: string }[]; total: number } {
    const before = old == ZERO ? new Set<string>() : this.ancestors(old);
    const total = [...this.ancestors(tip)].filter((s) => !before.has(s)).length;
    let seen = 0;
    const order = this.order(tip, (o) => { if (o.length && !before.has(o[o.length - 1])) seen++; return seen >= Math.min(total, limit); }).filter((s) => !before.has(s));
    return { commits: this.rows(order).map((r) => ({ sha: r.sha, subject: r.subject })), total };
  }

  /** The commits behind `tip`, newest first, as log lists them, until `done` says so. */
  private order(tip: string, done: (order: string[]) => boolean): string[] {
    const nodes = this.nodes(), seen = new Set<string>([tip]), frontier = [tip], order: string[] = [];
    while (frontier.length && !done(order)) {
      frontier.sort((x, y) => (nodes.get(x)?.committed ?? 0) - (nodes.get(y)?.committed ?? 0));
      const s = frontier.pop()!;
      order.push(s);
      for (const p of nodes.get(s)?.parents ?? []) if (!seen.has(p) && nodes.has(p)) { seen.add(p); frontier.push(p); }
    }
    return order;
  }

  /** The commits' rows, in the order asked. */
  private rows(order: string[]): Row[] {
    if (!order.length) return [];
    const rows = this.deps.db.exec<Row>(`SELECT * FROM commits WHERE sha IN (${order.map(() => "?").join(",")})`, ...order);
    const by = new Map(rows.map((r) => [r.sha, r]));
    return order.map((s) => by.get(s)!).filter(Boolean);
  }

  // ---- What the Ops page shows ---------------------------------------------

  /** Each branch's head and its latest commits, which of them main has, GitHub's status, and the merge waiting on conflicts, if one. */
  async branches(): Promise<{ branches: BranchInfo[]; github: GithubStatus; conflict: MergeConflict | null; moves: Move[]; tags: TagInfo[]; release: string | null; upstream?: UpstreamView }> {
    const remote = await this.deps.artifacts();
    const [{ refs }, { refs: tagRefs }] = await Promise.all([lsRefs(remote), lsRefs(remote, TAGS)]);
    const heads = Object.fromEntries(BRANCHES.map((b) => [b, refs.get(REF(b)) ?? null])) as Record<Branch, string | null>;
    let upstream: UpstreamView | undefined;
    await this.locked(async () => {
      await this.sync(remote, BRANCHES.map((b) => heads[b]).filter((s): s is string => !!s));
      this.setState("tips", Object.fromEntries(BRANCHES.filter((b) => heads[b]).map((b) => [b, heads[b]])));
      await this.syncTags(remote, tagRefs);
      if (this.deps.upstream?.()) upstream = await this.upstreamView(heads.staging);
    });
    const tags = this.tags();
    const onMain = heads.main ? this.ancestors(heads.main) : new Set<string>();
    const theirs = upstream?.main && this.known(upstream.main) ? this.ancestors(upstream.main) : null;
    const branches = BRANCHES.map((name): BranchInfo => {
      const tip = heads[name];
      const commit = (r: Row): CommitInfo => ({ sha: r.sha, subject: r.subject, author: r.author, email: r.email, at: r.at, parents: r.parents ? r.parents.split(" ") : [], inMain: onMain.has(r.sha), ...(theirs ? { own: !theirs.has(r.sha) } : {}) });
      const commits = tip ? this.withTasks(this.log(tip).map(commit), commit) : [];
      const info: BranchInfo = { name, commit: tip, commits };
      if (name == "staging" && tip) {
        const ahead = info.ahead = [...this.ancestors(tip)].filter((s) => !onMain.has(s)).length;
        // The last of staging's own commits, in log's order, until it has listed them all: those just after main's head.
        let seen = 0;
        const only = this.order(tip, (order) => { if (order.length && !onMain.has(order[order.length - 1])) seen++; return seen >= ahead; }).filter((s) => !onMain.has(s));
        info.afterMain = this.withTasks(this.rows(only.slice(-AFTER_MAIN)).map(commit), commit, false);
      }
      return info;
    });
    return { branches, github: this.githubStatus(), conflict: this.state<MergeConflict>("conflict"), moves: this.moves(10), tags, release: tags[0]?.name ?? null, ...(upstream ? { upstream } : {}) };
  }

  // ---- Upstream (a downstream's fork of erga.dev) --------------------------------------

  /** Upstream's refs as last read: main's head, the newest release tag and its commit, and when. */
  private upstreamRefs(): { main: string | null; release: { tag: string; commit: string } | null; checkedAt: number | null; error: string | null } {
    return this.state("upstream") ?? { main: null, release: null, checkedAt: null, error: null };
  }

  /**
   * Reads upstream's main and release tags, and indexes their commits (no files), so the position can be counted. An
   * upstream that doesn't answer leaves the last reading, with the error. Inside the lock.
   */
  private async syncUpstream(): Promise<ReturnType<SourceRepo["upstreamRefs"]>> {
    const up = this.deps.upstream?.();
    const last = this.upstreamRefs();
    if (!up) return last;
    try {
      const [{ refs }, { refs: tagRefs }] = await Promise.all([lsRefs(up.remote), lsRefs(up.remote, TAGS)]);
      const main = refs.get("refs/heads/main") ?? null;
      const tags = [...tagRefs].filter(([ref]) => isReleaseTag(ref.slice(TAGS.length))).sort(([a], [b]) => compareVersions(b.slice(TAGS.length), a.slice(TAGS.length)));
      const newest = tags[0] ?? null;
      const wants = [...new Set([main, newest?.[1]].filter((s): s is string => !!s && !this.known(s)))];
      let release: { tag: string; commit: string } | null = newest ? { tag: newest[0].slice(TAGS.length), commit: last.release?.tag == newest[0].slice(TAGS.length) ? last.release.commit : "" } : null;
      if (wants.length) {
        const haves = [...new Set([...this.heads(), last.main ?? "", last.release?.commit ?? ""])].filter((s) => s && this.known(s));
        const objects = await readPack(await fetchPack(up.remote, { wants, haves, filter: "blob:none" }), (t) => t == "commit" || t == "tag");
        for (const [sha, o] of objects) if (o.type == "commit") this.index(sha, parseCommit(o.data));
        if (newest && release && !release.commit) {
          const o = objects.get(newest[1]);
          release.commit = o?.type == "tag" ? parseTag(o.data).object : newest[1];
        }
      } else if (newest && release && !release.commit) release.commit = this.known(newest[1]) ? newest[1] : "";
      if (release && !release.commit) release = null;
      const now = { main, release, checkedAt: this.now(), error: null };
      this.setState("upstream", now);
      return now;
    } catch (e) {
      const error = e instanceof RemoteError || e instanceof SourceError ? e.message : `upstream didn't answer: ${(e as Error).message}`;
      const now = { ...last, error };
      this.setState("upstream", now);
      return now;
    }
  }

  /** What Update brings in, from the last reading of upstream: the release's commit on stable, main's head on edge; and the version's name. */
  private upstreamTarget(refs: ReturnType<SourceRepo["upstreamRefs"]>): { target: string | null; version: string | null } {
    const up = this.deps.upstream?.();
    if (!up) return { target: null, version: null };
    if (up.channel == "stable") return refs.release ? { target: refs.release.commit, version: refs.release.tag } : { target: null, version: null };
    return refs.main ? { target: refs.main, version: refs.main.slice(0, 12) } : { target: null, version: null };
  }

  /** The position against upstream, for the Ops page. Inside the lock. */
  private async upstreamView(staging: string | null): Promise<UpstreamView> {
    const up = this.deps.upstream!()!;
    const refs = await this.syncUpstream();
    const { target, version } = this.upstreamTarget(refs);
    const ours = staging ? this.ancestors(staging) : new Set<string>();
    const commit = (r: Row): CommitInfo => ({ sha: r.sha, subject: r.subject, author: r.author, email: r.email, at: r.at, parents: r.parents ? r.parents.split(" ") : [], inMain: false });
    let behind = 0, commits: CommitInfo[] = [];
    if (target && this.known(target)) {
      behind = [...this.ancestors(target)].filter((s) => !ours.has(s)).length;
      let seen = 0;
      const order = this.order(target, (o) => { if (o.length && !ours.has(o[o.length - 1])) seen++; return seen >= Math.min(behind, LOG); }).filter((s) => !ours.has(s));
      commits = this.rows(order).map(commit);
    }
    const theirs = refs.main && this.known(refs.main) ? this.ancestors(refs.main) : null;
    const own = theirs ? [...ours].filter((s) => !theirs.has(s)).length : 0;
    return { origin: up.origin, channel: up.channel, main: refs.main, release: refs.release, target, version, behind, commits, own, checkedAt: refs.checkedAt, error: refs.error };
  }

  /** The common ancestor of `a` and `b` to merge over: the newest of the best ones (one of several is enough: a criss-cross is rare here). */
  private mergeBase(a: string, b: string): string | null {
    const ofA = this.ancestors(a), nodes = this.nodes();
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
    const best = found.filter((c) => !found.some((d) => d != c && this.isAncestor(c, d)));
    return best.sort((x, y) => (nodes.get(y)?.committed ?? 0) - (nodes.get(x)?.committed ?? 0))[0] ?? null;
  }

  /**
   * Update from upstream: brings the channel's commit (the newest release tag's on stable, main's head on edge) into
   * staging. A fast-forward when staging has no commits of its own past it; else a merge commit made here; and when
   * files conflict, staging stays, and the merge with Git's markers goes on upstream-merge/<version> (the result says
   * which files). `who`: the admin, or the system (an install that follows the channel by itself).
   */
  async update(who: Actor): Promise<UpdateResult> {
    const up = this.deps.upstream?.();
    if (!up) throw new SourceError("This repository has no upstream to update from: it is not an install's fork.", 409);
    return this.locked(async () => {
      const remote = await this.deps.artifacts();
      const { refs } = await lsRefs(remote);
      const staging = refs.get(REF("staging")), main = refs.get(REF("main"));
      if (!staging) throw new SourceError("staging has no commits yet.", 409);
      await this.sync(remote, [staging, ...(main ? [main] : [])]);
      const read = await this.syncUpstream();
      if (read.error) throw new SourceError(`${up.origin} didn't answer: ${read.error}`, 502);
      const { target, version } = this.upstreamTarget(read);
      if (!target || !version || !this.known(target)) throw new SourceError(`${up.origin} has no release on ${up.channel} yet.`, 409);
      // Upstream was read again: the page's position may have changed even when nothing moves here.
      this.deps.changed();
      if (this.isAncestor(target, staging)) return { result: "up-to-date", commit: staging };
      const waiting = this.state<MergeConflict>("conflict");
      if (waiting) throw new SourceError(`A merge already waits on conflicts (${waiting.branch}): resolve or drop it first.`, 409);
      const base = this.mergeBase(staging, target);
      // Upstream's objects into this repository, under the tracking branch: what it has past what we had of it.
      const tracked = refs.get(TRACK) ?? null;
      if (tracked != target) {
        const haves = [...new Set([tracked, base].filter((s): s is string => !!s))];
        const pack = await fetchPack(up.remote, { wants: [target], haves });
        const r = await receivePack(remote, [{ ref: TRACK, old: tracked ?? ZERO, new: target }], pack);
        const said = r.unpack != "ok" ? r.unpack : r.refs.get(TRACK) ?? "no answer";
        if (said != "ok") throw new SourceError(`Artifacts didn't take upstream's objects: ${said}`, 502);
      }
      const brought = [...this.ancestors(target)].filter((s) => !this.isAncestor(s, staging)).length;
      if (this.isAncestor(staging, target)) {
        await this.moveBranch(remote, "staging", staging, target, null, who, "update");
        return { result: "fast-forward", commit: target, version, brought };
      }
      const label = `${up.origin.replace(/^https?:\/\//, "")} ${version}`;
      const merged = await this.threeWay(remote, { ours: staging, theirs: target, base, who, labels: { ours: "staging", theirs: label }, kind: "upstream", version, branch: `${MERGE_BRANCH}${version}`, message: `Update from ${label}` });
      return merged.result == "merged" ? { result: "merged", commit: merged.commit, version, brought } : merged;
    });
  }

  /** `branch` moved by a sync (to a commit already here, or to a commit in `pack`), recorded as `how`. Inside the lock. */
  private async moveBranch(remote: Remote, branch: Branch, old: string | null, to: string, pack: Uint8Array | null, who: Actor, how: Move["how"]): Promise<void> {
    const r = await receivePack(remote, [{ ref: REF(branch), old: old ?? ZERO, new: to }], pack ?? await emptyPack());
    const said = r.unpack != "ok" ? r.unpack : r.refs.get(REF(branch)) ?? "no answer";
    if (said != "ok") throw new SourceError(/stale|lock|old/i.test(said) ? `${branch} moved meanwhile: try again.` : `Artifacts refused it: ${said}`, 409);
    await this.sync(remote, [to]);
    this.recordMove({ branch, old: old ?? ZERO, new: to, how, by: who.login, via: who.via ?? null, at: this.now() });
  }

  /**
   * A three-way merge of `theirs` into staging (at `ours`), over `base`, made here (server/source/merge.ts). No
   * conflicts: the merge commit moves staging. Conflicts: staging stays, the merge with Git's markers goes on `branch`
   * (an older merge branch goes), and the conflict is kept for the Ops page and the agent. Inside the lock.
   */
  private async threeWay(remote: Remote, o: { ours: string; theirs: string; base: string | null; who: Actor; labels: { ours: string; theirs: string }; kind: MergeConflict["kind"]; version: string; branch: string; message: string }): Promise<{ result: "merged"; commit: string } | { result: "conflicts"; conflict: MergeConflict }> {
    const { ours, theirs, base } = o;
    // The three trees, read whole (a scratch ref for the base, which isn't a branch's head).
    const scratch = `${SCRATCH}${crypto.randomUUID().slice(0, 8)}`;
    if (base) await receivePack(remote, [{ ref: scratch, old: ZERO, new: base }], await emptyPack());
    let objects: Map<string, GitObject>;
    try { objects = await readPack(await fetchPack(remote, { wants: [ours, theirs, ...(base ? [base] : [])], deepen: 1 })); }
    finally { if (base) await receivePack(remote, [{ ref: scratch, old: base, new: ZERO }], null).catch(() => {}); }
    const treeOf = (sha: string) => { const x = objects.get(sha); if (!x || x.type != "commit") throw new SourceError(`Artifacts didn't send commit ${sha.slice(0, 7)}`, 502); return parseCommit(x.data).tree; };
    const merged = await mergeTrees({ get: (sha) => objects.get(sha) }, base ? treeOf(base) : null, treeOf(ours), treeOf(theirs), o.labels);
    const files = merged.conflicts;
    const message = files.length
      ? `${o.message}: ${files.length} file${files.length == 1 ? "" : "s"} conflict\n\n${files.map((f) => `${f.path} (${f.kind})`).join("\n")}\n`
      : `${o.message}\n`;
    const commit = this.commitObject({ tree: merged.tree, parents: [ours, theirs], who: o.who, message });
    const sha = await hashObject(commit);
    const pack = await writePack([...merged.objects, commit]);
    if (!files.length) {
      await this.moveBranch(remote, "staging", ours, sha, pack, o.who, o.kind == "upstream" ? "update" : "github");
      return { result: "merged", commit: sha };
    }
    // Conflicts: the merge on its branch, staging as it was; an older conflict branch goes.
    const { refs } = await lsRefs(remote);
    const old = refs.get(o.branch) ?? ZERO;
    const drop: RefUpdate[] = [...refs].filter(([r]) => isMergeBranch(r) && r != o.branch).map(([ref, s]) => ({ ref, old: s, new: ZERO }));
    const r = await receivePack(remote, [{ ref: o.branch, old, new: sha }, ...drop], pack);
    const said = r.unpack != "ok" ? r.unpack : r.refs.get(o.branch) ?? "no answer";
    if (said != "ok") throw new SourceError(`Artifacts refused the merge branch: ${said}`, 502);
    const conflict: MergeConflict = { kind: o.kind, branch: o.branch.slice("refs/heads/".length), version: o.version, target: theirs, ours, base, files, at: this.now(), by: byLine(o.who.login, o.who.via) };
    this.setState("conflict", conflict);
    this.index(sha, parseCommit(commit.data));
    this.deps.changed();
    return { result: "conflicts", conflict };
  }

  /** A commit object by `who`, now. */
  private commitObject(o: { tree: string; parents: string[]; who: Actor; message: string }): GitObject {
    const time = Math.floor(this.now() / 1000);
    const person = { name: o.who.name || o.who.login, email: o.who.login == SYSTEM ? `noreply@${TARGETS.production.host}` : `${o.who.login}@users.noreply.github.com`, time, tz: "+0000" };
    return { type: "commit", data: commitBytes({ tree: o.tree, parents: o.parents, author: person, committer: person, message: o.message }) };
  }

  /** The waiting merge, or null: the one that conflicted (from upstream, or from GitHub). */
  conflict(): MergeConflict | null { return this.state<MergeConflict>("conflict"); }

  /** The conflict branch's head and its files, for resolving: the conflict, the head, and the objects of its tree. */
  private async conflictHead(remote: Remote): Promise<{ conflict: MergeConflict; head: string; objects: Map<string, GitObject> }> {
    const conflict = this.state<MergeConflict>("conflict");
    if (!conflict) throw new SourceError("No merge is waiting on conflicts.", 409);
    const { refs } = await lsRefs(remote);
    const head = refs.get(`refs/heads/${conflict.branch}`);
    if (!head) { this.setState("conflict", null); throw new SourceError(`The branch ${conflict.branch} is gone: ${conflict.kind == "upstream" ? "run Update again" : "Sync now runs the merge again"}.`, 409); }
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
    if (!clean) throw new SourceError("Which file? Give its path, as the conflict lists it.");
    return this.locked(async () => {
      const remote = await this.deps.artifacts();
      const { conflict, head, objects } = await this.conflictHead(remote);
      const headCommit = parseCommit(objects.get(head)!.data);
      const blob: GitObject | null = content == null ? null : { type: "blob", data: utf8(content) };
      const edit = await editTree(objects, headCommit.tree, clean, blob);
      if (edit.tree == headCommit.tree) return { branch: conflict.branch, path: clean, remaining: this.unresolved(conflict, objects, headCommit.tree) };
      const commit = this.commitObject({ tree: edit.tree, parents: [head], who, message: `Resolve ${clean}\n` });
      const sha = await hashObject(commit);
      const r = await receivePack(remote, [{ ref: `refs/heads/${conflict.branch}`, old: head, new: sha }], await writePack([...edit.objects, commit]));
      const said = r.unpack != "ok" ? r.unpack : r.refs.get(`refs/heads/${conflict.branch}`) ?? "no answer";
      if (said != "ok") throw new SourceError(`Artifacts refused it: ${said}`, 502);
      for (const o of edit.objects) objects.set(await hashObject(o), o);
      return { branch: conflict.branch, path: clean, remaining: this.unresolved(conflict, objects, edit.tree) };
    });
  }

  /**
   * Finishes the waiting merge: a merge commit of staging and the other side's commit with the branch's tree (every
   * conflict resolved) moves staging; the branch goes. Refused while a file still carries markers, or when staging moved since.
   */
  async finishUpdate(who: Actor): Promise<{ commit: string; version: string }> {
    return this.locked(async () => {
      const remote = await this.deps.artifacts();
      const { conflict, head, objects } = await this.conflictHead(remote);
      const { refs } = await lsRefs(remote);
      const staging = refs.get(REF("staging"));
      if (staging != conflict.ours) throw new SourceError(`staging moved since this merge started (it was at ${conflict.ours.slice(0, 7)}): ${conflict.kind == "upstream" ? "run Update again" : "Sync now runs the merge again"}.`, 409);
      const tree = parseCommit(objects.get(head)!.data).tree;
      const left = this.unresolved(conflict, objects, tree);
      if (left.length) throw new SourceError(`${left.length} file${left.length == 1 ? " still carries" : "s still carry"} conflict markers: ${left.join(", ")}.`, 409);
      const what = conflict.kind == "upstream" ? `Update from ${this.deps.upstream?.()?.origin.replace(/^https?:\/\//, "") ?? "upstream"} ${conflict.version}` : `Merge GitHub's staging (${conflict.target.slice(0, 7)})`;
      const commit = this.commitObject({ tree, parents: [conflict.ours, conflict.target], who, message: `${what}\n\nConflicts in ${conflict.files.map((f) => f.path).join(", ")} resolved.\n` });
      const sha = await hashObject(commit);
      await this.moveBranch(remote, "staging", conflict.ours, sha, await writePack([commit]), who, conflict.kind == "upstream" ? "update" : "github");
      return { commit: sha, version: conflict.version };
    });
  }

  /** Drops the waiting merge: its branch goes, staging stays. */
  async abandonUpdate(): Promise<void> {
    await this.locked(async () => {
      const conflict = this.state<MergeConflict>("conflict");
      if (!conflict) return;
      const remote = await this.deps.artifacts();
      const { refs } = await lsRefs(remote);
      const drop: RefUpdate[] = [...refs].filter(([r]) => isMergeBranch(r)).map(([ref, s]) => ({ ref, old: s, new: ZERO }));
      if (drop.length) await receivePack(remote, drop, null).catch(() => {});
      this.setState("conflict", null);
      this.deps.changed();
    });
  }

  /** After staging moved: a waiting merge whose other commit staging now has is over (a person merged in a checkout and pushed). */
  private settleConflict(staging: string): void {
    const conflict = this.state<MergeConflict>("conflict");
    if (!conflict || !this.known(conflict.target) || !this.isAncestor(conflict.target, staging)) return;
    this.setState("conflict", null);
    this.deps.background((async () => {
      const remote = await this.deps.artifacts();
      const { refs } = await lsRefs(remote);
      const drop: RefUpdate[] = [...refs].filter(([r]) => isMergeBranch(r)).map(([ref, s]) => ({ ref, old: s, new: ZERO }));
      if (drop.length) await receivePack(remote, drop, null);
    })().catch(() => {}));
  }

  /**
   * Seeds a fork: every object behind `commit` (one of this repository's commits) pushed to `fork`, as its main and
   * staging. The pack goes through as Artifacts sends it: nothing is unpacked here (the whole history is some 20MB).
   */
  async seedFork(fork: Remote, commit: string): Promise<void> {
    if (!isSha(commit)) throw new SourceError("Name the commit by its full id (40 hex digits).");
    await this.locked(async () => {
      const remote = await this.deps.artifacts();
      const { refs } = await lsRefs(remote);
      await this.sync(remote, [commit].filter(() => [...refs.values()].includes(commit)));
      if (!this.known(commit)) throw new SourceError(`${commit.slice(0, 7)} isn't one of this repository's commits.`, 409);
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

  // ---- Releases (tags) ------------------------------------------------------------

  /** The release tags, newest version first. */
  tags(): TagInfo[] {
    return this.deps.db.exec<{ name: string; sha: string; commit_sha: string; tagger: string; at: number; message: string }>("SELECT name, sha, commit_sha, tagger, at, message FROM tags")
      .map((r) => ({ name: r.name, sha: r.sha, commit: r.commit_sha, tagger: r.tagger, at: r.at, message: r.message }))
      .sort((a, b) => compareVersions(b.name, a.name));
  }

  /** Indexes the release tags Artifacts has that the index doesn't: each tag object (or plain tag's commit) fetched and read. */
  private async syncTags(remote: Remote, tagRefs: Map<string, string>) {
    const known = new Set(this.deps.db.exec<{ name: string }>("SELECT name FROM tags").map((r) => r.name));
    const missing = [...tagRefs].filter(([ref]) => isReleaseTag(ref.slice(TAGS.length)) && !known.has(ref.slice(TAGS.length)));
    if (!missing.length) return;
    const objects = await readPack(await fetchPack(remote, { wants: missing.map(([, sha]) => sha), haves: this.heads().filter((s) => this.known(s)), filter: "blob:none" }), (t) => t == "tag" || t == "commit");
    for (const [sha, o] of objects) if (o.type == "commit") this.index(sha, parseCommit(o.data));
    for (const [ref, sha] of missing) {
      const name = ref.slice(TAGS.length), o = objects.get(sha);
      if (o?.type == "tag") {
        const t = parseTag(o.data);
        this.deps.db.exec("INSERT OR IGNORE INTO tags (name, sha, commit_sha, tagger, at, message) VALUES (?, ?, ?, ?, ?, ?)", name, sha, t.object, t.tagger.name, t.tagger.time * 1000, t.message.trim());
      } else if (this.known(sha)) {
        const [c] = this.rows([sha]);
        this.deps.db.exec("INSERT OR IGNORE INTO tags (name, sha, commit_sha, tagger, at, message) VALUES (?, ?, ?, ?, ?, ?)", name, sha, sha, c?.author ?? "", c?.committed ?? 0, "");
      }
    }
  }

  /**
   * Cuts a release: an annotated tag `version` (the next one, if not given) on
   * main's head (or `commit`, one of main's commits), by `who`. Each release
   * is newer than the last. Returns the tag.
   */
  async release(who: Actor, o: { version?: string; notes?: string; commit?: string } = {}): Promise<Released> {
    if (o.commit != null && !isSha(o.commit)) throw new SourceError("Name the commit by its full id (40 hex digits).");
    return this.locked(async () => {
      const remote = await this.deps.artifacts();
      const [{ refs }, { refs: tagRefs }] = await Promise.all([lsRefs(remote), lsRefs(remote, TAGS)]);
      const main = refs.get(REF("main"));
      if (!main) throw new SourceError("main has no commits yet: nothing to release.", 409);
      await this.sync(remote, [main]);
      await this.syncTags(remote, tagRefs);
      const tags = this.tags();
      const version = (o.version ?? "").trim() || nextVersion(tags[0]?.name ?? null);
      const wrong = this.checkVersion(version, tags[0]?.name ?? null, tagRefs);
      if (wrong) throw new SourceError(wrong, 409);
      const commit = o.commit ?? main;
      if (!this.known(commit) || !this.isAncestor(commit, main)) throw new SourceError(`${commit.slice(0, 7)} isn't one of main's commits: a release is cut from main.`, 409);
      const message = (o.notes ?? "").trim() || `Release ${version}`;
      const time = Math.floor(this.now() / 1000);
      const object: GitObject = { type: "tag", data: tagBytes({ object: commit, type: "commit", tag: version, tagger: { name: who.name || who.login, email: `${who.login}@users.noreply.github.com`, time, tz: "+0000" }, message }) };
      const sha = await hashObject(object);
      const r = await receivePack(remote, [{ ref: `${TAGS}${version}`, old: ZERO, new: sha }], await writePack([object]));
      const said = r.unpack != "ok" ? r.unpack : r.refs.get(`${TAGS}${version}`) ?? "no answer";
      if (said != "ok") throw new SourceError(`Artifacts refused the tag: ${said}`, 409);
      const released: Released = { tag: version, commit, sha, by: who.login, via: who.via ?? null, at: this.now(), message };
      this.recordRelease(released, who.name || who.login);
      return released;
    });
  }

  /** Why `version` can't be the next release, or null: the shape, and newer than the newest. */
  private checkVersion(version: string, latest: string | null, tagRefs: Map<string, string>): string | null {
    if (!isReleaseTag(version)) return `A release is a version tag like v1.2.3 (numbers only, v first): "${version}" isn't one.`;
    if (tagRefs.has(`${TAGS}${version}`)) return `${version} is already a release.`;
    if (latest && compareVersions(version, latest) <= 0) return `${version} isn't newer than the newest release, ${latest}: the next is ${nextVersion(latest)} or more.`;
    return null;
  }

  private recordRelease(r: Released, tagger: string) {
    this.deps.db.exec("INSERT OR REPLACE INTO tags (name, sha, commit_sha, tagger, at, message) VALUES (?, ?, ?, ?, ?, ?)", r.tag, r.sha, r.commit, tagger, r.at, r.message);
    this.deps.released?.(r);
    this.deps.changed();
    if (this.githubLink()) this.deps.background(this.syncGithub(byLine(r.by, r.via)).catch(() => {}));
  }

  /**
   * Groups each task's commits under its merge: a task merge in `list` gets `task`, and its commits (those its second
   * parent brings that its first parent doesn't have) follow it, newest first, marked `inTask`. With `complete`, the
   * task's commits that `list` doesn't have are added, so a card holds all of them (up to TASK_COMMITS). Other commits
   * keep their place.
   */
  private withTasks(list: CommitInfo[], commit: (r: Row) => CommitInfo, complete = true): CommitInfo[] {
    const nodes = this.nodes(), claimed = new Map<string, string>(), members = new Map<string, string[]>();
    for (const x of list) {
      const m = TASK_MERGE.exec(x.subject);
      if (!m || x.parents.length < 2 || claimed.has(x.sha)) continue;
      const base = this.ancestors(x.parents[0]), seen = new Set<string>(), todo = [x.parents[1]];
      while (todo.length && seen.size < TASK_COMMITS) {
        const s = todo.pop()!;
        if (seen.has(s) || base.has(s) || claimed.has(s) || !nodes.has(s)) continue;
        seen.add(s);
        todo.push(...nodes.get(s)!.parents);
      }
      const own = [...seen].sort((a, b) => nodes.get(b)!.committed - nodes.get(a)!.committed);
      for (const s of own) claimed.set(s, x.sha);
      members.set(x.sha, own);
      x.task = { id: Number(m[2]), branch: m[1], title: m[3], commits: own };
    }
    if (!members.size) return list;
    const by = new Map(list.map((x) => [x.sha, x]));
    const out: CommitInfo[] = [];
    for (const x of list) {
      if (claimed.has(x.sha)) continue;
      out.push(x);
      const own = members.get(x.sha);
      if (!own) continue;
      const extra = new Map(complete ? this.rows(own.filter((s) => !by.has(s))).map((r) => [r.sha, commit(r)]) : []);
      for (const s of own) { const c = by.get(s) ?? extra.get(s); if (c) out.push({ ...c, inTask: x.sha }); }
    }
    return out;
  }

  moves(limit: number): Move[] {
    return this.deps.db.exec<Move>("SELECT branch, old, new, how, by, via, at FROM moves ORDER BY id DESC LIMIT ?", limit);
  }

  // ---- Pushes (git push, through Erga's /git endpoint) ------------------------------

  /**
   * The receive-pack advertisement Erga gives a pusher: only staging and main, and what Erga's receive-pack does.
   */
  async advertise(): Promise<Uint8Array> {
    const remote = await this.deps.artifacts();
    const { refs } = await lsRefs(remote);
    const { refs: tagRefs } = await lsRefs(remote, TAGS);
    const caps = "report-status side-band-64k quiet ofs-delta delete-refs agent=erga";
    const names = BRANCHES.map(REF);
    const lines = [...names.filter((r) => refs.has(r)).map((r) => `${refs.get(r)} ${r}`), ...[...tagRefs].map(([r, sha]) => `${sha} ${r}`)];
    if (!lines.length) lines.push(`${ZERO} capabilities^{}`);
    return concat([pkt("# service=git-receive-pack\n"), FLUSH, ...lines.map((l, i) => pkt(`${l}${i == 0 ? `\0${caps}` : ""}\n`)), FLUSH]);
  }

  /**
   * A `git push`: the receive-pack request's body in, the report out (in side-band if the client asked).
   * An admin pushes staging and main: only staging and main are Erga's branches. And release tags (vX.Y.Z, new, newer
   * than the newest, on a commit of main after this push's own moves): each is a release cut.
   */
  async receive(body: Uint8Array, who: Actor): Promise<Uint8Array> {
    const { pkts, end } = readPkts(body, 0, (p) => p.kind == "flush");
    const commands: RefUpdate[] = [];
    let caps = new Set<string>();
    for (const p of pkts) {
      if (p.kind != "data") continue;
      let line = text(p.data).replace(/\n$/, "");
      const nul = line.indexOf("\0");
      if (nul >= 0) { caps = new Set(line.slice(nul + 1).split(" ")); line = line.slice(0, nul); }
      const [old, sha, ref] = line.split(" ");
      if (isSha(old) && isSha(sha) && ref) commands.push({ old, new: sha, ref });
    }
    // Git asks with nothing first (a probe, before a big push): nothing to say.
    if (!commands.length) return new Uint8Array();
    const pack = body.subarray(end);
    const messages: string[] = [];
    const { unpack, statuses } = await this.locked(async () => {
      const remote = await this.deps.artifacts();
      const { refs } = await lsRefs(remote);
      const { refs: tagRefs } = await lsRefs(remote, TAGS);
      const statuses = new Map<string, string>();
      const accepted: (RefUpdate & { branch: Branch })[] = [];
      const tagging: RefUpdate[] = [];
      for (const c of commands) {
        const branch = BRANCHES.find((b) => REF(b) == c.ref);
        if (c.ref.startsWith(TAGS)) {
          const name = c.ref.slice(TAGS.length);
          if (!isReleaseTag(name)) statuses.set(c.ref, "Erga takes release tags only: a version like v1.2.3 (numbers only, v first)");
          else if (c.new == ZERO || tagRefs.has(c.ref)) statuses.set(c.ref, "a release tag is never moved or deleted");
          else tagging.push(c);
        }
        else if (!branch) statuses.set(c.ref, isMergeBranch(c.ref) ? "that branch is Erga's own (the merge that conflicted): merge in your checkout and push the result to staging" : "Erga has two branches, staging and main: push to one of those");
        else if (c.new == ZERO) statuses.set(c.ref, `${branch} can't be deleted`);
        else if ((refs.get(c.ref) ?? ZERO) != c.old) statuses.set(c.ref, "stale info: it moved since you fetched; fetch first");
        else accepted.push({ ...c, branch });
      }
      // Quarantine branches left by a push that stopped halfway go now too.
      const leftovers: RefUpdate[] = [...refs].filter(([r]) => r.startsWith(QUARANTINE)).map(([ref, sha]) => ({ ref, old: sha, new: ZERO }));
      let unpack = "ok";
      if (accepted.length) {
        const id = crypto.randomUUID().slice(0, 8);
        const staged = accepted.map((c) => ({ ...c, quarantine: `${QUARANTINE}${id}-${c.branch}` }));
        const first = await receivePack(remote, staged.map((c) => ({ ref: c.quarantine, old: ZERO, new: c.new })), pack.length ? pack : await emptyPack());
        if (first.unpack != "ok") {
          unpack = first.unpack;
          for (const c of staged) statuses.set(c.ref, `Artifacts couldn't take the objects: ${first.unpack}`);
        } else {
          const landed = staged.filter((c) => {
            const said = first.refs.get(c.quarantine) ?? "no answer";
            if (said != "ok") statuses.set(c.ref, `Artifacts refused it: ${said}`);
            return said == "ok";
          });
          await this.sync(remote, landed.map((c) => c.new));
          const moving = this.allowed(landed, refs, statuses);
          const drop = [...staged.filter((c) => first.refs.get(c.quarantine) == "ok").map((c) => ({ ref: c.quarantine, old: c.new, new: ZERO })), ...leftovers];
          const final = await receivePack(remote, [...moving.map(({ ref, old, new: sha }) => ({ ref, old, new: sha })), ...drop], moving.length ? await emptyPack() : null);
          for (const c of moving) {
            const said = final.refs.get(c.ref) ?? final.unpack;
            statuses.set(c.ref, said);
            if (said == "ok") {
              this.recordMove({ branch: c.branch, old: c.old, new: c.new, how: "push", by: who.login, via: who.via ?? null, at: this.now() });
              const before = c.old == ZERO ? null : this.ancestors(c.old);
              const count = before ? [...this.ancestors(c.new)].filter((s) => !before.has(s)).length : null;
              messages.push(`Erga: ${c.branch} is now ${c.new.slice(0, 7)}${count != null ? ` (${count} new commit${count == 1 ? "" : "s"})` : ""}.`);
            }
          }
        }
      } else if (leftovers.length) {
        await receivePack(remote, leftovers, null).catch(() => {});
      }
      // Release tags, after the branches moved: each must mark a commit of main (as it is now), be a new version, and
      // come as an annotated tag in the pack or point straight at the commit.
      if (tagging.length && unpack == "ok") {
        const main = accepted.find((c) => c.branch == "main" && statuses.get(c.ref) == "ok")?.new ?? refs.get(REF("main")) ?? ZERO;
        const objects = pack.length ? await readPack(pack, (t) => t == "tag") : new Map<string, GitObject>();
        await this.syncTags(remote, tagRefs);
        let latest = this.tags()[0]?.name ?? null;
        const seen = new Map(tagRefs);
        for (const c of tagging.sort((a, b) => compareVersions(a.ref, b.ref))) {
          const name = c.ref.slice(TAGS.length);
          const object = objects.get(c.new);
          const tag = object ? parseTag(object.data) : null;
          const commit = tag ? tag.object : c.new;
          const wrong = this.checkVersion(name, latest, seen) ?? (tag && tag.type != "commit" ? "a release tag marks a commit" : null)
            ?? (main == ZERO || !this.known(commit) || !this.isAncestor(commit, main) ? `${commit.slice(0, 7)} isn't one of main's commits: a release is cut from main (merge first)` : null);
          if (wrong) { statuses.set(c.ref, wrong); continue; }
          const r = await receivePack(remote, [{ ref: c.ref, old: ZERO, new: c.new }], await writePack(object ? [object] : []));
          const said = r.unpack != "ok" ? r.unpack : r.refs.get(c.ref) ?? "no answer";
          statuses.set(c.ref, said);
          if (said != "ok") continue;
          latest = name;
          seen.set(c.ref, c.new);
          const message = tag?.message.trim() || `Release ${name}`;
          this.recordRelease({ tag: name, commit, sha: c.new, by: who.login, via: who.via ?? null, at: this.now(), message }, tag?.tagger.name || who.name || who.login);
          messages.push(`Erga: release ${name} cut at ${commit.slice(0, 7)}.`);
        }
      }
      return { unpack, statuses };
    });
    if (messages.length && this.githubLink()) messages.push("Erga: GitHub syncs in the background.");
    const report = concat([pkt(`unpack ${unpack}\n`), ...commands.map((c) => {
      const s = statuses.get(c.ref) ?? "not processed";
      return pkt(s == "ok" ? `ok ${c.ref}\n` : `ng ${c.ref} ${s}\n`);
    }), FLUSH]);
    if (!caps.has("side-band-64k") && !caps.has("side-band")) return report;
    const max = caps.has("side-band-64k") ? 65515 : 995;
    return concat([...messages.flatMap((m) => toSideBand(utf8(`${m}\n`), 2, max)), ...toSideBand(report, 1, max), FLUSH]);
  }

  private recordMove(m: Move) {
    this.deps.db.exec("INSERT INTO moves (branch, old, new, how, by, via, at) VALUES (?, ?, ?, ?, ?, ?, ?)", m.branch, m.old, m.new, m.how, m.by, m.via ?? null, m.at);
    const tips = this.state<Record<string, string>>("tips") ?? {};
    this.setState("tips", { ...tips, [m.branch]: m.new });
    if (m.branch == "staging") this.settleConflict(m.new);
    this.deps.moved(m);
    this.deps.changed();
    // The sync with GitHub is the mover's: it follows what they did.
    if (this.githubLink()) this.deps.background(this.syncGithub(byLine(m.by, m.via)).catch(() => {}));
  }

  /**
   * The strict model: two branches, staging always at or ahead of main, main
   * only following staging. Of these updates (whose commits are indexed),
   * the ones that keep it; the others get the reason in `statuses`.
   */
  private allowed<T extends RefUpdate & { branch: Branch }>(updates: T[], refs: Map<string, string>, statuses: Map<string, string>): T[] {
    let ok = [...updates];
    for (let round = 0; round < 3; round++) {
      const after = (b: Branch) => ok.find((u) => u.branch == b)?.new ?? refs.get(REF(b)) ?? ZERO;
      const next = ok.filter((u) => {
        if (u.branch == "main") {
          if (u.old != ZERO && !this.isAncestor(u.old, u.new)) return refuse(u, "main only moves forward (fast-forward): it follows staging");
          const staging = after("staging");
          if (staging == ZERO || !this.isAncestor(u.new, staging)) return refuse(u, "main only follows staging: push the commit to staging first (git push erga HEAD:staging), then merge it on the Ops page, or push both at once (git push erga HEAD:staging HEAD:main)");
          return true;
        }
        const main = after("main");
        if (main != ZERO && !this.isAncestor(main, u.new)) return refuse(u, "staging is always at or ahead of main, and this would drop commits main has: rebase onto main and push again");
        return true;
      });
      if (next.length == ok.length) return ok;
      ok = next;
    }
    return ok;
    function refuse(u: T, why: string) { statuses.set(u.ref, why); return false; }
  }

  // ---- Merging (the Ops page, POST /api/source/merge) ------------------------------

  /**
   * Moves main forward to staging's head, or to `commit`, one of staging's
   * commits that main doesn't have yet: always a fast-forward, since main
   * only follows staging. Returns where main is now.
   */
  async merge(who: Actor, commit?: string): Promise<{ commit: string; fastForward: boolean; upToDate: boolean }> {
    if (commit != null && !isSha(commit)) throw new SourceError("Name the commit by its full id (40 hex digits).");
    return this.locked(async () => {
      const remote = await this.deps.artifacts();
      const { refs } = await lsRefs(remote);
      const staging = refs.get(REF("staging")), main = refs.get(REF("main"));
      if (!staging) throw new SourceError("staging has no commits yet.", 409);
      await this.sync(remote, [staging, ...(main ? [main] : [])]);
      const target = commit ?? staging;
      if (!this.isAncestor(target, staging)) throw new SourceError(`${target.slice(0, 7)} isn't one of staging's commits.`, 409);
      if (main && this.isAncestor(target, main)) return { commit: main, fastForward: false, upToDate: true };
      if (main && !this.isAncestor(main, target)) throw new SourceError("main has commits staging doesn't: that shouldn't happen. Push main's commits to staging first.", 409);
      const r = await receivePack(remote, [{ ref: REF("main"), old: main ?? ZERO, new: target }], await emptyPack());
      const said = r.unpack != "ok" ? r.unpack : r.refs.get(REF("main")) ?? "no answer";
      if (said != "ok") throw new SourceError(/stale|lock|old/i.test(said) ? "main moved while merging: try again." : `Artifacts refused it: ${said}`, 409);
      this.recordMove({ branch: "main", old: main ?? ZERO, new: target, how: "merge", by: who.login, via: who.via ?? null, at: this.now() });
      return { commit: target, fastForward: true, upToDate: false };
    });
  }

  // ---- GitHub: the repository Erga is connected to there ---------------------------------

  /** The repository on GitHub Erga is connected to (Connect GitHub on the Ops page), or null. */
  githubLink(): GithubLink | null { return this.state<GithubLink>("github-link"); }

  /** What the Ops page shows of GitHub: the link, the sync's state, and how its last run went. */
  githubStatus(): GithubStatus {
    const link = this.githubLink();
    const saved = this.state<SyncRecord>("github") ?? { lastSyncAt: null, lastSyncBy: null, error: null };
    return { connected: !!link, link, state: !link ? "off" : this.syncing ? "syncing" : "idle", lastSyncAt: saved.lastSyncAt, lastSyncBy: saved.lastSyncBy ?? null, error: saved.error, ...(saved.refs ? { refs: saved.refs } : {}) };
  }

  /** Connected: the link kept, and a first sync (staging, main and the releases go there; what GitHub has comes in). */
  async connectGithub(link: GithubLink, by: string): Promise<GithubStatus> {
    this.setState("github-link", link);
    this.setState("github", { lastSyncAt: null, lastSyncBy: null, error: null } satisfies SyncRecord);
    this.githubToken = null;
    this.deps.changed();
    return this.syncGithub(by, { login: SYSTEM, name: "Erga" });
  }

  /** Disconnected: the link forgotten, the App uninstalled from the account (where it can be), a waiting merge from GitHub dropped. */
  async disconnectGithub(): Promise<void> {
    const link = this.githubLink();
    if (!link) return;
    await this.deps.githubUninstall?.(link.installationId).catch(() => {});
    this.setState("github-link", null);
    this.setState("github", { lastSyncAt: null, lastSyncBy: null, error: null } satisfies SyncRecord);
    this.githubToken = null;
    if (this.state<MergeConflict>("conflict")?.kind == "github") await this.abandonUpdate();
    this.deps.changed();
  }

  /** The linked repository as a Git remote, with an installation token (minted through the App; kept while it has ten minutes left). */
  private async githubRemote(link: GithubLink): Promise<Remote> {
    if (!this.deps.githubToken) throw new SourceError("This server can't reach GitHub as the App (no key to mint installation tokens).", 503);
    if (!this.githubToken || this.githubToken.installationId != link.installationId || this.githubToken.expiresAt - this.now() < 10 * 60_000) {
      const t = await this.deps.githubToken(link.installationId);
      this.githubToken = { installationId: link.installationId, ...t };
    }
    return asRemote(link.repo.cloneUrl, this.githubToken.token);
  }

  /**
   * A push event from the webhook: a sync, when it is the linked repository's (null: not ours). A push of ours echoed
   * back (GitHub's branch is where the last sync left it), or of something that isn't staging or main, syncs nothing.
   * `sender`: who pushed on GitHub.
   */
  githubPushed(event: PushEvent): Promise<GithubStatus> | null {
    const link = this.githubLink();
    if (!link || event.repository?.id != link.repo.id) return null;
    const branch = event.ref?.startsWith("refs/heads/") ? event.ref.slice("refs/heads/".length) : null;
    const saved = this.state<SyncRecord>("github");
    if (!branch || !(BRANCHES as readonly string[]).includes(branch) || (saved?.refs?.[branch as Branch] == event.after && !saved?.error)) return Promise.resolve(this.githubStatus());
    const sender = event.sender?.login || event.pusher?.name || "someone";
    return this.syncGithub(byLine(sender, VIA.github), { login: sender, name: sender, via: VIA.github });
  }

  /**
   * Brings GitHub and this repository together: after each move here (in the background), after each push there
   * (the webhook), and on Sync now. What GitHub has that this repository doesn't comes in first (staging fast-forwards,
   * or a merge commit is made here; main only to a commit of staging), then staging, main and the release tags go
   * to GitHub. A failure is recorded, never blocks anything. `by`: for whom (byLine); `who`: the actor of a merge made here.
   */
  syncGithub(by: string = SYSTEM, who?: Actor): Promise<GithubStatus> {
    this.syncBy = by;
    if (who) this.syncWho = who;
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    this.syncing = (async () => {
      let status = this.githubStatus();
      do {
        this.syncAgain = false;
        this.deps.changed();
        status = await this.syncOnce();
      } while (this.syncAgain);
      return status;
    })().finally(() => { this.syncing = null; this.syncWho = null; this.deps.changed(); });
    return this.syncing;
  }

  private async syncOnce(): Promise<GithubStatus> {
    const link = this.githubLink();
    if (!link) return this.githubStatus();
    const saved = this.state<SyncRecord>("github") ?? { lastSyncAt: null, lastSyncBy: null, error: null };
    const record: SyncRecord = { lastSyncAt: saved.lastSyncAt, lastSyncBy: saved.lastSyncBy ?? null, error: null, ...(saved.refs ? { refs: saved.refs } : {}) };
    const by = this.syncBy, who = this.syncWho ?? { login: SYSTEM, name: "Erga" };
    const problems: string[] = [];
    try {
      const gh = await this.githubRemote(link);
      const remote = await this.deps.artifacts();
      await this.locked(async () => {
        const [{ refs }, { refs: tagRefs }, advert] = await Promise.all([lsRefs(remote), lsRefs(remote, TAGS), receiveAdvert(gh)]);
        await this.sync(remote, BRANCHES.map((b) => refs.get(REF(b))).filter((s): s is string => !!s));
        // In: what GitHub's branches have that ours don't. A branch there still where the last sync left it has nothing
        // new, whatever moved here since (a rewrite of staging here goes out as it is, as a push here allowed it).
        for (const b of BRANCHES) {
          const ours = refs.get(REF(b)) ?? null, theirs = advert.refs.get(REF(b)) ?? null;
          if (!theirs || theirs == ours || theirs == saved.refs?.[b] || (ours && this.known(theirs) && this.isAncestor(theirs, ours))) continue;
          const r = await this.takeFromGithub(remote, gh, b, ours, theirs, refs, who);
          if ("problem" in r) problems.push(r.problem);
          else refs.set(REF(b), r.head);
        }
        // Out: our branches and release tags, where GitHub is behind (or has nothing).
        const updates: RefUpdate[] = [];
        for (const [ref, sha] of tagRefs) if (isReleaseTag(ref.slice(TAGS.length)) && !advert.refs.has(ref)) updates.push({ ref, old: ZERO, new: sha });
        for (const b of BRANCHES) {
          const ours = refs.get(REF(b)), theirs = advert.refs.get(REF(b)) ?? ZERO;
          if (!ours || ours == theirs) continue;
          // GitHub's head isn't behind ours, nor where we left it: the take above said why, and a push would drop its commits.
          if (theirs != ZERO && theirs != saved.refs?.[b] && !(this.known(theirs) && this.isAncestor(theirs, ours))) continue;
          updates.push({ ref: REF(b), old: theirs, new: ours });
        }
        if (updates.length) {
          const haves = [...advert.refs.values()].filter((s) => this.known(s));
          const pack = await fetchPack(remote, { wants: updates.map((u) => u.new), haves });
          const r = await receivePack(gh, updates, pack);
          if (r.unpack != "ok") problems.push(`GitHub couldn't take the objects: ${r.unpack}`);
          else for (const u of updates) { const said = r.refs.get(u.ref) ?? "no answer"; if (said != "ok") problems.push(`GitHub refused ${u.ref.slice(11)}: ${said}`); }
        }
        // Where the sync left GitHub's branches: what it pushed, or GitHub's head when ours has it (taken in, or the same). A
        // head it refused (GitHub's main off staging) isn't ours to call synced: the last value stays, and the next pass
        // looks at it again.
        record.refs = Object.fromEntries(BRANCHES.map((b) => {
          const pushed = updates.find((u) => u.ref == REF(b))?.new, ours = refs.get(REF(b)), theirs = advert.refs.get(REF(b));
          return [b, pushed ?? (theirs && ours && this.known(theirs) && this.isAncestor(theirs, ours) ? theirs : saved.refs?.[b])];
        }).filter(([, s]) => s));
      });
    } catch (e) {
      problems.push(e instanceof RemoteError || e instanceof SourceError || e instanceof GithubError ? e.message : `the sync failed: ${(e as Error).message}`);
    }
    if (!problems.length) { record.lastSyncAt = this.now(); record.lastSyncBy = by; }
    record.error = problems.length ? problems.join(". ").replace(/\.\.$/, ".") + (problems.join("").endsWith(".") ? "" : ".") : null;
    this.setState("github", record);
    return this.githubStatus();
  }

  /**
   * GitHub's `branch` moved past ours (`theirs` isn't behind `ours`): its objects come in under a tracking branch, and
   * then staging fast-forwards, or merges (a merge commit here, or the conflict on its branch); main moves only to a
   * commit of staging. The new head, or why not. Inside the lock.
   */
  private async takeFromGithub(remote: Remote, gh: Remote, branch: Branch, ours: string | null, theirs: string, refs: Map<string, string>, who: Actor): Promise<{ head: string } | { problem: string }> {
    const track = `${GITHUB_TRACK}${branch}`;
    const tracked = refs.get(track) ?? null;
    if (tracked != theirs) {
      const haves = [...new Set([tracked, ours, ...this.heads()].filter((s): s is string => !!s && this.known(s)))];
      const pack = await fetchPack(gh, { wants: [theirs], haves });
      const r = await receivePack(remote, [{ ref: track, old: tracked ?? ZERO, new: theirs }], pack);
      const said = r.unpack != "ok" ? r.unpack : r.refs.get(track) ?? "no answer";
      if (said != "ok") return { problem: `Artifacts didn't take GitHub's ${branch} (${said})` };
      refs.set(track, theirs);
    }
    await this.sync(remote, [theirs]);
    const short = theirs.slice(0, 7);
    if (!this.known(theirs)) return { problem: `GitHub's ${branch} (${short}) couldn't be read` };
    if (branch == "main") {
      const staging = refs.get(REF("staging"));
      if (!staging || !this.isAncestor(theirs, staging)) return { problem: `GitHub's main is at ${short}, which isn't a commit of staging. main only follows staging: push it to staging first (or move GitHub's main back)` };
      if (ours && !this.isAncestor(ours, theirs)) return { problem: `GitHub's main is at ${short}, which isn't forward of main here (${ours.slice(0, 7)}): move GitHub's main back` };
      await this.moveBranch(remote, "main", ours, theirs, null, who, "github");
      return { head: theirs };
    }
    if (!ours || this.isAncestor(ours, theirs)) {
      await this.moveBranch(remote, "staging", ours, theirs, null, who, "github");
      return { head: theirs };
    }
    // Both moved: a merge commit here, or the merge with its conflicts on a branch, for an admin.
    const waiting = this.state<MergeConflict>("conflict");
    if (waiting) return { problem: `GitHub's staging (${short}) and staging here have each moved, and a merge already waits on conflicts (${waiting.branch}): resolve or drop it first` };
    const merged = await this.threeWay(remote, { ours, theirs, base: this.mergeBase(ours, theirs), who, labels: { ours: "staging", theirs: `github/staging` }, kind: "github", version: theirs.slice(0, 12), branch: `${GITHUB_MERGE_BRANCH}${theirs.slice(0, 12)}`, message: `Merge GitHub's staging (${short})` });
    if (merged.result == "merged") return { head: merged.commit };
    const n = merged.conflict.files.length;
    return { problem: `GitHub's staging (${short}) conflicts with staging here in ${n} file${n == 1 ? "" : "s"}: the merge waits on ${merged.conflict.branch}` };
  }

  // ---- Reading a commit, for a build -------------------------------------------------

  /** Every file in `commit` (which must be a branch's head, so Artifacts lets it be asked for), by path. */
  async files(commit: string): Promise<{ path: string; mode: string; data: Uint8Array }[]> {
    const remote = await this.deps.artifacts();
    const objects = await readPack(await fetchPack(remote, { wants: [commit], deepen: 1 }));
    const c = objects.get(commit);
    if (!c || c.type != "commit") throw new SourceError(`Artifacts didn't send commit ${commit.slice(0, 7)}`, 502);
    const out: { path: string; mode: string; data: Uint8Array }[] = [];
    const walk = (tree: string, at: string) => {
      const t = objects.get(tree);
      if (!t) throw new SourceError(`Artifacts didn't send tree ${tree.slice(0, 7)}`, 502);
      for (const e of parseTree(t.data)) {
        const path = at ? `${at}/${e.name}` : e.name;
        if (isTreeMode(e.mode)) walk(e.sha, path);
        else if (e.mode != "160000") out.push({ path, mode: e.mode, data: objects.get(e.sha)?.data ?? new Uint8Array() });
      }
    };
    walk(parseCommit(c.data).tree, "");
    return out;
  }

  // ---- Reading the source, for the admin's agent and the deploys ------------------------

  /**
   * What the admin's agent's source tools ask: a folder's listing, a file's lines, a search,
   * or the log, at a branch (staging if none is named; also main, or a task's branch) or a commit. Read-only: it
   * only lists refs and fetches, with a read token. Throws a SourceError the agent can act on.
   */
  async read(q: SourceRead): Promise<SourceAnswer> {
    const remote = await (this.deps.reader ?? this.deps.artifacts)();
    const { ref, commit, head } = await this.resolve(remote, q.ref);
    try {
      if (q.op == "log") {
        if (!head) throw new SourceError("The log starts at a branch: name one (staging, main or a task's branch), not a commit.");
        await this.locked(() => this.sync(remote, [commit]));
        const skip = Math.max(0, Math.floor(Number(q.skip) || 0)), limit = Math.max(1, Math.min(LOG, Math.floor(Number(q.limit) || 20)));
        const rows = this.log(commit, skip + limit).slice(skip);
        if (!rows.length) return { ref, commit, text: `${ref} has no commits past the first ${skip}.` };
        const lines = rows.map((r) => `${r.sha.slice(0, 10)} ${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")} ${r.author}: ${r.subject}${r.parents.includes(" ") ? " (merge)" : ""}`);
        const more = rows.length == limit ? `\n… older commits: skip ${skip + limit}.` : "";
        return { ref, commit, text: `${ref} (${commit.slice(0, 10)}), commits ${skip + 1} to ${skip + rows.length}, newest first:\n${lines.join("\n")}${more}` };
      }
      const snap = await this.snapshot(remote, commit, head);
      if (q.op == "view") return { ref, commit, text: "", view: view(snap, cleanPath(q.path)) };
      const text = q.op == "list" ? list(snap, cleanPath(q.path), !!q.recursive)
        : q.op == "read" ? read(snap, cleanPath(q.path), q.from, q.to)
          : search(snap, q);
      return { ref, commit, text };
    } catch (e) {
      throw e instanceof BrowseError ? new SourceError(e.message) : e;
    }
  }

  /**
   * For the factory: every branch's head, and staging's newest LOG commits
   * (sha and subject), so it can see whether a task's merge reached staging. Read-only, with a read token.
   */
  async stagingLog(): Promise<{ heads: Record<string, string>; commits: { sha: string; subject: string }[] }> {
    const remote = await (this.deps.reader ?? this.deps.artifacts)();
    const { refs } = await lsRefs(remote);
    const heads = Object.fromEntries([...refs].filter(([r]) => r.startsWith("refs/heads/") && !r.startsWith(QUARANTINE)).map(([r, s]) => [r.slice("refs/heads/".length), s]));
    if (!heads.staging) return { heads, commits: [] };
    await this.locked(() => this.sync(remote, [heads.staging]));
    return { heads, commits: this.log(heads.staging, LOG).map((r) => ({ sha: r.sha, subject: r.subject })) };
  }

  /**
   * A branch's head, or a commit (all 40 hex digits, or the first 7 or more of one the index has): staging if none.
   * `head`: it is a branch's head, which Artifacts sends; another commit, it may refuse.
   */
  private async resolve(remote: Remote, asked?: string): Promise<{ ref: string; commit: string; head: boolean }> {
    const name = String(asked ?? "").trim().replace(/^refs\/heads\//, "").replace(/^origin\//, "") || "staging";
    const { refs } = await lsRefs(remote);
    const branches = [...refs].filter(([r]) => !r.startsWith(QUARANTINE));
    const hit = branches.find(([r]) => r == `refs/heads/${name}`);
    if (hit) return { ref: name, commit: hit[1], head: true };
    if (/^[0-9a-f]{7,40}$/i.test(name)) {
      const sha = name.toLowerCase();
      const heads = branches.filter(([, s]) => s.startsWith(sha));
      if (heads.length == 1) return { ref: heads[0][0].slice("refs/heads/".length), commit: heads[0][1], head: true };
      if (isSha(sha)) return { ref: sha.slice(0, 10), commit: sha, head: false };
      const known = this.deps.db.exec<{ sha: string }>("SELECT sha FROM commits WHERE sha LIKE ? LIMIT 2", `${sha}%`);
      if (known.length == 1) return { ref: sha, commit: known[0].sha, head: false };
      if (known.length > 1) throw new SourceError(`More than one commit starts with ${sha}: give more of it.`);
    }
    const rank = (b: string) => (b == "staging" ? 0 : b == "main" ? 1 : 2);
    const names = branches.map(([r]) => r.slice("refs/heads/".length)).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
    throw new SourceError(`There's no branch or known commit "${name}". The branches: ${names.slice(0, 30).join(", ")}${names.length > 30 ? `, and ${names.length - 30} more` : ""}.`, 404);
  }

  /** A commit's files: fetched once, then kept (the last 3 commits read). */
  private snapshot(remote: Remote, commit: string, head: boolean): Promise<Snapshot> {
    let s = this.snapshots.get(commit);
    if (s) { this.snapshots.delete(commit); this.snapshots.set(commit, s); return s; }
    s = (async () => {
      const objects = await readPack(await fetchPack(remote, { wants: [commit], deepen: 1 })).catch((e: unknown) => {
        throw new SourceError(head ? `Artifacts didn't send ${commit.slice(0, 10)}: ${(e as Error).message}` : `Artifacts didn't send commit ${commit.slice(0, 10)} (it may send only a branch's head): name a branch instead.`, 502);
      });
      try { return snapshotOf(commit, objects); } catch (e) { throw new SourceError(`Artifacts didn't send all of ${commit.slice(0, 10)}: ${(e as Error).message}`, 502); }
    })();
    s.catch(() => this.snapshots.delete(commit));
    this.snapshots.set(commit, s);
    while (this.snapshots.size > 3) this.snapshots.delete(this.snapshots.keys().next().value!);
    return s;
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

/** A remote's URL as shown: no credentials in it. */
export function publicUrl(url: string): string {
  try { const u = new URL(url); u.username = ""; u.password = ""; return u.toString(); } catch { return url; }
}

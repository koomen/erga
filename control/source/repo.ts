// Erga's own repository: the canonical copy is a Cloudflare Artifacts repo
// (one repo, "erga", two branches, staging and main), and this is Erga's side
// of it. Every push and merge comes through here, so Erga can hold the line
// Artifacts doesn't, and knows each time a branch moves (an event for the
// Ops page, the deploy hook, the sync with GitHub).
//
// The model is strict: two branches deploy, staging and main; staging is always at or
// ahead of main; main only follows staging. A push to main must be one of
// staging's commits (and forward of main); a push to staging must keep every
// commit main has. Merging is moving main forward to staging's head, or to
// one of staging's commits. So the two never diverge, and there are no merge
// commits or conflicts between them. Beside them, feature branches
// (features.ts): any other name, never deployed, each merged into staging as
// one commit from the Ops page.
//
// The repository's parts, each in a file of its own: Update from upstream
// (upstream.ts), the merges that wait on conflicts (conflicts.ts), releases
// (releases.ts), pushes (receive.ts) and the sync with GitHub
// (github-sync.ts). SourceRepo holds what they share (the commit index, the
// state, the lock, a branch's move) and is the API the rest calls.
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

import { emptyPack, isSha, isTreeMode, parseCommit, parseTree, readPack, subjectOf, ZERO, type Commit } from "./git.ts";
import { fetchPack, lsRefs, receivePack, type Remote } from "./remote.ts";
import { BrowseError, cleanPath, list, read, search, snapshotOf, view, type Snapshot, type SourceAnswer, type SourceRead } from "./browse.ts";
import type { GithubLink, PushEvent } from "./github.ts";
import { BRANCHES, featureOf, LOG, QUARANTINE, REF, SCRATCH, SourceError, TAGS, type Branch } from "./refs.ts";
import { sweepScratch } from "./scratch.ts";
import { Upstream, type UpstreamSource, type UpstreamView } from "./upstream.ts";
import { Conflicts, type MergeConflict } from "./conflicts.ts";
import { Releases, type Released, type TagInfo } from "./releases.ts";
import { Pushes } from "./receive.ts";
import { GithubSync, type GithubStatus } from "./github-sync.ts";
import { Features, type FeatureAction, type FeatureInfo } from "./features.ts";
import { byLine } from "../../shared/attribution.ts";

/** How many of staging's commits just after main's head the Ops page gets (BranchInfo.afterMain). */
export const AFTER_MAIN = 5;

export interface Db { exec<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] }

/** Someone acting on the repository: an admin, by their GitHub login, and how when not in person (shared/attribution.ts: "their admin agent", "a shared agent (label)", "the factory (task #3)"). */
export interface Actor { login: string; name: string; via?: string }

export interface CommitInfo {
  sha: string; subject: string; author: string; email: string; at: number; parents: string[]; /** Reachable from main. */ inMain: boolean;
  /** A downstream: this commit isn't on upstream's main (the instance's own). */
  own?: boolean;
}
export interface BranchInfo {
  name: Branch; commit: string | null; commits: CommitInfo[];
  /** Commits on it that main doesn't have (staging only). */
  ahead?: number;
  /** The AFTER_MAIN commits only on staging that come just after main's head, newest first (staging only): the Ops page shows them below its break, when staging is far ahead. */
  afterMain?: CommitInfo[];
}
/** A branch moved: `by` (a login) did it, `via` how when not in person. "update": an Update from upstream (a downstream); "github": a push on GitHub, synced in. */
export interface Move {
  branch: Branch; old: string; new: string; how: "push" | "merge" | "update" | "github"; by: string; via?: string | null; at: number;
  /** main moved past the production gate (a merge's emergency override, before the gate was removed): the reason given, and what the gate said. */
  override?: { reason: string; gate: string };
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
  /** Something the Ops page shows changed (a branch, the sync's status), or the event that says what (a feature branch's Merge or Delete). */
  changed(event?: { type: string } & Record<string, unknown>): void;
  /** Work that outlives the request (the sync with GitHub). */
  background(work: Promise<unknown>): void;
  now?(): number;
}

export interface Row {
  sha: string;
  tree: string;
  parents: string;
  author: string;
  email: string;
  at: number;
  committed: number;
  subject: string;
}
interface Node {
  parents: string[];
  committed: number;
}

export class SourceRepo {
  private chain: Promise<unknown> = Promise.resolve();
  private graph: Map<string, Node> | null = null;
  /** The commits `read` read last, the newest last: a few, as each holds every file. */
  private snapshots = new Map<string, Promise<Snapshot>>();
  readonly upstream = new Upstream(this);
  readonly conflicts = new Conflicts(this);
  readonly releases = new Releases(this);
  readonly pushes = new Pushes(this);
  readonly github = new GithubSync(this);
  readonly features = new Features(this);

  constructor(readonly deps: RepoDeps) {
    const db = deps.db;
    db.exec("CREATE TABLE IF NOT EXISTS commits (sha TEXT PRIMARY KEY, tree TEXT NOT NULL, parents TEXT NOT NULL, author TEXT NOT NULL, email TEXT NOT NULL, at INTEGER NOT NULL, committed INTEGER NOT NULL, subject TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS moves (id INTEGER PRIMARY KEY AUTOINCREMENT, branch TEXT NOT NULL, old TEXT NOT NULL, new TEXT NOT NULL, how TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Release tags, as Artifacts has them: the tag object (or the commit, for a plain tag), the commit, who, when, the message.
    db.exec("CREATE TABLE IF NOT EXISTS tags (name TEXT PRIMARY KEY, sha TEXT NOT NULL, commit_sha TEXT NOT NULL, tagger TEXT NOT NULL, at INTEGER NOT NULL, message TEXT NOT NULL)");
    // #69: how the mover did it, when not in person.
    if (!db.exec<{ name: string }>("PRAGMA table_info(moves)").some((c) => c.name == "via")) db.exec("ALTER TABLE moves ADD COLUMN via TEXT");
  }

  now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** One at a time: pushes and merges each see the branches as the last one left them. */
  locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => {});
    return run;
  }

  state<T>(key: string): T | null {
    const [row] = this.deps.db.exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key);
    return row ? (JSON.parse(row.value) as T) : null;
  }
  setState(key: string, value: unknown) {
    this.deps.db.exec("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  // ---- The commit index ------------------------------------------------------

  nodes(): Map<string, Node> {
    if (!this.graph) {
      this.graph = new Map();
      for (const r of this.deps.db.exec<{ sha: string; parents: string; committed: number }>("SELECT sha, parents, committed FROM commits")) {
        this.graph.set(r.sha, { parents: r.parents ? r.parents.split(" ") : [], committed: r.committed });
      }
    }
    return this.graph;
  }

  index(sha: string, c: Commit) {
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
  async sync(remote: Remote, tips: string[]) {
    const missing = [...new Set(tips.filter((t) => t != ZERO && !this.known(t)))];
    if (!missing.length) return;
    const haves = [...new Set([...this.heads(), ...Object.values(this.state<Record<string, string>>("tips") ?? {})])].filter((s) => this.known(s));
    // No files (the index needs commits only): far smaller, where the remote takes a filter (Artifacts takes blob:none).
    const objects = await readPack(await fetchPack(remote, { wants: missing, haves, filter: "blob:none" }), (t) => t == "commit");
    for (const [sha, o] of objects) this.index(sha, parseCommit(o.data));
    const still = missing.filter((t) => !this.known(t));
    if (still.length) throw new SourceError({ message: `Artifacts didn't send commit ${still[0].slice(0, 7)}`, status: 502 });
  }

  /** The branches' last known heads (as the index last saw them). */
  heads(): string[] {
    return Object.values(this.state<Record<string, string>>("tips") ?? {});
  }

  /** Every commit `tip` comes from, itself included. */
  ancestors(tip: string): Set<string> {
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
  order(tip: string, done: (order: string[]) => boolean): string[] {
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
  rows(order: string[]): Row[] {
    if (!order.length) return [];
    const rows = this.deps.db.exec<Row>(`SELECT * FROM commits WHERE sha IN (${order.map(() => "?").join(",")})`, ...order);
    const by = new Map(rows.map((r) => [r.sha, r]));
    return order.map((s) => by.get(s)!).filter(Boolean);
  }

  // ---- What the Ops page shows ---------------------------------------------

  /** Each branch's head and its latest commits, which of them main has, the feature branches, GitHub's status, and the merge waiting on conflicts, if one. */
  async branches(): Promise<{
    branches: BranchInfo[];
    features: FeatureInfo[];
    featureActions: FeatureAction[];
    github: GithubStatus;
    conflict: MergeConflict | null;
    moves: Move[];
    tags: TagInfo[];
    release: string | null;
    upstream?: UpstreamView;
  }> {
    const remote = await this.deps.artifacts();
    const [{ refs }, { refs: tagRefs }] = await Promise.all([lsRefs(remote), lsRefs(remote, TAGS)]);
    const heads = Object.fromEntries(BRANCHES.map((b) => [b, refs.get(REF(b)) ?? null])) as Record<Branch, string | null>;
    let upstream: UpstreamView | undefined;
    await this.locked(async () => {
      const features = [...refs].filter(([r]) => featureOf(r)).map(([, s]) => s);
      await this.sync(remote, [...BRANCHES.map((b) => heads[b]).filter((s): s is string => !!s), ...features]);
      this.setState("tips", Object.fromEntries(BRANCHES.filter((b) => heads[b]).map((b) => [b, heads[b]])));
      await this.releases.syncTags(remote, tagRefs);
      if (this.deps.upstream?.()) upstream = await this.upstream.upstreamView(heads.staging);
    });
    const tags = this.releases.tags();
    const onMain = heads.main ? this.ancestors(heads.main) : new Set<string>();
    const theirs = upstream?.main && this.known(upstream.main) ? this.ancestors(upstream.main) : null;
    const branches = BRANCHES.map((name): BranchInfo => {
      const tip = heads[name];
      const commit = (r: Row): CommitInfo => ({ sha: r.sha, subject: r.subject, author: r.author, email: r.email, at: r.at, parents: r.parents ? r.parents.split(" ") : [], inMain: onMain.has(r.sha), ...(theirs ? { own: !theirs.has(r.sha) } : {}) });
      const commits = tip ? this.log(tip).map(commit) : [];
      const info: BranchInfo = { name, commit: tip, commits };
      if (name == "staging" && tip) {
        const ahead = info.ahead = [...this.ancestors(tip)].filter((s) => !onMain.has(s)).length;
        // The last of staging's own commits, in log's order, until it has listed them all: those just after main's head.
        let seen = 0;
        const only = this.order(tip, (order) => { if (order.length && !onMain.has(order[order.length - 1])) seen++; return seen >= ahead; }).filter((s) => !onMain.has(s));
        info.afterMain = this.rows(only.slice(-AFTER_MAIN)).map(commit);
      }
      return info;
    });
    // A scratch ref a merge left behind goes (scratch.ts).
    if ([...refs.keys()].some((r) => r.startsWith(SCRATCH))) this.deps.background(sweepScratch(remote, refs).catch(() => {}));
    return {
      branches,
      features: this.features.list(remote, refs),
      featureActions: this.features.recent(),
      github: this.github.githubStatus(),
      conflict: this.state<MergeConflict>("conflict"),
      moves: this.moves(10),
      tags,
      release: tags[0]?.name ?? null,
      ...(upstream ? { upstream } : {}),
    };
  }
  /** `branch` moved by a sync (to a commit already here, or to a commit in `pack`), recorded as `how`. Inside the lock. */
  async moveBranch(
    remote: Remote,
    branch: Branch,
    old: string | null,
    to: string,
    pack: Uint8Array | null,
    who: Actor,
    how: Move["how"]
  ): Promise<void> {
    const r = await receivePack(remote, [{ ref: REF(branch), old: old ?? ZERO, new: to }], pack ?? (await emptyPack()));
    const said = r.unpack != "ok" ? r.unpack : (r.refs.get(REF(branch)) ?? "no answer");
    if (said != "ok")
      throw new SourceError({
        message: /stale|lock|old/i.test(said) ? `${branch} moved meanwhile: try again.` : `Artifacts refused it: ${said}`,
        status: 409,
      });
    await this.sync(remote, [to]);
    this.recordMove({ branch, old: old ?? ZERO, new: to, how, by: who.login, via: who.via ?? null, at: this.now() });
  }

  moves(limit: number): Move[] {
    return this.deps.db.exec<Move>("SELECT branch, old, new, how, by, via, at FROM moves ORDER BY id DESC LIMIT ?", limit);
  }
  recordMove(m: Move) {
    this.deps.db.exec("INSERT INTO moves (branch, old, new, how, by, via, at) VALUES (?, ?, ?, ?, ?, ?, ?)", m.branch, m.old, m.new, m.how, m.by, m.via ?? null, m.at);
    const tips = this.state<Record<string, string>>("tips") ?? {};
    this.setState("tips", { ...tips, [m.branch]: m.new });
    if (m.branch == "staging") this.conflicts.settleConflict(m.new);
    this.deps.moved(m);
    this.deps.changed();
    // The sync with GitHub is the mover's: it follows what they did.
    if (this.github.githubLink()) this.deps.background(this.github.syncGithub(byLine(m.by, m.via)).catch(() => {}));
  }
  // ---- Merging (the Ops page, deploy_production) ------------------------------

  /**
   * Moves main forward to staging's head, or to `commit`, one of staging's
   * commits that main doesn't have yet: always a fast-forward, since main
   * only follows staging. Returns where main is now.
   */
  async merge(who: Actor, commit?: string): Promise<{ commit: string; fastForward: boolean; upToDate: boolean }> {
    if (commit != null && !isSha(commit)) throw new SourceError({ message: "Name the commit by its full id (40 hex digits)." });
    return this.locked(async () => {
      const remote = await this.deps.artifacts();
      const { refs } = await lsRefs(remote);
      const staging = refs.get(REF("staging")), main = refs.get(REF("main"));
      if (!staging) throw new SourceError({ message: "staging has no commits yet.", status: 409 });
      await this.sync(remote, [staging, ...(main ? [main] : [])]);
      const target = commit ?? staging;
      if (!this.isAncestor(target, staging))
        throw new SourceError({ message: `${target.slice(0, 7)} isn't one of staging's commits.`, status: 409 });
      if (main && this.isAncestor(target, main)) return { commit: main, fastForward: false, upToDate: true };
      if (main && !this.isAncestor(main, target))
        throw new SourceError({
          message: "main has commits staging doesn't: that shouldn't happen. Push main's commits to staging first.",
          status: 409,
        });
      const r = await receivePack(remote, [{ ref: REF("main"), old: main ?? ZERO, new: target }], await emptyPack());
      const said = r.unpack != "ok" ? r.unpack : (r.refs.get(REF("main")) ?? "no answer");
      if (said != "ok")
        throw new SourceError({
          message: /stale|lock|old/i.test(said) ? "main moved while merging: try again." : `Artifacts refused it: ${said}`,
          status: 409,
        });
      this.recordMove({
        branch: "main",
        old: main ?? ZERO,
        new: target,
        how: "merge",
        by: who.login,
        via: who.via ?? null,
        at: this.now(),
      });
      return { commit: target, fastForward: true, upToDate: false };
    });
  }
  // ---- Reading a commit, for a build -------------------------------------------------

  /** Every file in `commit` (which must be a branch's head, so Artifacts lets it be asked for), by path. */
  async files(commit: string): Promise<{ path: string; mode: string; data: Uint8Array }[]> {
    const remote = await this.deps.artifacts();
    const objects = await readPack(await fetchPack(remote, { wants: [commit], deepen: 1 }));
    const c = objects.get(commit);
    if (!c || c.type != "commit") throw new SourceError({ message: `Artifacts didn't send commit ${commit.slice(0, 7)}`, status: 502 });
    const out: { path: string; mode: string; data: Uint8Array }[] = [];
    const walk = (tree: string, at: string) => {
      const t = objects.get(tree);
      if (!t) throw new SourceError({ message: `Artifacts didn't send tree ${tree.slice(0, 7)}`, status: 502 });
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
   * or the log, at a branch (staging if none is named; also main, or a feature branch) or a commit. Read-only: it
   * only lists refs and fetches, with a read token. Throws a SourceError the agent can act on.
   */
  async read(q: SourceRead): Promise<SourceAnswer> {
    const remote = await (this.deps.reader ?? this.deps.artifacts)();
    const { ref, commit, head } = await this.resolve(remote, q.ref);
    try {
      if (q.op == "log") {
        if (!head)
          throw new SourceError({ message: "The log starts at a branch: name one (staging, main or a feature branch), not a commit." });
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
      throw e instanceof BrowseError ? new SourceError({ message: e.message }) : e;
    }
  }

  /** Every branch's head. Read-only, with a read token. */
  async branchHeads(): Promise<Record<string, string>> {
    const remote = await (this.deps.reader ?? this.deps.artifacts)();
    const { refs } = await lsRefs(remote);
    const heads = Object.fromEntries([...refs].filter(([r]) => r.startsWith("refs/heads/") && !r.startsWith(QUARANTINE)).map(([r, s]) => [r.slice("refs/heads/".length), s]));
    return heads;
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
      if (known.length > 1) throw new SourceError({ message: `More than one commit starts with ${sha}: give more of it.` });
    }
    const rank = (b: string) => (b == "staging" ? 0 : b == "main" ? 1 : 2);
    const names = branches.map(([r]) => r.slice("refs/heads/".length)).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
    throw new SourceError({
      message: `There's no branch or known commit "${name}". The branches: ${names.slice(0, 30).join(", ")}${names.length > 30 ? `, and ${names.length - 30} more` : ""}.`,
      status: 404,
    });
  }

  /** A commit's files: fetched once, then kept (the last 3 commits read). */
  private snapshot(remote: Remote, commit: string, head: boolean): Promise<Snapshot> {
    let s = this.snapshots.get(commit);
    if (s) { this.snapshots.delete(commit); this.snapshots.set(commit, s); return s; }
    s = (async () => {
      const objects = await readPack(await fetchPack(remote, { wants: [commit], deepen: 1 })).catch((e: unknown) => {
        throw new SourceError({
          message: head
            ? `Artifacts didn't send ${commit.slice(0, 10)}: ${(e as Error).message}`
            : `Artifacts didn't send commit ${commit.slice(0, 10)} (it may send only a branch's head): name a branch instead.`,
          status: 502,
        });
      });
      try {
        return snapshotOf(commit, objects);
      } catch (e) {
        throw new SourceError({ message: `Artifacts didn't send all of ${commit.slice(0, 10)}: ${(e as Error).message}`, status: 502 });
      }
    })();
    s.catch(() => this.snapshots.delete(commit));
    this.snapshots.set(commit, s);
    while (this.snapshots.size > 3) this.snapshots.delete(this.snapshots.keys().next().value!);
    return s;
  }

  // ---- The parts: upstream.ts, conflicts.ts, releases.ts, receive.ts, github-sync.ts, features.ts --------

  update(who: Actor) {
    return this.upstream.update(who);
  }
  seedFork(fork: Remote, commit: string) {
    return this.upstream.seedFork(fork, commit);
  }
  conflict() {
    return this.conflicts.conflict();
  }
  resolveUpdate(who: Actor, path: string, content: string | null) {
    return this.conflicts.resolveUpdate(who, path, content);
  }
  finishUpdate(who: Actor) {
    return this.conflicts.finishUpdate(who);
  }
  abandonUpdate() {
    return this.conflicts.abandonUpdate();
  }
  tags() {
    return this.releases.tags();
  }
  release(who: Actor, o: { version?: string; notes?: string; commit?: string } = {}) {
    return this.releases.release(who, o);
  }
  advertise() {
    return this.pushes.advertise();
  }
  receive(body: Uint8Array, who: Actor) {
    return this.pushes.receive(body, who);
  }
  mergeFeature(who: Actor, name: string, message?: string) {
    return this.features.merge(who, name, message);
  }
  deleteFeature(name: string, who: Actor) {
    return this.features.remove(name, who);
  }
  checkFeature(name: string) {
    return this.features.recheck(name);
  }
  githubLink() {
    return this.github.githubLink();
  }
  githubStatus() {
    return this.github.githubStatus();
  }
  connectGithub(link: GithubLink, by: string) {
    return this.github.connectGithub(link, by);
  }
  disconnectGithub() {
    return this.github.disconnectGithub();
  }
  githubPushed(event: PushEvent) {
    return this.github.githubPushed(event);
  }
  syncGithub(by?: string, who?: Actor) {
    return this.github.syncGithub(by, who);
  }
}

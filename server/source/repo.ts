// Erga's own repository: the canonical copy is a Cloudflare Artifacts repo
// (one repo, "erga", two branches, staging and main), and this is Erga's side
// of it. Every push and merge comes through here, so Erga can hold the line
// Artifacts doesn't, and knows each time a branch moves (an event for the
// Ops page, the deploy hook, the GitHub mirror).
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
// Object's SQLite, or bun:sqlite in tests), and the repository and the mirror
// are smart HTTP remotes.

import {
  concat, emptyPack, FLUSH, hashObject, isSha, isTreeMode, parseCommit, parseTag, parseTree, pkt, readPack, readPkts, subjectOf, tagBytes, text,
  toSideBand, utf8, writePack, ZERO, type Commit, type GitObject,
} from "./git.ts";
import { fetchPack, lsRefs, receiveAdvert, receivePack, RemoteError, type RefUpdate, type Remote } from "./remote.ts";
import { BrowseError, cleanPath, list, read, search, snapshotOf, view, type Snapshot, type SourceAnswer, type SourceRead } from "./browse.ts";
import { byLine, SYSTEM } from "../../shared/attribution.ts";

export const BRANCHES = ["staging", "main"] as const;
export type Branch = (typeof BRANCHES)[number];
const REF = (b: Branch) => `refs/heads/${b}`;
const QUARANTINE = "refs/heads/erga-incoming/";
const TAGS = "refs/tags/";
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

export interface MirrorStatus {
  /** Where the mirror pushes (no credentials), or null when there's no mirror. */
  url: string | null;
  /** When it last brought the mirror up to date (ms), if ever. */
  lastPushAt: number | null;
  /** Whom its last push was for: who moved the branch it carried, or asked for the push ("ada, via their admin agent"). */
  lastPushBy?: string | null;
  error: string | null;
  /** off (not set up), idle, pushing. */
  state: "off" | "idle" | "pushing";
  /** What the mirror's branches pointed to after its last push. */
  refs?: Partial<Record<Branch, string>>;
}

export interface CommitInfo {
  sha: string; subject: string; author: string; email: string; at: number; parents: string[]; /** Reachable from main. */ inMain: boolean;
  /** A task's merge ("Merge task/<id>-<slug>: title"): the task, and the commits that came in with it (from its second parent's side), newest first. */
  task?: { id: number; branch: string; title: string; commits: string[] };
  /** One of a task's commits: the sha of the task's merge. */
  inTask?: string;
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
/** A branch moved: `by` (a login) did it, `via` how when not in person. */
export interface Move {
  branch: Branch; old: string; new: string; how: "push" | "merge"; by: string; via?: string | null; at: number;
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
  /** The GitHub mirror (with its token), or null when there's none. */
  github(): Remote | null;
  /** A branch moved (after a push or a merge). */
  moved(move: Move): void;
  /** A release cut: a tag made here, or pushed. */
  released?(release: Released): void;
  /** Something the Ops page shows changed (a branch, the mirror's status). */
  changed(): void;
  /** Work that outlives the request (the mirror). */
  background(work: Promise<unknown>): void;
  now?(): number;
}

interface Row { sha: string; tree: string; parents: string; author: string; email: string; at: number; committed: number; subject: string }
interface Node { parents: string[]; committed: number }

export class SourceRepo {
  private chain: Promise<unknown> = Promise.resolve();
  private graph: Map<string, Node> | null = null;
  private mirroring: Promise<MirrorStatus> | null = null;
  private mirrorAgain = false;
  /** Who the mirror's next push is for (byLine): whoever moved a branch, or asked for it. */
  private mirrorBy = SYSTEM;
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

  /** Each branch's head and its latest commits, which of them main has, and the mirror's status. */
  async branches(): Promise<{ branches: BranchInfo[]; mirror: MirrorStatus; moves: Move[]; tags: TagInfo[]; release: string | null }> {
    const remote = await this.deps.artifacts();
    const [{ refs }, { refs: tagRefs }] = await Promise.all([lsRefs(remote), lsRefs(remote, TAGS)]);
    const heads = Object.fromEntries(BRANCHES.map((b) => [b, refs.get(REF(b)) ?? null])) as Record<Branch, string | null>;
    await this.locked(async () => {
      await this.sync(remote, BRANCHES.map((b) => heads[b]).filter((s): s is string => !!s));
      this.setState("tips", Object.fromEntries(BRANCHES.filter((b) => heads[b]).map((b) => [b, heads[b]])));
      await this.syncTags(remote, tagRefs);
    });
    const tags = this.tags();
    const onMain = heads.main ? this.ancestors(heads.main) : new Set<string>();
    const branches = BRANCHES.map((name): BranchInfo => {
      const tip = heads[name];
      const commit = (r: Row): CommitInfo => ({ sha: r.sha, subject: r.subject, author: r.author, email: r.email, at: r.at, parents: r.parents ? r.parents.split(" ") : [], inMain: onMain.has(r.sha) });
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
    return { branches, mirror: this.mirrorStatus(), moves: this.moves(10), tags, release: tags[0]?.name ?? null };
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
    this.deps.background(this.mirror(byLine(r.by, r.via)).catch(() => {}));
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

  mirrorStatus(): MirrorStatus {
    const gh = this.deps.github();
    const saved = this.state<MirrorStatus>("mirror");
    if (!gh) return { url: null, lastPushAt: saved?.lastPushAt ?? null, error: null, state: "off" };
    return { url: publicUrl(gh.url), lastPushAt: null, error: null, ...saved, state: this.mirroring ? "pushing" : "idle" };
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
        else if (!branch) statuses.set(c.ref, "Erga has two branches, staging and main: push to one of those");
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
    if (messages.length && this.deps.github()) messages.push("Erga: GitHub's mirror updates in the background.");
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
    this.deps.moved(m);
    this.deps.changed();
    // The mirror's push is the mover's: it follows what they did.
    this.deps.background(this.mirror(byLine(m.by, m.via)).catch(() => {}));
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

  // ---- The GitHub mirror ---------------------------------------------------------

  /**
   * Brings the GitHub mirror up to date with staging and main, after each
   * move (in the background: a failure is only recorded, never blocks
   * anything). main moves there only forward: if GitHub's main has commits
   * Erga doesn't, the mirror stops and says so rather than drop them.
   */
  mirror(by: string = SYSTEM): Promise<MirrorStatus> {
    this.mirrorBy = by;
    if (this.mirroring) { this.mirrorAgain = true; return this.mirroring; }
    this.mirroring = (async () => {
      let status = this.mirrorStatus();
      do {
        this.mirrorAgain = false;
        this.deps.changed();
        status = await this.mirrorOnce();
      } while (this.mirrorAgain);
      return status;
    })().finally(() => { this.mirroring = null; this.deps.changed(); });
    return this.mirroring;
  }

  private async mirrorOnce(): Promise<MirrorStatus> {
    const gh = this.deps.github();
    if (!gh) return this.mirrorStatus();
    const saved = this.state<MirrorStatus>("mirror");
    const status: MirrorStatus = { url: publicUrl(gh.url), lastPushAt: saved?.lastPushAt ?? null, lastPushBy: saved?.lastPushBy ?? null, error: null, state: "idle", refs: saved?.refs };
    const by = this.mirrorBy;
    try {
      const remote = await this.deps.artifacts();
      const [{ refs }, { refs: tagRefs }, advert] = await Promise.all([lsRefs(remote), lsRefs(remote, TAGS), receiveAdvert(gh)]);
      await this.locked(() => this.sync(remote, BRANCHES.map((b) => refs.get(REF(b)) ?? ZERO)));
      const updates: RefUpdate[] = [], problems: string[] = [];
      // Release tags GitHub doesn't have yet (never moved there either).
      for (const [ref, sha] of tagRefs) if (isReleaseTag(ref.slice(TAGS.length)) && !advert.refs.has(ref)) updates.push({ ref, old: ZERO, new: sha });
      for (const b of BRANCHES) {
        const ours = refs.get(REF(b)), theirs = advert.refs.get(REF(b)) ?? ZERO;
        if (!ours || ours == theirs) continue;
        if (b == "main" && theirs != ZERO && !(this.known(theirs) && this.isAncestor(theirs, ours))) {
          problems.push(`GitHub's main has commits Erga doesn't (${theirs.slice(0, 7)}). Pull them into Erga's main, or reset GitHub's main, and the mirror carries on`);
          continue;
        }
        updates.push({ ref: REF(b), old: theirs, new: ours });
      }
      if (updates.length) {
        const haves = [...advert.refs.values()].filter((s) => this.known(s));
        const pack = await fetchPack(remote, { wants: updates.map((u) => u.new), haves });
        const r = await receivePack(gh, updates, pack);
        if (r.unpack != "ok") problems.push(`GitHub couldn't take the objects: ${r.unpack}`);
        else for (const u of updates) { const said = r.refs.get(u.ref) ?? "no answer"; if (said != "ok") problems.push(`GitHub refused ${u.ref.slice(11)}: ${said}`); }
      }
      const pushed = updates.length && !problems.length;
      status.refs = Object.fromEntries(BRANCHES.map((b) => [b, updates.find((u) => u.ref == REF(b))?.new ?? advert.refs.get(REF(b))]).filter(([, s]) => s));
      if (pushed || !problems.length) status.lastPushAt = this.now();
      if (pushed) status.lastPushBy = by;
      status.error = problems.length ? problems.join(". ") + "." : null;
    } catch (e) {
      status.error = e instanceof RemoteError || e instanceof SourceError ? e.message : `the mirror failed: ${(e as Error).message}`;
    }
    this.setState("mirror", { url: status.url, lastPushAt: status.lastPushAt, lastPushBy: status.lastPushBy, error: status.error, refs: status.refs });
    return status;
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

/** A remote's URL as shown: no credentials in it. */
export function publicUrl(url: string): string {
  try { const u = new URL(url); u.username = ""; u.password = ""; return u.toString(); } catch { return url; }
}

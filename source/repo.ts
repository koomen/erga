// Erga's own repository: the canonical copy is a Cloudflare Artifacts repo
// (one repo, "erga", two branches, staging and main), and this is Erga's side
// of it. Every push and merge comes through here, so Erga can hold the line
// Artifacts doesn't, and knows each time a branch moves (an event for the
// Source page, the deploy hook, the GitHub mirror).
//
// The model is strict: only two branches, ever; staging is always at or
// ahead of main; main only follows staging. A push to main must be one of
// staging's commits (and forward of main); a push to staging must keep every
// commit main has. Merging is moving main forward to staging's head, or to
// one of staging's commits. So the two never diverge, and there are no merge
// commits or conflicts between them.
//
// A push is staged before it lands: its objects go to Artifacts under a
// quarantine branch (refs/heads/erga-incoming/...), Erga reads the new
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
// are smart HTTP remotes (source/remote.ts).

import {
  concat, emptyPack, FLUSH, isSha, isTreeMode, parseCommit, parseTree, pkt, readPack, readPkts, subjectOf, text,
  toSideBand, utf8, ZERO, type Commit,
} from "./git.ts";
import { fetchPack, lsRefs, receiveAdvert, receivePack, RemoteError, type RefUpdate, type Remote } from "./remote.ts";
import { refsAllowed, type GitGrant } from "../factory/git-grant.ts";

export const BRANCHES = ["staging", "main"] as const;
export type Branch = (typeof BRANCHES)[number];
const REF = (b: Branch) => `refs/heads/${b}`;
const QUARANTINE = "refs/heads/erga-incoming/";
/** How many commits each branch shows. */
export const LOG = 25;
/** How many of staging's commits just after main's head the Source page gets (BranchInfo.afterMain). */
export const AFTER_MAIN = 5;

export interface Db { exec<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] }

/** Someone acting on the repository: an admin, by their GitHub login. */
export interface Actor { login: string; name: string }

export interface MirrorStatus {
  /** Where the mirror pushes (no credentials), or null when there's no mirror. */
  url: string | null;
  /** When it last brought the mirror up to date (ms), if ever. */
  lastPushAt: number | null;
  error: string | null;
  /** off (not set up), idle, pushing. */
  state: "off" | "idle" | "pushing";
  /** What the mirror's branches pointed to after its last push. */
  refs?: Partial<Record<Branch, string>>;
}

export interface CommitInfo { sha: string; subject: string; author: string; email: string; at: number; parents: string[]; /** Reachable from main. */ inMain: boolean }
export interface BranchInfo {
  name: Branch; commit: string | null; commits: CommitInfo[];
  /** Commits on it that main doesn't have (staging only). */
  ahead?: number;
  /** The AFTER_MAIN commits only on staging that come just after main's head, newest first (staging only): the Source page shows them below its break, when staging is far ahead. */
  afterMain?: CommitInfo[];
}
export interface Move { branch: Branch; old: string; new: string; how: "push" | "merge"; by: string; at: number }

export class SourceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface RepoDeps {
  db: Db;
  /** The Artifacts repo, with a write token. */
  artifacts(): Promise<Remote>;
  /** The GitHub mirror (with its token), or null when there's none. */
  github(): Remote | null;
  /** A branch moved (after a push or a merge). */
  moved(move: Move): void;
  /** Something the Source page shows changed (a branch, the mirror's status). */
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

  constructor(private deps: RepoDeps) {
    const db = deps.db;
    db.exec("CREATE TABLE IF NOT EXISTS commits (sha TEXT PRIMARY KEY, tree TEXT NOT NULL, parents TEXT NOT NULL, author TEXT NOT NULL, email TEXT NOT NULL, at INTEGER NOT NULL, committed INTEGER NOT NULL, subject TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS moves (id INTEGER PRIMARY KEY AUTOINCREMENT, branch TEXT NOT NULL, old TEXT NOT NULL, new TEXT NOT NULL, how TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
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

  // ---- What the Source page shows ---------------------------------------------

  /** Each branch's head and its latest commits, which of them main has, and the mirror's status. */
  async branches(): Promise<{ branches: BranchInfo[]; mirror: MirrorStatus; moves: Move[] }> {
    const remote = await this.deps.artifacts();
    const { refs } = await lsRefs(remote);
    const heads = Object.fromEntries(BRANCHES.map((b) => [b, refs.get(REF(b)) ?? null])) as Record<Branch, string | null>;
    await this.locked(async () => {
      await this.sync(remote, BRANCHES.map((b) => heads[b]).filter((s): s is string => !!s));
      this.setState("tips", Object.fromEntries(BRANCHES.filter((b) => heads[b]).map((b) => [b, heads[b]])));
    });
    const onMain = heads.main ? this.ancestors(heads.main) : new Set<string>();
    const branches = BRANCHES.map((name): BranchInfo => {
      const tip = heads[name];
      const commit = (r: Row): CommitInfo => ({ sha: r.sha, subject: r.subject, author: r.author, email: r.email, at: r.at, parents: r.parents ? r.parents.split(" ") : [], inMain: onMain.has(r.sha) });
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
    return { branches, mirror: this.mirrorStatus(), moves: this.moves(10) };
  }

  moves(limit: number): Move[] {
    return this.deps.db.exec<Move>("SELECT branch, old, new, how, by, at FROM moves ORDER BY id DESC LIMIT ?", limit);
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
   * A factory VM's token (`grant`) also sees its own task's branch, which it may push and delete.
   */
  async advertise(grant?: GitGrant): Promise<Uint8Array> {
    const remote = await this.deps.artifacts();
    const { refs } = await lsRefs(remote);
    const caps = "report-status side-band-64k quiet ofs-delta delete-refs agent=erga";
    const names = [...BRANCHES.map(REF), ...(grant ? [`refs/heads/${grant.branch}`] : [])];
    const lines = names.filter((r) => refs.has(r)).map((r) => `${refs.get(r)} ${r}`);
    if (!lines.length) lines.push(`${ZERO} capabilities^{}`);
    return concat([pkt("# service=git-receive-pack\n"), FLUSH, ...lines.map((l, i) => pkt(`${l}${i == 0 ? `\0${caps}` : ""}\n`)), FLUSH]);
  }

  /**
   * A `git push`: the receive-pack request's body in, the report out (in side-band if the client asked).
   * An admin pushes staging and main. A factory VM (`grant`, its git token: factory/git-grant.ts) pushes
   * its own task's branch (and may delete it), and a merge's token moves staging too, under staging's rules.
   * Task branches are never shown, mirrored or deployed: only staging and main are Erga's branches.
   */
  async receive(body: Uint8Array, who: Actor, grant?: GitGrant): Promise<Uint8Array> {
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
      const statuses = new Map<string, string>();
      const accepted: (RefUpdate & { branch: Branch })[] = [];
      const taskRef = grant ? `refs/heads/${grant.branch}` : null;
      const tasks: RefUpdate[] = [];
      for (const c of commands) {
        const branch = BRANCHES.find((b) => REF(b) == c.ref);
        const refused = grant ? refsAllowed(grant, [{ next: c.new, ref: c.ref }]) : null;
        if (refused) statuses.set(c.ref, refused);
        else if (c.ref == taskRef) {
          if ((refs.get(c.ref) ?? ZERO) != c.old) statuses.set(c.ref, "stale info: it moved since you fetched; fetch first");
          else tasks.push(c);
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
              this.recordMove({ branch: c.branch, old: c.old, new: c.new, how: "push", by: who.login, at: this.now() });
              const before = c.old == ZERO ? null : this.ancestors(c.old);
              const count = before ? [...this.ancestors(c.new)].filter((s) => !before.has(s)).length : null;
              messages.push(`Erga: ${c.branch} is now ${c.new.slice(0, 7)}${count != null ? ` (${count} new commit${count == 1 ? "" : "s"})` : ""}.`);
            }
          }
        }
      } else if (leftovers.length) {
        await receivePack(remote, leftovers, null).catch(() => {});
      }
      // A factory task's branch: no rules but its token's (above), so straight to Artifacts, objects and all.
      if (tasks.length && unpack == "ok") {
        const writes = tasks.some((c) => c.new != ZERO);
        const r = await receivePack(remote, tasks, writes ? (pack.length ? pack : await emptyPack()) : null);
        if (r.unpack != "ok") unpack = r.unpack;
        for (const c of tasks) {
          const said = r.unpack != "ok" ? `Artifacts couldn't take the objects: ${r.unpack}` : r.refs.get(c.ref) ?? "no answer";
          statuses.set(c.ref, said);
          if (said == "ok") messages.push(c.new == ZERO ? `Erga: ${c.ref.slice(11)} deleted.` : `Erga: ${c.ref.slice(11)} is now ${c.new.slice(0, 7)}.`);
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
    this.deps.db.exec("INSERT INTO moves (branch, old, new, how, by, at) VALUES (?, ?, ?, ?, ?, ?)", m.branch, m.old, m.new, m.how, m.by, m.at);
    const tips = this.state<Record<string, string>>("tips") ?? {};
    this.setState("tips", { ...tips, [m.branch]: m.new });
    this.deps.moved(m);
    this.deps.changed();
    this.deps.background(this.mirror().catch(() => {}));
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
          if (staging == ZERO || !this.isAncestor(u.new, staging)) return refuse(u, "main only follows staging: push the commit to staging first (git push erga HEAD:staging), then merge it on the Source page, or push both at once (git push erga HEAD:staging HEAD:main)");
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

  // ---- Merging (the Source page, POST /api/source/merge) ------------------------------

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
      this.recordMove({ branch: "main", old: main ?? ZERO, new: target, how: "merge", by: who.login, at: this.now() });
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
  mirror(): Promise<MirrorStatus> {
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
    const status: MirrorStatus = { url: publicUrl(gh.url), lastPushAt: saved?.lastPushAt ?? null, error: null, state: "idle", refs: saved?.refs };
    try {
      const remote = await this.deps.artifacts();
      const [{ refs }, advert] = await Promise.all([lsRefs(remote), receiveAdvert(gh)]);
      await this.locked(() => this.sync(remote, BRANCHES.map((b) => refs.get(REF(b)) ?? ZERO)));
      const updates: RefUpdate[] = [], problems: string[] = [];
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
      status.error = problems.length ? problems.join(". ") + "." : null;
    } catch (e) {
      status.error = e instanceof RemoteError || e instanceof SourceError ? e.message : `the mirror failed: ${(e as Error).message}`;
    }
    this.setState("mirror", { url: status.url, lastPushAt: status.lastPushAt, error: status.error, refs: status.refs });
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
}

/** A remote's URL as shown: no credentials in it. */
export function publicUrl(url: string): string {
  try { const u = new URL(url); u.username = ""; u.password = ""; return u.toString(); } catch { return url; }
}

// The factory (experimental): the task queue inside Erga. Each task is a
// branch of Erga's own repository, task/<id>-<slug>, made from staging, and
// a VM in which Claude Code does the work and reports back. Merging a task
// merges its branch into staging and deletes it; discarding it deletes it.
// Admins only, and only while the `factory` setting is "on". README, The
// factory, has the design, the findings and the runbook.
//
//   /admin/factory                         redirects to /admin/source: the board is there now (factory/page.ts),
//                                          with the source dashboard and the factory's own agent
//   GET  /api/factory                      { enabled, vms, claude: { signedIn, at, by } }
//   GET  /api/factory/tasks[/<id>]         the tasks, each with its log and screenshots
//   POST /api/factory/tasks                { title, description, startAfter?, mergeAfter? }: a new task (its branch,
//                                          then its VM, unless it waits for a startAfter task to merge)
//   PATCH /api/factory/tasks/<id>          { startAfter?, mergeAfter? }: changes its dependencies (lists of ids, or null)
//   POST /api/factory/tasks/<id>/start     a queued task's VM; 409 while a startAfter task isn't merged
//   POST /api/factory/tasks/<id>/merge     into staging (one merge at a time), then the branch is deleted; 409 while
//                                          a dependency isn't merged (or merging ahead of it)
//   POST /api/factory/tasks/<id>/discard   the branch deleted, the VM stopped
//   POST /api/factory/tasks/<id>/revise    { instructions }: Claude Code works on the task again
//   PUT  /api/factory/claude               { token }: the Claude plan's token (claude setup-token), stored encrypted
//   DELETE /api/factory/claude             forgets it
//   GET  /api/factory/events               server-sent events: { type: "task", task } on each change, and
//                                          { type: "unblocked" | "blocked", id, title, why } for a task's dependencies
//   GET  /api/factory/shots/<file>         a screenshot
//   GET  /api/factory/tasks/<id>/open      to the task's preview (on Cloudflare, with a ticket for its host)
//
// The factory's own agent (factory/agent.ts), one per admin, in this object; the page's panel uses:
//
//   GET  /api/factory/agent                { enabled, reason?, model, models, choice, log }
//   POST /api/factory/agent                { text, context }: a message (it steers a turn that is running)
//   POST /api/factory/agent/abort|reset    stops the turn; starts a new conversation
//   POST /api/factory/agent/model          { model }: sonnet or opus-fast, from the next message
//   (its events come on /api/factory/events, to that admin only: { type: "agent", ev })
//
// "Share with agent": factory tokens (erga_factory_...) for an outside agent, minted by an unlocked admin
// in a browser, at most 12 hours, revocable, and ended with the key that unlocked the admin:
//
//   GET  /api/factory/tokens               the tokens (never the secret), newest first
//   POST /api/factory/tokens               { label?, hours? }: a new one, shown once
//   DELETE /api/factory/tokens/<id>        revokes it
//   GET  /api/factory/guide                what the outside agent reads first (factory/agent.ts)
//
// With a factory token ("Authorization: Bearer erga_factory_..."), only: GET /api/factory, the tasks,
// one task and its screenshots, the guide; POST /api/factory/tasks; PATCH /api/factory/tasks/<id>;
// POST /api/factory/tasks/<id>/revise. Never merge, discard, start, the Claude sign-in or the agent.
//
// The VMs call back with their task's token (Authorization: Bearer fct...),
// which reaches their own task only:
//
//   GET   /api/factory/tasks/<id>/brief         the title, branch and prompt (and new instructions)
//   POST  /api/factory/tasks/<id>/log           { message }
//   POST  /api/factory/tasks/<id>/branch        { base }: the branch is made (from staging at base)
//   POST  /api/factory/tasks/<id>/preview       { path }: the preview is up
//   POST  /api/factory/tasks/<id>/screenshots   a PNG body, ?caption=&replace=1
//   PATCH /api/factory/tasks/<id>               { status: "complete" | "failed", summary, error, commit }
//
// Merge works in the task's own VM, in its clone (factory/vm/merge.ts): staging merged into the branch, then
// staging moved to a --no-ff merge commit. A conflict, or a step that fails or times out, sets the task to
// "needs agent" (Merge off, the reason on the card) and wakes the task's own Claude Code (run.ts resolve, the
// same session: --continue) with instructions to resolve, test under time limits and commit. When it says
// done, the merge runs again by itself; when it fails, the task goes back to ready to merge with its reason.
//
// Dependencies between tasks are the local task queue's (development/task-queue/deps.ts,
// README, The factory): startAfter and mergeAfter, a computed blockedBy, a
// blocked start or merge refused (409), the merge checked again when its turn
// comes. With no outer agent here, the factory starts a queued task itself as
// soon as nothing blocks it.
//
// All the state is in one Durable Object, "factory" (SQLite): tasks, their
// logs and screenshots, and the Claude token, encrypted (AES-GCM) with
// FACTORY_KEY. Where the VMs run is a VmHost: locally the dev server's
// Docker or simulation (dev/factory.ts); on Cloudflare, Containers
// (factory/cloudflare.ts), once set up.

import { DurableObject } from "cloudflare:workers";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { agentConfigFrom, isModelChoice, MODELS, type AgentConfig } from "../agent";
import type { Unlock } from "../admin-keys";
import { type Blocked, dependents, depRules, depsNote, type DepStatus, type DepTask, ids } from "../development/task-queue/deps";
import { factoryGuide, factoryTools, startFactoryAgent, type FactoryAgent, type FactoryOps } from "../factory/agent";
import { containersHost } from "../factory/cloudflare";
import { branchName, resolvePrompt, taskPrompt } from "../factory/prompt";
import { whoOf } from "../front";
import { LOCKED } from "../users";
import { isDev, sessionOf } from "./auth";
import { agentName } from "../src/room/doc";
import { adminKeysOf, directoryOf } from "./d1";
import type { Env } from "./env";

/** "needs agent": a merge stopped (a conflict, or a step that failed or timed out) and the task's Claude Code is finishing it. */
export type Status = "queued" | "working" | "complete" | "merging" | "needs agent" | "merged" | "failed" | "discarded";

/** How long the factory waits for a merge job's answer (each of its steps has a shorter limit of its own: factory/vm/common.ts). */
const MERGE_JOB_MS = 30 * 60_000;

export interface Task {
  id: number; title: string; description: string; status: Status; branch: string; base: string | null;
  commit: string | null; summary: string | null; error: string | null;
  /** The task's preview, where the user opens it (null until the VM says it's up, and after the VM stops). */
  url: string | null;
  vm: string | null; by: string; createdAt: string; updatedAt: string; mergedAt: string | null; mergeCommit: string | null;
  log: { at: string; message: string }[];
  screenshots: { file: string; caption: string; at: string }[];
  /** Don't start until these tasks are merged. */
  startAfter: number[];
  /** Don't merge until these tasks are merged (the startAfter ones too). */
  mergeAfter: number[];
  /** Computed on every read (not stored): what the task waits for, if anything. */
  blockedBy?: Blocked;
  /** Its VM is being started (a queued task, between Start and the VM). */
  starting?: boolean;
}

const enc = new TextEncoder();
const now = () => new Date().toISOString();
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", typeof key == "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** What signs the VMs' task tokens and encrypts the Claude token: FACTORY_KEY, or locally the session secret. */
function factoryKey(env: Env): string | null {
  if (env.FACTORY_KEY?.trim()) return env.FACTORY_KEY.trim();
  return env.ERGA_LINK_SECRET && env.DEV_LOGIN ? `local:${env.SESSION_SECRET}` : null;
}

/** What the repository checks the VMs' git tokens with: locally the dev server's secret (dev/factory.ts checks them); on Cloudflare FACTORY_KEY (worker/source.ts). */
export const gitSecret = (env: Env) => env.ERGA_LINK_SECRET || factoryKey(env);

/** A git token for the repository: pushes `branch` only, or (a merge) that and staging. Two hours. `by`: the admin who asked. */
export async function gitToken(env: Env, scope: "task" | "merge", branch: string, by?: string): Promise<string> {
  const secret = gitSecret(env);
  if (!secret) throw new Error("FACTORY_KEY isn't set");
  // UTF-8 first: `by` can be "tester’s agent" (btoa takes Latin-1 only, and threw, so an agent's task never started).
  const body = b64url(String.fromCharCode(...enc.encode(JSON.stringify({ scope, branch, exp: Math.floor(Date.now() / 1000) + 7200, ...(by ? { by } : {}) }))));
  return `fgt.${body}.${hex(await hmac(await hmac(secret, "erga-factory-git"), body))}`;
}

/** A task's own token, for its VM to report with. A week. */
async function taskToken(env: Env, id: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  return `fct.${id}.${exp}.${hex(await hmac(await hmac(factoryKey(env)!, "erga-factory-task"), `${id}.${exp}`))}`;
}

/** The task a VM's token is for, or null. */
async function taskOfToken(env: Env, token: string): Promise<number | null> {
  const m = /^fct\.(\d+)\.(\d+)\.([0-9a-f]{64})$/.exec(token);
  const key = factoryKey(env);
  if (!m || !key || Number(m[2]) * 1000 < Date.now()) return null;
  const want = hex(await hmac(await hmac(key, "erga-factory-task"), `${m[1]}.${m[2]}`));
  return want.length == m[3].length && crypto.subtle.timingSafeEqual(enc.encode(want), enc.encode(m[3])) ? Number(m[1]) : null;
}

/** A ticket to a VM's preview (factory/cloudflare.ts, previewDoor): twelve hours. */
async function previewTicket(env: Env, vm: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 43200;
  return `${exp}.${hex(await hmac(await hmac(factoryKey(env)!, "erga-factory-preview"), `${vm}.${exp}`))}`;
}

export async function previewTicketOk(env: Env, vm: string, ticket: string): Promise<boolean> {
  const m = /^(\d+)\.([0-9a-f]{64})$/.exec(ticket);
  const key = factoryKey(env);
  if (!m || !key || Number(m[1]) * 1000 < Date.now()) return false;
  const want = hex(await hmac(await hmac(key, "erga-factory-preview"), `${vm}.${m[1]}`));
  return crypto.subtle.timingSafeEqual(enc.encode(want), enc.encode(m[2]));
}

/** AES-GCM with a key from FACTORY_KEY. */
async function aes(env: Env): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`erga-factory-secrets:${factoryKey(env)}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// ---- where the VMs run -----------------------------------------------------------------

export interface VmHost {
  kind: string;
  /** A new VM for the task: its name, and where its preview shows. */
  start(task: number): Promise<{ vm: string; preview: string }>;
  /** Runs a script of the image's (factory/vm/) in the VM; with `wait`, until it ends. */
  job(vm: string, script: "run.ts" | "merge.ts", args: string[], env: Record<string, string>, wait: boolean): Promise<{ code: number; output: string } | null>;
  stop(vm: string): Promise<void>;
  alive(vm: string): Promise<boolean>;
  /** The repository's Git URL, as a VM reaches it. */
  repo(origin: string): string;
}

/** Local development: the dev server's VMs and repository (dev/factory.ts). */
function localHost(env: Env, origin: string): VmHost {
  const call = async (body: Record<string, unknown>) => {
    const r = await fetch(`${origin}/__factory/vm?link=${env.ERGA_LINK_SECRET}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json() as any;
    if (!r.ok) throw new Error(out.error ?? `the dev server answered ${r.status}`);
    return out;
  };
  return {
    kind: "local",
    start: (task) => call({ op: "start", task }),
    job: async (vm, script, args, jobEnv, wait) => { const r = await call({ op: "job", vm, script, args, env: jobEnv, wait }); return wait ? r : null; },
    stop: async (vm) => { await call({ op: "stop", vm }); },
    alive: async (vm) => (await call({ op: "alive", vm })).alive,
    repo: (o) => `${o}/__factory/git/erga.git`,
  };
}

/** The VMs of this server, or null with why there are none. */
function vmHost(env: Env, origin: string): VmHost | string {
  if (env.ERGA_LINK_SECRET && env.DEV_LOGIN) return localHost(env, origin);
  // On Cloudflare: Containers (factory/cloudflare.ts), which the deploy declares (deploy/cloudflare.ts, deploy/targets.json).
  if (env.FACTORY_VM && env.FACTORY_PREVIEW_DOMAIN) return containersHost(env, origin);
  return "This server has no VMs for the factory yet: its deploy declares them (README, The factory, On Cloudflare).";
}

/** What the dev server says about its VMs: Docker or simulated (local only). */
async function vmsInfo(env: Env, origin: string): Promise<{ runner: string; branches?: Record<string, string> } | null> {
  if (!(env.ERGA_LINK_SECRET && env.DEV_LOGIN)) return null;
  const r = await fetch(`${origin}/__factory/vm?link=${env.ERGA_LINK_SECRET}`, { method: "POST", body: JSON.stringify({ op: "info" }) }).catch(() => null);
  return r?.ok ? r.json() : null;
}

// ---- the Durable Object -----------------------------------------------------------------

type Row = {
  id: number; title: string; description: string; status: Status; branch: string; base: string | null; commit_sha: string | null;
  summary: string | null; error: string | null; preview_origin: string | null; preview_path: string | null; vm: string | null;
  origin: string; by_login: string; created: string; updated: string; merged_at: string | null; merge_commit: string | null; instructions: string | null;
  /** JSON lists of task ids, or null. */
  start_after: string | null; merge_after: string | null;
  /** Who pressed Merge, while the merge goes on (it continues by itself after "needs agent"). */
  merge_by: string | null;
};

/** A factory token: erga_factory_<id>_<secret>. */
export const TOKEN_PREFIX = "erga_factory_";
type TokenRow = { id: string; hash: string; login: string; name: string; label: string; unlock_key: string; created: number; expires: number; revoked: number | null; revoked_by: string | null; last_used: number | null };
export interface TokenView { id: string; login: string; label: string; created: number; expires: number; revoked: number | null; revokedBy: string | null; lastUsed: number | null }

const list = (json: string | null): number[] => { try { const v = JSON.parse(json ?? "[]"); return Array.isArray(v) ? v.map(Number) : []; } catch { return []; } };
// "needs agent" is a merge that hasn't happened yet: to the dependency rules, a task that isn't merged or merging.
const depOf = (r: Row): DepTask => ({ id: r.id, status: r.status as DepStatus, startAfter: list(r.start_after), mergeAfter: list(r.merge_after) });

export class Factory extends DurableObject<Env> {
  private sql: SqlStorage;
  /** The event streams open, each with the admin it's for (agent events go to theirs only). */
  private clients = new Map<WritableStreamDefaultWriter<Uint8Array>, string | null>();
  /** Each admin's agent (factory/agent.ts), with the unlock their page sent last and where the server is. */
  private agents = new Map<string, { agent: FactoryAgent; unlock: Unlock; origin: string }>();
  private agentCfg: Promise<AgentConfig | { missing: string }> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  /** Merges run one at a time, in the order they were asked for. */
  private merges: Promise<void> = Promise.resolve();
  /** Queued tasks whose VM is being started (so a second Start doesn't start another). */
  private starting = new Set<number>();
  /** The dependency rules (development/task-queue/deps.ts), over this object's tasks. */
  private deps = depRules((id) => { const r = this.row(id); return r && depOf(r); });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
      branch TEXT NOT NULL, base TEXT, commit_sha TEXT, summary TEXT, error TEXT, preview_origin TEXT, preview_path TEXT, vm TEXT, origin TEXT NOT NULL,
      by_login TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, merged_at TEXT, merge_commit TEXT, instructions TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS logs (n INTEGER PRIMARY KEY AUTOINCREMENT, task INTEGER NOT NULL, at TEXT NOT NULL, message TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS shots (n INTEGER PRIMARY KEY AUTOINCREMENT, task INTEGER NOT NULL, file TEXT NOT NULL UNIQUE, caption TEXT NOT NULL, at TEXT NOT NULL, data BLOB NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, iv BLOB NOT NULL, data BLOB NOT NULL, by_login TEXT NOT NULL, at TEXT NOT NULL)`);
    // Factory tokens, for outside agents ("Share with agent"): only the secret's SHA-256 is kept.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL, login TEXT NOT NULL, name TEXT NOT NULL, label TEXT NOT NULL,
      unlock_key TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER, revoked_by TEXT, last_used INTEGER)`);
    // Dependencies (#49), on a table made before them.
    const cols = this.sql.exec<{ name: string }>("PRAGMA table_info(tasks)").toArray().map((c) => c.name);
    for (const c of ["start_after", "merge_after", "merge_by"]) if (!cols.includes(c)) this.sql.exec(`ALTER TABLE tasks ADD COLUMN ${c} TEXT`);
    // A merge the object was stopped in the middle of goes back to ready to merge, saying so.
    for (const r of this.sql.exec<Row>("SELECT * FROM tasks WHERE status = 'merging'").toArray()) {
      this.update(r.id, { status: "complete", error: "The merge was stopped in the middle (the factory restarted). Merge again." });
    }
  }

  // -- reading

  private row(id: number): Row | null { return this.sql.exec<Row>("SELECT * FROM tasks WHERE id = ?", id).toArray()[0] ?? null; }

  private view(r: Row): Task {
    const log = this.sql.exec<{ at: string; message: string }>("SELECT at, message FROM (SELECT * FROM logs WHERE task = ? ORDER BY n DESC LIMIT 200) ORDER BY n", r.id).toArray();
    const screenshots = this.sql.exec<{ file: string; caption: string; at: string }>("SELECT file, caption, at FROM shots WHERE task = ? ORDER BY n", r.id).toArray();
    return {
      id: r.id, title: r.title, description: r.description, status: r.status, branch: r.branch, base: r.base, commit: r.commit_sha,
      summary: r.summary, error: r.error, url: r.preview_origin && r.preview_path != null ? r.preview_origin + r.preview_path : null,
      vm: r.vm, by: r.by_login, createdAt: r.created, updatedAt: r.updated, mergedAt: r.merged_at, mergeCommit: r.merge_commit, log, screenshots,
      startAfter: list(r.start_after), mergeAfter: list(r.merge_after),
      ...(this.deps.blocked(depOf(r)) ? { blockedBy: this.deps.blocked(depOf(r)) } : {}),
      ...(this.starting.has(r.id) ? { starting: true } : {}),
    };
  }

  async list(): Promise<Task[]> { return this.sql.exec<Row>("SELECT * FROM tasks ORDER BY id").toArray().map((r) => this.view(r)); }
  async task(id: number): Promise<Task | null> { const r = this.row(id); return r && this.view(r); }

  async shot(file: string): Promise<Uint8Array | null> {
    const r = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM shots WHERE file = ?", file).toArray()[0];
    return r ? new Uint8Array(r.data) : null;
  }

  // -- changing

  private update(id: number, fields: Partial<Record<keyof Row, string | number | null>>, message?: string) {
    const keys = Object.keys(fields);
    this.sql.exec(`UPDATE tasks SET ${[...keys.map((k) => `${k} = ?`), "updated = ?"].join(", ")} WHERE id = ?`, ...keys.map((k) => (fields as any)[k]), now(), id);
    if (message) this.sql.exec("INSERT INTO logs (task, at, message) VALUES (?, ?, ?)", id, now(), message);
    this.changed(id);
  }

  private note(id: number, message: string) {
    this.sql.exec("INSERT INTO logs (task, at, message) VALUES (?, ?, ?)", id, now(), message.slice(0, 2000));
    this.sql.exec("UPDATE tasks SET updated = ? WHERE id = ?", now(), id);
    this.changed(id);
  }

  async add(input: { title: string; description: string; by: string; origin: string; startAfter?: unknown; mergeAfter?: unknown }): Promise<Task> {
    const title = input.title.trim().slice(0, 200), description = input.description.trim().slice(0, 20000);
    if (!title) throw new Error("A task needs a title.");
    // A new task can't be in a cycle: nothing waits for it yet.
    const deps = this.deps.depChanges(Object.fromEntries(Object.entries({ startAfter: input.startAfter, mergeAfter: input.mergeAfter }).filter(([, v]) => v !== undefined)));
    if (typeof deps == "string") throw new Error(deps);
    const at = now();
    const id = this.sql.exec<{ id: number }>(`INSERT INTO tasks (title, description, status, branch, origin, by_login, created, updated, start_after, merge_after) VALUES (?, ?, 'queued', '', ?, ?, ?, ?, ?, ?) RETURNING id`,
      title, description || title, input.origin, input.by, at, at, deps.startAfter ? JSON.stringify(deps.startAfter) : null, deps.mergeAfter ? JSON.stringify(deps.mergeAfter) : null).one().id;
    this.sql.exec("UPDATE tasks SET branch = ? WHERE id = ?", branchName(id, title), id);
    this.note(id, `Added by ${input.by}${depsNote(deps)}`);
    const waiting = this.deps.unmetStart(depOf(this.row(id)!));
    if (waiting.length) this.note(id, `Queued: waiting for ${ids(waiting)} to merge (no VM until then)`);
    else this.begin(id);
    return this.view(this.row(id)!);
  }

  /** Starts a queued task's VM and job, once (the caller checked that nothing blocks it). */
  private begin(id: number) {
    if (this.starting.has(id)) return;
    this.starting.add(id);
    this.ctx.waitUntil(this.launch(id, "work").finally(() => { this.starting.delete(id); this.changed(id); }));
  }

  /** Start, for a queued task: refused while a startAfter task isn't merged (no VM starts). */
  async start(id: number, by: string, origin?: string): Promise<{ ok: boolean; error?: string }> {
    if (origin) this.sql.exec("UPDATE tasks SET origin = ? WHERE id = ?", origin, id);
    const r = this.row(id);
    if (!r) return { ok: false, error: "no such task" };
    if (r.status != "queued") return { ok: false, error: `task #${id} is ${r.status}: only a queued task can be started` };
    const why = this.deps.startRefusal(depOf(r));
    if (why) return { ok: false, error: why };
    if (!this.starting.has(id)) this.note(id, `Started by ${by}`);
    this.begin(id);
    return { ok: true };
  }

  /** Changes a task's dependencies (startAfter, mergeAfter: lists of ids; null or [] clears one). */
  async setDeps(id: number, body: Record<string, unknown>, by: string, origin?: string): Promise<{ ok: boolean; error?: string; status?: number }> {
    if (origin) this.sql.exec("UPDATE tasks SET origin = ? WHERE id = ?", origin, id);
    const r = this.row(id);
    if (!r) return { ok: false, error: "no such task", status: 404 };
    if (!("startAfter" in body) && !("mergeAfter" in body)) return { ok: false, error: "send startAfter or mergeAfter", status: 400 };
    if (["merging", "merged", "discarded"].includes(r.status)) return { ok: false, error: `task #${id} is ${r.status}: its dependencies can't change`, status: 409 };
    const deps = this.deps.depChanges(body, depOf(r));
    if (typeof deps == "string") return { ok: false, error: deps, status: 400 };
    const next = { startAfter: "startAfter" in deps ? deps.startAfter : list(r.start_after), mergeAfter: "mergeAfter" in deps ? deps.mergeAfter : list(r.merge_after) };
    const fields: Partial<Record<keyof Row, string | null>> = {};
    if ("startAfter" in deps) fields.start_after = deps.startAfter ? JSON.stringify(deps.startAfter) : null;
    if ("mergeAfter" in deps) fields.merge_after = deps.mergeAfter ? JSON.stringify(deps.mergeAfter) : null;
    this.update(id, fields, `Dependencies (${by}): ${depsNote(next).replace(/^ \(|\)$/g, "") || "none"}`);
    this.startUnblocked([id]);
    return { ok: true };
  }

  /** Starts each of these tasks that is queued and no longer waits for anything (the factory has no outer agent to do it). */
  private startUnblocked(ids: number[]) {
    for (const id of ids) {
      const r = this.row(id);
      if (r?.status == "queued" && !r.vm && !this.deps.unmetStart(depOf(r)).length) this.begin(id);
    }
  }

  /** A dependency's news (merged, discarded, failed): on each dependent's log, as an event, and the unblocked queued ones started. */
  private tellDependents(id: number) {
    const dep = this.row(id);
    if (!dep) return;
    const waiting = dependents(this.sql.exec<Row>("SELECT * FROM tasks WHERE status NOT IN ('merged', 'discarded')").toArray().map(depOf), id);
    for (const t of waiting) {
      const news = this.deps.dependentNews(depOf(dep), t);
      this.note(t.id, news.message);
      if (news.change) this.event({ type: news.change, id: t.id, title: this.row(t.id)!.title, why: news.message });
    }
    if (dep.status == "merged") this.startUnblocked(waiting.map((t) => t.id));
  }

  /** A VM for the task (a new one unless it has one that's up), then the job. */
  private async launch(id: number, job: "work" | "revise" | "resolve") {
    // A merge that needs the agent stays "needs agent" while the task's Claude Code finishes it.
    const status = job == "resolve" ? "needs agent" : "working";
    const r = this.row(id)!;
    const host = vmHost(this.env, r.origin);
    if (typeof host == "string") { this.update(id, { status: "failed", error: host }); return this.tellDependents(id); }
    try {
      let vm = r.vm;
      if (!vm || !(await host.alive(vm).catch(() => false))) {
        this.note(id, "Starting a VM");
        const t = Date.now();
        const started = await host.start(id);
        vm = started.vm;
        this.update(id, { vm, preview_origin: started.preview, preview_path: null, status }, `VM ${vm} started in ${((Date.now() - t) / 1000).toFixed(1)}s`);
        this.keepAlive();
      } else this.update(id, { status });
      await host.job(vm, "run.ts", [job], await this.jobEnv(id, "task"), false);
    } catch (e) {
      if (job == "resolve") return this.backToReady(id, `The merge needs Claude Code, but it couldn't be woken: ${(e as Error).message}`);
      this.update(id, { status: "failed", error: `The VM didn't start: ${(e as Error).message}` }, `Failed: the VM didn't start: ${(e as Error).message}`);
      this.tellDependents(id);
    }
  }

  /** A merge that ended without merging: back to ready to merge, with the reason (as the local queue does). */
  private backToReady(id: number, error: string) {
    this.update(id, { status: "complete", error, merge_by: null }, `Merge failed: ${error.slice(0, 600)}`);
  }

  /** What a job in the task's VM gets: where to report and with what, the repository, and the Claude token when there is one. */
  private async jobEnv(id: number, scope: "task" | "merge", by?: string): Promise<Record<string, string>> {
    const r = this.row(id)!;
    const host = vmHost(this.env, r.origin) as VmHost;
    const claude = await this.claudeToken();
    return {
      FACTORY_API: `${r.origin}/api/factory`, FACTORY_TASK: String(id), FACTORY_TOKEN: await taskToken(this.env, id),
      REPO_URL: host.repo(r.origin), REPO_TOKEN: await gitToken(this.env, scope, r.branch, by ?? r.by_login),
      ...(claude ? { CLAUDE_CODE_OAUTH_TOKEN: claude } : {}),
    };
  }

  async brief(id: number) {
    const r = this.row(id);
    if (!r) return null;
    return { title: r.title, branch: r.branch, base: "staging", prompt: taskPrompt({ ...r, base: "staging" }), instructions: r.instructions, maxTurns: 200 };
  }

  /** A VM's report on its task. */
  async report(id: number, kind: "log" | "branch" | "preview" | "status", body: any): Promise<{ ok: boolean; error?: string }> {
    const r = this.row(id);
    if (!r) return { ok: false, error: "no such task" };
    if (["merged", "discarded"].includes(r.status)) return { ok: false, error: `task #${id} is ${r.status}` };
    switch (kind) {
      case "log": this.note(id, String(body.message ?? "")); break;
      case "branch": this.update(id, { base: String(body.base ?? "") || null }); break;
      case "preview": this.update(id, { preview_path: String(body.path || "/") }, `Preview up: ${r.preview_origin}${body.path || "/"}`); break;
      case "status": {
        if (r.status == "merging") return { ok: false, error: "the task is merging" };
        if (r.status == "needs agent") {
          // The task's Claude Code finished the merge's problem: the merge goes on by itself. Or it couldn't.
          if (body.status == "complete") {
            this.update(id, { status: "merging", error: null, commit_sha: body.commit ? String(body.commit) : r.commit_sha }, `Claude Code: ${String(body.summary ?? "done").slice(0, 1500)}`);
            this.note(id, "The merge goes on");
            this.queueMerge(id, r.merge_by ?? r.by_login);
          } else if (body.status == "failed") this.backToReady(id, `Claude Code couldn't finish the merge: ${String(body.error ?? "failed")}`);
          else return { ok: false, error: "status: complete or failed" };
          return { ok: true };
        }
        if (body.status == "complete") this.update(id, { status: "complete", summary: String(body.summary ?? ""), commit_sha: body.commit ? String(body.commit) : r.commit_sha, error: null }, "Ready to merge");
        else if (body.status == "failed") { this.update(id, { status: "failed", error: String(body.error ?? "failed") }, "Failed"); if (r.status != "failed") this.tellDependents(id); }
        else return { ok: false, error: "status: complete or failed" };
      }
    }
    return { ok: true };
  }

  async addShot(id: number, data: Uint8Array, caption: string, replace: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!this.row(id)) return { ok: false, error: "no such task" };
    if (data.length > 1_900_000) return { ok: false, error: "a screenshot may be 1.9 MB at most" };
    if (replace) this.sql.exec("DELETE FROM shots WHERE task = ?", id);
    const file = `${id}-${Date.now().toString(36)}${crypto.getRandomValues(new Uint8Array(3)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}.png`;
    this.sql.exec("INSERT INTO shots (task, file, caption, at, data) VALUES (?, ?, ?, ?, ?)", id, file, caption.slice(0, 300), now(), data);
    this.note(id, `Screenshot: ${caption || file}`);
    return { ok: true };
  }

  async revise(id: number, instructions: string, by: string, origin?: string): Promise<{ ok: boolean; error?: string }> {
    // The server as the person asking reaches it now (it can move: another port locally).
    if (origin) this.sql.exec("UPDATE tasks SET origin = ? WHERE id = ?", origin, id);
    const r = this.row(id);
    if (!r) return { ok: false, error: "no such task" };
    if (!["complete", "failed"].includes(r.status)) return { ok: false, error: `task #${id} is ${r.status}: it takes instructions when it's ready to merge or failed` };
    if (!instructions.trim()) return { ok: false, error: "Say what to change." };
    const why = this.deps.startRefusal(depOf(r));
    if (why) return { ok: false, error: why };
    this.update(id, { instructions: instructions.trim().slice(0, 20000), status: "working", error: null }, `${by} asked: ${instructions.trim().slice(0, 500)}`);
    this.ctx.waitUntil(this.launch(id, "revise"));
    return { ok: true };
  }

  async merge(id: number, by: string, origin?: string): Promise<{ ok: boolean; error?: string }> {
    // The server as the person asking reaches it now (it can move: another port locally).
    if (origin) this.sql.exec("UPDATE tasks SET origin = ? WHERE id = ?", origin, id);
    const r = this.row(id);
    if (!r) return { ok: false, error: "no such task" };
    if (r.status != "complete") return { ok: false, error: `task #${id} is ${r.status}: only a task that's ready to merge can be merged` };
    // Its dependencies merged, or merging now (ahead of it: checked again when its turn comes).
    const why = this.deps.mergeRefusal(depOf(r));
    if (why) return { ok: false, error: why };
    const waiting = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM tasks WHERE status = 'merging'").one().n;
    this.update(id, { status: "merging", error: null, merge_by: by }, waiting ? `Merge requested by ${by}: waiting for ${waiting} merge${waiting > 1 ? "s" : ""} first` : `Merge requested by ${by}`);
    this.queueMerge(id, by);
    return { ok: true };
  }

  /** The task's merge, after the ones asked for before it (one at a time). */
  private queueMerge(id: number, by: string) {
    const run = this.merges.then(() => this.doMerge(id, by));
    this.merges = run.catch(() => {});
    this.ctx.waitUntil(run);
  }

  private async doMerge(id: number, by: string) {
    const r = this.row(id)!;
    // Discarded meanwhile (while it waited for its turn).
    if (r.status != "merging") return;
    const host = vmHost(this.env, r.origin);
    if (typeof host == "string") return this.backToReady(id, host);
    // A dependency that hasn't merged (its merge, queued ahead of this one, failed; or one added meanwhile).
    const waiting = this.deps.mergeTimeRefusal(depOf(r));
    if (waiting) return this.backToReady(id, waiting);
    try {
      this.note(id, `Merging staging into ${r.branch}, then ${r.branch} into staging (the preview stops)`);
      const vm = await this.vmFor(id, host);
      // The job stops the preview first: the board's link goes.
      this.update(id, { preview_path: null });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const out = await Promise.race([
        host.job(vm, "merge.ts", ["merge", r.branch, r.title], await this.jobEnv(id, "merge", by), true),
        new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`the merge job didn't answer in ${MERGE_JOB_MS / 60_000} minutes`)), MERGE_JOB_MS); }),
      ]).finally(() => clearTimeout(timer));
      const res = resultOf(out);
      if (this.row(id)?.status != "merging") return;
      if (!res.ok && res.needsAgent) {
        // The task's own Claude Code finishes it, in its clone, in the same session; then the merge goes on.
        this.update(id, { status: "needs agent", error: res.error ?? "the merge stopped", instructions: resolvePrompt(r, res) },
          `Needs agent: ${String(res.error ?? "").split("\n")[0].slice(0, 400)} Claude Code is woken to finish the merge.`);
        this.ctx.waitUntil(this.launch(id, "resolve"));
        return;
      }
      if (!res.ok) return this.backToReady(id, `The merge failed: ${res.error}`);
      await host.stop(vm).catch(() => {});
      this.update(id, { status: "merged", merged_at: now(), merge_commit: String(res.commit), vm: null, preview_origin: null, merge_by: null }, `Merged into staging as ${String(res.commit).slice(0, 10)}; ${r.branch} deleted; VM stopped`);
      this.tellDependents(id);
      // Staging moved. On Cloudflare the push went through Erga's Git endpoint, which tells the deploy pipeline itself
      // (worker/source-host.ts, deployHook): staging.erga.dev builds and deploys it. Locally the repository is the dev
      // server's own, which no deploy reads.
      this.note(id, host.kind == "local" ? "Staging moved (the local repository: nothing deploys it)" : "Staging moved: staging.erga.dev deploys it now (see /admin/source)");
    } catch (e) {
      this.backToReady(id, `The merge failed: ${(e as Error).message}`);
    }
  }

  async discard(id: number, by: string, origin?: string): Promise<{ ok: boolean; error?: string }> {
    // The server as the person asking reaches it now (it can move: another port locally).
    if (origin) this.sql.exec("UPDATE tasks SET origin = ? WHERE id = ?", origin, id);
    const r = this.row(id);
    if (!r) return { ok: false, error: "no such task" };
    if (["merging", "merged", "discarded"].includes(r.status)) return { ok: false, error: `task #${id} is ${r.status}` };
    this.update(id, { status: "discarded", preview_origin: null }, `Discarded by ${by}`);
    this.tellDependents(id);
    // A queued task that never started has no VM and no branch to delete.
    if (r.status == "queued" && !r.vm && !this.starting.has(id)) return { ok: true };
    this.ctx.waitUntil((async () => {
      const host = vmHost(this.env, r.origin);
      if (typeof host == "string") return;
      try {
        const vm = await this.vmFor(id, host);
        const res = resultOf(await host.job(vm, "merge.ts", ["discard", r.branch], await this.jobEnv(id, "task"), true));
        await host.stop(vm).catch(() => {});
        this.update(id, { vm: null }, res.ok ? `${r.branch} deleted; VM stopped` : `Couldn't delete ${r.branch}: ${res.error}`);
      } catch (e) {
        this.note(id, `Couldn't delete ${r.branch}: ${(e as Error).message}`);
      }
    })());
    return { ok: true };
  }

  /** The task's VM if it's up, else a new one (for a merge or a discard). */
  private async vmFor(id: number, host: VmHost): Promise<string> {
    const r = this.row(id)!;
    if (r.vm && (await host.alive(r.vm).catch(() => false))) return r.vm;
    const started = await host.start(id);
    this.update(id, { vm: started.vm, preview_origin: null }, `VM ${started.vm} started for the job`);
    this.keepAlive();
    return started.vm;
  }

  // -- keeping VMs up

  /**
   * On Cloudflare a container stops a while after its Durable Object last heard from anyone (factory/cloudflare.ts sets
   * that to the most it may be, six hours), and a task's VM can wait longer than that for a merge, with its preview.
   * So every 20 minutes, while any task has a VM, the factory asks each one whether it's up, which keeps it up.
   */
  private keepAlive() {
    this.ctx.waitUntil((async () => { if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 20 * 60_000); })());
  }

  async alarm() {
    const rows = this.sql.exec<Row>("SELECT * FROM tasks WHERE vm IS NOT NULL AND status NOT IN ('merged', 'discarded')").toArray();
    let any = false;
    for (const r of rows) {
      const host = vmHost(this.env, r.origin);
      if (typeof host == "string" || host.kind != "cloudflare") continue;
      any = true;
      if (!(await host.alive(r.vm!).catch(() => true))) {
        this.update(r.id, { vm: null, preview_origin: null }, "The VM stopped by itself (its preview is gone). More instructions, or a merge, start a new one.");
        if (r.status == "needs agent") this.backToReady(r.id, "The VM stopped while Claude Code finished the merge. Merge again.");
      }
    }
    if (any) await this.ctx.storage.setAlarm(Date.now() + 20 * 60_000);
  }

  // -- the Claude plan's token

  async claude(): Promise<{ signedIn: boolean; at: string | null; by: string | null; canStore: boolean }> {
    const r = this.sql.exec<{ at: string; by_login: string }>("SELECT at, by_login FROM secrets WHERE name = 'claude'").toArray()[0];
    return { signedIn: !!r, at: r?.at ?? null, by: r?.by_login ?? null, canStore: !!factoryKey(this.env) };
  }

  async setClaude(token: string | null, by: string): Promise<{ ok: boolean; error?: string }> {
    if (token == null) { this.sql.exec("DELETE FROM secrets WHERE name = 'claude'"); return { ok: true }; }
    token = token.trim();
    if (!factoryKey(this.env)) return { ok: false, error: "This server has no FACTORY_KEY to encrypt the token with: bun deploy/setup.ts --factory makes it (README, The factory, On Cloudflare)." };
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(token)) return { ok: false, error: "That isn't a Claude Code token. Run `claude setup-token` and paste the token it prints (sk-ant-…)." };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(this.env), enc.encode(token)));
    this.sql.exec("INSERT OR REPLACE INTO secrets (name, iv, data, by_login, at) VALUES ('claude', ?, ?, ?, ?)", iv, data, by, now());
    return { ok: true };
  }

  private async claudeToken(): Promise<string | null> {
    const r = this.sql.exec<{ iv: ArrayBuffer; data: ArrayBuffer }>("SELECT iv, data FROM secrets WHERE name = 'claude'").toArray()[0];
    if (!r || !factoryKey(this.env)) return null;
    try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(r.iv) }, await aes(this.env), new Uint8Array(r.data))); } catch { return null; }
  }

  // -- the factory's own agent (factory/agent.ts), one per admin

  private config(): Promise<AgentConfig | { missing: string }> {
    return this.agentCfg ??= Effect.runPromise(agentConfigFrom(ConfigProvider.fromUnknown(this.env)));
  }

  /**
   * Why the admin may not act now, or null: their unlock (the one their page sent last) must not have ended, its key
   * must still be theirs (a revoked key ends it at once), and they must still be an admin. Every tool call asks.
   */
  private async refusal(login: string, unlock: Unlock): Promise<string | null> {
    if (!(unlock.until > Date.now())) return LOCKED;
    const keyOk = unlock.key == "local" ? !!(this.env.DEV_LOGIN && this.env.ERGA_LINK_SECRET) : (await adminKeysOf(this.env).ownerOf(unlock.key)) == login;
    if (!keyOk) return LOCKED;
    if (!(await directoryOf(this.env).users.isAdmin(login))) return "Only admins can use the factory.";
    return null;
  }

  /** The admin's session, made the first time; the unlock and origin are the latest the page sent. */
  private async session(login: string, unlock: Unlock, origin: string): Promise<{ agent: FactoryAgent; unlock: Unlock; origin: string } | string> {
    const cfg = await this.config();
    if ("missing" in cfg) return cfg.missing;
    let s = this.agents.get(login);
    if (s) { s.unlock = unlock; s.origin = origin; return s; }
    const by = agentName(login);
    const on = async () => {
      if ((await directoryOf(this.env).config.get("factory")) != "on") throw new Error("The factory is off: an admin turns it on with the factory setting (/admin).");
    };
    const state = { unlock, origin };
    const ops: FactoryOps = {
      info: async () => {
        const host = vmHost(this.env, state.origin);
        return { enabled: (await directoryOf(this.env).config.get("factory")) == "on", vms: typeof host == "string" ? host : host.kind, claude: (await this.claude()).signedIn };
      },
      list: () => this.list(),
      task: (id) => this.task(id),
      add: async (input) => { await on(); return this.add({ ...input, by, origin: state.origin }); },
      setDeps: async (id, body) => { await on(); return this.setDeps(id, body, by, state.origin); },
      revise: async (id, instructions) => { await on(); return this.revise(id, instructions, by, state.origin); },
      shot: (file) => this.shot(file),
    };
    const guard = async () => {
      const why = await this.refusal(login, state.unlock);
      if (why) throw new Error(why);
    };
    const agent = startFactoryAgent({ cfg, owner: login, tools: factoryTools(ops, guard) });
    agent.subscribe((ev) => this.event({ type: "agent", ev }, login));
    s = Object.assign(state, { agent });
    this.agents.set(login, s);
    return s;
  }

  async agentState(login: string, unlock: Unlock, origin: string) {
    const s = await this.session(login, unlock, origin);
    if (typeof s == "string") return { enabled: false, reason: s };
    const models = s.agent.modelChoice ? Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })) : [];
    return { enabled: true, model: s.agent.model, choice: s.agent.modelChoice, models, log: s.agent.log() };
  }

  async agentPrompt(login: string, unlock: Unlock, origin: string, text: string, context: string | null): Promise<{ ok: boolean; reason?: string }> {
    const why = await this.refusal(login, unlock);
    if (why) return { ok: false, reason: why };
    const s = await this.session(login, unlock, origin);
    if (typeof s == "string") return { ok: false, reason: `the agent is off: ${s}` };
    if (!text.trim()) return { ok: false, reason: "say something" };
    s.agent.prompt(text.slice(0, 20000), context ? context.slice(0, 4000) : null);
    return { ok: true };
  }

  async agentControl(login: string, op: "abort" | "reset" | "model", model?: string) {
    const s = this.agents.get(login);
    if (!s) return { ok: op != "model", reason: "the agent hasn't started" };
    if (op == "abort") s.agent.abort();
    else if (op == "reset") await s.agent.reset();
    else if (!model || !isModelChoice(model) || !s.agent.setModel(model)) return { ok: false, reason: "that model isn't one of the choices" };
    return { ok: true, model: s.agent.model, choice: s.agent.modelChoice, models: s.agent.modelChoice ? Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })) : [] };
  }

  // -- factory tokens, for outside agents ("Share with agent")

  /** A new token for an outside agent: shown once. `key` is the admin key that unlocked the admin: revoking it ends the token. */
  async mintToken(login: string, name: string, key: string, label: string, hours: number): Promise<{ token: string } & TokenView> {
    const id = hex(crypto.getRandomValues(new Uint8Array(9)));
    const secret = b64url(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
    const ms = Math.round(Math.max(1, Math.min(12, hours || 4)) * 3600_000);
    const at = Date.now();
    this.sql.exec("INSERT INTO agent_tokens (id, hash, login, name, label, unlock_key, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, hex(await crypto.subtle.digest("SHA-256", enc.encode(secret))), login, name, label.replace(/\s+/g, " ").trim().slice(0, 60) || "Outside agent", key, at, at + ms);
    return { token: `${TOKEN_PREFIX}${id}_${secret}`, ...this.tokenView(this.sql.exec<TokenRow>("SELECT * FROM agent_tokens WHERE id = ?", id).one()) };
  }

  private tokenView(r: TokenRow): TokenView {
    return { id: r.id, login: r.login, label: r.label, created: r.created, expires: r.expires, revoked: r.revoked, revokedBy: r.revoked_by, lastUsed: r.last_used };
  }

  /** The tokens of the last week (working or not), newest first; never their secrets. */
  async tokens(): Promise<TokenView[]> {
    return this.sql.exec<TokenRow>("SELECT * FROM agent_tokens WHERE created > ? ORDER BY created DESC LIMIT 50", Date.now() - 7 * 86400_000).toArray().map((r) => this.tokenView(r));
  }

  async revokeToken(id: string, by: string): Promise<boolean> {
    const r = this.sql.exec<TokenRow>("SELECT * FROM agent_tokens WHERE id = ? AND revoked IS NULL", id).toArray()[0];
    if (!r) return false;
    this.sql.exec("UPDATE agent_tokens SET revoked = ?, revoked_by = ? WHERE id = ?", Date.now(), by, id);
    return true;
  }

  /** Whose a token is, while it works (not revoked, not ended); the caller checks the key and the admin. */
  async readToken(raw: string): Promise<{ id: string; login: string; name: string; label: string; key: string; expires: number } | null> {
    const m = /^erga_factory_([0-9a-f]{18})_([A-Za-z0-9_-]{20,64})$/.exec(raw);
    if (!m) return null;
    const r = this.sql.exec<TokenRow>("SELECT * FROM agent_tokens WHERE id = ?", m[1]).toArray()[0];
    if (!r || r.revoked != null || r.expires <= Date.now()) return null;
    const want = enc.encode(r.hash), got = enc.encode(hex(await crypto.subtle.digest("SHA-256", enc.encode(m[2]))));
    if (want.length != got.length || !crypto.subtle.timingSafeEqual(want, got)) return null;
    if (!r.last_used || Date.now() - r.last_used > 60_000) this.sql.exec("UPDATE agent_tokens SET last_used = ? WHERE id = ?", Date.now(), r.id);
    return { id: r.id, login: r.login, name: r.name, label: r.label, key: r.unlock_key, expires: r.expires };
  }

  // -- live updates

  async fetch(request: Request): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    this.clients.set(w, request.headers.get("x-erga-login"));
    this.send(w, ": connected\nretry: 2000\n\n");
    this.beat ??= setInterval(() => {
      for (const c of this.clients.keys()) this.send(c, ": beat\n\n");
      if (!this.clients.size && this.beat) { clearInterval(this.beat); this.beat = null; }
    }, 20_000);
    return new Response(readable, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  }

  /** Sends the task to the board, and the tasks that depend on it (their blockedBy may have changed with it). */
  private changed(id: number) {
    const r = this.row(id);
    if (!r) return;
    const rows = [r, ...this.sql.exec<Row>("SELECT * FROM tasks WHERE status NOT IN ('merged', 'discarded') AND id != ?", id).toArray().filter((t) => list(t.start_after).includes(id) || list(t.merge_after).includes(id))];
    for (const t of rows) this.event({ type: "task", task: this.view(t) });
  }

  /** An event for every board, or (`login`) for that admin's pages only. */
  private event(data: Record<string, unknown>, login?: string) {
    const line = enc.encode(`data: ${JSON.stringify(data)}\n\n`);
    for (const [c, who] of this.clients) if (login == null || who == login) this.send(c, line);
  }

  private send(w: WritableStreamDefaultWriter<Uint8Array>, s: string | Uint8Array) {
    w.write(typeof s == "string" ? enc.encode(s) : s).catch(() => { this.clients.delete(w); w.abort().catch(() => {}); });
  }
}

/** A merge or discard job's result: its output's FACTORY-RESULT line. */
function resultOf(out: { code: number; output: string } | null): { ok: boolean; error?: string; commit?: string; needsAgent?: boolean; kind?: string; step?: string; files?: string[] } {
  const line = out?.output.split("\n").reverse().find((l) => l.startsWith("FACTORY-RESULT "));
  if (!line) return { ok: false, error: `the job ended without a result (exit ${out?.code}): ${out?.output.slice(-400) ?? ""}` };
  return JSON.parse(line.slice("FACTORY-RESULT ".length));
}

// ---- the routes --------------------------------------------------------------------------

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const factory = (env: Env) => env.FACTORY.getByName("factory");

/** Whether the `factory` setting is on. */
const enabled = async (env: Env) => (await directoryOf(env).config.get("factory")) == "on";

/**
 * An admin, signed in (the person, in a browser: agent tokens don't reach the factory), who has unlocked
 * admin access with their SSH key (admin-keys.ts); "locked" for an admin who hasn't yet.
 */
async function adminOf(env: Env, request: Request): Promise<{ login: string; name: string; unlock: Unlock } | "locked" | null> {
  const session = await sessionOf(env, request);
  if (!session || session.test || (session as { agent?: unknown }).agent) return null;
  const users = directoryOf(env).users, who = whoOf(session);
  if (!(await users.isAdmin(who))) return null;
  return (await users.isUnlocked(who)) && session.unlocked ? { login: session.login.toLowerCase(), name: session.name, unlock: session.unlocked } : "locked";
}

/** /admin/factory: the board is on /admin/source now, with the source dashboard and the factory's agent. */
export function factoryDoor(): Response {
  return new Response(null, { status: 302, headers: { Location: "/admin/source" } });
}

/** Whether the factory is on, for the page (worker/source.ts). */
export const factoryEnabled = enabled;

/**
 * An outside agent with a factory token ("Share with agent"): it may create, read and instruct tasks, as its
 * admin's agent, while the token works, its key is still the admin's, and they're still an admin.
 */
async function sharedAgentApi(request: Request, env: Env, url: URL, raw: string, path: string, id: number | null, action: string): Promise<Response> {
  const f = factory(env);
  const t = await f.readToken(raw);
  const keyOk = t && (t.key == "local" ? isDev(env, url) : (await adminKeysOf(env).ownerOf(t.key)) == t.login);
  if (!t || !keyOk || !(await directoryOf(env).users.isAdmin(t.login))) {
    return json({ error: "That factory token doesn't work: it ended, was revoked, or the admin key that made it was. Ask an admin for a new one (Share with agent, on /admin/source)." }, 401);
  }
  const by = `${agentName(t.login)} (shared: ${t.label})`;
  const m = request.method;
  if (path == "/api/factory/guide" && m == "GET") return new Response(factoryGuide({ origin: url.origin, owner: t.login, label: t.label, expires: t.expires }), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" } });
  if (path == "/api/factory" && m == "GET") {
    const host = vmHost(env, url.origin), claude = await f.claude();
    return json({ enabled: await enabled(env), vms: typeof host == "string" ? { runner: null, why: host } : { runner: host.kind }, claude: { signedIn: claude.signedIn } });
  }
  if (path == "/api/factory/tasks" && m == "GET") return json(await f.list());
  if (id != null && !action && m == "GET") { const task = await f.task(id); return task ? json(task) : json({ error: "Not found" }, 404); }
  const shot = /^\/api\/factory\/shots\/([\w.-]+\.png)$/.exec(path);
  if (shot && m == "GET") {
    const data = await f.shot(shot[1]);
    return data ? new Response(data, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" } }) : json({ error: "Not found" }, 404);
  }
  const create = path == "/api/factory/tasks" && m == "POST", deps = id != null && !action && m == "PATCH", revise = id != null && action == "revise" && m == "POST";
  if (!create && !deps && !revise) return json({ error: "A factory token can only create, read and instruct tasks (GET /api/factory/guide). Merging, discarding and starting are an admin's, on /admin/source." }, 403);
  if (!(await enabled(env))) return json({ error: "The factory is off: an admin turns it on with the factory setting (/admin)." }, 409);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body != "object" || Array.isArray(body)) return json({ error: "Send JSON." }, 400);
  if (create) {
    try { return json(await f.add({ title: String(body.title ?? ""), description: String(body.description ?? ""), by, origin: url.origin, startAfter: body.startAfter, mergeAfter: body.mergeAfter }), 201); }
    catch (e) { return json({ error: (e as Error).message }, 400); }
  }
  const r = deps ? await f.setDeps(id!, body, by, url.origin) : await f.revise(id!, String(body.instructions ?? ""), by, url.origin);
  return r.ok ? json(await f.task(id!)) : json({ error: r.error }, (r as { status?: number }).status ?? 409);
}

/** /api/factory/... */
export async function factoryApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/$/, "");
  const m = /^\/api\/factory\/tasks\/(\d+)(?:\/(brief|log|branch|preview|screenshots|merge|discard|revise|open|start))?$/.exec(path);
  const id = m ? Number(m[1]) : null, action = m?.[2] ?? "";

  // An outside agent, with a factory token.
  const shared = /^Bearer\s+(erga_factory_\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (shared) return sharedAgentApi(request, env, url, shared, path, id, action);

  // A VM, with its task's token.
  const bearer = /^Bearer\s+(fct\.\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bearer) {
    const task = await taskOfToken(env, bearer);
    if (task == null || task != id) return json({ error: "That token isn't for this task." }, 403);
    const f = factory(env);
    if (action == "brief" && request.method == "GET") return json(await f.brief(task));
    if (action == "screenshots" && request.method == "POST") {
      const r = await f.addShot(task, new Uint8Array(await request.arrayBuffer()), url.searchParams.get("caption") ?? "", url.searchParams.get("replace") == "1");
      return json(r, r.ok ? 200 : 400);
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const kind = action == "" && request.method == "PATCH" ? "status" : (["log", "branch", "preview"].includes(action) && request.method == "POST" ? action : null);
    if (!kind) return json({ error: "Not found" }, 404);
    const r = await f.report(task, kind as "log", body);
    return json(r, r.ok ? 200 : 409);
  }

  const admin = await adminOf(env, request);
  if (!admin) return json({ error: "Only admins can use the factory." }, (await sessionOf(env, request)) ? 403 : 401);
  if (admin == "locked") return json({ error: LOCKED, locked: true }, 403);
  if (request.method != "GET" && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  const f = factory(env);
  const on = await enabled(env);
  if (path == "/api/factory" && request.method == "GET") {
    const vms = await vmsInfo(env, url.origin);
    const host = vmHost(env, url.origin);
    return json({ enabled: on, vms: typeof host == "string" ? { runner: null, why: host } : { runner: vms?.runner ?? host.kind }, claude: await f.claude() });
  }
  if (path == "/api/factory/events" && request.method == "GET") {
    const headers = new Headers(request.headers);
    headers.set("x-erga-login", admin.login);
    return f.fetch(new Request(request.url, { headers }));
  }
  if (path == "/api/factory/guide" && request.method == "GET") return new Response(factoryGuide({ origin: url.origin, owner: admin.login, label: "(your token's label)", expires: Date.now() + 4 * 3600_000 }), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" } });
  // The factory's own agent, for this admin.
  if (path == "/api/factory/agent") {
    if (request.method == "GET") return json(await f.agentState(admin.login, admin.unlock, url.origin));
    if (request.method == "POST") {
      const body = await request.json().catch(() => ({})) as { text?: unknown; context?: unknown };
      const r = await f.agentPrompt(admin.login, admin.unlock, url.origin, String(body.text ?? ""), typeof body.context == "string" ? body.context : null);
      return json(r, r.ok ? 200 : 409);
    }
  }
  const control = /^\/api\/factory\/agent\/(abort|reset|model)$/.exec(path)?.[1] as "abort" | "reset" | "model" | undefined;
  if (control && request.method == "POST") {
    const body = control == "model" ? await request.json().catch(() => ({})) as { model?: string } : {};
    const r = await f.agentControl(admin.login, control, body.model);
    return json(r, r.ok ? 200 : 409);
  }
  // Factory tokens, for outside agents (Share with agent).
  if (path == "/api/factory/tokens") {
    if (request.method == "GET") return json({ tokens: await f.tokens() });
    if (request.method == "POST") {
      const body = await request.json().catch(() => ({})) as { label?: unknown; hours?: unknown };
      return json(await f.mintToken(admin.login, admin.name, admin.unlock.key, String(body.label ?? ""), Number(body.hours) || 4), 201);
    }
  }
  const tok = /^\/api\/factory\/tokens\/([0-9a-f]{18})$/.exec(path)?.[1];
  if (tok && request.method == "DELETE") return (await f.revokeToken(tok, admin.login)) ? json({ ok: true, tokens: await f.tokens() }) : json({ error: "No such token, or it's revoked already." }, 404);
  const shot = /^\/api\/factory\/shots\/([\w.-]+\.png)$/.exec(path);
  if (shot && request.method == "GET") {
    const data = await f.shot(shot[1]);
    return data ? new Response(data, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable" } }) : json({ error: "Not found" }, 404);
  }
  if (path == "/api/factory/tasks" && request.method == "GET") return json(await f.list());
  // The preview, for the person asking: on Cloudflare with a ticket for its host (factory/cloudflare.ts).
  if (id != null && action == "open" && request.method == "GET") {
    const t = await f.task(id);
    if (!t?.url || !t.vm) return new Response("This task has no preview now.", { status: 404 });
    const to = new URL(t.url);
    if (to.protocol == "https:") to.searchParams.set("factory_ticket", await previewTicket(env, t.vm));
    return new Response(null, { status: 302, headers: { Location: to.toString() } });
  }
  if (id != null && !action && request.method == "GET") { const t = await f.task(id); return t ? json(t) : json({ error: "Not found" }, 404); }
  if (path == "/api/factory/claude") {
    if (request.method == "GET") return json(await f.claude());
    const token = request.method == "DELETE" ? null : String(((await request.json().catch(() => ({}))) as { token?: string }).token ?? "");
    const r = await f.setClaude(token, admin.login);
    return r.ok ? json(await f.claude()) : json(r, 400);
  }
  // Everything that changes something needs the factory on.
  if (!on) return json({ error: "The factory is off: an admin turns it on with the factory setting (/admin)." }, 409);
  if (path == "/api/factory/tasks" && request.method == "POST") {
    const body = await request.json().catch(() => ({})) as { title?: string; description?: string; startAfter?: unknown; mergeAfter?: unknown };
    try { return json(await f.add({ title: String(body.title ?? ""), description: String(body.description ?? ""), by: admin.login, origin: url.origin, startAfter: body.startAfter, mergeAfter: body.mergeAfter }), 201); }
    catch (e) { return json({ error: (e as Error).message }, 400); }
  }
  if (id != null && !action && request.method == "PATCH") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body != "object" || Array.isArray(body)) return json({ error: "send JSON: { startAfter, mergeAfter }" }, 400);
    const r = await f.setDeps(id, body as Record<string, unknown>, admin.login, url.origin);
    return r.ok ? json(await f.task(id)) : json({ error: r.error }, r.status ?? 409);
  }
  if (id != null && request.method == "POST" && ["merge", "discard", "revise", "start"].includes(action)) {
    const body = action == "revise" ? await request.json().catch(() => ({})) as { instructions?: string } : {};
    const r = action == "merge" ? await f.merge(id, admin.login, url.origin) : action == "discard" ? await f.discard(id, admin.login, url.origin)
      : action == "start" ? await f.start(id, admin.login, url.origin) : await f.revise(id, String(body.instructions ?? ""), admin.login, url.origin);
    return r.ok ? json(await f.task(id), action == "merge" ? 202 : 200) : json(r, 409);
  }
  return json({ error: "Not found" }, 404);
}

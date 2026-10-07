// The factory (experimental): Erga's task queue. Each task is a
// branch of Erga's own repository, task/<id>-<slug>, made from staging, and
// a VM in which Claude Code does the work and reports back. Merging a task
// merges its branch into staging and deletes it; discarding it deletes it.
// Admins only, and only while the `factory` setting is "on". README, The
// factory, has the design, the findings and the runbook.
//
//   /admin/factory                         the board (factory/page.ts), on the Factory page (worker/source.ts),
//                                          with the source dashboard and the factory's own agent
//   GET  /api/factory                      { enabled, vms, claude: { signedIn, at, by } }
//   GET  /api/factory/tasks[/<id>]         the tasks, each with its log (the last 200 lines; one task's, all
//                                          of them with ?log=all) and screenshots
//   POST /api/factory/tasks                { title, description, startAfter?, mergeAfter?, local? }: a new task (its branch,
//                                          then its VM, unless it waits for a startAfter task to merge). With
//                                          local: { machine } it is a local task: no VM; the agent that asked runs it
//   PATCH /api/factory/tasks/<id>          { startAfter?, mergeAfter? }: changes its dependencies (lists of ids, or null)
//   POST /api/factory/tasks/<id>/merge     into staging (one merge at a time), then the branch is deleted; 409 while
//                                          a dependency isn't merged (or merging ahead of it)
//   POST /api/factory/tasks/<id>/discard   the branch deleted, the VM stopped
//   POST /api/factory/tasks/<id>/revise    { instructions }: Claude Code works on the task again (ready to merge or
//                                          failed), or, while it works, gets them when its current step ends
//   POST /api/factory/tasks/<id>/restart   any task not merged or discarded (working, merging, stuck too) runs again on its
//                                          branch: its VM saves the work (merge.ts save) and stops; a fresh VM and git
//                                          token start Claude Code with the task's prompt and every earlier instruction
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
// An outside agent with an admin token ("Authorization: Bearer erga_...", tokens.ts, scope admin, whose person
// is an admin now: Share with agent on the admin pages makes one) uses the same API as the board, as its
// admin, except: setting the Claude token (a secret, set only on the page; it may sign the factory out) and the
// admin's own agent panel (/api/factory/agent...). Its events carry the board's changes only, never the
// admin's agent conversation. It doesn't need the page's Origin.
//
//   GET  /api/admin/guide                  what an outside agent with an admin token reads first: the admin
//                                          APIs, how to call them, and the token's limits (factory/agent.ts)
//   GET  /api/factory/guide                the same guide (its old address)
//
// A local task (factory/task.ts; README, The factory, "Local tasks") has no VM: a local agent (Claude Code on the
// admin's own machine) runs it in its own checkout, and reports with an admin token on the VMs' routes below
// (brief, inbox, log, branch, preview, screenshots, PATCH with a status), for a local task only. And:
//
//   POST  /api/factory/tasks/<id>/git           { token, repo, branch }: a git token that pushes the local task's branch
//                                               only (two hours), so its agent pushes through Erga's Git endpoint
//
// Merge starts a VM for the merge job only (merge.ts, in a fresh clone of the pushed branch); a conflict makes the
// task "needs agent" and tells the local agent (its inbox). Restart hands a local task to a VM, from its pushed branch.
//
// The VMs call back with their task's token (Authorization: Bearer fct...),
// which reaches their own task only:
//
//   GET   /api/factory/tasks/<id>/brief         the title, branch and prompt (and new instructions)
//   GET   /api/factory/tasks/<id>/inbox         { waiting }: instructions sent while the task works, not taken yet
//   POST  /api/factory/tasks/<id>/inbox         { how }: Claude Code takes them (each one once), and the log says so
//   POST  /api/factory/tasks/<id>/log           { message }
//   POST  /api/factory/tasks/<id>/branch        { base }: the branch is made (from staging at base)
//   POST  /api/factory/tasks/<id>/preview       { path }: the preview is up
//   POST  /api/factory/tasks/<id>/screenshots   a PNG body, ?caption=&replace=1
//   PATCH /api/factory/tasks/<id>               { status: "complete" | "failed", summary, error, commit, run }:
//                                               `run` (FACTORY_RUN) names the run of Claude Code; one that isn't
//                                               the task's current run (woken again since, or given up on) is refused
//
// Merge works in the task's own VM, in its clone (factory/vm/merge.ts): staging merged into the branch, then
// staging moved to a --no-ff merge commit. A conflict, or a step that fails or times out, sets the task to
// "needs agent" (Merge off, the reason on the card) and wakes the task's own Claude Code (run.ts resolve, the
// same session: --continue) with instructions to resolve, test under time limits and commit. When it says
// done, the merge runs again by itself (stopping that Claude Code first, if it is still saying its last words);
// when it fails, the task goes back to ready to merge with its reason, and its Claude Code is stopped.
//
// Dependencies between tasks (factory/deps.ts, README, The factory): startAfter and mergeAfter, a computed blockedBy, a
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
import type { SettingChange } from "../config";
import { type Blocked, dependents, depRules, depsNote, type DepStatus, type DepTask, ids } from "../factory/deps";
import type { ToolWho } from "../server-tools";
import type { SourceAnswer, SourceRead } from "../source/browse";
import { panelPrefs, restoredLog, restoredMessages, storedLog, storedMessages, type PanelPrefs } from "../factory/chat-store";
import { emptyLog, type Log, type LogEvent } from "../src/page/agent-log";
import { adminGuide, adminTools, dashboardTools, factoryTools, sourceTools, startFactoryAgent, type DashboardOps, type FactoryAgent, type FactoryOps } from "../factory/agent";
import { FACTORY_IDENTITY, githubIdOf, type Identity, personIdentity } from "../factory/author";
import { containersHost } from "../factory/cloudflare";
import { b64url } from "../factory/git-grant";
import { branchName, claudeToken, hideTokens, localResolvePrompt, resolvePrompt, restartPrompt, taskPrompt } from "../factory/prompt";
import { type Stalled, stalledOf } from "../factory/stall";
import { whoOf } from "../front";
import { sessionOf } from "./auth";
import { agentName } from "../src/room/doc";
import { checkAttachments } from "../src/page/attach";
import { directoryOf, factoryKey, tokensOf, withKeys } from "./d1";
import { SHARE_ADMIN_HOURS } from "../tokens";
import { LOCKED } from "../users";
import { forgetHome } from "./home";
import { hasSource } from "./artifacts";
import type { Env } from "./env";

/** "needs agent": a merge stopped (a conflict, or a step that failed or timed out) and the task's Claude Code is finishing it. */
export type Status = "queued" | "working" | "complete" | "merging" | "needs agent" | "merged" | "failed" | "discarded";

/** How long the factory waits for a merge job's answer (each of its steps has a shorter limit of its own: factory/vm/common.ts). */
const MERGE_JOB_MS = 30 * 60_000;
/** How long a restart waits for the old VM to save the work (stop Claude Code, commit, push) before it stops it anyway. */
const SAVE_JOB_MS = 3 * 60_000;

export interface Task {
  id: number; title: string; description: string; status: Status; branch: string; base: string | null;
  commit: string | null; summary: string | null; error: string | null;
  /** The task's preview, where the user opens it (null until the VM says it's up, and after the VM stops). */
  url: string | null;
  vm: string | null;
  /** Who added it, as the board says it: an admin, or their agent ("koomen’s agent"). */
  by: string;
  /** The person who added it (their login), in person or through an agent: the author of the task's commits. Null for a task from before. */
  person: string | null;
  createdAt: string; updatedAt: string; mergedAt: string | null; mergeCommit: string | null;
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
  /** Computed on every read: working or needs agent, and no new log line in 5 minutes (factory/stall.ts). */
  stalled?: Stalled;
  /** Instructions sent while it works that its Claude Code hasn't got yet (it gets them when its current step ends). */
  waiting?: number;
  /** A local task: no VM; a local agent runs it (who, on which machine, since when). Null for a VM's task. */
  local: Local | null;
  /** A local task that was handed to a VM (Restart): who ran it locally, on which machine. */
  handedFrom: string | null;
}

/** Who runs a local task: "koomen’s agent (Laptop)" on "pete-mbp", since a time. */
export interface Local { by: string; machine: string; since: string }

/** "koomen’s agent (Laptop) on pete-mbp". */
export const runsWhere = (l: Local) => `${l.by} on ${l.machine}`;

const enc = new TextEncoder();
const now = () => new Date().toISOString();
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", typeof key == "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}


/** What the repository checks the VMs' git tokens with: locally the dev server's secret (dev/factory.ts checks them); on Cloudflare FACTORY_KEY (worker/source.ts). */
export const gitSecret = (env: Env) => env.ERGA_LINK_SECRET || factoryKey(env);

/**
 * A git token for the repository: pushes `branch` only, for two hours; or, a merge's, that and one move of staging to
 * the merge itself (factory/git-grant.ts, mergeShape), for as long as the merge job may take. `by`: the admin who asked.
 */
export async function gitToken(env: Env, scope: "task" | "merge", branch: string, by?: string): Promise<string> {
  const secret = gitSecret(env);
  if (!secret) throw new Error("FACTORY_KEY isn't set");
  const life = scope == "merge" ? MERGE_JOB_MS / 1000 + 300 : 7200;
  const body = b64url(JSON.stringify({ scope, branch, exp: Math.floor(Date.now() / 1000) + life, ...(by ? { by } : {}), ...(scope == "merge" ? { id: crypto.randomUUID() } : {}) }));
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
  /** The id of the task's current run of Claude Code (run.ts): a report from another run is refused. */
  run: string | null;
  /** JSON: every instruction the user sent ("Send to Claude Code"), [{ at, by, text }], for a restart's brief. */
  asked: string | null;
  /** The person who added it (a login): its commits' author, whether they added it themselves or through an agent. Null before #68. */
  person: string | null;
  /** JSON Local: a local task, run by a local agent with no VM. Null for a VM's task (and once it's handed to a VM). */
  local: string | null;
  /** Who ran it locally (runsWhere), once Restart handed it to a VM. */
  handed: string | null;
};

const localOf = (r: Row): Local | null => { try { return r.local ? JSON.parse(r.local) as Local : null; } catch { return null; } };
const list =(json: string | null): number[] => { try { const v = JSON.parse(json ?? "[]"); return Array.isArray(v) ? v.map(Number) : []; } catch { return []; } };
const asked = (r: Row): { at: string; by: string; text: string }[] => { try { const v = JSON.parse(r.asked ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
// "needs agent" is a merge that hasn't happened yet: to the dependency rules, a task that isn't merged or merging.
const depOf = (r: Row): DepTask => ({ id: r.id, status: r.status as DepStatus, startAfter: list(r.start_after), mergeAfter: list(r.merge_after) });

export class Factory extends DurableObject<Env> {
  private sql: SqlStorage;
  /** The event streams open, each with the admin it's for (agent events go to theirs only). */
  private clients = new Map<WritableStreamDefaultWriter<Uint8Array>, string | null>();
  /** Each admin's agent (factory/agent.ts), with where the server is, as their page said last. */
  private agents = new Map<string, { agent: FactoryAgent; origin: string }>();
  /** The agent's settings, read again after a minute, so a key an admin changes on /admin reaches it. */
  private agentCfg: { at: number; cfg: Promise<AgentConfig | { missing: string }> } | null = null;
  /** Conversations with a save waiting (a reply streams in: at most one save a second). */
  private chatSaves = new Map<string, ReturnType<typeof setTimeout>>();
  private beat: ReturnType<typeof setInterval> | null = null;
  /** Merges run one at a time, in the order they were asked for. */
  private merges: Promise<void> = Promise.resolve();
  /** Each task's restarts in this object's life: a launch that a restart overtook stops the VM it started, and runs nothing. */
  private epochs = new Map<number, number>();
  /** Queued tasks whose VM is being started (so a second start doesn't start another). */
  private starting = new Set<number>();
  /** The dependency rules (factory/deps.ts), over this object's tasks. */
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
    // The old factory tokens (erga_factory_..., Share with agent before it made admin tokens): gone, and with them every such token.
    this.sql.exec("DROP TABLE IF EXISTS agent_tokens");
    // Instructions sent to a task while it works: its Claude Code takes them (taken) when its current step ends.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS asks (n INTEGER PRIMARY KEY AUTOINCREMENT, task INTEGER NOT NULL, by_login TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, taken TEXT)`);
    // Each admin's agent conversation (the transcript and the model's messages) and their panel's layout (factory/chat-store.ts).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_chats (login TEXT PRIMARY KEY, log TEXT NOT NULL, messages TEXT NOT NULL, updated INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_prefs (login TEXT PRIMARY KEY, prefs TEXT NOT NULL, updated INTEGER NOT NULL)`);
    // Dependencies (#49), on a table made before them.
    const cols = this.sql.exec<{ name: string }>("PRAGMA table_info(tasks)").toArray().map((c) => c.name);
    for (const c of ["start_after", "merge_after", "merge_by", "run", "asked", "person", "local", "handed"]) if (!cols.includes(c)) this.sql.exec(`ALTER TABLE tasks ADD COLUMN ${c} TEXT`);
    // A merge the object was stopped in the middle of goes back to ready to merge, saying so.
    for (const r of this.sql.exec<Row>("SELECT * FROM tasks WHERE status = 'merging'").toArray()) {
      this.update(r.id, { status: "complete", error: "The merge was stopped in the middle (the factory restarted). Merge again." });
    }
    // Every task starts by itself, with no button: when it is added, or when the tasks it waits for merge. One whose VM
    // was starting when the object stopped (each merge deploys staging, which restarts it) is still queued with no VM:
    // it starts again here.
    for (const { id } of this.sql.exec<{ id: number }>("SELECT id FROM tasks WHERE status = 'queued' AND vm IS NULL").toArray()) {
      if (this.deps.unmetStart(depOf(this.row(id)!)).length) continue;
      this.note(id, "Starting again: the factory restarted before the task's VM started");
      this.begin(id);
    }
  }

  // -- reading

  private row(id: number): Row | null { return this.sql.exec<Row>("SELECT * FROM tasks WHERE id = ?", id).toArray()[0] ?? null; }

  /** The task as the board and the API show it: the last 200 lines of its log, or every line with `allLog`. */
  private view(r: Row, allLog = false): Task {
    const log = this.sql.exec<{ at: string; message: string }>(`SELECT at, message FROM (SELECT * FROM logs WHERE task = ? ORDER BY n DESC${allLog ? "" : " LIMIT 200"}) ORDER BY n`, r.id).toArray();
    const screenshots = this.sql.exec<{ file: string; caption: string; at: string }>("SELECT file, caption, at FROM shots WHERE task = ? ORDER BY n", r.id).toArray();
    const stalled = stalledOf({ status: r.status, updatedAt: r.updated, log });
    const waiting = this.waiting(r.id).length;
    return {
      id: r.id, title: r.title, description: r.description, status: r.status, branch: r.branch, base: r.base, commit: r.commit_sha,
      summary: r.summary, error: r.error, url: r.preview_origin && r.preview_path != null ? r.preview_origin + r.preview_path : null,
      vm: r.vm, by: r.by_login, person: r.person, createdAt: r.created, updatedAt: r.updated, mergedAt: r.merged_at, mergeCommit: r.merge_commit, log, screenshots,
      startAfter: list(r.start_after), mergeAfter: list(r.merge_after),
      ...(this.deps.blocked(depOf(r)) ? { blockedBy: this.deps.blocked(depOf(r)) } : {}),
      ...(this.starting.has(r.id) ? { starting: true } : {}),
      ...(stalled ? { stalled } : {}),
      ...(waiting ? { waiting } : {}),
      local: localOf(r), handedFrom: r.handed,
    };
  }

  async list(): Promise<Task[]> { return this.sql.exec<Row>("SELECT * FROM tasks ORDER BY id").toArray().map((r) => this.view(r)); }
  async task(id: number, allLog = false): Promise<Task | null> { const r = this.row(id); return r && this.view(r, allLog); }

  /** The instructions that wait for the task's Claude Code, oldest first. */
  private waiting(id: number): Ask[] {
    return this.sql.exec<Ask>("SELECT n, by_login AS by, text, at FROM asks WHERE task = ? AND taken IS NULL ORDER BY n", id).toArray();
  }

  /** Takes the instructions that wait, each one once, so that two runs never both get one. */
  private takeAsks(id: number): Ask[] {
    const asks = this.waiting(id);
    if (asks.length) this.sql.exec("UPDATE asks SET taken = ? WHERE task = ? AND taken IS NULL AND n <= ?", now(), id, asks.at(-1)!.n);
    return asks;
  }

  /** What a VM polls (run.ts): how many instructions wait, and since when. */
  async inbox(id: number) { return { waiting: this.waiting(id).map(({ n, by, at }) => ({ n, by, at })) }; }

  /** The task's Claude Code takes the instructions that wait (the VM's hook, as a step ends, or run.ts, as it starts Claude Code). */
  async take(id: number, how: string): Promise<{ asks: Ask[]; text: string }> {
    const r = this.row(id);
    // A local task's agent also takes the factory's word on a merge that needs it (needs agent).
    if (r?.status != "working" && !(r?.status == "needs agent" && r.local)) return { asks: [], text: "" };
    const asks = this.takeAsks(id);
    if (asks.length) this.note(id, `${r.local ? "The local agent" : "Claude Code"} got the instructions from ${whoAsked(asks)}${how ? ` ${how.slice(0, 300)}` : ""}`);
    return { asks, text: joinAsks(asks) };
  }

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

  /** A line in the change log (/admin/changes), by `by`; a failure there is logged, never the caller's. */
  private async logged(by: string, change: SettingChange) {
    try { await directoryOf(this.env).config.record(by, [change]); } catch (e) { console.log(`couldn't write the change log: ${e}`); }
  }

  private note(id: number, message: string) {
    this.sql.exec("INSERT INTO logs (task, at, message) VALUES (?, ?, ?)", id, now(), message.slice(0, 2000));
    this.sql.exec("UPDATE tasks SET updated = ? WHERE id = ?", now(), id);
    this.changed(id);
  }

  /**
   * A new task. `by`: who the board says added it (an admin, or their agent); `user`: the admin to credit in the
   * change log (/admin/changes), the one who prompted the agent (`by` when not given); `via`: how, when not in person.
   * The task's person (its commits' author) is `user`, or `by`.
   */
  async add(input: { title: string; description: string; by: string; user?: string; via?: string; origin: string; startAfter?: unknown; mergeAfter?: unknown; local?: { machine?: unknown } }): Promise<Task> {
    const title = input.title.trim().slice(0, 200), description = input.description.trim().slice(0, 20000);
    if (!title) throw new Error("A task needs a title.");
    // A new task can't be in a cycle: nothing waits for it yet.
    const deps = this.deps.depChanges(Object.fromEntries(Object.entries({ startAfter: input.startAfter, mergeAfter: input.mergeAfter }).filter(([, v]) => v !== undefined)));
    if (typeof deps == "string") throw new Error(deps);
    const at = now();
    const id = this.sql.exec<{ id: number }>(`INSERT INTO tasks (title, description, status, branch, origin, by_login, person, created, updated, start_after, merge_after) VALUES (?, ?, 'queued', '', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      title, description || title, input.origin, input.by, (input.user ?? input.by).toLowerCase(), at, at, deps.startAfter ? JSON.stringify(deps.startAfter) : null, deps.mergeAfter ? JSON.stringify(deps.mergeAfter) : null).one().id;
    this.sql.exec("UPDATE tasks SET branch = ? WHERE id = ?", branchName(id, title), id);
    // A local task: the agent that asked runs it, on its own machine, with no VM.
    const local: Local | null = input.local ? { by: input.by, machine: String(input.local.machine ?? "").trim().slice(0, 80) || "an unnamed machine", since: at } : null;
    if (local) this.sql.exec("UPDATE tasks SET local = ? WHERE id = ?", JSON.stringify(local), id);
    this.note(id, `Added by ${input.by}${depsNote(deps)}${local ? `: a local task, run by ${runsWhere(local)} (no VM)` : ""}`);
    await this.logged(input.user ?? input.by, { key: "task", from: null, to: null, task: { id, title, event: "added" }, ...(input.via ? { via: input.via } : {}) });
    const waiting = this.deps.unmetStart(depOf(this.row(id)!));
    if (waiting.length) this.note(id, `Queued: waiting for ${ids(waiting)} to merge (no VM until then)`);
    else this.begin(id);
    return this.view(this.row(id)!);
  }

  /** Starts a queued task's VM and job, once (the caller checked that nothing blocks it). */
  private begin(id: number) {
    // A local task has no VM: it works now, and its agent makes the branch (task start).
    const r = this.row(id);
    if (r?.local) {
      if (r.status == "queued") this.update(id, { status: "working" }, `Working: nothing blocks it now. ${runsWhere(localOf(r)!)} makes ${r.branch} from staging (task start) and works on it`);
      return;
    }
    if (this.starting.has(id)) return;
    this.starting.add(id);
    this.ctx.waitUntil(this.launch(id, "work").finally(() => { this.starting.delete(id); this.changed(id); }));
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
  private async launch(id: number, job: "work" | "revise" | "resolve" | "restart") {
    const epoch = this.epochs.get(id) ?? 0;
    const overtaken = () => (this.epochs.get(id) ?? 0) != epoch;
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
        // Restarted while this VM started: the restart's own VM does the work.
        if (overtaken()) { await host.stop(vm).catch(() => {}); return; }
        this.update(id, { vm, preview_origin: started.preview, preview_path: null, status }, `VM ${vm} started in ${((Date.now() - t) / 1000).toFixed(1)}s`);
        this.keepAlive();
      } else this.update(id, { status });
      // Each run has an id of its own: only its reports count (an earlier run, still ending, can't fail this one).
      const run = crypto.randomUUID().slice(0, 8);
      if (overtaken()) return;
      this.update(id, { run });
      await host.job(vm, "run.ts", [job], { ...(await this.jobEnv(id, "task", undefined, true)), FACTORY_RUN: run }, false);
    } catch (e) {
      if (overtaken()) return;
      if (job == "resolve") return this.backToReady(id, `The merge needs Claude Code, but it couldn't be woken: ${(e as Error).message}`);
      this.update(id, { status: "failed", error: `The VM didn't start: ${(e as Error).message}` }, `Failed: the VM didn't start: ${(e as Error).message}`);
      this.tellDependents(id);
    }
  }

  /**
   * A merge that ended without merging: back to ready to merge, with the reason (as the local queue does). When the
   * task's Claude Code was woken for it, it's stopped in its VM (merge.ts stop), so it doesn't work on.
   */
  private backToReady(id: number, error: string) {
    const r = this.row(id);
    const woken = r?.status == "needs agent";
    this.update(id, { status: "complete", error, merge_by: null, ...(woken ? { run: null } : {}) }, `Merge failed: ${error.slice(0, 600)}`);
    if (woken && r.vm) this.ctx.waitUntil(this.stopClaude(id, r.vm));
  }

  /** Stops the task's Claude Code in its VM (it may say its last words first), once the factory has given up on it. */
  private async stopClaude(id: number, vm: string) {
    const r = this.row(id)!;
    const host = vmHost(this.env, r.origin);
    if (typeof host == "string") return;
    try {
      const res = resultOf(await host.job(vm, "merge.ts", ["stop", r.branch], await this.jobEnv(id, "task"), true));
      if (res.ok && res.stopped) this.note(id, "Claude Code was stopped");
    } catch (e) {
      this.note(id, `Couldn't stop Claude Code: ${(e as Error).message}`);
    }
  }

  /**
   * What a job in the task's VM gets: where to report and with what, the repository, and for a job that runs Claude
   * Code (`claude`), the Claude token when there is one. The others (merge, save, stop, discard) never get it.
   */
  private async jobEnv(id: number, scope: "task" | "merge", by?: string, claude = false): Promise<Record<string, string>> {
    const r = this.row(id)!;
    const host = vmHost(this.env, r.origin) as VmHost;
    const token = claude ? await this.claudeToken() : null;
    // The task's person authors its commits (Claude Code's, and "Merge staging into ..."); whoever pressed Merge, the
    // merge into staging. The factory is always the committer.
    const author = r.person ? await this.identity(r.person) : FACTORY_IDENTITY;
    const merger = scope == "merge" && by ? await this.identity(by) : null;
    return {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: FACTORY_IDENTITY.name, GIT_COMMITTER_EMAIL: FACTORY_IDENTITY.email,
      ...(merger ? { FACTORY_MERGE_AUTHOR_NAME: merger.name, FACTORY_MERGE_AUTHOR_EMAIL: merger.email } : {}),
      FACTORY_API: `${r.origin}/api/factory`, FACTORY_TASK: String(id), FACTORY_TOKEN: await taskToken(this.env, id),
      REPO_URL: host.repo(r.origin), REPO_TOKEN: await gitToken(this.env, scope, r.branch, by ?? r.by_login),
      FACTORY_MODEL: String((await directoryOf(this.env).config.get("factory_model")) ?? "opus"),
      FACTORY_FAST: (await directoryOf(this.env).config.get("factory_fast")) == "off" ? "0" : "1",
      // ./test.sh and the browser tests, in a 4-vCPU VM that Claude Code and the preview share: one test file at a
      // time (tests/cores.ts). A container may not see its own share of the host's cores, so it's said here.
      TEST_CORES_PER_JOB: "3",
      ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
    };
  }

  /** A person's commit identity (factory/author.ts): GitHub asked for their id when their sign-in didn't give it, except locally. */
  private identity(login: string): Promise<Identity> {
    return personIdentity(directoryOf(this.env).users, login, this.env.DEV_LOGIN ? null : (l) => githubIdOf(l));
  }

  async brief(id: number) {
    const r = this.row(id);
    if (!r) return null;
    return { title: r.title, branch: r.branch, base: "staging", prompt: taskPrompt({ ...r, base: "staging" }), instructions: r.instructions, restart: restartPrompt(r, asked(r), r.handed), maxTurns: 200 };
  }

  /** Why a local agent (an admin token) may not report on this task, or null: it must be a local task, not done. */
  async localRefusal(id: number): Promise<{ error: string; status: number } | null> {
    const r = this.row(id);
    if (!r) return { error: "no such task", status: 404 };
    if (!r.local) return { error: r.handed ? `Task #${id} was handed to a VM: it isn't yours any more. Stop working on it.` : `Task #${id} isn't a local task: its VM reports on it.`, status: 409 };
    if (["merged", "discarded"].includes(r.status)) return { error: `task #${id} is ${r.status}`, status: 409 };
    return null;
  }

  /**
   * A local task's git token (POST .../git): reads staging, main and its branch, and pushes its branch only, for two
   * hours (factory/git-grant.ts), as a VM's. Its agent pushes through Erga's Git endpoint with it; the repository's
   * rules stay as they are (no admin token pushes a task's branch).
   */
  async localGit(id: number, origin: string): Promise<{ token: string; repo: string; branch: string } | { error: string; status: number }> {
    const no = await this.localRefusal(id);
    if (no) return no;
    const r = this.row(id)!;
    const host = vmHost(this.env, origin);
    try {
      return { token: await gitToken(this.env, "task", r.branch, r.person ?? r.by_login), repo: typeof host == "string" ? `${origin}/git/erga.git` : host.repo(origin), branch: r.branch };
    } catch (e) {
      return { error: (e as Error).message, status: 503 };
    }
  }

  /** A VM's report on its task. */
  async report(id: number, kind: "log" | "branch" | "preview" | "status", body: any): Promise<{ ok: boolean; error?: string }> {
    const r = this.row(id);
    if (!r) return { ok: false, error: "no such task" };
    if (["merged", "discarded"].includes(r.status)) return { ok: false, error: `task #${id} is ${r.status}` };
    // The board and outside agents (admin tokens) read what the VM says, and the VM's code can read its tokens: none in it.
    body = { ...body };
    for (const k of ["message", "summary", "error"]) if (typeof body[k] == "string") body[k] = hideTokens(body[k]);
    switch (kind) {
      case "log": this.note(id, String(body.message ?? "")); break;
      case "branch": this.update(id, { base: String(body.base ?? "") || null }); break;
      case "preview":
        // A local task's preview is wherever its agent runs the app (its own machine, often localhost): a full URL.
        if (r.local) {
          let to: URL | null = null;
          try { to = new URL(String(body.url ?? "")); } catch { /* below */ }
          if (!to || !/^https?:$/.test(to.protocol)) return { ok: false, error: "url: the preview's address, http:// or https://" };
          this.update(id, { preview_origin: to.origin, preview_path: to.pathname + to.search }, `Preview up: ${to.href} (on ${localOf(r)!.machine})`);
          break;
        }
        // A path on the preview's own host, never another (//evil.example/, @evil.example: /open redirects there).
        if (!/^\/(?![\/\\])/.test(String(body.path || "/"))) return { ok: false, error: "path: a path on the preview's host, starting with one /" };
        this.update(id, { preview_path: String(body.path || "/") }, `Preview up: ${r.preview_origin}${body.path || "/"}`); break;
      case "status": {
        if (r.status == "merging") return { ok: false, error: "the task is merging" };
        // A run of Claude Code that the factory has woken again since (or given up on): its word is old.
        if (body.run && String(body.run) != r.run) {
          this.note(id, `An earlier run of Claude Code said ${body.status == "failed" ? "it failed" : String(body.status)}: ignored`);
          return { ok: false, error: "This run of Claude Code isn't the task's current one: it was woken again, or stopped. Stop now." };
        }
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
        // A local agent that says done while instructions wait for it: it takes them first (task inbox), and works on.
        if (r.local && body.status == "complete" && this.waiting(id).length) {
          const n = this.waiting(id).length;
          this.note(id, `The local agent said it was done, but ${n} instruction${n == 1 ? "" : "s"} wait${n == 1 ? "s" : ""} for it: still working`);
          return { ok: false, error: `${n} instruction${n == 1 ? "" : "s"} from the board wait${n == 1 ? "s" : ""} for this task: run \`task inbox\`, do ${n == 1 ? "it" : "them"}, then \`task done\` again.` };
        }
        // It ended before its Claude Code got the instructions that wait: it works on them now, in a new run.
        const asks = ["complete", "failed"].includes(body.status) && !r.local ? this.takeAsks(id) : [];
        if (asks.length) {
          const said = body.status == "complete" ? "said it was done" : `failed (${String(body.error ?? "").slice(0, 300)})`;
          this.update(id, { instructions: joinAsks(asks), summary: body.status == "complete" ? String(body.summary ?? "") : r.summary, commit_sha: body.commit ? String(body.commit) : r.commit_sha, error: null, run: null },
            `Claude Code ${said} before it got the instructions from ${whoAsked(asks)}: it works on them now`);
          this.ctx.waitUntil(this.launch(id, "revise"));
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
    const r = this.row(id);
    if (!r) return { ok: false, error: "no such task" };
    // As report: a task that is merged or discarded takes nothing more from its VM's token (it lasts a week).
    if (["merged", "discarded"].includes(r.status)) return { ok: false, error: `task #${id} is ${r.status}` };
    caption = hideTokens(caption);
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
    if (!["complete", "failed", "working"].includes(r.status)) return { ok: false, error: `task #${id} is ${r.status}: it takes instructions while it works, or when it's ready to merge or failed` };
    if (!instructions.trim()) return { ok: false, error: "Say what to change." };
    if (r.status == "working" || r.local) {
      // Claude Code works on, and gets them when its current step ends (the VM's hook): nothing it did is lost. A local
      // task's agent gets them with `task inbox` (it asks when a step ends, and before it says done); one that was
      // ready to merge or failed works again.
      if (r.local && r.status != "working") {
        const why = this.deps.startRefusal(depOf(r));
        if (why) return { ok: false, error: why };
      }
      this.sql.exec("INSERT INTO asks (task, by_login, text, at) VALUES (?, ?, ?, ?)", id, by, instructions.trim().slice(0, 20000), now());
      this.update(id, { asked: JSON.stringify([...asked(r), { at: now(), by, text: instructions.trim().slice(0, 20000) }]), ...(r.status != "working" ? { status: "working", error: null } : {}) });
      this.note(id, r.local
        ? `${by} asked${r.status == "working" ? ", while it works" : ""}: ${instructions.trim().slice(0, 500)} (${runsWhere(localOf(r)!)} gets it with task inbox)`
        : `${by} asked, while it works: ${instructions.trim().slice(0, 500)}`);
      return { ok: true };
    }
    const why = this.deps.startRefusal(depOf(r));
    if (why) return { ok: false, error: why };
    // Any sent while it worked that its Claude Code never got (its VM stopped first) go with them.
    const older = joinAsks(this.takeAsks(id));
    const text = instructions.trim().slice(0, 20000);
    this.update(id, { instructions: (older ? older + "\n\n" : "") + text, asked: JSON.stringify([...asked(r), { at: now(), by, text }]), status: "working", error: null }, `${by} asked: ${instructions.trim().slice(0, 500)}`);
    this.ctx.waitUntil(this.launch(id, "revise"));
    return { ok: true };
  }

  /**
   * Any task that isn't merged or discarded runs again on its branch, from the start, in a fresh VM (a fresh git token):
   * while it works, while it merges or needs its agent, or when it's stuck. The old VM, if it's up, saves the work first
   * (merge.ts save: Claude Code and the preview stopped, anything uncommitted committed, the branch pushed), then stops.
   * Claude Code starts in a new session with the task's prompt and every instruction the user sent (restartPrompt).
   */
  async restart(id: number, by: string, origin?: string): Promise<{ ok: boolean; error?: string }> {
    // The server as the person asking reaches it now (it can move: another port locally).
    if (origin) this.sql.exec("UPDATE tasks SET origin = ? WHERE id = ?", origin, id);
    const r = this.row(id);
    if (!r) return { ok: false, error: "no such task" };
    if (["merged", "discarded"].includes(r.status)) return { ok: false, error: `task #${id} is ${r.status}: it can't restart` };
    const why = this.deps.startRefusal(depOf(r));
    if (why) return { ok: false, error: why };
    // A local task is handed to a VM: its local agent's reports are refused from now on, and a fresh VM goes on from
    // what it pushed to the branch (what it didn't push stays on its machine). The board names it, in the brief too.
    const local = localOf(r);
    if (local) {
      this.update(id, { local: null, handed: runsWhere(local) },
        `Handed to a VM by ${by}: ${runsWhere(local)} ran it (the task was ${r.status == "complete" ? "ready to merge" : r.status}). Its reports are refused from now on; a VM goes on from what it pushed to ${r.branch}`);
      // Instructions it never took go to the VM's Claude Code in its brief (asked): taken below, as for any restart.
    }
    // A queued task that never ran has nothing to restart: it starts (again, if its VM was starting).
    if (r.status == "queued" && !r.vm) {
      if (!this.starting.has(id)) this.note(id, `Started by ${by}`);
      this.begin(id);
      return { ok: true };
    }
    const epoch = (this.epochs.get(id) ?? 0) + 1;
    this.epochs.set(id, epoch);
    const was = r.status == "complete" ? "ready to merge" : r.status;
    // Instructions sent while it worked, that the old Claude Code never got: in the restart's brief (asked), so taken here.
    this.takeAsks(id);
    // No run is current any more: the old Claude Code's reports are refused from now on. A merge that is running sees
    // the task isn't merging any more, and does nothing with its answer.
    this.update(id, { status: "working", error: null, run: null, merge_by: null, vm: null, preview_origin: null, preview_path: null },
      `Restarted by ${by} (the task was ${was}): ${r.vm ? `the work in VM ${r.vm} is saved, then a fresh VM` : "a fresh VM"} starts Claude Code with the task's prompt and ${asked(r).length} earlier instruction${asked(r).length == 1 ? "" : "s"}`);
    this.ctx.waitUntil((async () => {
      const host = vmHost(this.env, r.origin);
      if (r.vm && typeof host != "string") {
        await this.save(id, r, host);
        await host.stop(r.vm).catch(() => {});
        this.note(id, `VM ${r.vm} stopped`);
      }
      // Restarted again meanwhile: that restart goes on instead.
      if (this.epochs.get(id) == epoch) await this.launch(id, "restart");
    })());
    return { ok: true };
  }

  /** A restart's first step, in the old VM if it's still up: Claude Code stopped, the work committed and pushed (merge.ts save). */
  private async save(id: number, r: Row, host: VmHost) {
    if (!(await host.alive(r.vm!).catch(() => false))) return this.note(id, `VM ${r.vm} is gone: the restart uses what was pushed to ${r.branch}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        host.job(r.vm!, "merge.ts", ["save", r.branch], await this.jobEnv(id, "task"), true),
        new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`the VM didn't answer in ${SAVE_JOB_MS / 60_000} minutes`)), SAVE_JOB_MS); }),
      ]).finally(() => clearTimeout(timer));
      const res = resultOf(out);
      const stopped = res.stopped ? "Claude Code was stopped; " : "";
      if (res.ok) this.update(id, res.commit ? { commit_sha: String(res.commit) } : {}, `Saved before the restart: ${stopped}${res.saved}`);
      else this.note(id, `Couldn't save all the work before the restart: ${stopped}${String(res.error).slice(0, 1500)}. The restart uses what was pushed to ${r.branch}.`);
    } catch (e) {
      this.note(id, `Couldn't save the work before the restart: ${(e as Error).message}. The restart uses what was pushed to ${r.branch}.`);
    }
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
      if (!res.ok && res.needsAgent && r.local) {
        // A local task's merge VM has no Claude Code: it stops, and the local agent finishes the merge in its own
        // checkout (its inbox has the factory's instructions); its `task done` runs the merge again. Or Restart hands
        // the task to a VM.
        await host.stop(vm).catch(() => {});
        this.update(id, { status: "needs agent", error: res.error ?? "the merge stopped", vm: null, preview_origin: null }, `Needs agent: ${String(res.error ?? "").split("\n")[0].slice(0, 400)} VM ${vm} stopped. ${runsWhere(localOf(r)!)} is told to finish the merge (task inbox); Restart hands it to a VM instead.`);
        this.sql.exec("INSERT INTO asks (task, by_login, text, at) VALUES (?, ?, ?, ?)", id, "the factory", localResolvePrompt(r, res), now());
        this.changed(id);
        return;
      }
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
      await this.logged(by, { key: "task", from: null, to: null, task: { id, title: r.title, event: "merged", commit: String(res.commit) } });
      this.tellDependents(id);
      // Staging moved. On Cloudflare the push went through Erga's Git endpoint, which tells the deploy pipeline itself
      // (worker/source-host.ts, deployHook): staging.erga.dev builds and deploys it. Locally the repository is the dev
      // server's own, which no deploy reads.
      this.note(id, host.kind == "local" ? "Staging moved (the local repository: nothing deploys it)" : "Staging moved: staging.erga.dev deploys it now (see /admin/factory)");
    } catch (e) {
      // Restarted (or discarded) meanwhile: its VM was stopped under the merge.
      if (this.row(id)?.status != "merging") return;
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
    if (!factoryKey(this.env)) return { ok: false, error: "This server has no FACTORY_KEY to encrypt the token with: bun deploy/setup.ts --factory makes it (README, The factory, On Cloudflare)." };
    const checked = claudeToken(token);
    if ("error" in checked) return { ok: false, error: checked.error };
    token = checked.token;
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
    if (!this.agentCfg || Date.now() - this.agentCfg.at > 60_000) {
      this.agentCfg = { at: Date.now(), cfg: withKeys(this.env).then((env) => Effect.runPromise(agentConfigFrom(ConfigProvider.fromUnknown(env)))) };
    }
    return this.agentCfg.cfg;
  }

  /**
   * Why the admin may not act now, or null: they must still be an admin. Every tool call asks.
   */
  private async refusal(login: string): Promise<string | null> {
    if (!(await directoryOf(this.env).users.isAdmin(login))) return "Only admins can use the factory.";
    return null;
  }

  /** The admin's session, made the first time; the origin is the latest the page sent. */
  private async session(login: string, origin: string): Promise<{ agent: FactoryAgent; origin: string } | string> {
    const cfg = await this.config();
    if ("missing" in cfg) return cfg.missing;
    let s = this.agents.get(login);
    if (s) { s.origin = origin; return s; }
    const by = agentName(login);
    const on = async () => {
      if ((await directoryOf(this.env).config.get("factory")) != "on") throw new Error("The factory is off: an admin turns it on with the factory setting (/admin).");
    };
    const state = { origin };
    const ops: FactoryOps = {
      info: async () => {
        const host = vmHost(this.env, state.origin);
        return { enabled: (await directoryOf(this.env).config.get("factory")) == "on", vms: typeof host == "string" ? host : host.kind, claude: (await this.claude()).signedIn };
      },
      list: () => this.list(),
      task: (id) => this.task(id),
      add: async (input) => { await on(); return this.add({ ...input, by, user: login, via: "the factory's agent", origin: state.origin }); },
      setDeps: async (id, body) => { await on(); return this.setDeps(id, body, by, state.origin); },
      revise: async (id, instructions) => { await on(); return this.revise(id, instructions, by, state.origin); },
      shot: (file) => this.shot(file),
      // The board's buttons, as the admin themselves (the task's log and the change log name them, as when they click).
      merge: async (id) => { await on(); return this.merge(id, login, state.origin); },
      discard: async (id) => { await on(); return this.discard(id, login, state.origin); },
      restart: async (id) => { await on(); return this.restart(id, login, state.origin); },
      signOutClaude: async () => { await this.setClaude(null, login); },
    };
    const dashboard = this.dashboard(login, state);
    const guard = async () => {
      const why = await this.refusal(login);
      if (why) throw new Error(why);
    };
    // The admin tools act as the admin, with admin power: the settings' change log names them, not the agent.
    const as = (): ToolWho => ({ dir: directoryOf(this.env), who: { login, admin: true }, origin: state.origin });
    // The source tools read the server's copy of Erga's repository (SourceHost), read-only.
    const readSource = async (q: SourceRead): Promise<SourceAnswer> => {
      if (!hasSource(this.env)) throw new Error("Erga's repository isn't set up on this server: it needs the Artifacts binding (README, Erga's own source).");
      const r = await this.env.SOURCE.getByName("erga").read(state.origin, q);
      if ("error" in r) throw new Error(r.error);
      return r;
    };
    const stored = this.storedChat(login);
    const agent = startFactoryAgent({ cfg, owner: login, tools: [...factoryTools(ops, guard), ...adminTools(as, guard), ...sourceTools(readSource, guard), ...dashboardTools(dashboard, guard)], restore: stored ?? undefined });
    agent.subscribe((ev) => { this.event({ type: "agent", ev }, login); this.chatChanged(login, ev); });
    s = Object.assign(state, { agent });
    this.agents.set(login, s);
    return s;
  }

  /**
   * The dashboard tools' work (factory/agent.ts, dashboardTools), as the admin: the same calls the dashboard's API
   * makes (worker/source.ts, worker/deploys.ts), and /settings' tokens (server-api.ts),
   * so the change log and a deploy's trigger name the admin, as when they click.
   */
  private dashboard(login: string, state: { origin: string }): DashboardOps {
    const source = () => {
      if (!hasSource(this.env)) throw new Error("Erga's repository isn't set up on this server: it needs the Artifacts binding (README, Erga's own source).");
      return this.env.SOURCE.getByName("erga");
    };
    const pipeline = () => this.env.PIPELINE.getByName("deploys");
    const actor = async () => ({ login, name: (await directoryOf(this.env).users.get(login))?.name || login });
    return {
      branches: async () => source().branches(state.origin),
      release: async (commit) => {
        const r = await source().merge(state.origin, await actor(), commit);
        if ("error" in r) throw new Error(r.error);
        return { ...r, done: r.upToDate ? "main was at staging already: nothing to deploy" : `main moved to ${r.commit.slice(0, 10)}: production deploys it now (list_deploys follows it)` };
      },
      mirror: async () => ({ mirror: await source().mirrorNow(state.origin) }),
      deploys: (history) => pipeline().status(history),
      deployLog: (target, deploy) => pipeline().logOf(target, deploy),
      redeploy: async (target) => {
        const r = await pipeline().redeploy(target, `redeploy by ${login}`);
        if (!r.ok) throw new Error(r.error ?? "refused");
        return { done: `${target} redeploys now`, target: r.status };
      },
      deployHome: async () => {
        const dir = directoryOf(this.env);
        if (!(await dir.homeId())) throw new Error("No document is the homepage (the landing_document setting): there's nothing to deploy.");
        const status = await this.env.HOME.getByName("home").deploy();
        await forgetHome(new URL(state.origin)).catch(() => {});
        return { done: "The homepage deploys now", status };
      },
      agentTokens: async () => (await tokensOf(this.env).list(login)).map((t) => ({ id: t.id, label: t.label, kind: t.kind, scope: t.scope, docId: t.docId, created: t.created, expires: t.expires, lastUsed: t.lastUsed })),
      revokeAgentToken: (id) => tokensOf(this.env).revoke(login, id),
    };
  }

  async agentState(login: string, origin: string) {
    const s = await this.session(login, origin);
    if (typeof s == "string") return { enabled: false, reason: s };
    const models = s.agent.modelChoice ? Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })) : [];
    return { enabled: true, model: s.agent.model, choice: s.agent.modelChoice, models, log: s.agent.log() };
  }

  async agentPrompt(login: string, origin: string, text: string, context: string | null, attached?: unknown): Promise<{ ok: boolean; reason?: string }> {
    const why = await this.refusal(login);
    if (why) return { ok: false, reason: why };
    const s = await this.session(login, origin);
    if (typeof s == "string") return { ok: false, reason: `the agent is off: ${s}` };
    const files = checkAttachments(attached);
    if (typeof files == "string") return { ok: false, reason: files };
    if (!text.trim() && !files.length) return { ok: false, reason: "say something" };
    s.agent.prompt(text.slice(0, 20000), context ? context.slice(0, 4000) : null, files);
    return { ok: true };
  }

  // -- each admin's conversation, kept (factory/chat-store.ts): GET and DELETE /api/admin/agent/conversation

  private storedChat(login: string): { log: Log; messages: ReturnType<typeof restoredMessages> } | null {
    const r = this.sql.exec<{ log: string; messages: string }>("SELECT log, messages FROM agent_chats WHERE login = ?", login).toArray()[0];
    return r ? { log: restoredLog(r.log), messages: restoredMessages(r.messages) } : null;
  }

  /** Saves the conversation: at once when a turn ends, a message is sent or a tool finishes; else within a second. */
  private chatChanged(login: string, ev: LogEvent) {
    const now = ev.t == "user" || ev.t == "reset" || ev.t == "error" || (ev.t == "busy" && !ev.busy) || (ev.t == "tool" && ev.status != "running");
    if (now) { this.saveChat(login); return; }
    if (!this.chatSaves.has(login)) this.chatSaves.set(login, setTimeout(() => this.saveChat(login), 1000));
  }

  private saveChat(login: string) {
    clearTimeout(this.chatSaves.get(login));
    this.chatSaves.delete(login);
    const s = this.agents.get(login);
    if (!s) return;
    const log = s.agent.log();
    if (!log.items.length) { this.sql.exec("DELETE FROM agent_chats WHERE login = ?", login); return; }
    this.sql.exec("INSERT OR REPLACE INTO agent_chats (login, log, messages, updated) VALUES (?, ?, ?, ?)", login, storedLog(log), storedMessages(s.agent.messages()), Date.now());
  }

  /** The admin's conversation: the live one, or the one stored (the agent need not be on to read it). */
  async conversation(login: string): Promise<Log> {
    return this.agents.get(login)?.agent.log() ?? this.storedChat(login)?.log ?? emptyLog();
  }

  /** A new conversation: the turn stopped, the transcript and the model's messages gone, every tab told. */
  async clearConversation(login: string): Promise<Log> {
    const s = this.agents.get(login);
    if (s) await s.agent.reset();
    else this.event({ type: "agent", ev: { t: "reset" } }, login);
    clearTimeout(this.chatSaves.get(login));
    this.chatSaves.delete(login);
    this.sql.exec("DELETE FROM agent_chats WHERE login = ?", login);
    return emptyLog();
  }

  async agentPrefs(login: string): Promise<PanelPrefs> {
    const r = this.sql.exec<{ prefs: string }>("SELECT prefs FROM agent_prefs WHERE login = ?", login).toArray()[0];
    try { return panelPrefs(JSON.parse(r?.prefs ?? "{}")); } catch { return {}; }
  }

  /** Changes what's given (open, side, width), keeps the rest. */
  async setAgentPrefs(login: string, body: unknown): Promise<PanelPrefs> {
    const prefs = { ...(await this.agentPrefs(login)), ...panelPrefs(body) };
    this.sql.exec("INSERT OR REPLACE INTO agent_prefs (login, prefs, updated) VALUES (?, ?, ?)", login, JSON.stringify(prefs), Date.now());
    return prefs;
  }

  async agentControl(login: string, op: "abort" | "reset" | "model", model?: string) {
    const s = this.agents.get(login);
    if (!s) {
      if (op == "reset") await this.clearConversation(login);
      return { ok: op != "model", reason: "the agent hasn't started" };
    }
    if (op == "abort") s.agent.abort();
    else if (op == "reset") await this.clearConversation(login);
    else if (!model || !isModelChoice(model) || !s.agent.setModel(model)) return { ok: false, reason: "that model isn't one of the choices" };
    return { ok: true, model: s.agent.model, choice: s.agent.modelChoice, models: s.agent.modelChoice ? Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })) : [] };
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
function resultOf(out: { code: number; output: string } | null): { ok: boolean; error?: string; commit?: string; needsAgent?: boolean; kind?: string; step?: string; files?: string[]; stopped?: boolean; saved?: string } {
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
 * An admin, signed in (the person, in a browser: for their own agent panel, which no token reaches).
 */
async function adminOf(env: Env, request: Request): Promise<{ login: string; name: string } | null> {
  const session = await sessionOf(env, request);
  if (!session || session.test || (session as { agent?: unknown }).agent) return null;
  if (!(await directoryOf(env).users.actsAsAdmin(whoOf(session)))) return null;
  return { login: session.login.toLowerCase(), name: session.name };
}

/** An admin, or an outside agent acting as one: with `token`, it came with an admin token (tokens.ts). */
type FactoryAdmin = { login: string; name: string; token?: { id: string; label: string; expires: number | null } };

/**
 * Who asks the factory's API (and the admin guide): an admin signed in in a browser, or an outside agent with an
 * admin token ("Authorization: Bearer erga_...", scope admin, whose person is an admin now; Share with agent makes
 * one). Anyone else: the answer that refuses them, saying why.
 */
async function factoryAdminOf(env: Env, request: Request, url: URL): Promise<FactoryAdmin | Response> {
  const raw = /^Bearer\s+(erga_\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const users = directoryOf(env).users;
  if (raw) {
    const again = `Ask an admin for a new one (Share with agent, on any page under ${url.origin}/admin), or make an admin token at ${url.origin}/tokens.`;
    if (raw.startsWith("erga_factory_")) return json({ error: `Factory tokens no longer work: Share with agent makes admin tokens now. ${again}` }, 401);
    const t = await tokensOf(env).verify(raw).catch(() => null);
    if (!t) return json({ error: `That token doesn't work: it expired, or was revoked. ${again}` }, 401);
    if (t.testBy || !(await users.isAdmin(t.login))) return json({ error: `Only admins can do that, and ${t.login} isn't one.` }, 403);
    if (t.scope != "admin") return json({ error: LOCKED, locked: true }, 403);
    return { login: t.login, name: t.name, token: { id: t.id, label: t.label, expires: t.expires } };
  }
  const admin = await adminOf(env, request);
  if (admin) return admin;
  return json({ error: `Only admins can do that: sign in, or send an admin token as "Authorization: Bearer <token>".` }, (await sessionOf(env, request)) ? 403 : 401);
}

/** The guide an outside agent reads first (GET /api/admin/guide, and its old address GET /api/factory/guide). */
function guideFor(admin: FactoryAdmin, url: URL): Response {
  const body = adminGuide({ origin: url.origin, owner: admin.login, label: admin.token?.label ?? "(your token's label)", expires: admin.token ? admin.token.expires : Date.now() + SHARE_ADMIN_HOURS * 3600_000 });
  return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" } });
}

/** GET /api/admin/guide: the admin guide, for an admin or their agent with an admin token. */
export async function adminGuideApi(request: Request, env: Env, url: URL): Promise<Response> {
  const admin = await factoryAdminOf(env, request, url);
  if (admin instanceof Response) return admin;
  if (request.method != "GET") return json({ error: "Not found" }, 404);
  return guideFor(admin, url);
}

/**
 * Each admin's agent conversation and panel, kept in the Factory object, whatever admin page is open (and an
 * /admin made one page later): the panel reads it on mount (src/page/factory-agent.ts).
 *
 *   GET    /api/admin/agent/conversation   { log: { items, busy, undoable } }: the admin's conversation
 *   DELETE /api/admin/agent/conversation   a new conversation (the "New conversation" button)
 *   GET    /api/admin/agent/prefs          { open?, side?, width? }: their panel, as they left it
 *   PUT    /api/admin/agent/prefs          { open?, side?, width? }: changes what's given
 */
export const isAdminAgentPath = (path: string) => path.startsWith("/api/admin/agent/");

export async function adminAgentApi(request: Request, env: Env, url: URL): Promise<Response> {
  const admin = await adminOf(env, request);
  if (!admin) return json({ error: "Only admins have an admin agent." }, (await sessionOf(env, request)) ? 403 : 401);
  if (request.method != "GET" && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  const f = factory(env), path = url.pathname, m = request.method;
  if (path == "/api/admin/agent/conversation") {
    if (m == "GET") return json({ log: await f.conversation(admin.login) });
    if (m == "DELETE") return json({ ok: true, log: await f.clearConversation(admin.login) });
  }
  if (path == "/api/admin/agent/prefs") {
    if (m == "GET") return json(await f.agentPrefs(admin.login));
    if (m == "PUT") return json(await f.setAgentPrefs(admin.login, await request.json().catch(() => ({}))));
  }
  return json({ error: "Not found" }, 404);
}

/** Whether the factory is on, for the page (worker/source.ts). */
export const factoryEnabled = enabled;

/** /api/factory/... */
export async function factoryApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/$/, "");
  const m = /^\/api\/factory\/tasks\/(\d+)(?:\/(brief|inbox|log|branch|preview|screenshots|merge|discard|revise|restart|open|start|git))?$/.exec(path);
  const id = m ? Number(m[1]) : null, action = m?.[2] ?? "";

  // A VM, with its task's token.
  const bearer = /^Bearer\s+(fct\.\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bearer) {
    const task = await taskOfToken(env, bearer);
    if (task == null || task != id) return json({ error: "That token isn't for this task." }, 403);
    const f = factory(env);
    if (action == "brief" && request.method == "GET") return json(await f.brief(task));
    if (action == "inbox" && request.method == "GET") return json(await f.inbox(task));
    if (action == "inbox" && request.method == "POST") return json(await f.take(task, String(((await request.json().catch(() => ({}))) as { how?: unknown }).how ?? "")));
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

  // An admin in a browser, or an outside agent with an admin token (Share with agent).
  const admin = await factoryAdminOf(env, request, url);
  if (admin instanceof Response) return admin;
  const agent = admin.token;
  if (!agent && request.method != "GET" && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  // An outside agent works as its admin's agent: what it adds and asks says so (the board, the task's log, the change
  // log); the board's buttons (merge, discard, restart) name the admin, as their own agent's do.
  const by = agent ? `${agentName(admin.login)} (${agent.label})` : admin.login;
  if (agent && (path == "/api/factory/agent" || path.startsWith("/api/factory/agent/"))) return json({ error: `The admin's agent panel is theirs, in a browser: an outside agent calls the same APIs itself (GET ${url.origin}/api/admin/guide).` }, 403);
  if (agent && path == "/api/factory/claude" && request.method == "PUT") return json({ error: `The Claude token is a secret: it's pasted only on ${url.origin}/admin/api-keys, never by an agent. An agent may sign the factory out (DELETE).` }, 403);
  const f = factory(env);
  const on = await enabled(env);
  // A local task's agent (factory/task.ts), with an admin token: the VMs' report routes, for a local task only, and
  // its git token. (A PATCH without a status is a change of dependencies, below.)
  let patch: Record<string, unknown> | null = null;
  if (id != null && !action && request.method == "PATCH") patch = await request.json().catch(() => null);
  if (id != null && (["brief", "inbox", "log", "branch", "preview", "screenshots", "git"].includes(action) || (patch && typeof patch == "object" && "status" in patch))) {
    const no = await f.localRefusal(id);
    if (no) return json({ error: no.error }, no.status);
    const m = request.method;
    if (action == "brief" && m == "GET") return json(await f.brief(id));
    if (action == "inbox" && m == "GET") return json(await f.inbox(id));
    if (action == "inbox" && m == "POST") return json(await f.take(id, String(((await request.json().catch(() => ({}))) as { how?: unknown }).how ?? "")));
    if (action == "git" && m == "POST") { const r = await f.localGit(id, url.origin); return "error" in r ? json({ error: r.error }, r.status) : json(r); }
    if (action == "screenshots" && m == "POST") {
      const r = await f.addShot(id, new Uint8Array(await request.arrayBuffer()), url.searchParams.get("caption") ?? "", url.searchParams.get("replace") == "1");
      return json(r, r.ok ? 200 : 400);
    }
    const kind = patch ? "status" : (["log", "branch", "preview"].includes(action) && m == "POST" ? action : null);
    if (!kind) return json({ error: "Not found" }, 404);
    const r = await f.report(id, kind as "log", patch ?? await request.json().catch(() => ({})));
    return json(r, r.ok ? 200 : 409);
  }
  if (path == "/api/factory" && request.method == "GET") {
    const vms = await vmsInfo(env, url.origin);
    const host = vmHost(env, url.origin);
    return json({ enabled: on, vms: typeof host == "string" ? { runner: null, why: host } : { runner: vms?.runner ?? host.kind }, claude: await f.claude() });
  }
  if (path == "/api/factory/events" && request.method == "GET") {
    const headers = new Headers(request.headers);
    // The admin's agent's events go to their own pages only: an outside agent's stream has the board's alone.
    headers.set("x-erga-login", agent ? `token:${agent.id}` : admin.login);
    return f.fetch(new Request(request.url, { headers }));
  }
  if (path == "/api/factory/guide" && request.method == "GET") return guideFor(admin, url);
  // The factory's own agent, for this admin.
  if (path == "/api/factory/agent") {
    if (request.method == "GET") return json(await f.agentState(admin.login, url.origin));
    if (request.method == "POST") {
      const body = await request.json().catch(() => ({})) as { text?: unknown; context?: unknown; files?: unknown };
      const r = await f.agentPrompt(admin.login, url.origin, String(body.text ?? ""), typeof body.context == "string" ? body.context : null, body.files);
      return json(r, r.ok ? 200 : 409);
    }
  }
  const control = /^\/api\/factory\/agent\/(abort|reset|model)$/.exec(path)?.[1] as "abort" | "reset" | "model" | undefined;
  if (control && request.method == "POST") {
    const body = control == "model" ? await request.json().catch(() => ({})) as { model?: string } : {};
    const r = await f.agentControl(admin.login, control, body.model);
    return json(r, r.ok ? 200 : 409);
  }
  const shot = /^\/api\/factory\/shots\/([\w.-]+\.png)$/.exec(path);
  if (shot && request.method == "GET") {
    const data = await f.shot(shot[1]);
    return data ? new Response(data, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" } }) : json({ error: "Not found" }, 404);
  }
  if (path == "/api/factory/tasks" && request.method == "GET") return json(await f.list());
  // The preview, for the person asking: on Cloudflare with a ticket for its host (factory/cloudflare.ts).
  if (id != null && action == "open" && request.method == "GET") {
    const t = await f.task(id);
    // A local task's preview is on its agent's machine (no VM, no ticket): the link its agent gave.
    if (!t?.url || !(t.vm || t.local)) return new Response("This task has no preview now.", { status: 404 });
    const to = new URL(t.url);
    if (to.protocol == "https:" && t.vm && !t.local) to.searchParams.set("factory_ticket", await previewTicket(env, t.vm));
    return new Response(null, { status: 302, headers: { Location: to.toString() } });
  }
  if (id != null && !action && request.method == "GET") { const t = await f.task(id, url.searchParams.get("log") == "all"); return t ? json(t) : json({ error: "Not found" }, 404); }
  if (path == "/api/factory/claude") {
    if (request.method == "GET") return json(await f.claude());
    const token = request.method == "DELETE" ? null : String(((await request.json().catch(() => ({}))) as { token?: string }).token ?? "");
    const r = await f.setClaude(token, admin.login);
    return r.ok ? json(await f.claude()) : json(r, 400);
  }
  // Everything that changes something needs the factory on.
  if (!on) return json({ error: "The factory is off: an admin turns it on with the factory setting (/admin)." }, 409);
  if (path == "/api/factory/tasks" && request.method == "POST") {
    const body = await request.json().catch(() => ({})) as { title?: string; description?: string; startAfter?: unknown; mergeAfter?: unknown; local?: unknown };
    // local: { machine } (or true): a local task, run by the agent that asks, on that machine (factory/task.ts).
    const local = body.local ? { machine: typeof body.local == "object" ? (body.local as { machine?: unknown }).machine : undefined } : undefined;
    try { return json(await f.add({ title: String(body.title ?? ""), description: String(body.description ?? ""), by, user: admin.login, ...(agent ? { via: `an outside agent (${agent.label})` } : {}), origin: url.origin, startAfter: body.startAfter, mergeAfter: body.mergeAfter, local }), 201); }
    catch (e) { return json({ error: (e as Error).message }, 400); }
  }
  if (id != null && !action && request.method == "PATCH") {
    const body = patch;
    if (!body || typeof body != "object" || Array.isArray(body)) return json({ error: "send JSON: { startAfter, mergeAfter }" }, 400);
    const r = await f.setDeps(id, body as Record<string, unknown>, by, url.origin);
    return r.ok ? json(await f.task(id)) : json({ error: r.error }, r.status ?? 409);
  }
  if (id != null && request.method == "POST" && ["merge", "discard", "revise", "restart"].includes(action)) {
    const body = action == "revise" ? await request.json().catch(() => ({})) as { instructions?: string } : {};
    const r = action == "merge" ? await f.merge(id, admin.login, url.origin) : action == "discard" ? await f.discard(id, admin.login, url.origin)
      : action == "restart" ? await f.restart(id, admin.login, url.origin) : await f.revise(id, String(body.instructions ?? ""), by, url.origin);
    return r.ok ? json(await f.task(id), action == "merge" ? 202 : 200) : json(r, 409);
  }
  return json({ error: "Not found" }, 404);
}

/** An instruction sent while a task worked. */
type Ask = { n: number; by: string; text: string; at: string };

const whoAsked = (asks: Ask[]) => [...new Set(asks.map((a) => a.by))].join(", ");

/** Instructions sent while a task worked, for Claude Code: each with who sent it, oldest first. */
export function joinAsks(asks: { by: string; text: string }[]): string {
  return asks.map((a) => `${a.by} asks: ${a.text}`).join("\n\n");
}

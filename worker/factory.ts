// The factory (experimental): the task queue inside Erga. Each task is a
// branch of Erga's own repository, task/<id>-<slug>, made from staging, and
// a VM in which Claude Code does the work and reports back. Merging a task
// merges its branch into staging and deletes it; discarding it deletes it.
// Admins only, and only while the `factory` setting is "on". README, The
// factory, has the design, the findings and the runbook.
//
//   /admin/factory                         the board (factory/page.ts)
//   GET  /api/factory                      { enabled, vms, claude: { signedIn, at, by } }
//   GET  /api/factory/tasks[/<id>]         the tasks, each with its log and screenshots
//   POST /api/factory/tasks                { title, description }: a new task (its branch, then its VM)
//   POST /api/factory/tasks/<id>/merge     into staging (one merge at a time), then the branch is deleted
//   POST /api/factory/tasks/<id>/discard   the branch deleted, the VM stopped
//   POST /api/factory/tasks/<id>/revise    { instructions }: Claude Code works on the task again
//   PUT  /api/factory/claude               { token }: the Claude plan's token (claude setup-token), stored encrypted
//   DELETE /api/factory/claude             forgets it
//   GET  /api/factory/events               server-sent events: { type: "task", task } on each change
//   GET  /api/factory/shots/<file>         a screenshot
//   GET  /api/factory/tasks/<id>/open      to the task's preview (on Cloudflare, with a ticket for its host)
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
// All the state is in one Durable Object, "factory" (SQLite): tasks, their
// logs and screenshots, and the Claude token, encrypted (AES-GCM) with
// FACTORY_KEY. Where the VMs run is a VmHost: locally the dev server's
// Docker or simulation (dev/factory.ts); on Cloudflare, Containers
// (factory/cloudflare.ts), once set up.

import { DurableObject } from "cloudflare:workers";
import { deployHook } from "../deploy";
import { containersHost } from "../factory/cloudflare";
import { factoryPage } from "../factory/page";
import { branchName, taskPrompt } from "../factory/prompt";
import { whoOf } from "../front";
import { isDev, sessionOf } from "./auth";
import { directoryOf } from "./d1";
import type { Env } from "./env";

export type Status = "queued" | "working" | "complete" | "merging" | "merged" | "failed" | "discarded";

export interface Task {
  id: number; title: string; description: string; status: Status; branch: string; base: string | null;
  commit: string | null; summary: string | null; error: string | null;
  /** The task's preview, where the user opens it (null until the VM says it's up, and after the VM stops). */
  url: string | null;
  vm: string | null; by: string; createdAt: string; updatedAt: string; mergedAt: string | null; mergeCommit: string | null;
  log: { at: string; message: string }[];
  screenshots: { file: string; caption: string; at: string }[];
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

/** What the repository checks the VMs' git tokens with: locally the dev server's secret (dev/factory.ts checks them). */
const gitSecret = (env: Env) => env.ERGA_LINK_SECRET || factoryKey(env);

/** A git token for the repository: pushes `branch` only, or (a merge) that and staging. Two hours. */
export async function gitToken(env: Env, scope: "task" | "merge", branch: string): Promise<string> {
  const secret = gitSecret(env);
  if (!secret) throw new Error("FACTORY_KEY isn't set");
  const body = b64url(JSON.stringify({ scope, branch, exp: Math.floor(Date.now() / 1000) + 7200 }));
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
  // On Cloudflare: Containers (factory/cloudflare.ts), once the runbook's steps are done.
  if (env.FACTORY_VM && env.FACTORY_PREVIEW_DOMAIN) return containersHost(env, origin);
  return "This server has no VMs for the factory yet: see README, The factory, Runbook.";
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
};

export class Factory extends DurableObject<Env> {
  private sql: SqlStorage;
  private clients = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private beat: ReturnType<typeof setInterval> | null = null;
  /** Merges run one at a time, in the order they were asked for. */
  private merges: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
      branch TEXT NOT NULL, base TEXT, commit_sha TEXT, summary TEXT, error TEXT, preview_origin TEXT, preview_path TEXT, vm TEXT, origin TEXT NOT NULL,
      by_login TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, merged_at TEXT, merge_commit TEXT, instructions TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS logs (n INTEGER PRIMARY KEY AUTOINCREMENT, task INTEGER NOT NULL, at TEXT NOT NULL, message TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS shots (n INTEGER PRIMARY KEY AUTOINCREMENT, task INTEGER NOT NULL, file TEXT NOT NULL UNIQUE, caption TEXT NOT NULL, at TEXT NOT NULL, data BLOB NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, iv BLOB NOT NULL, data BLOB NOT NULL, by_login TEXT NOT NULL, at TEXT NOT NULL)`);
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

  async add(input: { title: string; description: string; by: string; origin: string }): Promise<Task> {
    const title = input.title.trim().slice(0, 200), description = input.description.trim().slice(0, 20000);
    if (!title) throw new Error("A task needs a title.");
    const at = now();
    const id = this.sql.exec<{ id: number }>(`INSERT INTO tasks (title, description, status, branch, origin, by_login, created, updated) VALUES (?, ?, 'queued', '', ?, ?, ?, ?) RETURNING id`,
      title, description || title, input.origin, input.by, at, at).one().id;
    this.sql.exec("UPDATE tasks SET branch = ? WHERE id = ?", branchName(id, title), id);
    this.note(id, `Added by ${input.by}`);
    this.ctx.waitUntil(this.launch(id, "work"));
    return this.view(this.row(id)!);
  }

  /** A VM for the task (a new one unless it has one that's up), then the job. */
  private async launch(id: number, job: "work" | "revise") {
    const r = this.row(id)!;
    const host = vmHost(this.env, r.origin);
    if (typeof host == "string") return this.update(id, { status: "failed", error: host });
    try {
      let vm = r.vm;
      if (!vm || !(await host.alive(vm).catch(() => false))) {
        this.note(id, "Starting a VM");
        const t = Date.now();
        const started = await host.start(id);
        vm = started.vm;
        this.update(id, { vm, preview_origin: started.preview, preview_path: null, status: "working" }, `VM ${vm} started in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      } else this.update(id, { status: "working" });
      await host.job(vm, "run.ts", [job], await this.jobEnv(id, "task"), false);
    } catch (e) {
      this.update(id, { status: "failed", error: `The VM didn't start: ${(e as Error).message}` });
    }
  }

  /** What a job in the task's VM gets: where to report and with what, the repository, and the Claude token when there is one. */
  private async jobEnv(id: number, scope: "task" | "merge"): Promise<Record<string, string>> {
    const r = this.row(id)!;
    const host = vmHost(this.env, r.origin) as VmHost;
    const claude = await this.claudeToken();
    return {
      FACTORY_API: `${r.origin}/api/factory`, FACTORY_TASK: String(id), FACTORY_TOKEN: await taskToken(this.env, id),
      REPO_URL: host.repo(r.origin), REPO_TOKEN: await gitToken(this.env, scope, r.branch),
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
        if (body.status == "complete") this.update(id, { status: "complete", summary: String(body.summary ?? ""), commit_sha: body.commit ? String(body.commit) : r.commit_sha, error: null }, "Ready to merge");
        else if (body.status == "failed") this.update(id, { status: "failed", error: String(body.error ?? "failed") }, "Failed");
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

  async revise(id: number, instructions: string, by: string): Promise<{ ok: boolean; error?: string }> {
    const r = this.row(id);
    if (!r) return { ok: false, error: "no such task" };
    if (!["complete", "failed"].includes(r.status)) return { ok: false, error: `task #${id} is ${r.status}: it takes instructions when it's ready to merge or failed` };
    if (!instructions.trim()) return { ok: false, error: "Say what to change." };
    this.update(id, { instructions: instructions.trim().slice(0, 20000), status: "working", error: null }, `${by} asked: ${instructions.trim().slice(0, 500)}`);
    this.ctx.waitUntil(this.launch(id, "revise"));
    return { ok: true };
  }

  async merge(id: number, by: string): Promise<{ ok: boolean; error?: string }> {
    const r = this.row(id);
    if (!r) return { ok: false, error: "no such task" };
    if (r.status != "complete") return { ok: false, error: `task #${id} is ${r.status}: only a task that's ready to merge can be merged` };
    const waiting = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM tasks WHERE status = 'merging'").one().n;
    this.update(id, { status: "merging", error: null }, waiting ? `Merge requested by ${by}: waiting for ${waiting} merge${waiting > 1 ? "s" : ""} first` : `Merge requested by ${by}`);
    const run = this.merges.then(() => this.doMerge(id));
    this.merges = run.catch(() => {});
    this.ctx.waitUntil(run);
    return { ok: true };
  }

  private async doMerge(id: number) {
    const r = this.row(id)!;
    const host = vmHost(this.env, r.origin);
    if (typeof host == "string") return this.update(id, { status: "complete", error: host });
    try {
      this.note(id, `Merging ${r.branch} into staging`);
      const vm = await this.vmFor(id, host);
      const out = await host.job(vm, "merge.ts", ["merge", r.branch, r.title], await this.jobEnv(id, "merge"), true);
      const res = resultOf(out);
      if (!res.ok) return this.update(id, { status: "complete", error: `The merge failed: ${res.error}` }, "Merge failed: back to ready to merge");
      await host.stop(vm).catch(() => {});
      this.update(id, { status: "merged", merged_at: now(), merge_commit: String(res.commit), vm: null, preview_origin: null }, `Merged into staging as ${String(res.commit).slice(0, 10)}; ${r.branch} deleted; VM stopped`);
      // Staging moved: its deploy (#40) builds and deploys staging.erga.dev. Locally the repository is the dev server's own, which no deploy reads.
      if (host.kind == "local") this.note(id, "Staging moved (the local repository: nothing deploys it)");
      else {
        await deployHook("staging", String(res.commit), this.env).then(() => this.note(id, "Staging's deploy is asked for (/admin/deploys)"), (e) => this.note(id, `Staging's deploy wasn't asked for: ${(e as Error).message}`));
      }
    } catch (e) {
      this.update(id, { status: "complete", error: `The merge failed: ${(e as Error).message}` }, "Merge failed: back to ready to merge");
    }
  }

  async discard(id: number, by: string): Promise<{ ok: boolean; error?: string }> {
    const r = this.row(id);
    if (!r) return { ok: false, error: "no such task" };
    if (["merging", "merged", "discarded"].includes(r.status)) return { ok: false, error: `task #${id} is ${r.status}` };
    this.update(id, { status: "discarded", preview_origin: null }, `Discarded by ${by}`);
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
    return started.vm;
  }

  // -- the Claude plan's token

  async claude(): Promise<{ signedIn: boolean; at: string | null; by: string | null; canStore: boolean }> {
    const r = this.sql.exec<{ at: string; by_login: string }>("SELECT at, by_login FROM secrets WHERE name = 'claude'").toArray()[0];
    return { signedIn: !!r, at: r?.at ?? null, by: r?.by_login ?? null, canStore: !!factoryKey(this.env) };
  }

  async setClaude(token: string | null, by: string): Promise<{ ok: boolean; error?: string }> {
    if (token == null) { this.sql.exec("DELETE FROM secrets WHERE name = 'claude'"); return { ok: true }; }
    token = token.trim();
    if (!factoryKey(this.env)) return { ok: false, error: "This server has no FACTORY_KEY to encrypt the token with: set it first (README, The factory, Runbook)." };
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

  // -- live updates

  async fetch(): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    this.clients.add(w);
    this.send(w, ": connected\nretry: 2000\n\n");
    this.beat ??= setInterval(() => {
      for (const c of this.clients) this.send(c, ": beat\n\n");
      if (!this.clients.size && this.beat) { clearInterval(this.beat); this.beat = null; }
    }, 20_000);
    return new Response(readable, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  }

  private changed(id: number) {
    const r = this.row(id);
    if (!r) return;
    const line = enc.encode(`data: ${JSON.stringify({ type: "task", task: this.view(r) })}\n\n`);
    for (const c of this.clients) this.send(c, line);
  }

  private send(w: WritableStreamDefaultWriter<Uint8Array>, s: string | Uint8Array) {
    w.write(typeof s == "string" ? enc.encode(s) : s).catch(() => { this.clients.delete(w); w.abort().catch(() => {}); });
  }
}

/** A merge or discard job's result: its output's FACTORY-RESULT line. */
function resultOf(out: { code: number; output: string } | null): { ok: boolean; error?: string; commit?: string } {
  const line = out?.output.split("\n").reverse().find((l) => l.startsWith("FACTORY-RESULT "));
  if (!line) return { ok: false, error: `the job ended without a result (exit ${out?.code}): ${out?.output.slice(-400) ?? ""}` };
  return JSON.parse(line.slice("FACTORY-RESULT ".length));
}

// ---- the routes --------------------------------------------------------------------------

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const factory = (env: Env) => env.FACTORY.getByName("factory");

/** Whether the `factory` setting is on. */
const enabled = async (env: Env) => (await directoryOf(env).config.get("factory")) == "on";

/** An admin, signed in (the person, in a browser: agent tokens don't reach the factory). */
async function adminOf(env: Env, request: Request): Promise<{ login: string } | null> {
  const session = await sessionOf(env, request);
  if (!session || session.test || (session as { agent?: unknown }).agent) return null;
  return (await directoryOf(env).users.isAdmin(whoOf(session))) ? { login: session.login.toLowerCase() } : null;
}

/** /admin/factory: the board. */
export async function factoryDoor(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await sessionOf(env, request);
  if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(url.pathname)}` } });
  if (!(await adminOf(env, request))) return new Response("Not found", { status: 404 });
  return factoryPage({ enabled: await enabled(env), dev: isDev(env, url) });
}

/** /api/factory/... */
export async function factoryApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/$/, "");
  const m = /^\/api\/factory\/tasks\/(\d+)(?:\/(brief|log|branch|preview|screenshots|merge|discard|revise|open))?$/.exec(path);
  const id = m ? Number(m[1]) : null, action = m?.[2] ?? "";

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
  if (request.method != "GET" && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  const f = factory(env);
  const on = await enabled(env);
  if (path == "/api/factory" && request.method == "GET") {
    const vms = await vmsInfo(env, url.origin);
    const host = vmHost(env, url.origin);
    return json({ enabled: on, vms: typeof host == "string" ? { runner: null, why: host } : { runner: vms?.runner ?? host.kind }, claude: await f.claude() });
  }
  if (path == "/api/factory/events" && request.method == "GET") return f.fetch(request);
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
    const body = await request.json().catch(() => ({})) as { title?: string; description?: string };
    try { return json(await f.add({ title: String(body.title ?? ""), description: String(body.description ?? ""), by: admin.login, origin: url.origin }), 201); }
    catch (e) { return json({ error: (e as Error).message }, 400); }
  }
  if (id != null && request.method == "POST" && ["merge", "discard", "revise"].includes(action)) {
    const body = action == "revise" ? await request.json().catch(() => ({})) as { instructions?: string } : {};
    const r = action == "merge" ? await f.merge(id, admin.login) : action == "discard" ? await f.discard(id, admin.login) : await f.revise(id, String(body.instructions ?? ""), admin.login);
    return r.ok ? json(await f.task(id), action == "merge" ? 202 : 200) : json(r, 409);
  }
  return json({ error: "Not found" }, 404);
}

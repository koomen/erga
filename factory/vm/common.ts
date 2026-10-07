// What the VM's scripts share (they run in the factory's image as
// /opt/factory/*.ts, or straight from the repo in the local simulation).
//
// Each job gets its settings in the environment, from the factory:
//
//   FACTORY_API      the factory's API, e.g. https://erga.dev/api/factory (locally http://host.docker.internal:<port>/api/factory)
//   FACTORY_TASK     the task's number
//   FACTORY_TOKEN    the task's own token for that API: it reports on this task only
//   REPO_URL         Erga's repository (Git over HTTPS)
//   REPO_TOKEN       a token for it that may push this task's branch only (the merge job's may also move staging)
//   FACTORY_MODEL    the model for `claude --model` (the factory_model setting); absent: opus
//   FACTORY_FAST     "0": Claude Code without fast mode (the factory_fast setting); else fast mode on
//   FACTORY_WORK     where the clone goes (/work in the image)
//   FACTORY_PREVIEW_PORT   the port the task's preview listens on, inside the VM (4400)
//   FACTORY_PUBLIC_PORT    the port the VM shows it on (4401: a relay to it, as the VM's own loopback isn't reachable)
//   CLAUDE_CODE_OAUTH_TOKEN  the signed-in Claude plan's token, for the claude command only; absent: the scripted stand-in
//
// Tokens are never printed: git gets REPO_TOKEN as a header in its config.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v == null) throw new Error(`${name} isn't set`);
  return v;
};

export const TASK = () => Number(env("FACTORY_TASK"));
export const WORK = () => env("FACTORY_WORK", "/work");
export const CLONE = () => join(WORK(), "erga");
/**
 * The run of Claude Code that this job is (run.ts sets it, from the factory's FACTORY_RUN), so that each run's
 * report is its own: on 2026-10-05 a merge that conflicted twice woke Claude Code a second time while the first
 * run was still ending, and that run read the second's conflict as its own failure.
 */
export const RUN = () => env("FACTORY_JOB_RUN", "run");
/** Where a run notes that the task reported its end (task done or fail), so the job doesn't report again: one file for each run. */
export const REPORTED = () => join(WORK(), `.reported-${RUN()}`);
/** The run's id for the factory, which refuses a report from a run that isn't the task's current one (none from an older factory). */
export const runField = (): { run?: string } => process.env.FACTORY_RUN ? { run: process.env.FACTORY_RUN } : {};

/** The factory's API, for this task. */
export async function api(path: string, init: { method?: string; json?: unknown; body?: BodyInit; type?: string } = {}): Promise<any> {
  const url = `${env("FACTORY_API")}/tasks/${TASK()}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${env("FACTORY_TOKEN")}` };
  let body = init.body;
  if (init.json !== undefined) { body = JSON.stringify(init.json); headers["Content-Type"] = "application/json"; }
  else if (init.type) headers["Content-Type"] = init.type;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
      const text = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      // The factory restarting, or the network blinking: a few tries, then give up.
      if (attempt >= 4 || /^4\d\d /.test((e as Error).message)) throw new Error(`factory API ${path}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

export const log = (message: string) => api("/log", { json: { message } }).catch((e) => console.error(String(e)));

/**
 * How long each step of a job may take, in seconds, before its processes are killed (the whole tree) and the
 * task's Claude Code is woken with the logs (README, The factory, "Timeouts"). Nothing in a job waits forever.
 */
export const LIMITS = {
  clone: 300, fetch: 120, push: 120, git: 60,
  install: 600,
  /** Claude Code's run on a task (and on more instructions); then it's woken once to finish. */
  claude: 3 * 3600,
  /** Claude Code's run on a merge that needs it (a conflict, or a step that failed or hung). */
  resolve: 3600,
  preview: 150, shot: 60, stopPreview: 10,
  /** An earlier run that is still going when a merge or another run starts: the time it gets to end by itself (it reported, and says its last words). */
  stopRun: 30,
  /**
   * The same, for the merge that goes on right after a resolve: that run said `task done` a moment ago, and only says
   * its last words. The full stopRun there kept every such merge waiting up to 30 s for nothing.
   */
  stopReported: 10,
  /**
   * Instructions sent while Claude Code works reach it when its current step ends. When one command of its still runs
   * this long after they came (and had run this long), that command is stopped, so they reach Claude Code anyway.
   */
  instructionsWait: 60,
};

export interface StepResult { code: number; out: string; err: string; timedOut: boolean; secs: number; /** Its time limit, in seconds. */ limit: number }

/**
 * Runs a command as a step with a time limit, in a process group of its own: when it times out, the whole tree is
 * killed (TERM, then KILL 5 seconds later), and when it ends, whatever it left running in its group is killed too.
 * Only what a step put in a session of its own (the preview: task.ts, daemon) outlives it. Output is scrubbed of the
 * job's secrets; `echo` copies it to ours as it comes; `onLine` gets each line of stdout.
 */
export function step(cmd: string[], opts: { name?: string; timeout: number; cwd?: string; env?: Record<string, string | undefined>; echo?: boolean; onLine?: (line: string) => void; onStart?: (pid: number) => void } ): Promise<StepResult> {
  const started = Date.now();
  // A test of the timeouts (the scripted stand-in only): this step hangs, once.
  const hang = hangFor(opts.name);
  if (hang) { cmd = ["sh", "-c", `sleep ${hang.sleep} & sleep ${hang.sleep}; wait`]; opts = { ...opts, timeout: hang.timeout }; }
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "", err = "", buf = "", timedOut = false, settled = false;
    const group = (sig: NodeJS.Signals) => { try { process.kill(-p.pid!, sig); } catch { /* gone */ } };
    if (p.pid) opts.onStart?.(p.pid);
    const take = (c: Buffer, isErr: boolean) => {
      const t = c.toString();
      if (isErr) err = (err + t).slice(-20000); else out = (out + t).slice(-20000);
      if (opts.echo) (isErr ? process.stderr : process.stdout).write(scrub(t));
      if (isErr || !opts.onLine) return;
      buf += t;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) opts.onLine(l);
    };
    p.stdout!.on("data", (c) => take(c, false));
    p.stderr!.on("data", (c) => take(c, true));
    let kill: ReturnType<typeof setTimeout> | undefined;
    const limit = setTimeout(() => { timedOut = true; group("SIGTERM"); kill = setTimeout(() => group("SIGKILL"), 5000); }, opts.timeout * 1000);
    const end = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      if (kill) clearTimeout(kill);
      // Nothing of the step's own stays behind.
      group("SIGKILL");
      if (buf && opts.onLine) opts.onLine(buf);
      resolve({ code: timedOut ? 124 : code, out: scrub(out).trim(), err: scrub(err).trim(), timedOut, secs: Math.round((Date.now() - started) / 100) / 10, limit: opts.timeout });
    };
    p.on("error", (e) => { err += String(e); end(127); });
    p.on("close", (code) => end(code ?? 1));
  });
}

/** A step's failure, in a line, with the tail of its output: for logs, errors and Claude Code's instructions. */
export function stepError(what: string, r: StepResult): string {
  const tail = (r.err + (r.err && r.out ? "\n" : "") + r.out).split("\n").slice(-40).join("\n").slice(-3000);
  return `${what} ${r.timedOut ? `timed out after ${r.limit}s (its processes were killed)` : `failed (exit ${r.code})`}${tail ? `:\n${tail}` : ""}`;
}

/** Thrown for a git step that failed, with what it said. */
export class StepFailed extends Error {
  constructor(message: string, readonly result: StepResult, readonly stepName: string) { super(message); }
}

/** git, in `cwd`, as a step with a time limit (fetch, push and clone get longer), with the repository's token as a header (from the environment, never on the command line or in output). */
export async function git(args: string[], cwd = CLONE(), opts: { quiet?: boolean; name?: string; env?: Record<string, string> } = {}): Promise<StepResult> {
  const timeout = args[0] == "clone" ? LIMITS.clone : args[0] == "fetch" ? LIMITS.fetch : args[0] == "push" ? LIMITS.push : LIMITS.git;
  const name = opts.name ?? args[0];
  const r = await step(["git", ...args], { name, timeout, cwd, env: { ...opts.env, ...gitAuth() } });
  if (r.code != 0 && !opts.quiet) throw new StepFailed(stepError(`git ${args[0]}`, r), r, name);
  return r;
}

/**
 * The stand-in's tests of the timeouts: a task whose ask says "[factory-test: hang STEP SECONDS]" makes that step
 * (by name: push, fetch, merge, install, ...) hang once, with a limit of SECONDS. Honoured only when the scripted
 * stand-in does the work (no Claude plan), so a real task never hangs on purpose. The brief is read by the job
 * (FACTORY_TEST_HOOKS, set from it in run.ts and merge.ts). The merge's steps are "merge:<name>" (merge:push).
 */
function hangFor(step?: string): { timeout: number; sleep: number } | null {
  const hooks = process.env.FACTORY_TEST_HOOKS;
  if (!step || !hooks) return null;
  const name = `${process.env.FACTORY_HOOK_PREFIX ?? ""}${step}`;
  const m = new RegExp(`\\[factory-test: hang ${name} (\\d+)\\]`).exec(hooks);
  if (!m) return null;
  const once = join(WORK(), `.hung-${name}`);
  if (existsSync(once)) return null;
  writeFileSync(once, "");
  return { timeout: Number(m[1]), sleep: 3000 + TASK() };
}

/** The test hooks in a task's ask, for the stand-in only (hangFor). */
export function testHooks(prompt: string) {
  if (realClaude()) return;
  const hooks = prompt.match(/\[factory-test: [^\]]+\]/g);
  if (hooks) process.env.FACTORY_TEST_HOOKS = hooks.join(" ");
}

/** The token as an HTTP header for git, through its environment config (GIT_CONFIG_*), so it never shows in `ps` or in .git/config. */
export function gitAuth(): Record<string, string> {
  const token = process.env.REPO_TOKEN;
  if (!token) return {};
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`, GIT_TERMINAL_PROMPT: "0" };
}

/** Text with any of the job's secrets taken out, for logs. */
export function scrub(s: string): string {
  for (const name of ["REPO_TOKEN", "FACTORY_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    const v = process.env[name];
    if (v && v.length > 8) s = s.split(v).join(`[${name}]`);
  }
  return s;
}

/** Claude Code's first-run state, so `claude -p` starts without asking anything (the token itself stays in the environment). */
export function prepareClaude() {
  const home = process.env.HOME ?? "/home/bun";
  const file = join(home, ".claude.json");
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true }, null, 2));
  mkdirSync(join(home, ".claude"), { recursive: true });
  // Fast mode, from the factory_fast setting: Claude Code's own settings key (it has no flag for it).
  const settings = join(home, ".claude", "settings.json");
  let now: Record<string, unknown> = {};
  try { now = JSON.parse(readFileSync(settings, "utf8")); } catch {}
  writeFileSync(settings, JSON.stringify({ ...now, fastMode: FAST(), hooks: inboxHooks() }, null, 2));
}

/**
 * Claude Code's hooks for the instructions sent while it works (task.ts hook): after each tool call (failed or not),
 * and when it would stop, it gets those that wait. The hook asks the factory only when run.ts has seen some (INBOX).
 */
function inboxHooks() {
  const hook = [{ type: "command", command: `bun '${join(import.meta.dirname, "task.ts")}' hook`, timeout: 30 }];
  return { PostToolUse: [{ matcher: "*", hooks: hook }], PostToolUseFailure: [{ matcher: "*", hooks: hook }], Stop: [{ hooks: hook }] };
}

/** Where run.ts notes that instructions wait for this run's Claude Code (the hook then takes them), and why a command of its was stopped. */
export const INBOX = () => join(WORK(), `.inbox-${RUN()}`);
export const STOPPED = () => join(WORK(), `.stopped-${RUN()}`);

/** What Claude Code reads with the instructions that were sent while it worked (`text`: the factory's, who asks what). */
export function asksPrompt(text: string, stopped = ""): string {
  return `The user sent more instructions while you worked on this task. Do them now, as part of the task, and keep the work you did, unless they say otherwise. Then go on as before: test, commit, and say task done (or task fail).${stopped ? `\n\n${stopped}` : ""}\n\n${text}`;
}

/** Fast mode for Claude Code: on, unless the factory_fast setting is off (FACTORY_FAST=0). */
export const FAST = () => process.env.FACTORY_FAST != "0";

/** Whether the real Claude Code can run: a token, and the command, and no request for the scripted stand-in. */
export function realClaude(): boolean {
  if (process.env.FACTORY_FAKE == "1" || !process.env.CLAUDE_CODE_OAUTH_TOKEN) return false;
  return spawnSync("claude", ["--version"], { stdio: "ignore" }).status == 0;
}

/** The model for `claude --model`: the factory_model setting (FACTORY_MODEL), default opus. */
export const MODEL = () => process.env.FACTORY_MODEL?.trim() || "opus";

/** Claude Code's complaint that it can't use the model, made plain: which model, and the setting that picks it. */
/** Claude Code's last event when it stopped at --max-turns (stream-json): run.ts then wakes it once to finish. */
export const maxTurnsHit = (ev: any): boolean => ev?.type == "result" && ev.subtype == "error_max_turns";

/** The turns Claude Code gets when it is woken after --max-turns: enough to commit and report, not to start again. */
export const FINISH_TURNS = 30;

export function modelError(text: string): string | null {
  if (!/issue with the selected model|model.{0,40}(not exist|not found|access)|invalid model/i.test(text)) return null;
  return `Claude Code can't use the model "${MODEL()}" (the factory_model setting, /admin). Pick another model there, e.g. opus or sonnet. Claude Code said: ${text.trim().slice(0, 300)}`;
}

/** The last line of a job's output: its result, as JSON, for the factory (merge and discard). */
export const result = (value: Record<string, unknown>) => console.log(`FACTORY-RESULT ${JSON.stringify(value)}`);

/**
 * The board's lines for Claude Code's stream-json events: each of its words and the commands it runs, once.
 * Claude Code can send one message again, with more in it (the same text, then a tool call), so a block it
 * has seen (by message id and place), words it has said before, or a line the same as the one before it, give nothing. A run that goes
 * quiet says "still working" at most once a minute. Lines come at most every 5 s; one that comes too soon waits
 * for the next `tick` (every 5 s), so a command right after Claude Code's words isn't lost.
 * Two lines say where the time went, at once (they are rare): a tool call that took SLOW_TOOL_MS or more, when
 * it ends, the run's totals (time, time in the model, turns, tokens, cost at API prices), when it ends, and the model
 * it uses, when it starts.
 */
export const SLOW_TOOL_MS = 30_000;

export function claudeLog(now = () => Date.now()) {
  const seen = new Set<string>();
  const tools = new Map<string, { at: number; what: string }>();
  const started = now();
  let last = "", lastAt = 0, quietSince = started, pending = "";
  const said = new Set<string>();
  const out = (line: string): string[] => {
    line = scrub(line).slice(0, 300);
    // Its words: once in the run. A command: not twice in a row (it can run the tests again, later).
    if (line == last || (line.startsWith("Claude: ") && said.has(line))) return [];
    // Too soon after the last line: it waits for the next tick (only the newest one waits).
    if (now() - lastAt < 5000) { pending = line; return []; }
    pending = "";
    if (said.size > 500) said.clear();
    said.add(line);
    last = line; lastAt = quietSince = now();
    return [line];
  };
  // A line that says where the time went: never held back, and never held back by.
  const timing = (line: string): string[] => { last = line; quietSince = now(); return [line]; };
  return {
    event(ev: any): string[] {
      if (ev?.type == "user") {
        const lines: string[] = [];
        for (const c of Array.isArray(ev.message?.content) ? ev.message.content : []) {
          const t = c?.type == "tool_result" ? tools.get(c.tool_use_id) : undefined;
          if (!t) continue;
          tools.delete(c.tool_use_id);
          if (now() - t.at >= SLOW_TOOL_MS) lines.push(...timing(`Took ${secs(now() - t.at)}: ${t.what}`));
        }
        return lines;
      }
      if (ev?.type == "result") return timing(runTotals(ev));
      // The model Claude Code really uses, as it says when it starts (the factory_model setting names an alias).
      if (ev?.type == "system" && ev.subtype == "init" && typeof ev.model == "string") return timing(`Claude Code uses the model ${ev.model}${FAST() ? ", fast mode on" : ""}`);
      if (ev?.type != "assistant") return [];
      const lines: string[] = [];
      (ev.message?.content ?? []).forEach((c: any, i: number) => {
        const key = `${ev.message?.id ?? ""}:${i}:${c.id ?? c.text ?? ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (c.type == "text" && c.text?.trim()) lines.push(...out(`Claude: ${c.text.trim()}`));
        if (c.type == "tool_use") {
          const what = `${c.name}: ${scrub(String(c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? c.input?.description ?? "").replace(/\s+/g, " ")).slice(0, 200)}`;
          if (c.id) tools.set(c.id, { at: now(), what });
          lines.push(...out(`Claude runs ${what}`));
        }
      });
      return lines;
    },
    tick(): string[] {
      if (pending && now() - lastAt >= 5000) return out(pending);
      if (now() - quietSince < 60_000) return [];
      return out(`Claude Code is still working, ${Math.round((now() - started) / 1000)}s`);
    },
  };
}

const secs = (ms: number) => ms >= 120_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)}s`;
const count = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** The line for Claude Code's `result` event: how long its run took, how much of that was the model, and what it used. */
export function runTotals(ev: any): string {
  const n = (v: unknown) => (typeof v == "number" && Number.isFinite(v) ? v : 0);
  const u = ev.usage ?? {};
  const read = n(u.cache_read_input_tokens), input = n(u.input_tokens) + n(u.cache_creation_input_tokens) + read;
  const parts = [
    `${secs(n(ev.duration_ms))} (${secs(n(ev.duration_api_ms))} in the model)`,
    `${n(ev.num_turns)} turns`,
    `${count(input)} tokens in (${count(read)} from the cache), ${count(n(u.output_tokens))} out`,
    ...(typeof ev.total_cost_usd == "number" ? [`$${ev.total_cost_usd.toFixed(2)} at API prices`] : []),
  ];
  return `Claude Code's run ended${ev.is_error ? " with an error" : ""}: ${parts.join(", ")}`;
}

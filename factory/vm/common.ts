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
/** Where a job notes that the task reported its end (task done or fail), so the job doesn't report again. */
export const REPORTED = () => join(WORK(), ".reported");

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

/** git, in `cwd`, with the repository's token as a header (from the environment, never on the command line or in output). */
export function git(args: string[], cwd = CLONE(), opts: { quiet?: boolean } = {}): { code: number; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitAuth() } });
  const res = { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: scrub((r.stderr ?? "").trim()) };
  if (res.code != 0 && !opts.quiet) throw new Error(`git ${args[0]}: ${res.err || res.out}`);
  return res;
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

/** Runs a command, its output to ours; resolves with its exit code. */
export function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; onLine?: (line: string) => void } = {}): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const take = (c: Buffer, err: boolean) => {
      const t = c.toString();
      (err ? process.stderr : process.stdout).write(scrub(t));
      if (!opts.onLine) return;
      buf += t;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) opts.onLine(l);
    };
    p.stdout.on("data", (c) => take(c, false));
    p.stderr.on("data", (c) => take(c, true));
    p.on("error", () => resolve(127));
    p.on("close", (code) => { if (buf && opts.onLine) opts.onLine(buf); resolve(code ?? 1); });
  });
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
  writeFileSync(settings, JSON.stringify({ ...now, fastMode: FAST() }, null, 2));
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
export function modelError(text: string): string | null {
  if (!/issue with the selected model|model.{0,40}(not exist|not found|access)|invalid model/i.test(text)) return null;
  return `Claude Code can't use the model "${MODEL()}" (the factory_model setting, /admin). Pick another model there, e.g. opus or sonnet. Claude Code said: ${text.trim().slice(0, 300)}`;
}

/** The last line of a job's output: its result, as JSON, for the factory (merge and discard). */
export const result = (value: Record<string, unknown>) => console.log(`FACTORY-RESULT ${JSON.stringify(value)}`);

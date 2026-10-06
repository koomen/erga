#!/usr/bin/env bun
// `task`: how Claude Code, in the VM, reports to the factory (as `tq` does
// for the local task queue). It works on the job's task only.
//
//   task log "message"                    a progress line on the board
//   task preview [/path] [--static DIR]   runs the app from the clone (bun start) on the preview port, kept
//                                         running after the job; --static serves a folder instead
//   task shot URL|FILE "caption" [--replace]   a screenshot (headless Chromium for a URL); --replace drops the old ones first
//   task done "summary"                   pushes the branch, then marks the task ready to merge
//   task fail "why"                       marks the task failed
//   task run [--timeout SECONDS] -- CMD...  runs a command with a time limit (default 600 s): on timeout its whole
//                                         process tree is killed and it exits 124; nothing it started stays behind
//
// A URL given to `task shot` on localhost is the VM's own (the preview).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { api, asksPrompt, CLONE, env, git, INBOX, LIMITS, log, REPORTED, runField, step, STOPPED, TASK } from "./common.ts";

const PORT = () => Number(env("FACTORY_PREVIEW_PORT", "4400"));
const PUBLIC = () => Number(env("FACTORY_PUBLIC_PORT", "4401"));

/** Pushes the task's branch (whatever is committed) and says where it is. */
export async function pushBranch(): Promise<string> {
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).out;
  if (!branch.startsWith("task/")) throw new Error(`the clone is on ${branch}, not the task's branch`);
  await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
  return (await git(["rev-parse", "HEAD"])).out;
}

async function up(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; }
}

/** Where a daemon's process id is kept (`name`: preview, relay), so the merge can stop it (stopPreview). */
export const pidFile = (name: string) => join(env("FACTORY_WORK", "/work"), `${name}.pid`);

/** Starts something detached (its own session), so it outlives the job that started it; its pid goes in WORK/<name>.pid. */
function daemon(name: string, cmd: string[], cwd: string, logFile: string, extra: Record<string, string> = {}) {
  // The preview gets none of the job's secrets.
  const { CLAUDE_CODE_OAUTH_TOKEN, REPO_TOKEN, FACTORY_TOKEN, FACTORY_TEST_HOOKS, ...rest } = process.env;
  const p = spawn("sh", ["-c", `exec ${cmd.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")} >>'${logFile}' 2>&1`], { cwd, detached: true, stdio: "ignore", env: { ...rest, ...extra } });
  if (p.pid) writeFileSync(pidFile(name), String(p.pid));
  p.unref();
}

const alive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };

/**
 * Stops the preview and its relay, with everything they started (their process groups), so nothing of a dev server
 * that has run for hours can block a build or hold a port while the merge works (on 2026-10-05 a 3-hour-old dev
 * server blocked `vite build` in the local queue). Answers what it stopped.
 */
export async function stopPreview(): Promise<string[]> {
  const stopped: string[] = [];
  for (const name of ["preview", "relay"]) {
    const file = pidFile(name);
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8"));
    rmSync(file, { force: true });
    if (!pid || !alive(pid)) continue;
    try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
    for (let i = 0; i < LIMITS.stopPreview * 10 && alive(pid); i++) await Bun.sleep(100);
    if (alive(pid)) try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    stopped.push(name);
  }
  // A preview started before pid files (an older script): by its command line, on this VM's port.
  const port = String(PORT());
  for (const pattern of [`dev.ts --port ${port} `, `serve-static .* ${port}$`]) {
    if (spawnSync("pkill", ["-f", pattern], { stdio: "ignore" }).status == 0) stopped.push(pattern.split(" ")[0]);
  }
  return stopped;
}

/** Whether a process (not a group) is there. */
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Whether that process is a run.ts job (not another that got its pid since), where /proc can say. */
const isRun = (pid: number) => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("run.ts"); } catch { return !existsSync("/proc/self"); } };

/**
 * Stops an earlier run of Claude Code (run.ts, pid in WORK/run.pid, and Claude Code's process group, WORK/claude.pid)
 * that is still going: a merge, or another run, starts only when it has ended. It gets `grace` seconds to end by
 * itself (after `task done` Claude Code still says its last words); then the job is killed first (so it reports
 * nothing), and Claude Code with everything it started. Answers whether it had to stop something.
 */
export async function stopRun(grace = LIMITS.stopRun): Promise<boolean> {
  const file = pidFile("run");
  if (!existsSync(file)) return false;
  const job = Number(readFileSync(file, "utf8"));
  const claudeFile = pidFile("claude");
  const group = existsSync(claudeFile) ? Number(readFileSync(claudeFile, "utf8")) : 0;
  const left = () => (job > 0 && job != process.pid && running(job) && isRun(job)) || (group > 0 && alive(group));
  for (let i = 0; i < grace * 10 && left(); i++) await Bun.sleep(100);
  const stopped = left();
  if (stopped) {
    if (job > 0 && job != process.pid && isRun(job)) try { process.kill(job, "SIGKILL"); } catch { /* gone */ }
    if (group > 0) {
      try { process.kill(-group, "SIGTERM"); } catch { /* gone */ }
      for (let i = 0; i < 50 && alive(group); i++) await Bun.sleep(100);
      try { process.kill(-group, "SIGKILL"); } catch { /* gone */ }
    }
  }
  rmSync(file, { force: true });
  rmSync(claudeFile, { force: true });
  return stopped;
}

export async function preview(path = "/", staticDir?: string) {
  const port = PORT(), pub = PUBLIC();
  if (!(await up(port))) {
    const logFile = join(env("FACTORY_WORK", "/work"), "preview.log");
    if (staticDir) daemon("preview", ["bun", import.meta.path, "serve-static", resolve(CLONE(), staticDir), String(port)], CLONE(), logFile);
    else daemon("preview", ["bun", "dev.ts", "--port", String(port), "--no-open"], CLONE(), logFile);
    for (let i = 0; i < LIMITS.preview * 4 && !(await up(port)); i++) await Bun.sleep(250);
    if (!(await up(port))) {
      // Not left half-started: its processes are stopped.
      await stopPreview();
      throw new Error(`the preview didn't start in ${LIMITS.preview}s (stopped): ${readFileSync(logFile, "utf8").slice(-1500)}`);
    }
  }
  // The VM's loopback isn't reachable from outside it: a relay on the public port, when that is another one.
  if (pub != port && !(await up(pub))) {
    daemon("relay", ["socat", `TCP-LISTEN:${pub},fork,reuseaddr`, `TCP:127.0.0.1:${port}`], CLONE(), join(env("FACTORY_WORK", "/work"), "relay.log"));
    for (let i = 0; i < 40 && !(await up(pub)); i++) await Bun.sleep(100);
  }
  await api("/preview", { json: { path } });
}

/** Chromium's binary: CHROME, else the usual places. */
function chrome(): string {
  const candidates = [process.env.CHROME, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error("no Chromium here: set CHROME");
  return found;
}

/**
 * Headless Chromium's screenshot of `url` into `file`; resolves with what it said that matters. Some builds (Chrome on a
 * Mac) don't exit after writing it: once the file is there and stops growing, the browser is stopped.
 */
function chromeShot(url: string, file: string, profile: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(chrome(), ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars", "--no-first-run",
      `--user-data-dir=${profile}`, "--window-size=1280,860", "--virtual-time-budget=10000", `--screenshot=${file}`, url], {
      stdio: ["ignore", "ignore", "pipe"], detached: true,
      // The local simulation gives jobs a HOME of their own, in which Chrome on a Mac hangs: it gets the real one (CHROME_HOME), and its own profile.
      env: process.env.CHROME_HOME ? { ...process.env, HOME: process.env.CHROME_HOME } : process.env,
    });
    let stderr = "", last = -1, settled = false;
    p.stderr.on("data", (c: Buffer) => { stderr = (stderr + c.toString()).slice(-4000); });
    const done = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll); clearTimeout(limit);
      // Chromium and its helpers: the whole group.
      try { process.kill(-p.pid!, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch { /* gone */ } }
      resolve(/Page load failed[^\n]*/.exec(stderr)?.[0] ?? stderr.slice(-800));
    };
    const poll = setInterval(() => {
      const size = existsSync(file) ? statSync(file).size : -1;
      if (size > 0 && size == last) done();
      last = size;
    }, 300);
    const limit = setTimeout(done, LIMITS.shot * 1000);
    p.on("close", done);
  });
}

export async function shot(target: string, caption: string, replace = false) {
  let file = target;
  if (/^https?:\/\//.test(target)) {
    const dir = mkdtempSync(join(tmpdir(), "shot-"));
    file = join(dir, "shot.png");
    // A few tries: a dev server restarts when the files it serves change (a commit just made), and refuses meanwhile.
    let err = "";
    for (let attempt = 0; attempt < 4 && !existsSync(file); attempt++) {
      if (attempt) await Bun.sleep(2500);
      err = await chromeShot(target, file, join(dir, `profile-${attempt}`));
      if (/ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE/.test(err)) rmSync(file, { force: true });
    }
    if (!existsSync(file)) throw new Error(`the screenshot failed: ${err}`);
  }
  const bytes = readFileSync(file);
  await api(`/screenshots?caption=${encodeURIComponent(caption)}${replace ? "&replace=1" : ""}`, { body: bytes, type: "image/png" });
}

/**
 * Takes the instructions that wait for this run's Claude Code (the factory hands each over once), as the prompt it
 * reads: "" when none wait, or the run reported its end already (the factory then gives them to a new run).
 */
export async function takeAsks(how: string): Promise<string> {
  if (existsSync(REPORTED())) return "";
  const { asks, text } = await api("/inbox", { json: { how } }) as { asks: unknown[]; text?: string };
  rmSync(INBOX(), { force: true });
  if (!asks.length || !text) return "";
  const stopped = existsSync(STOPPED()) ? readFileSync(STOPPED(), "utf8") : "";
  rmSync(STOPPED(), { force: true });
  return asksPrompt(text, stopped);
}

/**
 * Claude Code's hook (common.ts, inboxHooks), after each tool call and when it would stop: the instructions that wait,
 * as more context for it (or, at its stop, as the reason to go on). Quick when none wait (no call to the factory), and
 * never in a subagent (the main Claude Code gets them, when the subagent ends).
 */
async function hook() {
  let input: any = {};
  try { input = JSON.parse(await Bun.stdin.text()); } catch { /* none */ }
  if (input.agent_id || !existsSync(INBOX())) return;
  const event = String(input.hook_event_name ?? "PostToolUse");
  const prompt = await takeAsks(event == "Stop" ? "as it was about to stop" : `after a step (${String(input.tool_name ?? "a tool")})`);
  if (!prompt) return;
  console.log(JSON.stringify(event == "Stop" ? { decision: "block", reason: prompt } : { hookSpecificOutput: { hookEventName: event, additionalContext: prompt } }));
}

export async function done(summary: string) {
  const commit = await pushBranch();
  await api("", { method: "PATCH", json: { status: "complete", summary, commit, ...runField() } });
  writeFileSync(REPORTED(), "complete");
}

export async function fail(why: string) {
  await api("", { method: "PATCH", json: { status: "failed", error: why, ...runField() } });
  writeFileSync(REPORTED(), "failed");
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };
  const has = (name: string) => { const i = rest.indexOf(name); if (i >= 0) rest.splice(i, 1); return i >= 0; };
  try {
    switch (cmd) {
      case "log": await log(rest.join(" ")); break;
      case "preview": { const dir = flag("--static"); await preview(rest[0] ?? "/", dir); console.log("preview up"); break; }
      case "shot": { const replace = has("--replace"); await shot(rest[0], rest.slice(1).join(" ") || "", replace); console.log("screenshot added"); break; }
      case "done": await done(rest.join(" ")); console.log(`task #${TASK()} is ready to merge`); break;
      case "fail": await fail(rest.join(" ")); break;
      case "hook": await hook().catch((e) => console.error(`task hook: ${(e as Error).message}`)); break;
      case "run": {
        // A command under a time limit: its output as it comes; on timeout, its whole tree killed (exit 124).
        const t = Number(flag("--timeout") ?? 600);
        const cmdline = rest[0] == "--" ? rest.slice(1) : rest;
        if (!cmdline.length || !(t > 0)) throw new Error('say what to run: task run --timeout SECONDS -- CMD...');
        const r = await step(cmdline, { name: "run", timeout: t, cwd: process.cwd(), echo: true });
        if (r.timedOut) console.error(`task run: ${cmdline.join(" ")} timed out after ${t}s; its processes were killed`);
        process.exit(r.code);
      }
      case "serve-static": {
        // The light preview (the local simulation's): a folder's files.
        const [dir, port] = rest;
        Bun.serve({ port: Number(port), hostname: "127.0.0.1", async fetch(req) {
          const p = decodeURIComponent(new URL(req.url).pathname);
          const f = Bun.file(join(dir, p.endsWith("/") ? p + "index.html" : p));
          return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
        } });
        await new Promise(() => {});
        break;
      }
      default: console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1).filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    }
  } catch (e) {
    console.error(`task ${cmd}: ${(e as Error).message}`);
    process.exit(1);
  }
}

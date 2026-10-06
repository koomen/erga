#!/usr/bin/env bun
// The task queue: a local board of the work agents are doing in this repo.
//
//   bun development/task-queue/server.ts      (or let ./tq start it)
//
// Each task gets its own branch and worktree (.claude/worktrees/task-<id>),
// a port for its preview server, and a card on the board at
// http://localhost:4700 that moves Queued → Working → Ready to merge →
// Merging as the agent doing it reports in and the user merges it, and then
// shows on its merge commit in Branches (main's latest commits).
// Merge (on the board, or POST /api/tasks/:id/merge) puts the task in
// Merging: the queue stops the task's preview (and anything else still
// running in its worktree), merges origin's branch and main into the task's
// branch, runs TASK_QUEUE_CHECK there if set, merges the branch into main and
// pushes it (to origin's staging branch, for Erga: Erga's own Git endpoint,
// which then deploys staging.erga.dev by itself); then it's Done (merged).
//
// One agent per task, from start to merge: the task records its agent (agent,
// set by the outer agent: tq start ID --agent AGENT, tq agent ID AGENT). When
// a merge needs work (a conflict, uncommitted changes, a check that fails, a
// step that times out), the queue never settles it itself: it puts the
// worktree back on the branch's last commit and the task in Needs agent
// (needs-agent, with needsAgent {step, reason, output, files}); tq watch says
// so, the outer agent wakes the task's agent, which fixes it in the worktree
// and runs tq continue ID, and the merge runs again. Every step the queue runs
// has a time limit (TIMEOUTS) and runs in its own process group, killed whole
// when the time is up. GET /api describes the whole API; AGENTS.md says how to use it.
//
// Its state is data/tasks.json (and data/screenshots/, data/logs/), beside
// this file in the main checkout, whichever worktree it's started from.
//
// Settings, all optional: TASK_QUEUE_PORT (4700), TASK_QUEUE_REPO (the repo
// this file is in), TASK_QUEUE_DATA, TASK_QUEUE_PREVIEW (the default preview
// command), TASK_QUEUE_CHECK (a command run in the worktree before the branch
// goes into main, after origin's branch and main are merged into it; none if
// unset), TASK_QUEUE_TIMEOUT_<STEP> (seconds: each step's time limit, see
// TIMEOUTS), TASK_QUEUE_INSTALL=0 (don't set up node_modules in new worktrees),
// TASK_QUEUE_FETCH (seconds between `git fetch origin`, for the Branches
// column's view of origin; 60, 0 for never), TASK_QUEUE_LIVE (live mode's
// dev server command), TASK_QUEUE_CHROME and TASK_QUEUE_CHROME_HEADLESS (live
// mode's Chrome window: chrome.ts).
//
// Where merges go (README, Merging): main is pushed to origin's branch that
// `git config remote.origin.push refs/heads/main:refs/heads/<branch>` names
// (main if none). For Erga (source/git-credential.ts in the repo) the queue
// sets the main checkout up itself, when no merge runs and it's clean on main:
// origin is TASK_QUEUE_ORIGIN (https://erga.dev/git/erga.git; "" leaves the
// remotes alone), the old origin is kept as `github`, main pushes to
// TASK_QUEUE_PUSH_TO (staging), and Git signs in to origin with
// TASK_QUEUE_ORIGIN_HELPER (the credential helper, source/git-credential.ts).
// Before it talks to origin it runs TASK_QUEUE_LOGIN (`bun
// source/git-credential.ts login <origin>`: an admin token, made with this
// machine's SSH key; the first time, an agent token someone approves, shown on
// the board and by `tq watch`). POST /api/release moves origin's main to its
// staging (production, for Erga): a deliberate step, never part of a merge.
//
// Live tasks (live: true) are worked on by the user and an agent together, in
// a session, not by a background worker: POST /api/tasks/:id/live runs the
// dev server with live reload in the task's worktree and opens (or brings
// back) a Chrome window of its own on it, recorded on the task (chrome);
// GET /api/tasks/:id/look says what that window shows. Merging or discarding
// the task stops the dev server and closes the window.
//
// When the queue's own code changes on disk (a merge, or anything else: the
// files in this directory that the server, the board or tq run; not docs,
// mod/ or its tests), the queue restarts itself, so it runs the new code:
// once nothing is merging and no request is in flight, and the new code
// builds, it spawns a fresh server (detached, logging to data/server.log) and
// exits; the new one waits for the old to be gone before it reads the state
// and listens. Previews run in their own process groups, so they carry on
// through it. GET /api says which code runs (running: {version, stale}).
//
// Dependencies between tasks: startAfter (don't start until these are merged)
// and mergeAfter (don't merge until these are merged; startAfter ones count
// too), stored on the task. blockedBy, computed on every change, says what a
// task waits for; starting (PATCH status working, POST .../live) and merging
// (POST .../merge, and again when a queued merge runs) are refused while it
// does. A dependency that is discarded or failed blocks its dependents until
// someone removes or changes it. GET /api, "dependencies", has the details.

import { spawn as spawnDetached } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import * as chrome from "./chrome.ts";
import { type Blocked, dependents as dependentsIn, depRules, depsNote, ids } from "./deps.ts";
import { foreign } from "./foreign.ts";

const HERE = import.meta.dir;
const PORT = Number(process.env.TASK_QUEUE_PORT ?? 4700);
const MAIN = "main";
const REPO = process.env.TASK_QUEUE_REPO ?? dirname(gitSync(HERE, "rev-parse", "--path-format=absolute", "--git-common-dir"));
const DATA = process.env.TASK_QUEUE_DATA ?? join(REPO, "development/task-queue/data");
const SHOTS = join(DATA, "screenshots");
const LOGS = join(DATA, "logs");
const WORKTREES = join(REPO, ".claude/worktrees");
const PREVIEW = process.env.TASK_QUEUE_PREVIEW ?? "bun start --port $PORT --no-open";
/** Run in the worktree before the branch goes into main (after origin's branch and main are merged into it): "" for nothing. */
const CHECK = process.env.TASK_QUEUE_CHECK ?? "";
/**
 * Each step's time limit, in seconds (TASK_QUEUE_TIMEOUT_<STEP> overrides one). A step that runs out of time is
 * killed with its whole process group; during a merge, the task then goes to its agent (needs-agent).
 */
const TIMEOUTS = Object.fromEntries(Object.entries({
  git: 120, // a local git command: merge, commit, reset, worktree add/remove, ...
  origin: 120, // git fetch and push to origin (with its credential helper)
  login: 300, // TASK_QUEUE_LOGIN: it may wait for someone to approve this machine
  check: 240, // TASK_QUEUE_CHECK (a task builds, tests and merges in under 5 minutes: AGENTS.md)
  install: 180, // node_modules for a new worktree
  stop: 15, // a preview, or a process left in the worktree, stopping (SIGTERM, then SIGKILL)
  screenshot: 60, // a headless Chrome screenshot
  build: 60, // the new code built before a self-restart
}).map(([k, v]) => [k, Number(process.env[`TASK_QUEUE_TIMEOUT_${k.toUpperCase()}`] ?? v)])) as Record<"git" | "origin" | "login" | "check" | "install" | "stop" | "screenshot" | "build", number>;
/** Live mode's dev server: tabs reload by themselves on every edit (dev/reload.ts). */
const LIVE = process.env.TASK_QUEUE_LIVE ?? "bun start --port $PORT --no-open --reload";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FETCH_EVERY = Number(process.env.TASK_QUEUE_FETCH ?? 60);
/** Erga's credential helper for its Git endpoint: there, the queue sets origin up itself (README, Erga's own source). */
const HELPER_FILE = join(REPO, "source/git-credential.ts");
const ERGA = existsSync(HELPER_FILE);
/** What the main checkout's origin should be ("": leave the remotes alone), the old origin's new name, and where main goes there. */
const ORIGIN_URL = process.env.TASK_QUEUE_ORIGIN ?? (ERGA ? "https://erga.dev/git/erga.git" : "");
const OLD_ORIGIN = "github";
const PUSH_TO = process.env.TASK_QUEUE_PUSH_TO ?? (ORIGIN_URL ? "staging" : "");
const ORIGIN_HELPER = process.env.TASK_QUEUE_ORIGIN_HELPER ?? (ERGA ? `!bun ${HELPER_FILE}` : "");
const httpOrigin = (url: string) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : ""; } catch { return ""; } };
/** Run before talking to origin, so Git's credential helper has a token without asking anyone ("" for nothing to do). */
const LOGIN = process.env.TASK_QUEUE_LOGIN ?? (ERGA && httpOrigin(ORIGIN_URL) ? `bun ${HELPER_FILE} login ${httpOrigin(ORIGIN_URL)}` : "");
const LOOKS = join(DATA, "looks");
/** Where the credential helper says, while it waits, which link approves this machine's agent token. */
const LOGIN_NOTICE = join(DATA, "origin-login.json");
for (const dir of [SHOTS, LOGS, LOOKS]) mkdirSync(dir, { recursive: true });

// Started by a self-restart: wait for the old server to save, exit and let go of the port, then read the state.
const restartedFrom = Number(process.env.TASK_QUEUE_RESTARTED_FROM) || 0;
delete process.env.TASK_QUEUE_RESTARTED_FROM; // not for previews, nor the next restart
if (restartedFrom) {
  const alive = () => { try { process.kill(restartedFrom, 0); return true; } catch { return false; } };
  for (let i = 0; i < 600 && alive(); i++) await Bun.sleep(50);
  for (let i = 0; i < 100 && !(await portFree(PORT)); i++) await Bun.sleep(50);
  // Something else got there first (a tq command that found the queue down started the same code): leave it to that one.
  if (!(await portFree(PORT))) { console.log(`restart: something already listens on ${PORT}; leaving it be`); process.exit(0); }
}

type Status = "queued" | "working" | "complete" | "merging" | "needs-agent" | "merged" | "failed" | "discarded";
/** What an agent may set; the rest the queue sets itself (merging, needs-agent and merged on merge, discarded on discard). */
const AGENT_STATUSES: Status[] = ["queued", "working", "complete", "failed"];

interface Task {
  id: number;
  title: string;
  description: string;
  status: Status;
  branch?: string;
  worktree?: string;
  /** The preview server's port: the agent runs (or asks the queue to run) the task's app here. */
  port?: number;
  /** Where the user sees the work done: a page on the preview server, usually. */
  url?: string;
  /** What was done and how it was checked, for the person merging. */
  summary?: string;
  screenshots: { file: string; caption?: string }[];
  log: { at: string; message: string }[];
  preview?: { pid: number; command: string };
  previewUp?: boolean;
  /** Worked on live, in a session with the user, not by a background worker (AGENTS.md, "Live mode"). */
  live?: boolean;
  /** A live task's Chrome window: its own profile and DevTools port, and the tab it opened. */
  chrome?: chrome.LiveChrome;
  chromeUp?: boolean;
  error?: string;
  /** The agent doing the task, from start to merge (the Agent tool's agent id): the one to wake when the merge needs work. */
  agent?: string;
  /** Why the merge stopped and waits for the task's agent (status needs-agent): the step, why, its output's tail, conflicted files. */
  needsAgent?: NeedsAgentInfo;
  /** The branch's last commit when the merge running now began: the worktree goes back to it if the merge stops. */
  mergeFrom?: string;
  commit?: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  /** When it first went to working, when it was last set complete, and when its last merge began: the board shows the times. */
  workingAt?: string;
  completeAt?: string;
  mergeStartedAt?: string;
  /** Don't start until these tasks are merged. */
  startAfter?: number[];
  /** Don't merge until these tasks are merged (the startAfter ones too). */
  mergeAfter?: number[];
  /** Computed on every change (not stored): what the task waits for, if anything. */
  blockedBy?: Blocked;
}

interface NeedsAgentInfo { step: string; reason: string; output?: string; files?: string[]; at: string }

// ---- state ----------------------------------------------------------------

const STORE = join(DATA, "tasks.json");
const store: { nextId: number; tasks: Task[] } = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { nextId: 1, tasks: [] };
const clients = new Set<ReadableStreamDefaultController>();
const encoder = new TextEncoder();

function save() {
  computeBlocked();
  writeFileSync(STORE + ".tmp", JSON.stringify(store, (k, v) => (k == "blockedBy" ? undefined : v), 2));
  renameSync(STORE + ".tmp", STORE);
  broadcast("tasks", store.tasks);
}

function broadcast(event: string, data: unknown) {
  const msg = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const c of clients) try { c.enqueue(msg); } catch { clients.delete(c); }
}

function touch(task: Task, changes: Partial<Task> = {}, message?: string) {
  const now = new Date().toISOString();
  if (changes.status && changes.status != task.status) {
    if (changes.status == "working" && !task.workingAt) changes.workingAt = now;
    if (changes.status == "complete" && task.status != "merging") changes.completeAt = now;
  }
  Object.assign(task, changes, { updatedAt: now });
  if (message) task.log.push({ at: task.updatedAt, message });
  save();
}

const find = (id: number) => store.tasks.find((t) => t.id == id);

// ---- dependencies ---------------------------------------------------------
// The model and its rules are shared with the factory inside Erga: deps.ts.

const { unmetStart, blocked, depChanges, startRefusal, mergeRefusal, mergeTimeRefusal, dependentNews } = depRules(find);

function computeBlocked() {
  for (const t of store.tasks) { const b = blocked(t); if (b) t.blockedBy = b; else delete t.blockedBy; }
}

/** The tasks still to do that wait on this one. */
const dependents = (id: number) => dependentsIn(store.tasks, id);

/** Notes on each dependent's log what happened to a dependency (merged, discarded, failed), and what that means for it. */
function tellDependents(dep: Task) {
  for (const t of dependents(dep.id)) touch(t, {}, dependentNews(dep, t).message);
}

computeBlocked();

// A merge that was running when the queue stopped will never finish: put it
// back in Ready to merge, its worktree out of the half-done merge and back on
// the branch's last commit.
for (const t of store.tasks.filter((t) => t.status == "merging")) {
  if (t.worktree && existsSync(join(t.worktree, ".git"))) {
    Bun.spawnSync(["git", "merge", "--abort"], { cwd: t.worktree, stderr: "ignore" });
    if (t.mergeFrom) Bun.spawnSync(["git", "reset", "-q", "--hard", t.mergeFrom], { cwd: t.worktree, stderr: "ignore" });
  }
  const error = "The task queue stopped while this was merging; merge it again.";
  touch(t, { status: "complete", error, mergeFrom: undefined }, `Merge interrupted: ${error}`);
}

// ---- git and processes ----------------------------------------------------

function gitSync(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (r.exitCode != 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

interface Ran { ok: boolean; code: number | null; out: string; err: string; all: string; timedOut: boolean; seconds: number }

/** Every process the queue runs now (their process groups), killed if the queue is told to stop. */
const running = new Set<number>();

/** Kills a process group: SIGTERM, then SIGKILL after `grace` ms if anything in it is left. */
function killGroup(pid: number, grace = 3000) {
  try { process.kill(-pid, "SIGTERM"); } catch { return; }
  setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, grace).unref();
}
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };

/**
 * Runs a command in its own process group, with a time limit (seconds): when it runs out, the whole group (the
 * command and everything it started) is killed, and timedOut says so. Never throws.
 */
function run(cmd: string[], cwd: string, env: Record<string, string> = {}, timeout = TIMEOUTS.git): Promise<Ran> {
  const started = Date.now();
  return new Promise((done) => {
    let out = "", err = "", timedOut = false, finished = false;
    const child = spawnDetached(cmd[0], cmd.slice(1), { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (s: string, more: string) => (s.length > 2_000_000 ? s.slice(-1_000_000) : s) + more;
    child.stdout!.on("data", (d) => (out = keep(out, String(d))));
    child.stderr!.on("data", (d) => (err = keep(err, String(d))));
    if (child.pid) running.add(child.pid);
    const timer = setTimeout(() => { timedOut = true; if (child.pid) killGroup(child.pid); }, timeout * 1000);
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child.pid) running.delete(child.pid);
      done({ ok: code == 0 && !timedOut, code, out: out.trim(), err: err.trim(), all: (out + err).trim(), timedOut, seconds: Math.round((Date.now() - started) / 1000) });
    };
    child.on("error", (e) => { err += String(e.message); finish(-1); });
    // close: it exited and its output ended. A process it left behind holding the output open doesn't keep us waiting.
    child.on("close", (code) => finish(code));
    child.on("exit", (code) => setTimeout(() => finish(code), 500));
  });
}

/** The files in `git status --porcelain` output (trimmed or not). */
const changedFiles = (porcelain: string) => porcelain.split("\n").map((l) => l.trim().replace(/^\S+\s+/, "")).filter(Boolean).join(", ");

/** The last lines of a command's output, for a log or the agent. */
const tail = (s: string, lines = 40) => s.split("\n").slice(-lines).join("\n").slice(-6000);

/** A merge that needs the task's agent: the queue stops, puts the worktree back, and the task goes to needs-agent. */
class NeedsAgent extends Error {
  constructor(public step: string, reason: string, public output?: string, public files?: string[]) { super(reason); }
}

/** A step that ran out of time, as a NeedsAgent (its output's tail with it). */
const timeoutError = (step: string, r: Ran, timeout: number) => new NeedsAgent(step, `${step} timed out after ${timeout}s`, tail(r.all));

async function git(cwd: string, ...args: string[]) {
  const r = await run(["git", ...args], cwd);
  if (r.timedOut) throw timeoutError(`git ${args[0]}`, r, TIMEOUTS.git);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed:\n${r.all}`);
  return r.out;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "") || "task";

/** Nothing listening, on any address (a server on the wildcard address doesn't stop a listen on 127.0.0.1). */
async function portFree(port: number) {
  for (const hostname of ["0.0.0.0", "::", "127.0.0.1", "::1"]) {
    try { Bun.listen({ hostname, port, socket: { data() {} } }).stop(true); } catch (e) {
      if ((e as { code?: string }).code == "EADDRINUSE") return false;
    }
  }
  return true;
}

/** The lowest port from 4501 that no unfinished task holds and nothing listens on. */
async function freePort() {
  const held = new Set(store.tasks.filter((t) => !["merged", "discarded"].includes(t.status)).map((t) => t.port));
  for (let p = 4501; p < 4700; p++) if (!held.has(p) && (await portFree(p))) return p;
  throw new Error("no free preview port in 4501-4699");
}

async function setUpWorktree(task: Task) {
  const branch = `task/${task.id}-${slugify(task.title)}`;
  const worktree = join(WORKTREES, `task-${task.id}`);
  await git(REPO, "worktree", "add", "-b", branch, worktree, MAIN);
  touch(task, { branch, worktree }, `Worktree ${worktree} on branch ${branch}, from ${MAIN}`);
  // Gitignored things a checkout needs to run: local settings, and its packages.
  for (const f of [".dev.vars"]) if (existsSync(join(REPO, f))) copyFileSync(join(REPO, f), join(worktree, f));
  // Packages: a copy-on-write clone of the main checkout's (seconds, no extra disk), else an install.
  if (process.env.TASK_QUEUE_INSTALL != "0" && existsSync(join(worktree, "package.json"))) {
    const cloned = existsSync(join(REPO, "node_modules")) && (await run(["cp", "-cR", join(REPO, "node_modules"), join(worktree, "node_modules")], REPO, {}, TIMEOUTS.install)).ok;
    const r = cloned ? undefined : await run(["bun", "install", "--frozen-lockfile"], worktree, {}, TIMEOUTS.install);
    touch(task, {}, cloned ? "node_modules cloned from the main checkout" : r!.ok ? "bun install: done" : `bun install failed:\n${r!.all}`);
  }
}

/** Previews told to stop, still to be killed if they haven't (a restart waits for these). */
const stopping = new Set<number>();

function stopPreview(task: Task) {
  if (!task.preview) return;
  const { pid } = task.preview;
  killGroup(pid, 5000);
  stopping.add(pid);
  setTimeout(() => stopping.delete(pid), 5500);
  touch(task, { preview: undefined, previewUp: false }, "Preview stopped");
}

/** Stops the preview and waits (TIMEOUTS.stop) until its whole process group is gone: whether it is. */
async function stopPreviewAndWait(task: Task) {
  const pid = task.preview?.pid;
  stopPreview(task);
  if (!pid) return true;
  for (const end = Date.now() + TIMEOUTS.stop * 1000; groupAlive(pid) && Date.now() < end; ) await Bun.sleep(100);
  return !groupAlive(pid);
}

/** The processes (but this one) whose working directory is in `dir`: [pid, command]. */
async function processesIn(dir: string): Promise<[number, string][]> {
  const dirs = [dir, ...(() => { try { const real = realpathSync(dir); return real == dir ? [] : [real]; } catch { return []; } })()]; // lsof says /private/var/..., not /var/...
  const inside = (path: string) => dirs.some((d) => path == d || path.startsWith(d + "/"));
  const r = await run(["lsof", "-n", "-w", "-d", "cwd", "-F", "pn"], "/", {}, 30);
  const pids: number[] = [];
  let pid = 0;
  for (const line of r.out.split("\n")) {
    if (line[0] == "p") pid = Number(line.slice(1));
    else if (line[0] == "n" && pid && pid != process.pid && inside(line.slice(1))) pids.push(pid);
  }
  if (!pids.length) return [];
  const ps = await run(["ps", "-o", "pid=,command=", "-p", pids.join(",")], "/", {}, 10);
  return ps.out.split("\n").map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean).map((m) => [Number(m![1]), m![2]]);
}

/**
 * Before any merge work in a task's worktree: its preview stopped, and anything else still running there (a dev
 * server, a build or a test an agent left behind) stopped too, so nothing in the worktree waits on it. Logged.
 */
async function quietWorktree(task: Task) {
  if (task.preview && !(await stopPreviewAndWait(task))) touch(task, {}, `The preview didn't stop in ${TIMEOUTS.stop}s`);
  await stopLeftovers(task);
}

/** Stops whatever still runs in the task's worktree (SIGTERM, then SIGKILL after TIMEOUTS.stop), and logs it. */
async function stopLeftovers(task: Task) {
  if (!task.worktree || !existsSync(task.worktree)) return;
  const left = await processesIn(task.worktree);
  if (!left.length) return;
  for (const [pid] of left) try { process.kill(pid, "SIGTERM"); } catch {}
  for (const end = Date.now() + TIMEOUTS.stop * 1000; left.some(([pid]) => alive(pid)) && Date.now() < end; ) await Bun.sleep(100);
  for (const [pid] of left) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
  touch(task, {}, `Stopped ${left.length} process${left.length == 1 ? "" : "es"} left running in the worktree: ${left.map(([pid, cmd]) => `${pid} (${cmd.slice(0, 80)})`).join(", ")}`);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Runs the preview in its own process group, so it outlives this server and stops as one. */
async function startPreview(task: Task, command = PREVIEW, path = "/") {
  if (!task.worktree || !task.port) throw new Error("task has no worktree or port");
  stopPreview(task);
  if (!(await portFree(task.port))) throw new Error(`port ${task.port} is in use: stop what's on it first (lsof -i :${task.port})`);
  const out = openSync(join(LOGS, `task-${task.id}-preview.log`), "a");
  const child = spawnDetached("bash", ["-lc", command], { cwd: task.worktree, detached: true, stdio: ["ignore", out, out], env: { ...process.env, PORT: String(task.port) } });
  child.unref();
  const url = `http://localhost:${task.port}${path.startsWith("/") ? path : "/" + path}`;
  touch(task, { preview: { pid: child.pid!, command }, url: task.url ?? url }, `Preview started: ${command} (pid ${child.pid}, log data/logs/task-${task.id}-preview.log)`);
}

/** Is anything answering on the task's port (within `ms`)? */
async function answers(port: number, ms: number) {
  for (const end = Date.now() + ms; ; await Bun.sleep(250)) {
    if (await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(1500) }).then(() => true, () => false)) return true;
    if (Date.now() > end) return false;
  }
}

/**
 * Live mode, in one step: the task marked live (and working), its dev server running with live reload (started
 * unless one with that command already runs), and its Chrome window open on it: launched, or brought back to the
 * front on the dev server if it's still open. Records the window on the task.
 */
async function goLive(task: Task, path = "/", command = LIVE) {
  if (!task.worktree || !task.port) throw new Error("task has no worktree or port");
  if (!task.live || task.status == "queued") touch(task, { live: true, ...(task.status == "queued" ? { status: "working" as Status } : {}) }, "Live: worked on in a session with the user");
  const page = `http://localhost:${task.port}${path.startsWith("/") ? path : "/" + path}`;
  const gone = (pid: number) => { try { process.kill(-pid, 0); return false; } catch { return true; } };
  if (task.preview && (task.preview.command != command || gone(task.preview.pid))) {
    stopPreview(task);
    for (let i = 0; i < 40 && !(await portFree(task.port)); i++) await Bun.sleep(250); // the old one letting go
  }
  if (!task.preview) {
    if (await answers(task.port, 0)) touch(task, {}, `Something already answers on ${task.port}: using it as the dev server`);
    else await startPreview(task, command, path);
  }
  if (!(await answers(task.port, 120_000))) throw new Error(`the dev server didn't answer on ${task.port} (log: data/logs/task-${task.id}-preview.log)`);
  touch(task, { previewUp: true, url: page });
  if (await chrome.alive(task.chrome)) {
    const target = await chrome.reattach(task.chrome!, page);
    touch(task, { chrome: { ...task.chrome!, target }, chromeUp: true }, `Chrome window brought back (DevTools port ${task.chrome!.port})`);
  } else {
    const c = await chrome.launch(join(DATA, "chrome", `task-${task.id}`), page);
    touch(task, { chrome: c, chromeUp: true }, `Chrome window opened on ${page} (pid ${c.pid}, DevTools port ${c.port})`);
  }
}

/** Closes a live task's Chrome window. */
async function closeChrome(task: Task) {
  if (!task.chrome) return;
  await chrome.close(task.chrome);
  touch(task, { chromeUp: false }, "Chrome window closed");
}

/** Is anything answering on each live task's port? Shown on the board. */
async function checkPreviews() {
  for (const t of store.tasks) {
    if (!t.port || ["merged", "discarded"].includes(t.status)) continue;
    const up = await fetch(`http://localhost:${t.port}/`, { redirect: "manual", signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
    if (up != !!t.previewUp) { t.previewUp = up; save(); }
    if (t.chrome) { const open = await chrome.alive(t.chrome); if (open != !!t.chromeUp) { t.chromeUp = open; save(); } }
  }
}
setInterval(checkPreviews, 4000);

// ---- main's history: the board's Branches column --------------------------

/** How many of main's latest commits the board shows, and how far back done tasks are matched to their merge commits. */
const SHOWN = 25, MATCHED = 200;

interface Commit { sha: string; short: string; subject: string; at: string; task?: number; remote: boolean }
interface History {
  /** The latest SHOWN commits on main's first-parent line (its merges and direct commits), newest first. */
  commits: Commit[];
  /** Each done task's merge commit among main's latest MATCHED: its place (0 = newest) and whether origin has it (on the branch main goes to). */
  tasks: Record<number, { sha: string; short: string; index: number; remote: boolean }>;
  /** Commits on main that origin's branch doesn't have yet, and the other way round. */
  unpushed: number;
  behind: number;
  origin: boolean;
  /** The branch on origin main is pushed to (staging, for Erga), and its head. */
  originBranch: string;
  main?: string;
  originMain?: string;
  /** When main goes to another branch: commits on origin's branch that origin's main (production) doesn't have yet. */
  unreleased?: number;
  /** The last push to origin, and the last release ({at, commit, ok, said}). */
  pushed?: Outcome;
  released?: Outcome;
  /** Signing in to origin: a link someone must open to approve this machine, or why it failed. */
  login?: Login;
}
interface Outcome { at: string; commit?: string; ok: boolean; said: string }
interface Login { approve_url?: string; user_code?: string; expires?: string; error?: string }

let history: History = { commits: [], tasks: {}, unpushed: 0, behind: 0, origin: false, originBranch: MAIN };
let historyKey = "";
let pushed: Outcome | undefined, released: Outcome | undefined;

const ref = async (name: string) => (await run(["git", "rev-parse", "-q", "--verify", name], REPO)).out || undefined;
const hasOrigin = async () => (await run(["git", "remote", "get-url", "origin"], REPO)).ok;

/** The branch on origin that main goes to: remote.origin.push's refs/heads/main:refs/heads/<branch>, else main. */
async function pushBranch(): Promise<string> {
  const specs = (await run(["git", "config", "--get-all", "remote.origin.push"], REPO)).out.split("\n");
  for (const s of specs) { const m = s.trim().match(new RegExp(`^\\+?(?:refs/heads/)?${MAIN}:(?:refs/heads/)?(.+)$`)); if (m) return m[1]; }
  return MAIN;
}

/** Reads main and origin's branch again when either moved, and sends the board the new history. */
async function refreshHistory() {
  const branch = await pushBranch();
  const [main, originMain, originProd] = await Promise.all([ref(`refs/heads/${MAIN}`), ref(`refs/remotes/origin/${branch}`), branch == MAIN ? undefined : ref(`refs/remotes/origin/${MAIN}`)]);
  const login = readLogin();
  const key = JSON.stringify([branch, main, originMain, originProd, pushed, released, login]);
  if (key == historyKey) return;
  const log = main ? (await run(["git", "log", "--first-parent", `-n${MATCHED}`, "--format=%H%x1f%h%x1f%cI%x1f%s", main], REPO)).out : "";
  const unpushed = new Set(originMain && main ? (await run(["git", "rev-list", "--first-parent", `${originMain}..${main}`], REPO)).out.split("\n").filter(Boolean) : []);
  const behind = originMain && main ? Number((await run(["git", "rev-list", "--first-parent", "--count", `${main}..${originMain}`], REPO)).out) || 0 : 0;
  const unreleased = originMain && originProd ? Number((await run(["git", "rev-list", "--count", `${originProd}..${originMain}`], REPO)).out) || 0 : undefined;
  const commits: Commit[] = log.split("\n").filter(Boolean).map((line) => {
    const [sha, short, at, subject] = line.split("\x1f");
    // The queue's merges say whose they are ("Merge task/7-...: title"); else the commit the queue recorded.
    const id = subject.match(/^Merge (?:branch ')?task\/(\d+)-/)?.[1];
    const task = id ? Number(id) : store.tasks.find((t) => t.commit && sha.startsWith(t.commit))?.id;
    return { sha, short, at, subject, task, remote: !!originMain && !unpushed.has(sha) };
  });
  const tasks: History["tasks"] = {};
  commits.forEach((c, index) => { if (c.task != null && !(c.task in tasks)) tasks[c.task] = { sha: c.sha, short: c.short, index, remote: c.remote }; });
  historyKey = key;
  history = { commits: commits.slice(0, SHOWN), tasks, unpushed: originMain ? unpushed.size : commits.length, behind, origin: !!originMain, originBranch: branch, main, originMain,
    ...(unreleased != undefined ? { unreleased } : {}), ...(pushed ? { pushed } : {}), ...(released ? { released } : {}), ...(login ? { login } : {}) };
  broadcast("history", history);
}

// One read at a time, each after the last: a refresh asked for after a merge reads the merge, never an older read's answer.
let reading = Promise.resolve(), pending = 0;
const refresh = () => { pending++; return (reading = reading.then(refreshHistory).catch(() => {}).finally(() => pending--)); };
refresh();
setInterval(() => { if (!pending) refresh(); }, 1500);

// ---- origin: setting it up, signing in, fetching ----------------------------

/** Git talking to origin: never a prompt; the credential helper says where to approve this machine in LOGIN_NOTICE. */
const ORIGIN_ENV = { GIT_TERMINAL_PROMPT: "0", ERGA_LOGIN_NOTICE: LOGIN_NOTICE };
async function originGit(args: string[], { cachedOnly = false } = {}) {
  return run(["git", ...args], REPO, { ...ORIGIN_ENV, ...(cachedOnly ? { ERGA_CREDENTIAL_CACHED_ONLY: "1" } : {}) }, TIMEOUTS.origin);
}

let loginError = "";
function readLogin(): Login | undefined {
  try { return JSON.parse(readFileSync(LOGIN_NOTICE, "utf8")); } catch {}
  return loginError ? { error: loginError } : undefined;
}

/** TASK_QUEUE_LOGIN, one at a time (it may wait for someone to approve this machine): whether Git can now sign in to origin. */
let loggingIn: Promise<boolean> | null = null, loginAt = 0, loginTimedOut: Ran | undefined;
function login(): Promise<boolean> {
  if (!LOGIN) return Promise.resolve(true);
  return (loggingIn ??= (async () => {
    loginAt = Date.now();
    const r = await run(["bash", "-c", LOGIN], REPO, ORIGIN_ENV, TIMEOUTS.login);
    loginTimedOut = r.timedOut ? r : undefined;
    loginError = r.ok ? "" : r.timedOut ? `the sign-in timed out after ${TIMEOUTS.login}s` : (r.all.split("\n").filter(Boolean).at(-1) ?? `exit ${r.code}`);
    if (!r.ok) console.log(`origin login failed: ${r.timedOut ? loginError + "\n" : ""}${r.all}`);
    rmSync(LOGIN_NOTICE, { force: true });
    refresh();
    return r.ok;
  })().finally(() => { loggingIn = null; }));
}

/** Why origin isn't set up yet (logged once per reason). */
let originWaits = "";
let originReady = !ORIGIN_URL;

/**
 * Points the main checkout's origin at ORIGIN_URL, once no merge is running or waiting and the checkout is clean on
 * main: the old origin becomes OLD_ORIGIN (kept, a mirror), main pushes to PUSH_TO there, and Git signs in to it
 * with ORIGIN_HELPER only (no other credential helper for that host). Only remote and credential config changes.
 * Runs inside mergeLock. Whether origin is ready.
 */
async function ensureOrigin(): Promise<boolean> {
  if (!ORIGIN_URL) return true;
  const say = (why: string) => { if (why != originWaits) console.log(`origin: ${why}`); originWaits = why; };
  const current = await run(["git", "remote", "get-url", "origin"], REPO);
  if (current.out != ORIGIN_URL) {
    if (store.tasks.some((t) => t.status == "merging")) { say("a task is merging: setting origin up after it"); return false; }
    const head = (await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], REPO)).out;
    if (head != MAIN) { say(`${REPO} is on ${head}, not ${MAIN}: setting origin up once it's back on ${MAIN}`); return false; }
    if ((await run(["git", "status", "--porcelain", "--untracked-files=no"], REPO)).out) { say(`${REPO} has uncommitted changes: setting origin up once it's clean`); return false; }
    if (current.ok) {
      if ((await run(["git", "remote", "get-url", OLD_ORIGIN], REPO)).ok) await git(REPO, "remote", "remove", "origin");
      else await git(REPO, "remote", "rename", "origin", OLD_ORIGIN);
    }
    await git(REPO, "remote", "add", "origin", ORIGIN_URL);
    say(`origin is now ${ORIGIN_URL}${current.ok ? ` (it was ${current.out}: that's ${OLD_ORIGIN} now)` : ""}`);
  }
  if (PUSH_TO && (await pushBranch()) != PUSH_TO) {
    await run(["git", "config", "--unset-all", "remote.origin.push"], REPO);
    await git(REPO, "config", "remote.origin.push", `refs/heads/${MAIN}:refs/heads/${PUSH_TO}`);
  }
  const site = httpOrigin(ORIGIN_URL);
  if (ORIGIN_HELPER && site) {
    const key = `credential.${site}.helper`;
    if (Bun.spawnSync(["git", "config", "--get-all", key], { cwd: REPO }).stdout.toString() != `\n${ORIGIN_HELPER}\n`) {
      await run(["git", "config", "--unset-all", key], REPO);
      await git(REPO, "config", "--add", key, ""); // no other helper for this host: it would keep an ended token
      await git(REPO, "config", "--add", key, ORIGIN_HELPER);
    }
  }
  originWaits = "";
  return true;
}

/** Fetches origin; main then tracks origin's branch. cachedOnly: only with a token Git has already (background fetches). */
async function fetchOriginNow(cachedOnly: boolean) {
  const f = await originGit(["fetch", "-q", "--prune", "origin"], { cachedOnly });
  if (f.ok) {
    const branch = await pushBranch();
    if ((await run(["git", "config", "branch." + MAIN + ".remote"], REPO)).out != "origin" && (await ref(`refs/remotes/origin/${branch}`)))
      await run(["git", "branch", `--set-upstream-to=origin/${branch}`, MAIN], REPO);
  }
  return f;
}

/** What a push's output says that matters: origin's own lines ("remote: ..."), and why it failed. */
const pushSaid = (p: { ok: boolean; all: string }) => p.all.split("\n").map((l) => l.trim())
  .filter((l) => l.startsWith("remote:") || (!p.ok && /^(!|error:|fatal:)/.test(l))).map((l) => l.replace(/^remote:\s*/, "")).filter(Boolean).join(" ");

/** Pushes main to origin's branch: what origin said (Erga: "remote: Erga: staging is now ..."). */
async function pushMain(): Promise<Outcome> {
  const branch = await pushBranch();
  const commit = (await ref(`refs/heads/${MAIN}`))?.slice(0, 12);
  const p = await originGit(["push", "origin", `refs/heads/${MAIN}:refs/heads/${branch}`]);
  const said = p.timedOut ? `the push timed out after ${TIMEOUTS.origin}s: ${pushSaid(p) || tail(p.all, 3)}` : pushSaid(p) || (p.ok ? `origin's ${branch} is at ${commit}` : "the push failed");
  pushed = { at: new Date().toISOString(), commit, ok: p.ok, said };
  console.log(`push ${MAIN} -> origin/${branch}: ${said}`);
  return pushed;
}

/**
 * Between merges (TASK_QUEUE_FETCH): sets origin up if it isn't yet, fetches it (with a token Git already has: a
 * background fetch never makes one), and pushes main when it's a queue merge that origin's branch doesn't have but
 * could take as a fast-forward (its push failed, or the queue restarted before it, as after merging its own code).
 */
async function fetchOrigin({ cachedOnly = true } = {}) {
  if (!originReady) {
    originReady = await ensureOrigin();
    if (!originReady) return;
    cachedOnly = false;
  }
  if (!(await hasOrigin())) return;
  if (!cachedOnly && !(await login())) return;
  const f = await fetchOriginNow(cachedOnly);
  await refresh();
  if (!f.ok) return;
  const branch = await pushBranch(), main = await ref(`refs/heads/${MAIN}`), there = await ref(`refs/remotes/origin/${branch}`);
  const subject = main ? (await run(["git", "log", "-1", "--format=%s", main], REPO)).out : "";
  if (!main || main == there || !/^Merge task\//.test(subject)) return;
  if (there && !(await run(["git", "merge-base", "--is-ancestor", there, main], REPO)).ok) return;
  // Refused already: again, but not more often than every five fetches.
  if (cachedOnly && pushed && !pushed.ok && pushed.commit == main.slice(0, 12) && Date.now() - Date.parse(pushed.at) < 5 * FETCH_EVERY * 1000) return;
  if (cachedOnly && !(await login())) return;
  await pushMain();
  await fetchOriginNow(true);
  await refresh();
}
if (FETCH_EVERY > 0) setInterval(() => {
  // A sign-in that failed (nobody approved it in time): again every 15 minutes, outside the lock, so the board keeps a live link.
  if (LOGIN && loginError && !loggingIn && Date.now() - loginAt > 15 * 60_000) login();
  locked(() => fetchOrigin());
}, FETCH_EVERY * 1000);

/** POST /api/release: origin's main to its staging head (or to `commit`, one of staging's commits): a fast-forward, never forced. */
async function release(commit?: string): Promise<Outcome> {
  const branch = await pushBranch();
  const done = (ok: boolean, said: string, c?: string): Outcome => { released = { at: new Date().toISOString(), commit: c?.slice(0, 12), ok, said }; console.log(`release: ${said}`); refresh(); return released; };
  if (branch == MAIN) return done(false, `main goes straight to origin's ${MAIN}: there's nothing to release`);
  if (!(await hasOrigin())) return done(false, "no origin");
  if (!(await login())) return done(false, `couldn't sign in to origin: ${loginError}`);
  const f = await fetchOriginNow(false);
  if (!f.ok) return done(false, `couldn't fetch origin: ${f.all}`);
  const target = commit ? (await run(["git", "rev-parse", "-q", "--verify", `${commit}^{commit}`], REPO)).out : await ref(`refs/remotes/origin/${branch}`);
  if (!target) return done(false, commit ? `not a commit here: ${commit}` : `origin has no ${branch}`);
  const tip = await ref(`refs/remotes/origin/${branch}`);
  if (!tip || !(await run(["git", "merge-base", "--is-ancestor", target, tip], REPO)).ok) return done(false, `${target.slice(0, 12)} isn't on origin's ${branch}`);
  const prod = await ref(`refs/remotes/origin/${MAIN}`);
  if (prod == target || (prod && (await run(["git", "merge-base", "--is-ancestor", target, prod], REPO)).ok)) return done(true, `origin's ${MAIN} has ${target.slice(0, 12)} already`, target);
  const p = await originGit(["push", "origin", `${target}:refs/heads/${MAIN}`]);
  await fetchOriginNow(true);
  const said = p.timedOut ? `the push timed out after ${TIMEOUTS.origin}s` : pushSaid(p);
  return done(p.ok, said || (p.ok ? `origin's ${MAIN} is at ${target.slice(0, 12)}` : "the push failed"), target);
}

// ---- screenshots ----------------------------------------------------------

function removeShot(file: string) {
  rmSync(join(SHOTS, basename(file)), { force: true });
}

function shotName(task: Task, ext = ".png") {
  return `task-${task.id}-${task.screenshots.length + 1}-${Date.now().toString(36)}${ext}`;
}

/**
 * A headless Chrome screenshot of a URL, `wait` ms after it loads (no
 * interaction: for that, take it yourself, e.g. with tests/cdp.ts, and upload it).
 */
async function capture(url: string, file: string, { width = 1280, height = 800, wait = 1500, fullPage = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "tq-chrome-"));
  const chrome = Bun.spawn([CHROME, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check", "--hide-scrollbars", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  let ws: WebSocket | undefined, timer: Timer | undefined;
  try {
    // The whole screenshot within TIMEOUTS.screenshot: else Chrome is killed (below) and it fails.
    const limit = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`the screenshot timed out after ${TIMEOUTS.screenshot}s`)), TIMEOUTS.screenshot * 1000); });
    await Promise.race([limit, (async () => {
      let port = 0;
      for (let i = 0; i < 200 && !port; i++) {
        await Bun.sleep(50);
        try { port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {}
      }
      if (!port) throw new Error("Chrome did not start");
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
      ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((ok, no) => { ws!.onopen = ok; ws!.onerror = no; });
      let seq = 0;
      const pending = new Map<number, (r: any) => void>();
      let loaded: () => void;
      const load = new Promise<void>((r) => (loaded = r));
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.method == "Page.loadEventFired") loaded();
        pending.get(msg.id)?.(msg);
      };
      const send = (method: string, params = {}) => new Promise<any>((ok, no) => {
        const id = ++seq;
        pending.set(id, (m) => (m.error ? no(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
        ws!.send(JSON.stringify({ id, method, params }));
      });
      await send("Page.enable");
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
      const nav = await send("Page.navigate", { url });
      if (nav.errorText) throw new Error(`couldn't load ${url}: ${nav.errorText}`);
      await Promise.race([load, Bun.sleep(15000)]);
      await Bun.sleep(wait);
      const size = fullPage ? (await send("Page.getLayoutMetrics")).cssContentSize : undefined;
      const { data } = await send("Page.captureScreenshot", { format: "png", ...(size ? { captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } } : {}) });
      await Bun.write(file, Buffer.from(data, "base64"));
    })()]);
  } finally {
    clearTimeout(timer);
    ws?.close();
    chrome.kill("SIGKILL");
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 2000);
  }
}

// ---- merging --------------------------------------------------------------

let mergeLock = Promise.resolve();
/** Runs `fn` on mergeLock, after what's queued there; an error is logged and doesn't stop the work queued after it. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = mergeLock.then(fn);
  mergeLock = p.then(() => {}, (e) => { console.log(`error: ${(e as Error).message}`); });
  return p;
}
// Origin at start: set it up if need be, sign in (maybe waiting for an approval, outside the lock, so merges can queue),
// fetch, and push a merge origin's branch doesn't have yet (a restart after merging the queue's own code).
locked(async () => {
  originReady = await ensureOrigin();
  if (originReady && (await hasOrigin())) login().then((ok) => { if (ok) locked(() => fetchOrigin({ cachedOnly: false })); });
});

/** Merges `ref` into the worktree's branch. A conflict (or any failure) aborts it, and the task goes to its agent. */
async function mergeInto(task: Task, ref: string) {
  const wt = task.worktree!;
  const r = await run(["git", "merge", "--no-edit", ref], wt);
  if (r.timedOut) throw timeoutError(`git merge ${ref}`, r, TIMEOUTS.git);
  if (r.ok) { if (!r.out.includes("Already up to date")) touch(task, {}, `Merged ${ref} into ${task.branch}`); return; }
  const conflicted = (await run(["git", "diff", "--name-only", "--diff-filter=U"], wt)).out.split("\n").filter(Boolean);
  if (!conflicted.length) throw new NeedsAgent(`git merge ${ref}`, `git merge ${ref} failed`, tail(r.all));
  throw new NeedsAgent(`git merge ${ref}`, `conflicts merging ${ref}: ${conflicted.join(", ")}`, tail(r.all), conflicted);
}

/** TASK_QUEUE_CHECK in the worktree, within TIMEOUTS.check: a failure or a timeout goes to the task's agent. */
async function runCheck(task: Task) {
  if (!CHECK) return;
  touch(task, {}, `Check: ${CHECK}`);
  const r = await run(["bash", "-c", CHECK], task.worktree!, task.port ? { PORT: String(task.port) } : {}, TIMEOUTS.check);
  writeFileSync(join(LOGS, `task-${task.id}-check.log`), r.all);
  if (r.timedOut) throw timeoutError(`the check (${CHECK})`, r, TIMEOUTS.check);
  if (!r.ok) throw new NeedsAgent("check", `the check failed (${CHECK}: exit ${r.code}; log data/logs/task-${task.id}-check.log)`, tail(r.all));
  touch(task, {}, `Check passed in ${r.seconds}s`);
}

/**
 * The merge, on mergeLock. Its worktree quiet first (preview and leftovers stopped); then origin's branch and main
 * into the task's branch, the check, the branch into main, the push and the clean-up. If anything in the task's
 * worktree needs work (uncommitted changes, a conflict, a failed check) or any step times out, the worktree goes
 * back to the branch's last commit and the task to its agent (needs-agent), which fixes it and runs tq continue.
 * Anything else (a dependency not merged, the main checkout off main) goes back to complete with the reason.
 */
async function merge(task: Task) {
  touch(task, { mergeStartedAt: new Date().toISOString() }, "Merging");
  const wt = task.worktree!;
  const preview = task.preview?.command;
  let from: string | undefined, inMain = false;
  try {
    // A dependency that hasn't merged (its merge, queued ahead of this one, failed; or one added meanwhile).
    const waiting = mergeTimeRefusal(task);
    if (waiting) throw new Error(waiting);
    if (!wt || !existsSync(wt)) throw new Error("the task's worktree is gone");
    const head = await git(REPO, "rev-parse", "--abbrev-ref", "HEAD");
    if (head != MAIN) throw new Error(`${REPO} is on ${head}, not ${MAIN}: switch it back to merge`);
    await quietWorktree(task);
    if ((await run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], wt)).ok) throw new NeedsAgent("unfinished merge", "the worktree is in the middle of a merge: finish it (commit) or abort it");
    const dirty = await git(wt, "status", "--porcelain", "--untracked-files=no");
    if (dirty) throw new NeedsAgent("uncommitted changes", `uncommitted changes in the worktree: ${changedFiles(dirty)}`, dirty);
    from = await git(wt, "rev-parse", "HEAD");
    touch(task, { mergeFrom: from });
    if (!originReady) originReady = await ensureOrigin();
    const origin = await hasOrigin(), branch = await pushBranch();
    // Origin's branch (Erga's staging: also a merge on /source, a factory task) and main into the branch first, where
    // conflicts can be settled by the task's agent, away from the main checkout...
    if (origin) {
      if (!(await login())) {
        if (loginTimedOut) throw timeoutError("origin sign-in (TASK_QUEUE_LOGIN)", loginTimedOut, TIMEOUTS.login);
        throw new Error(`couldn't sign in to origin: ${loginError || "see data/server.log"}`);
      }
      const f = await fetchOriginNow(false);
      if (f.timedOut) throw timeoutError("git fetch origin", f, TIMEOUTS.origin);
      if (!f.ok) throw new Error(`git fetch origin failed:\n${f.all}`);
      if (await ref(`refs/remotes/origin/${branch}`)) await mergeInto(task, `origin/${branch}`);
    }
    await mergeInto(task, MAIN);
    await runCheck(task);
    // ...so merging the branch into main can't conflict, and pushing it is a fast-forward.
    const into = await run(["git", "merge", "--no-ff", "-m", `Merge ${task.branch}: ${task.title}\n\nTask ${task.id} from the task queue.`, task.branch!], REPO);
    if (!into.ok) {
      await run(["git", "merge", "--abort"], REPO);
      if (into.timedOut) throw timeoutError(`git merge ${task.branch} into ${MAIN}`, into, TIMEOUTS.git);
      throw new Error(`git merge ${task.branch} into ${MAIN} failed (aborted):\n${into.all}`);
    }
    inMain = true;
    const commit = await git(REPO, "rev-parse", "--short", "HEAD");
    await refresh(); // on the board at once, as not pushed yet
    // To origin's branch (Erga: staging, which deploys staging.erga.dev by itself). A refused (or timed out) push undoes
    // nothing: the merge is in main, the log says why, and it's pushed again between merges (fetchOrigin) or with the next one.
    const p = origin ? await pushMain() : undefined;
    if (origin) await fetchOriginNow(true);
    touch(task, { status: "merged", commit, mergedAt: new Date().toISOString(), mergeFrom: undefined, needsAgent: undefined, error: undefined },
      `Merged into ${MAIN} as ${commit}${!p ? "" : p.ok ? ` and pushed to origin's ${branch}: ${p.said}` : `, but origin's ${branch} didn't take it: ${p.said}`}`);
    tellDependents(task);
    await refresh();
    await cleanUp(task, false);
    console.log(`#${task.id} merged as ${commit}`);
    const changed = codeChangedSinceLastLook();
    if (changed.length) { restartWanted = true; console.log(`#${task.id} changed the queue's code (${changed.join(", ")}): restarting once nothing else is merging`); }
  } catch (e) {
    const err = e as Error;
    if (inMain) { touch(task, {}, `After the merge: ${err.message}`); return; }
    // The worktree back on the branch's last commit: no half-done merge, none of the queue's merge commits.
    if (from && existsSync(wt)) {
      await run(["git", "merge", "--abort"], wt);
      const reset = await run(["git", "reset", "-q", "--hard", from], wt);
      if (!reset.ok) touch(task, {}, `Couldn't put the worktree back on ${from.slice(0, 12)}: ${reset.all}`);
    }
    if (err instanceof NeedsAgent) {
      const needsAgent: NeedsAgentInfo = { step: err.step, reason: err.message, at: new Date().toISOString(), ...(err.output ? { output: err.output } : {}), ...(err.files ? { files: err.files } : {}) };
      touch(task, { status: "needs-agent", error: err.message, needsAgent, mergeFrom: undefined },
        `Needs agent: ${err.message}. ${task.agent ? `Its agent (${task.agent}) fixes it in the worktree` : "No agent is recorded: a new one fixes it in the worktree"}, then runs tq continue ${task.id}.${err.output ? `\n${tail(err.output, 20)}` : ""}`);
    } else touch(task, { status: "complete", error: err.message, mergeFrom: undefined }, `Merge failed: ${err.message}`);
    // The preview back, so the user can still look at the work (the agent stops it if it gets in its way).
    if (preview && existsSync(wt)) await startPreview(task, preview).catch((x) => touch(task, {}, `Preview not restarted: ${(x as Error).message}`));
  }
}

// ---- restarting when the queue's own code changes ---------------------------

/** Files the server, the board or tq run: everything here but docs, the Claude Code mod, the tests and the sample, and the data. */
const isQueueCode = (file: string) => !/\.md$/i.test(file) && !/^(mod|data)(\/|$)/.test(file) && !["test.ts", "sample.ts", ".gitignore"].includes(file);

/** The queue's code files in this directory, each with a hash of its content. */
function codeFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of readdirSync(HERE).sort()) {
    if (!isQueueCode(f)) continue;
    try { if (statSync(join(HERE, f)).isFile()) files[f] = Bun.hash(readFileSync(join(HERE, f))).toString(36); } catch {}
  }
  return files;
}
const differ = (a: Record<string, string>, b: Record<string, string>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] != b[f]).sort();
/** What this server runs: its code files' hashes when it started, and a version made of them. */
const startedWith = codeFiles();
const CODE_VERSION = Bun.hash(JSON.stringify(startedWith)).toString(36);
let lastSeen = startedWith;
/** The queue's code files that changed since the last look. */
function codeChangedSinceLastLook() {
  const now = codeFiles(), changed = differ(lastSeen, now);
  lastSeen = now;
  return changed;
}

let restartWanted = false, restartForced = false, restarting = false, inFlight = 0;

// The code changed on disk some other way (a commit, a pull, an edit in the main checkout): the same. Not while a
// merge runs: a merge says itself whether it changed the code.
setInterval(() => {
  if (restarting || store.tasks.some((t) => t.status == "merging")) return;
  const changed = codeChangedSinceLastLook();
  if (!changed.length) return;
  console.log(`the queue's code changed (${changed.join(", ")}): restarting once nothing is merging`);
  restartWanted = true;
  locked(restartIfWanted);
}, 3000);

/**
 * Runs after every merge (on mergeLock), and when the code changes: once the queue's code has changed and nothing
 * is merging, waits for requests in flight and previews being stopped, checks the new code builds, then starts a
 * fresh server and exits.
 */
async function restartIfWanted() {
  if (!restartWanted || restarting || store.tasks.some((t) => t.status == "merging")) return;
  // Changed back to what this server runs (say, a broken edit undone): nothing to restart for.
  if (!restartForced && !differ(startedWith, codeFiles()).length) { restartWanted = false; return; }
  restarting = true;
  const out = mkdtempSync(join(tmpdir(), "tq-build-"));
  const built = await run([process.execPath, "build", join(HERE, "server.ts"), "--target=bun", `--outdir=${out}`], HERE, {}, TIMEOUTS.build);
  rmSync(out, { recursive: true, force: true });
  if (!built.ok) {
    console.log(`not restarting: the new code doesn't build${built.timedOut ? ` (timed out after ${TIMEOUTS.build}s)` : ""}; still running the old code (pid ${process.pid}):\n${tail(built.all, 20)}`);
    restartWanted = restartForced = restarting = false;
    return;
  }
  for (let i = 0; i < 300 && (inFlight > 0 || stopping.size); i++) await Bun.sleep(100);
  if (store.tasks.some((t) => t.status == "merging")) { restarting = false; return; } // one was asked for meanwhile: after it
  console.log(`restarting with the new code (pid ${process.pid})`);
  save();
  const log = openSync(join(DATA, "server.log"), "a");
  spawnDetached(process.execPath, [join(HERE, "server.ts")], { cwd: process.cwd(), detached: true, stdio: ["ignore", log, log], env: { ...process.env, TASK_QUEUE_RESTARTED_FROM: String(process.pid) } }).unref();
  for (const c of clients) try { c.close(); } catch {}
  process.exit(0);
}

/** Stops the preview and removes the worktree and branch (force: even unmerged, for a discarded task). */
async function cleanUp(task: Task, force: boolean) {
  await stopPreviewAndWait(task);
  await closeChrome(task);
  await stopLeftovers(task); // nothing left running in a folder about to go
  if (task.worktree && existsSync(task.worktree)) {
    const r = await run(["git", "worktree", "remove", "--force", task.worktree], REPO);
    touch(task, {}, r.ok ? "Worktree removed" : `Couldn't remove worktree: ${r.all}`);
  }
  if (task.branch) {
    const r = await run(["git", "branch", force ? "-D" : "-d", task.branch], REPO);
    touch(task, {}, r.ok ? `Branch ${task.branch} deleted` : `Couldn't delete branch: ${r.all}`);
  }
}

// ---- HTTP -----------------------------------------------------------------

const API = {
  about: "Local task queue for agents working in this repo. Every task gets a branch, a worktree and a preview port; the board at / updates live.",
  cli: "development/task-queue/tq (run it with no arguments for its commands); it starts this server when it isn't running. Screenshots: tq shot ID URL-or-FILE [caption] [--replace] (--replace removes the old ones first), tq unshot ID FILE|INDEX, tq unshot ID --all",
  statuses: {
    queued: "registered, not started",
    working: "an agent is on it",
    complete: "done and tested, waiting for the user to merge (also where a merge that failed for a reason outside the worktree lands, with error)",
    merging: "being merged: the worktree quieted (preview stopped), origin's branch and main into the branch, TASK_QUEUE_CHECK, then the branch into main, pushed and cleaned up; set by POST /api/tasks/:id/merge (or .../continue), ends merged, needs-agent, or back at complete with error",
    "needs-agent": "the merge stopped and waits for the task's own agent (agent): a conflict, uncommitted changes, a failed check, or a step that timed out. needsAgent {step, reason, output, files, at} says what; the worktree is back on the branch's last commit. The agent fixes it in the worktree, commits, and POST /api/tasks/:id/continue (tq continue ID) merges again. Merge is off meanwhile",
    merged: "in main and pushed (on its merge commit in the board's Branches column)",
    failed: "the agent couldn't finish (see error)",
    discarded: "dropped by the user",
  },
  board: `http://localhost:${PORT}/`,
  pid: process.pid,
  live: "a live task (live: true) is worked on in a session with the user, not by a background worker: POST /api/tasks/:id/live runs its dev server with live reload and opens a Chrome window of its own on it (chrome: {pid, port, profile, target}); GET /api/tasks/:id/look says what that window shows; merge and discard stop both",
  restart: "when the queue's own code changes on disk (a merge, or anything else), it restarts itself (new pid) once nothing is merging and the new code builds; tasks and previews carry on. POST /api/restart asks for one",
  running: { version: CODE_VERSION, get stale() { return differ(startedWith, codeFiles()); } },
  agent: "a task records the agent doing it (agent: the Agent tool's agent id; PATCH {agent}, tq start ID --agent AGENT, tq agent ID AGENT). The same agent keeps the task until it merges: when the merge needs work (needs-agent), the outer agent wakes that agent (SendMessage to it), and only starts a new one if it is gone",
  timeouts: Object.fromEntries(Object.entries(TIMEOUTS).map(([k, v]) => [k, `${v}s (TASK_QUEUE_TIMEOUT_${k.toUpperCase()})`])),
  dependencies: {
    startAfter: "task ids: don't start this task until they are merged. PATCH status working (tq start) and POST /live answer 409, with the reason, until then",
    mergeAfter: "task ids: don't merge this task until they are merged. POST /merge (the board's Merge, tq merge) answers 409 until then; the startAfter tasks count too. A merge may be asked for while the dependencies are merging (queued ahead of it); if one of them doesn't merge, this merge fails back to complete with the reason",
    blockedBy: "computed on every read and event, absent when nothing blocks the task: {start: startAfter ids not merged (queued tasks only), merge: startAfter and mergeAfter ids not merged, stuck: those discarded or failed, reason: e.g. 'waiting for #12 to merge', 'can't merge until #12 merges', 'blocked: #12 was discarded; remove or change the dependency'}",
    rules: "set them in POST /api/tasks or change them with PATCH (a list of ids, or null / [] to clear; not while merging or once done). Each id must be another task that isn't discarded; a cycle is refused (400). When a dependency merges, its dependents' logs say so and the tasks event fires; tq watch prints '#14 unblocked: title (#12 merged)'. A discarded or failed dependency blocks its dependents until someone removes or changes it",
  },
  columns: { Queued: ["queued"], Working: ["working", "failed"], "Needs agent": ["needs-agent"], "Ready to merge": ["complete"], Merging: ["merging"], Branches: "main's latest commits (GET /api/history): a merged task shows on its merge commit; older merged tasks and discarded ones aren't shown" },
  endpoints: {
    "GET /api": "this description",
    "GET /api/tasks[?status=complete]": "all tasks, oldest first",
    "GET /api/tasks/:id": "one task",
    "POST /api/tasks {title, description?, worktree?: true, live?: false, startAfter?: [ids], mergeAfter?: [ids]}": "register a task: makes branch task/<id>-<slug> and worktree .claude/worktrees/task-<id> from main (node_modules cloned from the main checkout) and assigns a preview port. live marks it a live task; startAfter and mergeAfter are its dependencies (see dependencies). Returns the task.",
    "PATCH /api/tasks/:id {status?, url?, summary?, error?, title?, description?, live?, agent?, startAfter?, mergeAfter?, message?}": `update a task; status is one of ${AGENT_STATUSES.join(", ")} (working is refused, 409, while a startAfter task isn't merged); agent records the agent doing it (see agent); startAfter and mergeAfter replace its dependencies (see dependencies); message is appended to its log`,
    "POST /api/tasks/:id/log {message}": "append a progress line to the task's log",
    "POST /api/tasks/:id/preview {command?, path?}": `start the task's preview server in its worktree with $PORT set (default command: ${PREVIEW}); it outlives the agent and is stopped on merge. Sets url to http://localhost:<port><path> unless url is already set.`,
    "DELETE /api/tasks/:id/preview": "stop the preview server",
    "POST /api/tasks/:id/live {path?, command?}": `live mode: marks the task live (and working), runs its dev server with live reload (default command: ${LIVE}) unless that already runs, waits for it to answer, and opens a Chrome window of its own (own profile and DevTools port) on http://localhost:<port><path>, or brings the open one back to the front. Records it as chrome {pid, port, profile, target}. Returns the task.`,
    "GET /api/tasks/:id/look[?shot=1][&console=1]": "what the live task's Chrome window shows: {url, title, target, tabs, selection?, console? (errors and warnings; everything with console=1), screenshot?: a PNG's path (with shot=1)}",
    "POST /api/tasks/:id/screenshots": "attach a screenshot: a raw image body (Content-Type image/png, ?caption=...), or JSON {path, caption?} (a file on disk), or JSON {url, caption?, width?, height?, wait?: ms after load, fullPage?} (the queue takes it with headless Chrome)",
    "DELETE /api/tasks/:id/screenshots/:file": "remove one screenshot (by its file name, or its 1-based index) and delete its file; any status but merging",
    "DELETE /api/tasks/:id/screenshots": "remove all the task's screenshots and delete their files (for a fresh pass); any status but merging",
    "POST /api/tasks/:id/merge": "for a complete (or failed) task whose dependencies are merged (else 409 with the reason; dependencies that are merging, ahead of it, are fine): status merging at once (202), then, in the background and one merge at a time: stop the task's preview and anything else running in its worktree, merge origin's branch and main into the branch, run TASK_QUEUE_CHECK there if set, merge the branch into main, push main to origin's branch (see origin), and remove the worktree and branch: status merged. A conflict, uncommitted changes, a failed check or a step that times out (see timeouts) puts the worktree back on the branch's last commit and the task in needs-agent; any other failure goes back to complete with error. Watch the task.",
    "POST /api/tasks/:id/continue": "for a needs-agent task, once its agent has fixed what stopped the merge and committed (409 while the worktree has uncommitted changes or an unfinished merge): the merge runs again, as POST .../merge (202, merging)",
    "POST /api/restart": "restart the queue with the code on disk, once nothing is merging (202)",
    "POST /api/tasks/:id/discard": "drop the task: stops its preview (and a live task's Chrome window), removes its worktree and deletes its branch",
    "GET /api/history": `main's history, for the board's Branches column: {commits: the latest ${SHOWN} on main's first-parent line, newest first, each {sha, short, subject, at, task?: the task whose merge it is, remote: whether origin's branch has it}, tasks: {id: {sha, short, index, remote}} for tasks merged in main's latest ${MATCHED}, unpushed, behind, origin, originBranch: the branch on origin main is pushed to, unreleased?: commits on it that origin's main lacks, pushed?, released?: the last push and release {at, commit, ok, said}, login?: {approve_url, user_code, expires} while signing in to origin waits for someone to approve this machine, or {error}}. Origin is fetched every ${FETCH_EVERY || "(never)"}s (TASK_QUEUE_FETCH).`,
    "POST /api/release {commit?}": "moves origin's main to its branch's head (or to commit, one of that branch's commits): for Erga, production (erga.dev) to staging. A fast-forward, never forced, and never part of a merge: only when someone asks. Answers {ok, said, commit}",
    "GET /api/events": "server-sent events: a `version` event (the board's own, which reloads when it changes), a `tasks` event with every task and a `history` event with GET /api/history, on connect and on each change",
  },
};

/** Merging: status merging at once, the merge itself queued on mergeLock, one at a time, in the order asked for. */
function enqueueMerge(task: Task, message: string) {
  const ahead = store.tasks.filter((t) => t.status == "merging").map((t) => `#${t.id}`);
  touch(task, { status: "merging", error: undefined, needsAgent: undefined }, ahead.length ? `${message}: waiting for ${ahead.join(", ")} to merge first` : message);
  mergeLock = mergeLock.then(() => merge(task)).then(restartIfWanted);
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, error: string) => json({ error }, status);
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const refused = foreign(req, PORT);
  if (refused) return fail(403, refused);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const m = path.match(/^\/api\/tasks\/(\d+)(?:\/(\w+)(?:\/([^/]+))?)?$/);
  const task = m ? find(Number(m[1])) : undefined;
  const action = m?.[2];
  const sub = m?.[3] && decodeURIComponent(m[3]);
  if (sub && action != "screenshots") return fail(404, `no route ${req.method} ${path} (GET /api lists them)`);
  if (m && !task) return fail(404, `no task ${m[1]}`);
  // JSON only when it says so exactly (a page's "text/plain;x=json" would skip the browser's preflight).
  const body = async () => (/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "") ? await req.json() : {}) as Record<string, any>;

  if (path == "/" && req.method == "GET") return new Response(Bun.file(join(HERE, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
  if (path == "/api" && req.method == "GET") return json(API);
  if (path == "/api/history" && req.method == "GET") { await refresh(); return json(history); }
  if (path == "/api/restart" && req.method == "POST") {
    restartWanted = restartForced = true;
    console.log("restart asked for (POST /api/restart)");
    locked(restartIfWanted);
    return json({ restarting: true, pid: process.pid, after: store.tasks.filter((t) => t.status == "merging").map((t) => t.id) }, 202);
  }
  if (path == "/api/release" && req.method == "POST") {
    const { commit } = await body();
    const r = await locked(() => release(typeof commit == "string" && commit ? commit : undefined)).catch((e) => ({ at: new Date().toISOString(), ok: false, said: (e as Error).message }) as Outcome);
    return json(r, r.ok ? 200 : 409);
  }
  if (path.startsWith("/shots/") && req.method == "GET") {
    const file = join(SHOTS, basename(path));
    return existsSync(file) ? new Response(Bun.file(file)) : fail(404, "no such screenshot");
  }
  if (path == "/api/events") {
    let ctrl: ReadableStreamDefaultController;
    let beat: Timer;
    return new Response(new ReadableStream({
      start(c) {
        ctrl = c; clients.add(c);
        // The board's version first: a board from older code reloads itself (say, after a restart with new code).
        const version = Bun.hash(readFileSync(join(HERE, "index.html"))).toString(36);
        c.enqueue(encoder.encode(`retry: 1000\nevent: version\ndata: ${JSON.stringify(version)}\n\nevent: tasks\ndata: ${JSON.stringify(store.tasks)}\n\nevent: history\ndata: ${JSON.stringify(history)}\n\n`));
        beat = setInterval(() => { try { c.enqueue(encoder.encode(": beat\n\n")); } catch { clearInterval(beat); } }, 15000);
      },
      cancel() { clients.delete(ctrl); clearInterval(beat); },
    }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }
  if (path == "/api/tasks" && req.method == "GET") {
    const status = url.searchParams.get("status");
    return json(status ? store.tasks.filter((t) => t.status == status) : store.tasks);
  }
  if (path == "/api/tasks" && req.method == "POST") {
    const b = await body();
    if (!b.title || typeof b.title != "string") return fail(400, "title is required");
    const deps = depChanges(b);
    if (typeof deps == "string") return fail(400, deps);
    const now = new Date().toISOString();
    const t: Task = { id: store.nextId++, title: b.title.trim(), description: String(b.description ?? "").trim(), status: "queued", screenshots: [], log: [], createdAt: now, updatedAt: now, ...(b.live ? { live: true } : {}), ...deps };
    store.tasks.push(t);
    touch(t, {}, "Registered" + depsNote(t));
    if (b.worktree !== false) {
      try { t.port = await freePort(); await setUpWorktree(t); } catch (e) {
        touch(t, { status: "failed", error: (e as Error).message }, `Couldn't set up: ${(e as Error).message}`);
        return json(t, 500);
      }
    }
    return json(t, 201);
  }
  if (task && !action && req.method == "GET") return json(task);
  if (task && !action && req.method == "PATCH") {
    const b = await body();
    if (b.status && !AGENT_STATUSES.includes(b.status)) return fail(400, `status must be one of ${AGENT_STATUSES.join(", ")} (merging, merged and discarded come from POST /api/tasks/:id/merge and /discard)`);
    if (["merging", "merged", "discarded"].includes(task.status) && b.status) return fail(409, `task ${task.id} is ${task.status}`);
    const depsAsked = "startAfter" in b || "mergeAfter" in b;
    if (depsAsked && ["merging", "merged", "discarded"].includes(task.status)) return fail(409, `task ${task.id} is ${task.status}: its dependencies can't change`);
    const deps = depChanges(b, task);
    if (typeof deps == "string") return fail(400, deps);
    if (b.status == "working" && task.status != "working") {
      const why = startRefusal(task, "startAfter" in deps ? deps.startAfter : task.startAfter);
      if (why) return fail(409, why);
    }
    const changes: Partial<Task> = { ...deps };
    for (const k of ["status", "url", "summary", "error", "title", "description"] as const) if (k in b) (changes as any)[k] = b[k] ?? undefined;
    if ("live" in b) changes.live = !!b.live || undefined;
    if ("agent" in b) changes.agent = b.agent ? String(b.agent).trim() : undefined;
    if (b.status && b.status != "failed" && !("error" in b)) changes.error = undefined;
    if (b.status && task.status == "needs-agent") changes.needsAgent = undefined;
    const was = task.status;
    const message = [b.message ?? (b.status && b.status != task.status ? `Status: ${b.status}` : undefined), "agent" in b && changes.agent != task.agent ? `Agent: ${changes.agent ?? "none"}` : undefined, depsAsked ? `Dependencies: ${depsNote({ ...task, ...changes }).replace(/^ \(|\)$/g, "") || "none"}` : undefined].filter(Boolean).join("; ");
    touch(task, changes, message || undefined);
    if (task.status == "failed" && was != "failed") tellDependents(task);
    return json(task);
  }
  if (task && action == "log" && req.method == "POST") {
    const { message } = await body();
    if (!message) return fail(400, "message is required");
    touch(task, {}, String(message));
    return json(task);
  }
  if (task && action == "preview" && req.method == "POST") {
    const b = await body();
    try { await startPreview(task, b.command || PREVIEW, b.path || "/"); } catch (e) { return fail(409, (e as Error).message); }
    return json(task);
  }
  if (task && action == "preview" && req.method == "DELETE") { stopPreview(task); return json(task); }
  if (task && action == "live" && req.method == "POST") {
    if (["merging", "merged", "discarded"].includes(task.status)) return fail(409, `task ${task.id} is ${task.status}`);
    if (task.status == "queued" && unmetStart(task).length) return fail(409, `task ${task.id} can't start: ${task.blockedBy?.reason ?? `waiting for ${ids(unmetStart(task))} to merge`}`);
    const b = await body();
    try { await goLive(task, b.path || "/", b.command || LIVE); } catch (e) { touch(task, {}, `Live mode: ${(e as Error).message}`); return fail(500, (e as Error).message); }
    return json(task);
  }
  if (task && action == "look" && req.method == "GET") {
    if (!(await chrome.alive(task.chrome))) return fail(409, `task ${task.id} has no Chrome window open: tq live ${task.id} opens one`);
    const shot = url.searchParams.get("shot") ? join(LOOKS, `task-${task.id}-${Date.now().toString(36)}.png`) : undefined;
    try { return json(await chrome.look(task.chrome!, { shot, console: !!url.searchParams.get("console") })); } catch (e) { return fail(500, (e as Error).message); }
  }
  if (task && action == "screenshots" && req.method == "DELETE") {
    if (task.status == "merging") return fail(409, `task ${task.id} is merging`);
    if (!sub) {
      const n = task.screenshots.length;
      for (const s of task.screenshots.splice(0)) removeShot(s.file);
      touch(task, {}, n ? `Screenshots removed (${n})` : undefined);
      return json(task);
    }
    // A 1-based index (as tq lists them), or the file name.
    const i = /^\d+$/.test(sub) ? Number(sub) - 1 : task.screenshots.findIndex((s) => s.file == sub);
    const shot = task.screenshots[i];
    if (!shot) return fail(404, `task ${task.id} has no screenshot ${sub}`);
    task.screenshots.splice(i, 1);
    removeShot(shot.file);
    touch(task, {}, `Screenshot removed: ${shot.caption ?? shot.file}`);
    return json(task);
  }
  if (task && action == "screenshots" && req.method == "POST") {
    const type = req.headers.get("content-type") ?? "";
    let file: string, caption: string | undefined;
    try {
      if (type.startsWith("image/")) {
        file = shotName(task, Object.entries(TYPES).find(([, t]) => t == type.split(";")[0])?.[0] ?? ".png");
        await Bun.write(join(SHOTS, file), await req.arrayBuffer());
        caption = url.searchParams.get("caption") ?? undefined;
      } else {
        const b = await body();
        caption = b.caption;
        if (b.path) {
          if (!existsSync(b.path)) return fail(400, `no file at ${b.path}`);
          file = shotName(task, extname(b.path) || ".png");
          copyFileSync(resolve(b.path), join(SHOTS, file));
        } else if (b.url) {
          file = shotName(task);
          await capture(b.url, join(SHOTS, file), { width: b.width, height: b.height, wait: b.wait, fullPage: b.fullPage });
        } else return fail(400, "send an image body, or JSON with path or url");
      }
    } catch (e) { return fail(500, (e as Error).message); }
    task.screenshots.push({ file, caption });
    touch(task, {}, `Screenshot: ${caption ?? file}`);
    return json(task);
  }
  if (task && action == "merge" && req.method == "POST") {
    if (task.status == "merging") return fail(409, `task ${task.id} is already merging`);
    if (task.status == "needs-agent") return fail(409, `task ${task.id} needs its agent: ${task.error}. The agent fixes it and runs tq continue ${task.id}`);
    if (!["complete", "failed"].includes(task.status) && !(task.status == "working" && url.searchParams.has("force"))) return fail(409, `task ${task.id} is ${task.status}, not complete`);
    if (!task.branch) return fail(409, "task has no branch");
    // Its dependencies merged, or merging now (queued ahead of it, checked again when its turn comes).
    const why = mergeRefusal(task);
    if (why) return fail(409, why);
    enqueueMerge(task, "Merge requested");
    return json(task, 202);
  }
  if (task && action == "continue" && req.method == "POST") {
    if (task.status != "needs-agent") return fail(409, `task ${task.id} is ${task.status}: tq continue is for a task whose merge waits for its agent (needs-agent)`);
    const why = mergeRefusal(task);
    if (why) return fail(409, why);
    if (!task.worktree || !existsSync(task.worktree)) return fail(409, "the task's worktree is gone");
    if ((await run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], task.worktree)).ok) return fail(409, `${task.worktree} is in the middle of a merge: commit it (or abort it) first`);
    const dirty = (await run(["git", "status", "--porcelain", "--untracked-files=no"], task.worktree)).out;
    if (dirty) return fail(409, `${task.worktree} has uncommitted changes (${changedFiles(dirty)}): commit them first`);
    enqueueMerge(task, `Continued${task.agent ? ` by its agent (${task.agent})` : ""}: merging again`);
    return json(task, 202);
  }
  if (task && action == "discard" && req.method == "POST") {
    if (["merging", "merged"].includes(task.status)) return fail(409, `task ${task.id} is ${task.status}`);
    touch(task, { status: "discarded" }, "Discarded");
    tellDependents(task);
    await cleanUp(task, true);
    return json(task);
  }
  return fail(404, `no route ${req.method} ${path} (GET /api lists them)`);
}

/** Requests in flight (a restart waits for them), but not the event streams, which stay open. */
async function counted(req: Request) {
  if (new URL(req.url).pathname == "/api/events") return handle(req);
  inFlight++;
  try { return await handle(req); } catch (e) { return fail(500, (e as Error).message); } finally { inFlight--; }
}

Bun.serve({ port: PORT, hostname: "127.0.0.1", idleTimeout: 0, fetch: counted });
console.log(`task queue on http://localhost:${PORT}  (repo ${REPO}, data ${DATA}, pid ${process.pid})${restartedFrom ? `, restarted from pid ${restartedFrom}` : ""}`);

#!/usr/bin/env bun
// The task queue: a local board of the work agents are doing in this repo.
//
//   bun development/task-queue/server.ts      (or let ./tq start it)
//
// Each task gets its own branch and worktree (.claude/worktrees/task-<id>),
// a port for its preview server, and a card on the board at
// http://localhost:4700 that moves Queued → Working → Ready to merge →
// Merged as the agent doing it reports in. Merge (on the board, or
// POST /api/tasks/:id/merge) merges main into the task's branch, has
// `claude -p` resolve any conflicts there, merges the branch into main and
// pushes. GET /api describes the whole API; AGENTS.md says how to use it.
//
// Its state is data/tasks.json (and data/screenshots/, data/logs/), beside
// this file in the main checkout, whichever worktree it's started from.
//
// Settings, all optional: TASK_QUEUE_PORT (4700), TASK_QUEUE_REPO (the repo
// this file is in), TASK_QUEUE_DATA, TASK_QUEUE_PREVIEW (the default preview
// command), TASK_QUEUE_RESOLVER (a shell command that resolves a conflicted
// merge in its cwd, given the instructions in $PROMPT; `claude -p` if unset),
// TASK_QUEUE_INSTALL=0 (don't set up node_modules in new worktrees).

import { spawn as spawnDetached } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const HERE = import.meta.dir;
const PORT = Number(process.env.TASK_QUEUE_PORT ?? 4700);
const MAIN = "main";
const REPO = process.env.TASK_QUEUE_REPO ?? dirname(gitSync(HERE, "rev-parse", "--path-format=absolute", "--git-common-dir"));
const DATA = process.env.TASK_QUEUE_DATA ?? join(REPO, "development/task-queue/data");
const SHOTS = join(DATA, "screenshots");
const LOGS = join(DATA, "logs");
const WORKTREES = join(REPO, ".claude/worktrees");
const PREVIEW = process.env.TASK_QUEUE_PREVIEW ?? "bun start --port $PORT --no-open";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
for (const dir of [SHOTS, LOGS]) mkdirSync(dir, { recursive: true });

type Status = "queued" | "working" | "complete" | "merging" | "merged" | "failed" | "discarded";
/** What an agent may set; the rest the queue sets itself (merge, discard). */
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
  error?: string;
  commit?: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
}

// ---- state ----------------------------------------------------------------

const STORE = join(DATA, "tasks.json");
const store: { nextId: number; tasks: Task[] } = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { nextId: 1, tasks: [] };
const clients = new Set<ReadableStreamDefaultController>();
const encoder = new TextEncoder();

function save() {
  writeFileSync(STORE + ".tmp", JSON.stringify(store, null, 2));
  renameSync(STORE + ".tmp", STORE);
  const msg = encoder.encode(`event: tasks\ndata: ${JSON.stringify(store.tasks)}\n\n`);
  for (const c of clients) try { c.enqueue(msg); } catch { clients.delete(c); }
}

function touch(task: Task, changes: Partial<Task> = {}, message?: string) {
  Object.assign(task, changes, { updatedAt: new Date().toISOString() });
  if (message) task.log.push({ at: task.updatedAt, message });
  save();
}

const find = (id: number) => store.tasks.find((t) => t.id == id);

// ---- git and processes ----------------------------------------------------

function gitSync(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (r.exitCode != 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { ok: code == 0, out: out.trim(), err: err.trim(), all: (out + err).trim() };
}

async function git(cwd: string, ...args: string[]) {
  const r = await run(["git", ...args], cwd);
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
    const cloned = existsSync(join(REPO, "node_modules")) && (await run(["cp", "-cR", join(REPO, "node_modules"), join(worktree, "node_modules")], REPO)).ok;
    const r = cloned ? undefined : await run(["bun", "install", "--frozen-lockfile"], worktree);
    touch(task, {}, cloned ? "node_modules cloned from the main checkout" : r!.ok ? "bun install: done" : `bun install failed:\n${r!.all}`);
  }
}

function stopPreview(task: Task) {
  if (!task.preview) return;
  try { process.kill(-task.preview.pid, "SIGTERM"); } catch {}
  const { pid } = task.preview;
  setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 5000);
  touch(task, { preview: undefined, previewUp: false }, "Preview stopped");
}

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

/** Is anything answering on each live task's port? Shown on the board. */
async function checkPreviews() {
  for (const t of store.tasks) {
    if (!t.port || ["merged", "discarded"].includes(t.status)) continue;
    const up = await fetch(`http://localhost:${t.port}/`, { redirect: "manual", signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
    if (up != !!t.previewUp) { t.previewUp = up; save(); }
  }
}
setInterval(checkPreviews, 4000);

// ---- screenshots ----------------------------------------------------------

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
  let ws: WebSocket | undefined;
  try {
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
  } finally {
    ws?.close();
    chrome.kill();
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 2000);
  }
}

// ---- merging --------------------------------------------------------------

let mergeLock = Promise.resolve();

const resolverPrompt = (task: Task, ref: string) => `You are resolving a git merge conflict in ${task.worktree}, on branch ${task.branch}.
${ref} was merged into the branch and some files conflict. The branch's task:

  ${task.title}
  ${task.description}

Resolve every conflict so that both the branch's work and ${ref}'s changes are kept and work together
(read both sides' commits: git log --oneline --left-right HEAD...MERGE_HEAD). Then run the tests that
cover the files involved (see AGENTS.md; ./test.sh for the whole suite) and fix what fails. Finally
\`git add\` the resolved files and \`git commit --no-edit\` to conclude the merge. Do not push, do not
touch any other checkout, and do not abort the merge.`;

/** Merges `ref` into the worktree's branch, having the resolver settle any conflicts. */
async function mergeInto(task: Task, ref: string) {
  const wt = task.worktree!;
  const r = await run(["git", "merge", "--no-edit", ref], wt);
  if (r.ok) { if (!r.out.includes("Already up to date")) touch(task, {}, `Merged ${ref} into ${task.branch}`); return; }
  const conflicted = await git(wt, "diff", "--name-only", "--diff-filter=U");
  if (!conflicted) throw new Error(`git merge ${ref} failed:\n${r.all}`);
  touch(task, {}, `Conflicts merging ${ref}: ${conflicted.split("\n").join(", ")}. Resolving with ${process.env.TASK_QUEUE_RESOLVER ? "TASK_QUEUE_RESOLVER" : "claude -p"}…`);
  const prompt = resolverPrompt(task, ref);
  const res = process.env.TASK_QUEUE_RESOLVER
    ? await run(["bash", "-c", process.env.TASK_QUEUE_RESOLVER], wt, { PROMPT: prompt })
    : await run(["claude", "-p", prompt, "--dangerously-skip-permissions"], wt);
  writeFileSync(join(LOGS, `task-${task.id}-resolve.log`), res.all);
  const left = (await run(["git", "diff", "--name-only", "--diff-filter=U"], wt)).out;
  if (left) {
    await run(["git", "merge", "--abort"], wt);
    throw new Error(`Conflicts left unresolved in ${left.split("\n").join(", ")} (resolver log: data/logs/task-${task.id}-resolve.log). Merge aborted.`);
  }
  if ((await run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], wt)).ok) await git(wt, "commit", "--no-edit");
  touch(task, {}, `Conflicts resolved (log: data/logs/task-${task.id}-resolve.log)`);
}

async function merge(task: Task) {
  touch(task, { status: "merging", error: undefined }, "Merge requested");
  try {
    const wt = task.worktree;
    if (!wt || !existsSync(wt)) throw new Error("the task's worktree is gone");
    if (await git(wt, "status", "--porcelain", "--untracked-files=no")) throw new Error(`${wt} has uncommitted changes: commit them (or ask the task's agent to) and merge again`);
    const head = await git(REPO, "rev-parse", "--abbrev-ref", "HEAD");
    if (head != MAIN) throw new Error(`${REPO} is on ${head}, not ${MAIN}: switch it back to merge`);
    const origin = (await run(["git", "remote", "get-url", "origin"], REPO)).ok;
    // Main (local and pushed) into the branch first, where conflicts can be settled away from the main checkout...
    if (origin) { await git(REPO, "fetch", "origin", MAIN); await mergeInto(task, `origin/${MAIN}`); }
    await mergeInto(task, MAIN);
    // ...so merging the branch into main can't conflict, and pushing it is a fast-forward.
    await git(REPO, "merge", "--no-ff", "-m", `Merge ${task.branch}: ${task.title}\n\nTask ${task.id} from the task queue.`, task.branch!);
    const commit = await git(REPO, "rev-parse", "--short", "HEAD");
    if (origin) await git(REPO, "push", "origin", MAIN);
    touch(task, { status: "merged", commit, mergedAt: new Date().toISOString() }, `Merged into ${MAIN} as ${commit}${origin ? " and pushed" : ""}`);
    await cleanUp(task, false);
  } catch (e) {
    touch(task, { status: "complete", error: (e as Error).message }, `Merge failed: ${(e as Error).message}`);
  }
}

/** Stops the preview and removes the worktree and branch (force: even unmerged, for a discarded task). */
async function cleanUp(task: Task, force: boolean) {
  stopPreview(task);
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
  board: `http://localhost:${PORT}/`,
  cli: "development/task-queue/tq (run it with no arguments for its commands); it starts this server when it isn't running",
  statuses: { queued: "registered, not started", working: "an agent is on it", complete: "done and tested, waiting for the user to merge", merging: "being merged", merged: "in main and pushed", failed: "the agent couldn't finish (see error)", discarded: "dropped by the user" },
  endpoints: {
    "GET /api": "this description",
    "GET /api/tasks[?status=complete]": "all tasks, oldest first",
    "GET /api/tasks/:id": "one task",
    "POST /api/tasks {title, description?, worktree?: true}": "register a task: makes branch task/<id>-<slug> and worktree .claude/worktrees/task-<id> from main (node_modules cloned from the main checkout) and assigns a preview port. Returns the task.",
    "PATCH /api/tasks/:id {status?, url?, summary?, error?, title?, description?, message?}": `update a task; status is one of ${AGENT_STATUSES.join(", ")}; message is appended to its log`,
    "POST /api/tasks/:id/log {message}": "append a progress line to the task's log",
    "POST /api/tasks/:id/preview {command?, path?}": `start the task's preview server in its worktree with $PORT set (default command: ${PREVIEW}); it outlives the agent and is stopped on merge. Sets url to http://localhost:<port><path> unless url is already set.`,
    "DELETE /api/tasks/:id/preview": "stop the preview server",
    "POST /api/tasks/:id/screenshots": "attach a screenshot: a raw image body (Content-Type image/png, ?caption=...), or JSON {path, caption?} (a file on disk), or JSON {url, caption?, width?, height?, wait?: ms after load, fullPage?} (the queue takes it with headless Chrome)",
    "POST /api/tasks/:id/merge": "merge main into the branch (claude -p resolves conflicts), merge the branch into main, push, then remove the worktree and branch. Runs in the background; watch the task.",
    "POST /api/tasks/:id/discard": "drop the task: stops its preview, removes its worktree and deletes its branch",
    "GET /api/events": "server-sent events: a `tasks` event with every task, on connect and on each change",
  },
};

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, error: string) => json({ error }, status);
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const m = path.match(/^\/api\/tasks\/(\d+)(?:\/(\w+))?$/);
  const task = m ? find(Number(m[1])) : undefined;
  const action = m?.[2];
  if (m && !task) return fail(404, `no task ${m[1]}`);
  const body = async () => (req.headers.get("content-type")?.includes("json") ? await req.json() : {}) as Record<string, any>;

  if (path == "/" && req.method == "GET") return new Response(Bun.file(join(HERE, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
  if (path == "/api" && req.method == "GET") return json(API);
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
        c.enqueue(encoder.encode(`retry: 1000\nevent: tasks\ndata: ${JSON.stringify(store.tasks)}\n\n`));
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
    const now = new Date().toISOString();
    const t: Task = { id: store.nextId++, title: b.title.trim(), description: String(b.description ?? "").trim(), status: "queued", screenshots: [], log: [], createdAt: now, updatedAt: now };
    store.tasks.push(t);
    touch(t, {}, "Registered");
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
    if (b.status && !AGENT_STATUSES.includes(b.status)) return fail(400, `status must be one of ${AGENT_STATUSES.join(", ")} (merge and discard have their own endpoints)`);
    if (["merging", "merged", "discarded"].includes(task.status) && b.status) return fail(409, `task ${task.id} is ${task.status}`);
    const changes: Partial<Task> = {};
    for (const k of ["status", "url", "summary", "error", "title", "description"] as const) if (k in b) (changes as any)[k] = b[k] ?? undefined;
    if (b.status && b.status != "failed" && !("error" in b)) changes.error = undefined;
    touch(task, changes, b.message ?? (b.status && b.status != task.status ? `Status: ${b.status}` : undefined));
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
    if (!["complete", "failed"].includes(task.status) && !(task.status == "working" && url.searchParams.has("force"))) return fail(409, `task ${task.id} is ${task.status}, not complete`);
    if (!task.branch) return fail(409, "task has no branch");
    mergeLock = mergeLock.then(() => merge(task));
    task.status = "merging"; save();
    return json(task, 202);
  }
  if (task && action == "discard" && req.method == "POST") {
    if (["merging", "merged"].includes(task.status)) return fail(409, `task ${task.id} is ${task.status}`);
    touch(task, { status: "discarded" }, "Discarded");
    await cleanUp(task, true);
    return json(task);
  }
  return fail(404, `no route ${req.method} ${path} (GET /api lists them)`);
}

Bun.serve({ port: PORT, hostname: "127.0.0.1", idleTimeout: 0, fetch: (req) => handle(req).catch((e) => fail(500, (e as Error).message)) });
console.log(`task queue on http://localhost:${PORT}  (repo ${REPO}, data ${DATA})`);

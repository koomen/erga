#!/usr/bin/env bun
// `task`, outside a VM: how a local agent (Claude Code on the admin's own
// machine, in its own checkout) runs a factory task itself, with no VM, and
// reports on it as a VM's Claude Code does (factory/vm/task.ts). README, The
// factory, "Local tasks"; AGENTS.md, "Two ways to work".
//
//   bun task new "title" "ask" [--start-after 12,13] [--merge-after 14]
//                                   registers a local task on the board, then starts it (below), unless it waits
//   bun task start [ID]             makes the task's branch from Erga's staging (or checks out the one there is), pushes it
//   bun task status                 the task as the board has it: status, what blocks it, instructions waiting
//   bun task log "message"          a progress line on the board
//   bun task inbox [--wait SECONDS] takes the instructions sent from the board (each one once) and prints them;
//                                   --wait polls until some come (or the time is up)
//   bun task shot FILE|URL "caption" [--replace]   a screenshot (headless Chrome for a URL)
//   bun task preview URL            where the change can be seen (a URL the user can open), on the board
//   bun task push                   pushes the branch through Erga's Git endpoint
//   bun task pull [--staging]       brings in the branch's commits from Erga (the factory's merge adds some); --staging
//                                   merges Erga's staging too, and stops at a conflict, for you to resolve
//   bun task done "summary"         pushes, then marks the task ready to merge (refused while instructions wait)
//   bun task fail "why"             marks it failed
//   bun task run [--timeout SECONDS] -- CMD...   a command under a time limit (its whole process tree killed; exit 124)
//
// Settings: the server is ERGA_URL, else `git config erga.url`, else the origin remote when it is an Erga Git
// endpoint (https://erga.dev/git/erga.git). The admin token is ERGA_TOKEN, else the one Git's credential store keeps
// for that server (README, Tokens). The task is FACTORY_TASK, else the branch's (task/<id>-...). The machine's name
// on the board is ERGA_MACHINE, else the host name. Git pushes with a git token the factory makes for the task's
// branch only (POST /api/factory/tasks/<id>/git); the admin token never goes on a command line.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import { localTaskNote } from "./prompt.ts";
import { api, scrub, step } from "./vm/common.ts";
import { shot } from "./vm/task.ts";

/** A local git command (no network), in the current checkout: its output, or "" when it fails. */
const gitOut = (args: string[]) => {
  const r = spawnSync("git", args, { encoding: "utf8", timeout: 30_000 });
  return r.status == 0 ? (r.stdout ?? "").trim() : "";
};

/** git with the task's git token (REPO_TOKEN) as a header, never on the command line, under a time limit (common.ts, step). */
async function git(args: string[], quiet = false) {
  const token = process.env.REPO_TOKEN;
  const auth = token ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` } : {};
  const r = await step(["git", ...args], { name: args[0], timeout: ["fetch", "push", "ls-remote"].includes(args[0]) ? 120 : 60, cwd: process.cwd(), env: { ...auth, GIT_TERMINAL_PROMPT: "0" } });
  if (r.code != 0 && !quiet) throw new Error(`git ${args[0]} ${r.timedOut ? `timed out after ${r.limit}s` : `failed (exit ${r.code})`}: ${(r.err || r.out).slice(-1500)}`);
  return r;
}

/** The Erga server: ERGA_URL, git config erga.url, or the origin remote's. */
function server(): string {
  const set = process.env.ERGA_URL || gitOut(["config", "--get", "erga.url"]);
  if (set) return set.replace(/\/+$/, "");
  const m = /^(https?:\/\/[^/]+)(?:\/__factory)?\/git\/erga\.git\/?$/.exec(gitOut(["remote", "get-url", "origin"]));
  if (m) return m[1];
  throw new Error("Which Erga server? Set ERGA_URL (e.g. https://erga.dev), or `git config erga.url https://erga.dev`.");
}

/** The admin token: ERGA_TOKEN, or Git's credential store's for the server (never asked for on the terminal). */
function adminToken(origin: string): string {
  if (process.env.ERGA_TOKEN) return process.env.ERGA_TOKEN.trim();
  const u = new URL(origin);
  const r = spawnSync("git", ["credential", "fill"], { input: `protocol=${u.protocol.slice(0, -1)}\nhost=${u.host}\n\n`, encoding: "utf8", timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" } });
  const password = /^password=(.*)$/m.exec(r.stdout ?? "")?.[1]?.trim();
  if (password?.startsWith("erga_")) return password;
  throw new Error(`No admin token: set ERGA_TOKEN, or keep one in Git's credential store for ${u.host} (README, Tokens). Make one at ${origin}/tokens (scope: admin).`);
}

/** The task: FACTORY_TASK, or the branch's number (task/<id>-...). */
function taskOfBranch(): number {
  if (process.env.FACTORY_TASK) return Number(process.env.FACTORY_TASK);
  const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
  const m = /^task\/(\d+)-/.exec(branch);
  if (!m) throw new Error(`This checkout is on ${branch || "no branch"}, not a task's branch (task/<id>-...): run \`task start ID\`, or set FACTORY_TASK.`);
  return Number(m[1]);
}

/** The factory's API as common.ts's api() reaches it: FACTORY_API, FACTORY_TOKEN (the admin token here), FACTORY_TASK. */
function connect(id?: number) {
  const origin = server();
  process.env.FACTORY_API = `${origin}/api/factory`;
  process.env.FACTORY_TOKEN = adminToken(origin);
  if (id != null) process.env.FACTORY_TASK = String(id);
  return origin;
}

type Task = { id: number; title: string; status: string; branch: string; local: { by: string; machine: string } | null; handedFrom: string | null; blockedBy?: { reason: string; start: number[] }; waiting?: number; error: string | null; url: string | null };

const STATUS: Record<string, string> = { complete: "ready to merge" };
const describe = (t: Task) => `#${t.id} ${t.title}: ${STATUS[t.status] ?? t.status}` +
  (t.local ? ` (a local task, run by ${t.local.by} on ${t.local.machine})` : t.handedFrom ? ` (handed to a VM: not yours any more)` : " (a VM's task)") +
  (t.blockedBy ? `\n  ${t.blockedBy.reason}` : "") + (t.waiting ? `\n  ${t.waiting} instruction${t.waiting == 1 ? "" : "s"} from the board wait${t.waiting == 1 ? "s" : ""}: task inbox` : "") +
  (t.error ? `\n  error: ${t.error}` : "") + (t.url ? `\n  preview: ${t.url}` : "") + `\n  branch: ${t.branch}`;

/** The task's git token and where the repository is (POST .../git): it pushes the task's branch only, for two hours. */
async function gitGrant(): Promise<{ repo: string; branch: string }> {
  const g = await api("/git", { method: "POST" }) as { token: string; repo: string; branch: string };
  process.env.REPO_TOKEN = g.token;
  return g;
}

const dirty = () => gitOut(["status", "--porcelain", "--untracked-files=no"]);

async function register(title: string, description: string, startAfter?: number[], mergeAfter?: number[]) {
  const origin = connect();
  const r = await fetch(`${origin}/api/factory/tasks`, {
    method: "POST", headers: { Authorization: `Bearer ${process.env.FACTORY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title, description, local: { machine: process.env.ERGA_MACHINE || hostname() }, ...(startAfter ? { startAfter } : {}), ...(mergeAfter ? { mergeAfter } : {}) }),
  });
  const t = await r.json().catch(() => ({})) as Task & { error?: string };
  if (!r.ok) throw new Error(`the factory answered ${r.status}: ${t.error ?? ""}`);
  console.log(`Registered task #${t.id}: ${t.title}\nbranch: ${t.branch}\nboard: ${origin}/admin/factory`);
  if (t.status == "queued") {
    console.log(`It waits: ${t.blockedBy?.reason ?? "queued"}. Run \`task start ${t.id}\` when it is working (task status says).`);
    return;
  }
  await start(t.id);
}

async function start(id: number) {
  connect(id);
  const t = await api("") as Task;
  if (!t.local) throw new Error(`Task #${id} isn't a local task${t.handedFrom ? ": it was handed to a VM" : ""}.`);
  if (t.status == "queued") throw new Error(`Task #${id} waits: ${t.blockedBy?.reason ?? "it is queued"}.`);
  if (dirty()) throw new Error("This checkout has uncommitted changes: commit or stash them first.");
  const g = await gitGrant();
  if (gitOut(["rev-parse", "--verify", "--quiet", `refs/heads/${g.branch}`])) {
    await git(["checkout", "--quiet", g.branch]);
    console.log(`On ${g.branch} (it was here already).`);
  } else if ((await git(["ls-remote", g.repo, `refs/heads/${g.branch}`])).out.trim()) {
    await git(["fetch", "--quiet", g.repo, g.branch]);
    await git(["checkout", "--quiet", "-b", g.branch, "FETCH_HEAD"]);
    await api("/log", { json: { message: `Local agent: ${g.branch} checked out at ${gitOut(["rev-parse", "--short", "HEAD"])} in ${basename(process.cwd())} on ${t.local.machine}` } });
    console.log(`On ${g.branch}, as Erga has it.`);
  } else {
    await git(["fetch", "--quiet", g.repo, "staging"]);
    const base = gitOut(["rev-parse", "FETCH_HEAD"]);
    await git(["checkout", "--quiet", "-b", g.branch, base]);
    await git(["push", "--quiet", g.repo, `HEAD:refs/heads/${g.branch}`]);
    await api("/branch", { json: { base } });
    await api("/log", { json: { message: `Local agent: made ${g.branch} from staging at ${base.slice(0, 10)} in ${basename(process.cwd())} on ${t.local.machine}` } });
    console.log(`Made ${g.branch} from Erga's staging at ${base.slice(0, 10)}, and pushed it.`);
  }
  console.log(`\n${localTaskNote({ id, branch: g.branch })}`);
}

/** Pushes the task's branch through Erga's Git endpoint; answers the commit. */
async function push(): Promise<string> {
  const g = await gitGrant();
  const on = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (on != g.branch) throw new Error(`This checkout is on ${on}, not the task's branch ${g.branch}.`);
  const r = await git(["push", "--quiet", g.repo, `HEAD:refs/heads/${g.branch}`], true);
  if (r.code != 0) {
    if (/fetch first|non-fast-forward|stale info|rejected/.test(r.err)) throw new Error(`Erga's ${g.branch} has commits this checkout lacks (the factory's merge may have merged staging into it): run \`task pull\`, then push again.`);
    throw new Error(`git push failed: ${r.err.slice(-1500)}`);
  }
  return gitOut(["rev-parse", "HEAD"]);
}

async function pull(staging: boolean) {
  const g = await gitGrant();
  const on = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (on != g.branch) throw new Error(`This checkout is on ${on}, not the task's branch ${g.branch}.`);
  if (dirty()) throw new Error("This checkout has uncommitted changes: commit them first.");
  for (const [ref, message] of [[g.branch, `Merge ${g.branch} from Erga`], ...(staging ? [["staging", `Merge staging into ${g.branch}`]] : [])]) {
    if (!(await git(["ls-remote", g.repo, `refs/heads/${ref}`])).out.trim()) continue;
    await git(["fetch", "--quiet", g.repo, ref]);
    if ((await git(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], true)).code == 0) { console.log(`${ref}: nothing new`); continue; }
    const m = await git(["merge", "--no-edit", "-m", message, "FETCH_HEAD"], true);
    if (m.code != 0) {
      const files = gitOut(["diff", "--name-only", "--diff-filter=U"]);
      if (files) throw new Error(`Merging Erga's ${ref} conflicts in: ${files.split("\n").join(", ")}. Resolve them, commit, test, then \`task done\`.`);
      throw new Error(`git merge failed: ${(m.err || m.out).slice(-1500)}`);
    }
    console.log(`${ref}: merged`);
  }
}

async function inbox(wait: number) {
  const until = Date.now() + wait * 1000;
  for (;;) {
    const { text } = await api("/inbox", { json: { how: "(task inbox)" } }) as { asks: unknown[]; text?: string };
    if (text) { console.log(`Instructions from the board. Do them now, as part of this task, and keep your work unless they say otherwise; then test, commit and task done.\n\n${text}`); return; }
    if (Date.now() >= until) { console.log("No instructions wait."); return; }
    await Bun.sleep(Math.min(5000, Math.max(0, until - Date.now())));
  }
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };
  const has = (name: string) => { const i = rest.indexOf(name); if (i >= 0) rest.splice(i, 1); return i >= 0; };
  const idList = (v?: string) => v == null ? undefined : v.split(/[,\s]+/).filter(Boolean).map((x) => Number(x.replace(/^#/, "")));
  try {
    switch (cmd) {
      case "new": {
        const startAfter = idList(flag("--start-after")), mergeAfter = idList(flag("--merge-after"));
        if (!rest[0]) throw new Error('say what: task new "title" "ask"');
        await register(rest[0], rest.slice(1).join(" "), startAfter, mergeAfter);
        break;
      }
      case "start": await start(rest[0] ? Number(rest[0].replace(/^#/, "")) : taskOfBranch()); break;
      case "status": connect(taskOfBranch()); console.log(describe(await api("") as Task)); break;
      case "log": connect(taskOfBranch()); await api("/log", { json: { message: rest.join(" ") } }); break;
      case "inbox": { const wait = Number(flag("--wait") ?? 0); connect(taskOfBranch()); await inbox(wait); break; }
      case "shot": { const replace = has("--replace"); connect(taskOfBranch()); await shot(rest[0], rest.slice(1).join(" "), replace); console.log("screenshot added"); break; }
      case "preview": connect(taskOfBranch()); await api("/preview", { json: { url: rest[0] } }); console.log("preview noted on the board"); break;
      case "push": connect(taskOfBranch()); console.log(`pushed ${(await push()).slice(0, 10)}`); break;
      case "pull": { const staging = has("--staging"); connect(taskOfBranch()); await pull(staging); break; }
      case "done": {
        const id = taskOfBranch();
        connect(id);
        if (dirty()) throw new Error("This checkout has uncommitted changes: commit them first.");
        const commit = await push();
        await api("", { method: "PATCH", json: { status: "complete", summary: rest.join(" "), commit } });
        console.log(`task #${id} is ready to merge (or its merge goes on)`);
        break;
      }
      case "fail": connect(taskOfBranch()); await api("", { method: "PATCH", json: { status: "failed", error: rest.join(" ") } }); console.log("marked failed"); break;
      case "run": {
        const t = Number(flag("--timeout") ?? 600);
        const cmdline = rest[0] == "--" ? rest.slice(1) : rest;
        if (!cmdline.length || !(t > 0)) throw new Error("say what to run: task run --timeout SECONDS -- CMD...");
        const r = await step(cmdline, { name: "run", timeout: t, cwd: process.cwd(), echo: true });
        if (r.timedOut) console.error(`task run: ${cmdline.join(" ")} timed out after ${t}s; its processes were killed`);
        process.exit(r.code);
      }
      default: console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1).filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    }
  } catch (e) {
    console.error(`task ${cmd}: ${scrub((e as Error).message)}`);
    process.exit(1);
  }
}

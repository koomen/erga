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
//
// A URL given to `task shot` on localhost is the VM's own (the preview).

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { api, CLONE, env, git, log, REPORTED, TASK } from "./common.ts";

const PORT = () => Number(env("FACTORY_PREVIEW_PORT", "4400"));
const PUBLIC = () => Number(env("FACTORY_PUBLIC_PORT", "4401"));

/** Pushes the task's branch (whatever is committed) and says where it is. */
export function pushBranch(): string {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out;
  if (!branch.startsWith("task/")) throw new Error(`the clone is on ${branch}, not the task's branch`);
  git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
  return git(["rev-parse", "HEAD"]).out;
}

async function up(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; }
}

/** Starts something detached (its own session), so it outlives the job that started it. */
function daemon(cmd: string[], cwd: string, logFile: string, extra: Record<string, string> = {}) {
  // The preview gets none of the job's secrets.
  const { CLAUDE_CODE_OAUTH_TOKEN, REPO_TOKEN, FACTORY_TOKEN, ...rest } = process.env;
  const p = spawn("sh", ["-c", `exec ${cmd.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")} >>'${logFile}' 2>&1`], { cwd, detached: true, stdio: "ignore", env: { ...rest, ...extra } });
  p.unref();
}

export async function preview(path = "/", staticDir?: string) {
  const port = PORT(), pub = PUBLIC();
  if (!(await up(port))) {
    const logFile = join(env("FACTORY_WORK", "/work"), "preview.log");
    if (staticDir) daemon(["bun", import.meta.path, "serve-static", resolve(CLONE(), staticDir), String(port)], CLONE(), logFile);
    else daemon(["bun", "dev.ts", "--port", String(port), "--no-open"], CLONE(), logFile);
    for (let i = 0; i < 600 && !(await up(port)); i++) await Bun.sleep(250);
    if (!(await up(port))) throw new Error(`the preview didn't start: ${readFileSync(logFile, "utf8").slice(-1500)}`);
  }
  // The VM's loopback isn't reachable from outside it: a relay on the public port, when that is another one.
  if (pub != port && !(await up(pub))) {
    daemon(["socat", `TCP-LISTEN:${pub},fork,reuseaddr`, `TCP:127.0.0.1:${port}`], CLONE(), join(env("FACTORY_WORK", "/work"), "relay.log"));
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
      stdio: ["ignore", "ignore", "pipe"],
      // The local simulation gives jobs a HOME of their own, in which Chrome on a Mac hangs: it gets the real one (CHROME_HOME), and its own profile.
      env: process.env.CHROME_HOME ? { ...process.env, HOME: process.env.CHROME_HOME } : process.env,
    });
    let stderr = "", last = -1, settled = false;
    p.stderr.on("data", (c: Buffer) => { stderr = (stderr + c.toString()).slice(-4000); });
    const done = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll); clearTimeout(limit);
      try { p.kill("SIGKILL"); } catch { /* gone */ }
      resolve(/Page load failed[^\n]*/.exec(stderr)?.[0] ?? stderr.slice(-800));
    };
    const poll = setInterval(() => {
      const size = existsSync(file) ? statSync(file).size : -1;
      if (size > 0 && size == last) done();
      last = size;
    }, 300);
    const limit = setTimeout(done, 60_000);
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

export async function done(summary: string) {
  const commit = pushBranch();
  await api("", { method: "PATCH", json: { status: "complete", summary, commit } });
  writeFileSync(REPORTED(), "complete");
}

export async function fail(why: string) {
  await api("", { method: "PATCH", json: { status: "failed", error: why } });
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

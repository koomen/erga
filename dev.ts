#!/usr/bin/env bun
// Local development: erga.dev's app on your machine, the very same Worker
// (worker/index.ts) run by Vite and the Cloudflare plugin, with any file or
// folder from disk as a document.
//
//   bun start [file-or-folder] [--port N] [--no-open] [--reload]
//   bun start --print-url      this checkout's running server's address (from .dev-url), or exit 1
//
// Any number of checkouts (worktrees) run at once, each on a port of its
// own with nothing shared: the main checkout takes 4400, every other one a
// port from its path (4410-4999), the same each time, or the next free one
// if that's taken. --port (or ERGA_PORT) picks one outright. The server
// writes its address to .dev-url once it answers, and removes it on the way
// out. Its state, cache and settings are this checkout's (.cloudflare/,
// .dev.vars), and its cookies are named for its port (worker/cookies.ts).
//
// --reload reloads open tabs by itself when the editor is rebuilt, the
// Worker's code changes or the server restarts (dev/reload.ts), for working
// locally with someone watching (AGENTS.md).
//
// A folder (with index.html or index.md) or a single .html or .md file
// named here is linked to one of your documents and edited where it is:
// edits are written back to it, and changes made to it on disk (another
// editor, git) show up in the page as they happen (dev/plugin.ts). A single
// file is synced on its own, and no other files can be made beside it. More
// can be opened from /docs while it runs. With nothing named, the browser
// opens on your documents.
//
// It builds the editor first, makes .dev.vars if there isn't one (you're
// DEV_LOGIN, signed in without GitHub), checks the settings the deploy fixes
// (server.config.ts), and on the way out has every linked
// document write what it holds to disk before the server stops.

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { deployedSettings } from "./config";
import { resolveTarget } from "./dev/plugin";
import { deployed } from "./server.config";

const EDITOR = import.meta.dir;
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1).filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
// This checkout's server's address, while it runs: for agents and scripts (`bun start --print-url`, or read the file).
const URL_FILE = join(EDITOR, ".dev-url");
if (args.includes("--print-url")) {
  const url = existsSync(URL_FILE) ? readFileSync(URL_FILE, "utf8").trim() : "";
  if (url && await fetch(`${url}/style.css`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false)) { console.log(url); process.exit(0); }
  console.error("No server is running in this checkout: bun start");
  process.exit(1);
}
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const asked = flag("--port") ?? process.env.ERGA_PORT;
const browser = !args.includes("--no-open");
const reload = args.includes("--reload");
const target = args.find((a) => !a.startsWith("--"));

// Fail fast on a target that won't open, before anything starts.
if (target) await resolveTarget(target, process.cwd()).catch((e) => { console.error((e as Error).message); process.exit(2); });
// The settings the deploy fixes (server.config.ts, ERGA_SERVER_CONFIG): a bad one stops here, saying why.
try { deployedSettings(deployed()); } catch (e) { console.error(`server.config.ts: ${(e as Error).message}`); process.exit(2); }
// Tests give each server its own state (ERGA_STATE_DIR); otherwise it's this checkout's, which one server at a time may hold.
const ownState = !process.env.ERGA_STATE_DIR;
if (ownState && existsSync(URL_FILE)) {
  const url = readFileSync(URL_FILE, "utf8").trim();
  if (await fetch(`${url}/style.css`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false)) {
    console.error(`This checkout's server is already running at ${url}`);
    process.exit(2);
  }
}
const port = asked ? Number(asked) : checkoutPort();
if (asked && !free(port)) {
  console.error(`port ${port} is taken: is another server running? Pick another with --port`);
  process.exit(2);
}
// The Worker's debugger (workerd's inspector), beside it: the plugin's own pick (the first free from 9229) races another server starting.
const inspector = process.env.ERGA_INSPECTOR == "0" ? 0 : [port + 10000].find(free) ?? anyFreePort();

// Who you are locally, and what signs your session: .dev.vars, made the first time.
if (!process.env.ERGA_ENV_DIR) ensureDevVars(join(EDITOR, ".dev.vars"));

// Tests build the editor once for all the servers they start (ERGA_BUILT).
if (!process.env.ERGA_BUILT) {
  const built = Bun.spawnSync([join(EDITOR, "site.sh")], { cwd: EDITOR, stdout: "ignore", stderr: "inherit" });
  if (built.exitCode != 0) process.exit(built.exitCode ?? 1);
}

const secret = process.env.ERGA_LINK_SECRET || randomBytes(24).toString("hex");
// No Web Storage in Node (Node 25+ warns when something reaches for it, and nothing here needs it).
const vite = Bun.spawn(["node", "--no-experimental-webstorage", join(EDITOR, "node_modules/vite/bin/vite.js"), "dev", "--port", String(port), "--strictPort"], {
  cwd: EDITOR,
  stdio: ["ignore", "inherit", "inherit"],
  // Its own process group: Ctrl-C comes to us first, so the documents write to disk before it stops.
  detached: true,
  env: {
    ...process.env,
    ERGA_LINK_SECRET: secret,
    ERGA_OPEN: target ?? "",
    ERGA_BROWSER: browser ? "1" : "",
    ERGA_RELOAD: reload ? "1" : "",
    ERGA_CWD: process.cwd(),
    ERGA_PARENT: String(process.pid),
    // Where the Worker finds the dev server's stand-ins for Artifacts and GitHub (dev/git-server.ts).
    ERGA_DEV_ORIGIN: `http://127.0.0.1:${port}`,
    ...(inspector ? { ERGA_INSPECTOR_PORT: String(inspector) } : {}),
  },
});

// The address, once it answers: printed, and in .dev-url for as long as this runs.
const url = `http://localhost:${port}`;
(async () => {
  while (vite.exitCode == null) {
    if (await fetch(`http://127.0.0.1:${port}/style.css`).then((r) => r.ok, () => false)) {
      if (ownState) writeFileSync(URL_FILE, url + "\n");
      console.log(`\n  Erga is running at ${url}${ownState ? " (in .dev-url)" : ""}\n`);
      return;
    }
    await Bun.sleep(100);
  }
})();
const forgetUrl = () => { if (ownState && existsSync(URL_FILE) && readFileSync(URL_FILE, "utf8").trim() == url) rmSync(URL_FILE, { force: true }); };
process.on("exit", forgetUrl);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.race([
    fetch(`http://127.0.0.1:${port}/__erga/flush?link=${secret}`, { method: "POST" }).catch(() => {}),
    Bun.sleep(4000),
  ]);
  vite.kill("SIGTERM");
  const timer = setTimeout(() => vite.kill("SIGKILL"), 5000);
  await vite.exited;
  clearTimeout(timer);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.exit(await vite.exited);

/** Whether nothing listens on `port`, on 127.0.0.1 (the server's) or ::1 (where browsers try localhost first: another server there would answer instead). */
function free(port: number): boolean {
  for (const hostname of ["127.0.0.1", "::1"]) {
    try { Bun.listen({ hostname, port, socket: { data() {} } }).stop(true); } catch (e) {
      if ((e as { code?: string }).code == "EADDRINUSE") return false;
    }
  }
  return true;
}

/** A port the OS says is free now. */
function anyFreePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/**
 * This checkout's port, the same every time: 4400 for the main checkout (.git a folder), else one from its path in
 * 4410-4999 (a worktree, a copy). Taken: the next free one in that range, then any.
 */
function checkoutPort(): number {
  const main = (() => { try { return statSync(join(EDITOR, ".git")).isDirectory(); } catch { return false; } })();
  const first = main ? 4400 : 4410 + createHash("sha1").update(EDITOR).digest().readUInt32BE(0) % 590;
  for (let i = 0; i < 590; i++) {
    const p = first + i > 4999 ? first + i - 590 : first + i;
    if (free(p)) return p;
  }
  return anyFreePort();
}

/** .dev.vars with what local development needs: who you are (DEV_LOGIN) and a session secret. */
function ensureDevVars(file: string) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const has = (key: string) => new RegExp(`^${key}=.+`, "m").test(text);
  const add: string[] = [];
  if (!has("DEV_LOGIN")) {
    const git = (key: string) => Bun.spawnSync(["git", "config", key]).stdout.toString().trim();
    const login = (git("github.user") || git("user.name").split(/\s+/)[0] || process.env.USER || "me").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    add.push(`# Who you are locally: signed in as this login, without GitHub.\nDEV_LOGIN=${login}`);
  }
  if (!has("SESSION_SECRET")) add.push(`SESSION_SECRET=${randomBytes(32).toString("hex")}`);
  if (!has("ANTHROPIC_API_KEY")) {
    // An agent key from .env, where it used to live.
    const key = existsSync(join(EDITOR, ".env")) ? /^ANTHROPIC_API_KEY=(.+)$/m.exec(readFileSync(join(EDITOR, ".env"), "utf8"))?.[1] : undefined;
    if (key) add.push(`ANTHROPIC_API_KEY=${key}`);
  }
  if (!add.length) return;
  writeFileSync(file, (text && !text.endsWith("\n") ? text + "\n" : text) + add.join("\n") + "\n");
  console.log(`  ${text ? "added to" : "made"} .dev.vars: ${add.map((l) => l.split("\n").pop()!.split("=")[0]).join(", ")}`);
}

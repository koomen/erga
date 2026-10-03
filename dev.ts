#!/usr/bin/env bun
// Local development: erga.dev's app on your machine, the very same Worker
// (worker/index.ts) run by Vite and the Cloudflare plugin, with any file or
// folder from disk as a document.
//
//   bun start [file-or-folder] [--port 4400] [--no-open]
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
// DEV_LOGIN, signed in without GitHub), and on the way out has every linked
// document write what it holds to disk before the server stops.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveTarget } from "./dev/plugin";

const EDITOR = import.meta.dir;
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1).filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const port = Number(flag("--port") ?? 4400);
const browser = !args.includes("--no-open");
const target = args.find((a) => !a.startsWith("--"));

// Fail fast on a target that won't open, before anything starts.
if (target) await resolveTarget(target, process.cwd()).catch((e) => { console.error((e as Error).message); process.exit(2); });
// The server listens on 127.0.0.1, but browsers try localhost's IPv6 address first: another server there would answer instead.
for (const hostname of ["127.0.0.1", "::1"]) {
  try { Bun.listen({ hostname, port, socket: { data() {} } }).stop(true); } catch (e) {
    if ((e as { code?: string }).code != "EADDRINUSE") continue;
    console.error(`port ${port} is taken (on ${hostname}): is another server running? Pick another with --port`);
    process.exit(2);
  }
}

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
    ERGA_CWD: process.cwd(),
    ERGA_PARENT: String(process.pid),
  },
});

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

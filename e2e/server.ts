// A dev server for the tests (dev.ts: the Worker under Vite, as `bun start`
// runs it), on a free port, with its own state, settings (.dev.vars) and Vite
// cache in a scratch folder, and a clean environment (env.ts). Signed in as
// DEV_LOGIN ("tester") unless a request says otherwise (worker/auth.ts:
// ?user=, /auth/github?as=). The editor's files are built once, in
// global-setup.ts (ERGA_BUILT).
//
// Stopping kills the whole tree at once (dev.ts, Vite, workerd, and anything a
// simulated factory VM left running under the scratch folder): tests don't
// need the documents flushed to disk on the way out.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv, ROOT } from "./env";

/** Settings the Worker reads from .dev.vars; anything else in `env` goes to the server's environment. */
const DEV_VARS = new Set(["DEV_LOGIN", "SESSION_SECRET", "ANTHROPIC_API_KEY", "ERGA_AGENT_MODEL", "GITHUB_CLIENT_SECRET"]);

export interface ServerOptions {
  /** .dev.vars (DEV_VARS above) and the server's environment (the rest). */
  env?: Record<string, string>;
  /** The server's environment as is, past .dev.vars (an ANTHROPIC_API_KEY of its own, say). */
  processEnv?: Record<string, string>;
  /** Up to how long to wait for it to answer. */
  startMs?: number;
}

export interface Server {
  /** http://127.0.0.1:<port> */
  root: string;
  port: number;
  /** The Worker's local state (ERGA_STATE_DIR): its Durable Objects, the factory's repository and VMs. */
  state: string;
  /** The scratch folder everything of this server's is in. */
  scratch: string;
  /** What it printed lately. */
  output(): string;
  /** Links a file or folder as one of DEV_LOGIN's documents: the document's address (no #edit). */
  open(path: string): Promise<string>;
  /** Copies tests/fixtures/<name> into the scratch folder and links it: its folder and address. */
  fixture(name: string): Promise<{ dir: string; address: string }>;
  stop(): void;
  dispose(): void;
}

/** A port nothing listens on right now (dev.ts refuses a taken one, and we try again). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}

/** Every process under `pid`. */
function descendants(pid: number): number[] {
  const out: number[] = [];
  for (const line of spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout?.split("\n") ?? []) {
    const child = Number(line);
    if (child) out.push(child, ...descendants(child));
  }
  return out;
}

const kill = (pids: number[]) => { for (const p of pids) try { process.kill(p, "SIGKILL"); } catch { /* gone */ } };

/** Servers this worker started and hasn't disposed of: killed when it exits, however it exits. */
const live = new Set<Server>();
process.on("exit", () => { for (const s of live) s.dispose(); });

let fixtures = 0;

export async function startServer(opts: ServerOptions = {}): Promise<Server> {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "erga-e2e-"));
  const state = join(scratch, "state"), envDir = join(scratch, "env");
  mkdirSync(envDir);
  const vars: Record<string, string> = { DEV_LOGIN: "tester", SESSION_SECRET: crypto.randomUUID(), ...opts.env };
  writeFileSync(join(envDir, ".dev.vars"), Object.entries(vars).filter(([k, v]) => DEV_VARS.has(k) && v).map(([k, v]) => `${k}=${v}\n`).join(""));
  const env = cleanEnv({
    ...Object.fromEntries(Object.entries(opts.env ?? {}).filter(([k]) => !DEV_VARS.has(k))),
    ...opts.processEnv,
    ERGA_STATE_DIR: state, ERGA_ENV_DIR: envDir, ERGA_VITE_CACHE: join(scratch, "vite"), ERGA_INSPECTOR: "0", ERGA_BUILT: "1",
  });
  let proc: ChildProcess | null = null;
  let output = "";
  let port = 0;
  const server: Server = {
    root: "", port: 0, state, scratch,
    output: () => output,
    async open(path) {
      const r = await fetch(`${server.root}/__erga/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }), redirect: "manual" });
      const at = r.headers.get("location");
      if (r.status != 303 || !at) throw new Error(`opening ${path}: ${r.status} ${await r.text()}`);
      return server.root + at.replace(/#edit$/, "");
    },
    async fixture(name) {
      const dir = join(scratch, "docs", `${name}-${++fixtures}`);
      cpSync(join(ROOT, "tests/fixtures", name), dir, { recursive: true });
      return { dir, address: await server.open(dir) };
    },
    stop() {
      const p = proc;
      proc = null;
      if (p?.pid) kill([p.pid, ...descendants(p.pid)]);
    },
    dispose() {
      server.stop();
      // What a simulated factory VM started detached (its preview, a stand-in) runs from a folder in the scratch one.
      // (The folder is a real path, /private/var/... on a Mac, so that is what its processes' command lines name.)
      spawnSync("pkill", ["-9", "-f", scratch]);
      live.delete(server);
      rmSync(scratch, { recursive: true, force: true });
    },
  };
  live.add(server);
  const until = Date.now() + (opts.startMs ?? 90_000);
  for (let attempt = 0; ; attempt++) {
    port = await freePort();
    const root = `http://127.0.0.1:${port}`;
    output = "";
    const p = proc = spawn("bun", [join(ROOT, "dev.ts"), "--port", String(port), "--no-open"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const take = (c: Buffer) => { output = (output + c.toString()).slice(-20_000); };
    p.stdout!.on("data", take);
    p.stderr!.on("data", take);
    let exited: number | null = null;
    p.on("exit", (code) => { exited = code ?? 1; });
    // Up once a page that reads the database answers: the server migrates it as it starts.
    while (Date.now() < until && exited == null) {
      const ok = await fetch(`${root}/docs`, { redirect: "manual", signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
      if (ok) { Object.assign(server, { root, port }); return server; }
      await new Promise((r) => setTimeout(r, 50));
    }
    // Another server took the port between freePort and dev.ts: once more, on another.
    if (exited != null && /port \d+ is taken/.test(output) && attempt < 3) continue;
    server.dispose();
    throw new Error(`the dev server didn't start (${exited != null ? `exit ${exited}` : "timed out"}):\n${output.slice(-4000)}`);
  }
}

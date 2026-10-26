// A dev server for the tests (dev/start.ts: the Worker under Vite, as `bun start`
// runs it), on a free port, with its own state, settings (.dev.vars) and Vite
// cache in a scratch folder, and a clean environment. Signed in as
// DEV_LOGIN ("tester") unless a request says otherwise (server/identity/sign-in.ts:
// ?user=, /auth/github?as=). The editor's files are built once, in
// global-setup.ts (ERGA_BUILT).
//
// Stopping kills the whole tree at once (dev/start.ts, Vite, workerd, and anything
// left running under the scratch folder): tests don't
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
  /** A folder dev/start.ts opens as it starts (as `bun start <folder>` does), at the same address after every restart: `base`. */
  open?: string;
  /** This port, not a free one: for servers that name each other's address as they start (servers.pair). No second try if it's taken. */
  port?: number;
  /** The local state (ERGA_STATE_DIR) of a server stopped before, to start again on: a restart. Its owner disposes of it. */
  state?: string;
}

export interface Server {
  /** http://127.0.0.1:<port> */
  root: string;
  port: number;
  /** The `open` folder's document (no ?edit), else `root`. */
  base: string;
  /** The Worker's local state (ERGA_STATE_DIR): its Durable Objects. */
  state: string;
  /** The scratch folder everything of this server's is in. */
  scratch: string;
  /** What it printed lately. */
  output(): string;
  /** Whether its process still runs. */
  alive(): boolean;
  /** Links a file or folder as one of DEV_LOGIN's documents: the document's address (no ?edit). */
  open(path: string): Promise<string>;
  /** Copies e2e/fixtures/<name> into the scratch folder and links it: its folder and address. */
  fixture(name: string): Promise<{ dir: string; address: string }>;
  stop(): void;
  /**
   * Stops it as a restart or a crash would: SIGTERM lets the documents write what's unsaved first (dev/start.ts stops in
   * under 10 s), SIGKILL kills everything at once. The state and the port stay, for start().
   */
  halt(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  /** Starts it again after halt(), on the same port, with the same state and settings. */
  start(): Promise<void>;
  /** Kills it at once (as a deploy cuts a Durable Object off) and starts it again, on the same port and state. */
  restart(): Promise<void>;
  dispose(): void;
}

/** A port nothing listens on right now (dev/start.ts refuses a taken one, and we try again). */
export function freePort(): Promise<number> {
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
  for (const line of spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8", timeout: 30_000 }).stdout?.split("\n") ?? []) {
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
  // The run's mark in its name: what a simulated VM starts gets a clean environment, without ERGA_TEST_RUN, but its command
  // line names this folder, so e2e/run.ts's sweep finds it after a worker that was killed.
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), `erga-e2e-${process.env.ERGA_TEST_RUN ? `${process.env.ERGA_TEST_RUN}-` : ""}`));
  const state = opts.state ?? join(scratch, "state"), envDir = join(scratch, "env");
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
    root: "", port: 0, base: "", state, scratch,
    output: () => output,
    alive: () => !!proc && proc.exitCode == null && proc.signalCode == null,
    async open(path) {
      const r = await fetch(`${server.root}/__erga/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }), redirect: "manual" });
      const at = r.headers.get("location");
      if (r.status != 303 || !at) throw new Error(`opening ${path}: ${r.status} ${await r.text()}`);
      return server.root + at.replace(/[?&]edit$/, "");
    },
    async fixture(name) {
      const dir = join(scratch, "docs", `${name}-${++fixtures}`);
      cpSync(join(ROOT, "e2e/helpers/fixtures", name), dir, { recursive: true });
      return { dir, address: await server.open(dir) };
    },
    stop() {
      const p = proc;
      proc = null;
      if (p?.pid) kill([p.pid, ...descendants(p.pid)]);
    },
    async halt(signal = "SIGTERM") {
      const p = proc;
      if (!p?.pid) return;
      const exited = new Promise<boolean>((r) => { if (p.exitCode != null || p.signalCode != null) r(true); else p.once("exit", () => r(true)); });
      const within = (ms: number) => Promise.race([exited, new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
      if (signal == "SIGTERM") {
        proc = null;
        try { process.kill(p.pid, "SIGTERM"); } catch { /* gone */ }
        // Past dev/start.ts's own limit it's stuck: everything goes, as for SIGKILL.
        if (await within(20_000)) { kill(descendants(p.pid)); return; }
        proc = p;
      }
      server.stop();
      await within(10_000);
    },
    async start() {
      if (server.alive()) throw new Error(`the dev server at ${server.root} is running`);
      await launch(port, true);
    },
    async restart() {
      server.stop();
      await launch(server.port, true);
    },
    dispose() {
      server.stop();
      // Anything a test started detached runs from a folder in the scratch one.
      // (The folder is a real path, /private/var/... on a Mac, so that is what its processes' command lines name.)
      spawnSync("pkill", ["-9", "-f", scratch], { timeout: 10_000 });
      live.delete(server);
      rmSync(scratch, { recursive: true, force: true });
    },
  };
  live.add(server);
  /** Starts dev/start.ts on a free port (or on `fixed`) and waits until it answers; `again`: a restart, which waits for its own port. */
  async function launch(fixed?: number, again = false) {
    const until = Date.now() + (opts.startMs ?? 90_000);
    for (let attempt = 0; ; attempt++) {
      const at = fixed ?? await freePort();
      const root = `http://127.0.0.1:${at}`;
      output = "";
      const p = proc = spawn("bun", [join(ROOT, "dev/start.ts"), ...(opts.open ? [opts.open] : []), "--port", String(at), "--no-open"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const take = (c: Buffer) => { output = (output + c.toString()).slice(-20_000); };
      p.stdout!.on("data", take);
      p.stderr!.on("data", take);
      let exited: number | null = null, up = false;
      p.on("exit", (code, signal) => {
        exited = code ?? 1;
        // Stopped by nobody, once it was up: say why, for the test that finds it gone.
        if (proc == p && up) console.error(`the dev server at ${server.root} stopped by itself (${signal ?? `exit ${code}`}):\n${output.slice(-3000)}`);
      });
      // Up once a page that reads the database answers (the server migrates it as it starts), and the folder it opens is open.
      while (Date.now() < until && exited == null) {
        const doc = opts.open ? new RegExp(`editing .*: http://localhost:${at}(/[a-z0-9-]+/[a-z0-9-]+)`).exec(output)?.[1] : "";
        const ok = doc != null && await fetch(opts.open ? `${root}${doc}/api/doc` : `${root}/docs`, { redirect: "manual", signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
        if (ok) { up = true; port = at; Object.assign(server, { root, port, base: root + doc }); return; }
        await new Promise((r) => setTimeout(r, 50));
      }
      // Another server took the port between freePort and dev/start.ts: once more, on another. (A restart keeps its port: the
      // killed one's socket may linger a moment, so it tries that port again.)
      if (exited != null && /port \d+ is taken/.test(output) && !(fixed && !again) && attempt < (again ? 40 : 3)) {
        if (again) await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      server.dispose();
      throw new Error(`the dev server didn't start (${exited != null ? `exit ${exited}` : "timed out"}):\n${output.slice(-4000)}`);
    }
  }
  await launch(opts.port);
  return server;
}

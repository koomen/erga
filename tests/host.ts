// Starts a dev server for a test (dev.ts: the Worker under Vite, as `bun
// start` runs it) on a port of its own, with its own state, settings
// (.dev.vars) and Vite cache, so it never touches yours. Given a file or
// folder, it links that as a document and `base` is the document's address;
// without one, `base` is the app's root, and `open` links them as needed.

import "./hermetic";
import { exitedWithin, waiting } from "./stop";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = new URL("../", import.meta.url).pathname;

/** Settings the Worker reads from .dev.vars; anything else in `env` goes to the server's environment. */
const DEV_VARS = new Set(["DEV_LOGIN", "SESSION_SECRET", "ANTHROPIC_API_KEY", "ERGA_AGENT_MODEL", "GITHUB_CLIENT_SECRET"]);

export interface Host {
  /** The document's address (http://127.0.0.1:<port>/<owner>/<id>), or the app's root without one. */
  base: string;
  /** The app's root. */
  root: string;
  port: number;
  /** The Worker's local state: its Durable Objects' storage (v3/) and the links (erga-links.json). */
  state: string;
  /** What it has printed lately. */
  output(): string;
  /** Links a file or folder as one of DEV_LOGIN's documents: its address. */
  open(path: string): Promise<string>;
  /** Deletes a document made by `open` (its files stay). */
  forget(address: string): Promise<void>;
  /** Stops it (SIGTERM has the documents write what's unsaved first; SIGKILL kills everything at once). */
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  /** Starts it again, on the same port and state. */
  start(): Promise<void>;
  /** Stops it and removes its state. */
  dispose(): Promise<void>;
}

/**
 * The editor's files, built once for every server this process starts
 * (dev.ts skips it with ERGA_BUILT); not at all if test.sh already has.
 */
let built: Promise<void> | null = process.env.ERGA_BUILT ? Promise.resolve() : null;
const build = () => built ??= (async () => {
  const p = Bun.spawn([join(ROOT, "site.sh")], { cwd: ROOT, stdout: "ignore", stderr: "inherit" });
  if (await p.exited) throw new Error("site.sh failed");
})();

/** A port nothing is listening on right now. */
export function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/**
 * A dev server, its settings from `env`: DEV_LOGIN ("tester"), the agent's
 * (ANTHROPIC_API_KEY, none by default; ERGA_AGENT_MODEL) and the room's
 * write delay (ERGA_WRITE_DELAY_MS). `processEnv` goes to the server's
 * environment as is, past .dev.vars (e.g. an ANTHROPIC_API_KEY of its own).
 */
export async function startHost(target: string | null, opts: { port?: number; env?: Record<string, string>; processEnv?: Record<string, string> } = {}): Promise<Host> {
  // A port the OS says is free: a random guess collides now and then with this many servers starting at once.
  await build();
  const port = opts.port ?? freePort();
  const scratch = mkdtempSync(join(tmpdir(), "erga-host-"));
  scratches.add(scratch);
  const state = join(scratch, "state"), envDir = join(scratch, "env");
  mkdirSync(envDir);
  const vars: Record<string, string> = { DEV_LOGIN: "tester", SESSION_SECRET: crypto.randomUUID(), ...opts.env };
  writeFileSync(join(envDir, ".dev.vars"), Object.entries(vars).filter(([k, v]) => DEV_VARS.has(k) && v).map(([k, v]) => `${k}=${v}\n`).join(""));
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    // The agent's key only from .dev.vars above, not whatever this shell has (dev/agent-key.ts would take it), unless `processEnv` gives one.
    ANTHROPIC_API_KEY: "",

    ...Object.fromEntries(Object.entries(opts.env ?? {}).filter(([k]) => !DEV_VARS.has(k))),
    ...opts.processEnv,
    ERGA_STATE_DIR: state, ERGA_ENV_DIR: envDir, ERGA_VITE_CACHE: join(scratch, "vite"), ERGA_INSPECTOR: "0", ERGA_BUILT: "1",
  };
  const root = `http://127.0.0.1:${port}`;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let output = "";
  let readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const host: Host = {
    base: root, root, port, state,
    output: () => output,
    async open(path) {
      const r = await fetch(`${root}/__erga/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }), redirect: "manual", signal: AbortSignal.timeout(60_000) });
      const at = r.headers.get("location");
      if (r.status != 303 || !at) throw new Error(`opening ${path}: ${r.status} ${await r.text()}`);
      // The editor's address (…#edit); the tests address the document itself, where its API is too.
      return root + at.replace(/#edit$/, "");
    },
    async forget(address) {
      const info = await (await fetch(`${address}/api/doc`, { signal: AbortSignal.timeout(60_000) })).json() as { docName?: { id: string } };
      const id = info.docName?.id ?? address.split("/").pop()!;
      await fetch(`${root}/docs/delete`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ id }), redirect: "manual", signal: AbortSignal.timeout(60_000) });
    },
    async start() {
      // Its own process group, so stopping it outright takes the server with it.
      const p = proc = Bun.spawn(["bun", join(ROOT, "dev.ts"), ...(target ? [target] : []), "--port", String(port), "--no-open"], { env, stdout: "pipe", stderr: "pipe", detached: true });
      running.add(p.pid);
      p.exited.then(() => running.delete(p.pid));
      readers = ([p.stdout, p.stderr] as ReadableStream<Uint8Array>[]).map((s) => s.getReader());
      for (const r of readers) (async () => { for (let c; !(c = await r.read()).done;) output = (output + new TextDecoder().decode(c.value)).slice(-20000); })().catch(() => {});
      // Usually ~2s; the margin is for a machine busy running everything else at once (./test.sh starts many
      // servers together, each optimizing Vite's dependencies in a cache of its own: on a loaded machine, 30s wasn't enough).
      const done = waiting(`the dev server on port ${port} to start`);
      try {
        for (const until = Date.now() + 120_000; Date.now() < until;) {
          if (p.exitCode != null) break;
          const at = target ? new RegExp(`editing .*: http://localhost:${port}(/[a-z0-9-]+/[a-z0-9-]+)`).exec(output)?.[1] : "";
          // Up once a page that reads the database answers: the server migrates it as it starts, and until then those fail.
          try { if (at != null && (await fetch(target ? `${root}${at}/api/doc` : `${root}/docs`, { redirect: "manual", signal: AbortSignal.timeout(10_000) })).ok) { host.base = root + at; return; } } catch { /* not up yet */ }
          await Bun.sleep(25);
        }
      } finally { done(); }
      throw new Error(`dev server didn't start${p.exitCode != null ? ` (it exited, ${p.exitCode})` : " in 120 s"}:\n${output}`);
    },
    async stop(signal = "SIGTERM") {
      const p = proc;
      if (!p) return;
      proc = null;
      // dev.ts writes what's unsaved and stops in under 10 s (its own limit); past 20 s, it's stuck: everything goes.
      const done = waiting(`the dev server on port ${port} to stop`);
      try {
        if (signal == "SIGTERM") {
          p.kill("SIGTERM");
          if (await exitedWithin(p, 20_000)) return;
        }
        // Everything at once, as a crash would: dev.ts, the server and workerd under it.
        for (const pid of [p.pid, ...descendants(p.pid)]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
        if (!(await exitedWithin(p, 10_000))) throw new Error(`the dev server on port ${port} (pid ${p.pid}) didn't stop, even killed`);
      } finally {
        done();
        // Stopped: nothing of it may keep this process running (with Bun 1.2 its pipes could stay open after it exited).
        for (const r of readers) r.cancel().catch(() => {});
        p.unref();
      }
    },
    async dispose() {
      await host.stop();
      killLeftovers(scratch);
      scratches.delete(scratch);
      rmSync(scratch, { recursive: true, force: true });
    },
  };
  await host.start();
  return host;
}

/** Every process under `pid`, children first found first. */
function descendants(pid: number): number[] {
  const out: number[] = [];
  for (const line of Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().split("\n")) {
    const child = Number(line);
    if (child) out.push(child, ...descendants(child));
  }
  return out;
}

/** Every host's scratch folder this process made and hasn't disposed of: what's left running from them goes when it exits. */
const scratches = new Set<string>();
/**
 * Every dev server (dev.ts) still running, by pid: killed with everything under it when this process exits, as a test
 * that fails half-way never disposes of its hosts. killLeftovers can't find them: their command line names the
 * document's folder, and their working directory is the checkout.
 */
const running = new Set<number>();
process.on("exit", () => {
  for (const pid of running) for (const p of [pid, ...descendants(pid)]) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  for (const dir of scratches) { killLeftovers(dir); try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});
// Stopped from outside (Ctrl-C, a time limit): tests/stop.ts exits, so the above runs.

/**
 * Kills what is still running from a host's scratch folder. A factory job's preview (factory/vm/task.ts serve-static,
 * or bun dev.ts), started detached in a simulated VM's clone there, outlives the server that started it: without
 * this, each test run leaves some behind. Found by command line (the folder in it) and by working directory.
 */
export function killLeftovers(dir: string) {
  const dirs = [...new Set([dir, (() => { try { return realpathSync(dir); } catch { return dir; } })()])]; // /var/... is /private/var/... on a Mac
  const pids = new Set<number>();
  for (const d of dirs) for (const line of run(["pgrep", "-f", d]).split("\n")) if (Number(line)) pids.add(Number(line));
  const inside = (cwd: string) => dirs.some((d) => cwd == d || cwd.startsWith(d + "/"));
  for (const [pid, cwd] of cwds()) if (inside(cwd)) pids.add(pid);
  pids.delete(process.pid);
  for (const p of pids) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
}

/** A command's output, or "" when it isn't installed (a factory VM's image may lack lsof) or fails to start. */
function run(cmd: string[]): string {
  try { return Bun.spawnSync(cmd, { stderr: "ignore" }).stdout.toString(); } catch { return ""; }
}

/** Every process's working directory: /proc/<pid>/cwd on Linux, lsof elsewhere (none if lsof is missing). */
function cwds(): [number, string][] {
  const out: [number, string][] = [];
  if (process.platform == "linux") {
    let entries: string[] = [];
    try { entries = readdirSync("/proc"); } catch { /* no /proc */ }
    for (const e of entries) if (/^\d+$/.test(e)) try { out.push([Number(e), readlinkSync(`/proc/${e}/cwd`)]); } catch { /* gone, or not ours */ }
    return out;
  }
  let pid = 0;
  for (const line of run(["lsof", "-n", "-w", "-d", "cwd", "-F", "pn"]).split("\n")) {
    if (line[0] == "p") pid = Number(line.slice(1));
    else if (line[0] == "n") out.push([pid, line.slice(1)]);
  }
  return out;
}

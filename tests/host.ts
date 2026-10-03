// Starts a dev server for a test (dev.ts: the Worker under Vite, as `bun
// start` runs it) on a port of its own, with its own state, settings
// (.dev.vars) and Vite cache, so it never touches yours. Given a file or
// folder, it links that as a document and `base` is the document's address;
// without one, `base` is the app's root, and `open` links them as needed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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
 * write delay (ERGA_WRITE_DELAY_MS).
 */
export async function startHost(target: string | null, opts: { port?: number; env?: Record<string, string> } = {}): Promise<Host> {
  // A port the OS says is free: a random guess collides now and then with this many servers starting at once.
  await build();
  const port = opts.port ?? freePort();
  const scratch = mkdtempSync(join(tmpdir(), "erga-host-"));
  const state = join(scratch, "state"), envDir = join(scratch, "env");
  mkdirSync(envDir);
  const vars: Record<string, string> = { DEV_LOGIN: "tester", SESSION_SECRET: crypto.randomUUID(), ...opts.env };
  writeFileSync(join(envDir, ".dev.vars"), Object.entries(vars).filter(([k, v]) => DEV_VARS.has(k) && v).map(([k, v]) => `${k}=${v}\n`).join(""));
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...Object.fromEntries(Object.entries(opts.env ?? {}).filter(([k]) => !DEV_VARS.has(k))),
    ERGA_STATE_DIR: state, ERGA_ENV_DIR: envDir, ERGA_VITE_CACHE: join(scratch, "vite"), ERGA_INSPECTOR: "0", ERGA_BUILT: "1",
  };
  const root = `http://127.0.0.1:${port}`;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let output = "";
  const host: Host = {
    base: root, root, port, state,
    output: () => output,
    async open(path) {
      const r = await fetch(`${root}/__erga/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }), redirect: "manual" });
      const at = r.headers.get("location");
      if (r.status != 303 || !at) throw new Error(`opening ${path}: ${r.status} ${await r.text()}`);
      return root + at;
    },
    async forget(address) {
      const info = await (await fetch(`${address}/api/doc`)).json() as { docName?: { id: string } };
      const id = info.docName?.id ?? address.split("/").pop()!;
      await fetch(`${root}/docs/delete`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ id }), redirect: "manual" });
    },
    async start() {
      // Its own process group, so stopping it outright takes the server with it.
      const p = proc = Bun.spawn(["bun", join(ROOT, "dev.ts"), ...(target ? [target] : []), "--port", String(port), "--no-open"], { env, stdout: "pipe", stderr: "pipe", detached: true });
      for (const s of [p.stdout, p.stderr] as ReadableStream<Uint8Array>[]) (async () => { for await (const c of s) output = (output + new TextDecoder().decode(c)).slice(-20000); })();
      // Usually ~2s; the margin is for a machine busy running everything else at once.
      for (let i = 0; i < 1200; i++) {
        if (p.exitCode != null) break;
        const at = target ? new RegExp(`editing .*: http://localhost:${port}(/[a-z0-9-]+/[a-z0-9-]+)`).exec(output)?.[1] : "";
        try { if (at != null && (await fetch(target ? `${root}${at}/api/doc` : `${root}/style.css`)).ok) { host.base = root + at; return; } } catch { /* not up yet */ }
        await Bun.sleep(25);
      }
      throw new Error(`dev server didn't start:\n${output}`);
    },
    async stop(signal = "SIGTERM") {
      const p = proc;
      if (!p) return;
      proc = null;
      if (signal == "SIGTERM") { p.kill("SIGTERM"); await p.exited; return; }
      // Everything at once, as a crash would: dev.ts, the server and workerd under it.
      for (const pid of [p.pid, ...descendants(p.pid)]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      await p.exited;
    },
    async dispose() {
      await host.stop();
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

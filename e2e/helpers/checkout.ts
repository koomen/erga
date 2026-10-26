// A throwaway copy of this checkout, and `bun start` in it, for the tests that edit the server's own files
// (e2e/reload: live reload) or test what a checkout's server does by itself (e2e/alone/checkouts: ports, .dev-url).
// The copy is the checkout's files, committed or not, minus what git ignores, and a link to its node_modules
// (read-only here, and copying it is slow). It has no .build: dev/start.ts builds the editor's files in it as it starts,
// and rebuilds them when they change, as `bun start` does in a fresh worktree.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanEnv, ROOT } from "./env";

/** Copies the checkout to `dir` (made). */
export function copyCheckout(dir: string) {
  const r = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8", timeout: 30_000, maxBuffer: 64 << 20 });
  if (r.status != 0) throw new Error(`git ls-files: ${r.stderr}`);
  for (const f of r.stdout.split("\0").filter(Boolean)) {
    if (!existsSync(join(ROOT, f))) continue; // deleted, not yet committed
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
}

/** Every process under `pid`. */
export function tree(pid: number): number[] {
  const out = [pid];
  for (const line of spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8", timeout: 30_000 }).stdout?.split("\n") ?? []) if (Number(line)) out.push(...tree(Number(line)));
  return out;
}

export interface Started {
  proc: ChildProcess;
  output(): string;
  /** Whether it still runs. */
  alive(): boolean;
  /** SIGTERM (dev/start.ts stops in under 10 s), then everything under it by force. */
  stop(): Promise<void>;
}

/** Started servers this worker hasn't stopped: killed when it exits, however it exits. */
const running = new Set<Started>();
process.on("exit", () => { for (const s of running) for (const p of tree(s.proc.pid!)) try { process.kill(p, "SIGKILL"); } catch { /* gone */ } });

/** `bun dev/start.ts ARGS` in `dir`, with `env` added to a clean environment (no ERGA_BUILT: it builds the editor's files itself). */
export function startIn(dir: string, args: string[], env: Record<string, string> = {}): Started {
  let output = "";
  const proc = spawn("bun", [join(dir, "dev/start.ts"), ...args], { cwd: dir, env: cleanEnv(env), stdio: ["ignore", "pipe", "pipe"], detached: true });
  const take = (c: Buffer) => { output = (output + c.toString()).slice(-20_000); };
  proc.stdout!.on("data", take);
  proc.stderr!.on("data", take);
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  const s: Started = {
    proc,
    output: () => output,
    alive: () => proc.exitCode == null && proc.signalCode == null,
    async stop() {
      running.delete(s);
      if (s.alive()) {
        const pids = tree(proc.pid!);
        try { process.kill(proc.pid!, "SIGTERM"); } catch { /* gone */ }
        await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000).unref())]);
        for (const p of pids) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
      }
    },
  };
  running.add(s);
  return s;
}

/** Waits until `url` answers 200 (a page that reads the database: the server migrates it as it starts); fails if the server exits. */
export async function upAt(s: Started, url: () => string | null, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end && s.alive();) {
    const u = url();
    if (u && await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the dev server didn't come up (${s.alive() ? "timed out" : `exit ${s.proc.exitCode}`}):\n${s.output().slice(-4000)}`);
}

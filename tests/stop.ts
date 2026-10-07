// What a test file is waiting on, and how it stops when stopped from outside (test.sh's time limit, through
// tests/run-file.ts; Ctrl-C): it prints the waits it was in (each until() of tests/suite/harness.ts, each DevTools
// command of tests/cdp.ts with no answer yet, each dev server starting, tests/host.ts), then exits, so the exit
// handlers stop its dev servers and browsers. The report names the step that hung, not just the file.

import { readFileSync, writeFileSync } from "fs";

const waits = new Map<number, { what: string; since: number }>();
let next = 0;

/** Notes a wait until the function it returns is called. */
export function waiting(what: string): () => void {
  const id = ++next;
  waits.set(id, { what, since: Date.now() });
  return () => { waits.delete(id); };
}

/** The waits under way, oldest first, with how long each has lasted. */
export function waitingOn(): string[] {
  const now = Date.now();
  return [...waits.values()].map((w) => `${w.what} (for ${((now - w.since) / 1000).toFixed(1)}s)`);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => {
  const on = waitingOn();
  console.error(`\nstopped (${sig}) ${on.length ? `while waiting on:\n  ${on.join("\n  ")}` : "between waits (the file was busy, or on a step with no wait)"}`);
  process.exit(130);
});

/**
 * Whether `proc` has exited within `ms`. Not just `proc.exited`: Bun 1.2 (on a Mac) now and then never resolves it
 * for a child that has exited (a zombie, <defunct> in ps), and a test that awaited it hung for good (and the zombie
 * kept the event loop alive after the test's last check). So this also looks for itself, every 250 ms, and a child
 * found gone is unref'd, so it can't keep the process running. No timer is left behind.
 */
export async function exitedWithin(proc: { pid: number; exited: Promise<number>; exitCode: number | null; signalCode?: string | null; unref(): void }, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const looked = new Promise<boolean>((resolve) => {
    const until = Date.now() + ms;
    const look = () => {
      if (proc.exitCode != null || proc.signalCode) return resolve(true);
      if (gone(proc.pid)) { proc.unref(); return resolve(true); }
      if (Date.now() >= until) return resolve(false);
      timer = setTimeout(look, 250);
    };
    timer = setTimeout(look, 250);
  });
  try { return await Promise.race([proc.exited.then(() => true), looked]); }
  finally { clearTimeout(timer); }
}

/** Whether `pid` has exited: no such process, or a zombie waiting for its parent. */
export function gone(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return true; }
  try { return Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stderr: "ignore" }).stdout.toString().trim().startsWith("Z"); } catch { return false; }
}

/**
 * A child's exit code, even when Bun lost it (above): the child, if it imports this file, writes its code to
 * ERGA_EXIT_FILE as it exits. Without either, 1, so a lost exit never passes for a pass.
 */
export function exitCode(proc: { exitCode: number | null; signalCode?: string | null }, file?: string): number {
  if (proc.exitCode != null) return proc.exitCode;
  if (proc.signalCode) return 128 + (SIGNALS[proc.signalCode] ?? 1);
  try { const n = Number(readFileSync(file ?? "", "utf8")); if (Number.isInteger(n)) return n; } catch { /* none */ }
  console.error("(its exit status was lost: counted as a failure)");
  return 1;
}
const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
if (process.env.ERGA_EXIT_FILE) {
  const file = process.env.ERGA_EXIT_FILE;
  process.on("exit", (code) => { try { writeFileSync(file, String(code)); } catch { /* best effort */ } });
}

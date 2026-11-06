// A process by its pid and its start time: a lock or a job record names both, so a pid that the system gives to
// another process later does not keep a lock held, or a job "running", for ever.

/** The process's start time, as `ps` says it, or null: no such process. */
export function processStart(pid: number): string | null {
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const out = r.stdout.toString().trim();
  return r.exitCode == 0 && out ? out : null;
}

/** This process's start time: a lock and a job record write it beside the pid. */
export const ownStart = () => processStart(process.pid);

/** Whether the process `pid` lives and started at `start`. */
export const alive = (pid: number, start: unknown) => typeof start == "string" && processStart(pid) == start;

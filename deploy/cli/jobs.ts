// The lock and the record of a job (a deploy, a rollback, a merge, a run of the tests), in .erga/jobs/ of the main
// clone. The lock, <host>.lock, lets one job at a time work on an instance (or on staging, or on the tests). The
// record, <when>-<host>-<pid>.jsonl, is what the ops page shows of the job (ops-view.ts, jobOf).

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { alive, ownStart } from "./pid";

const jobsDir = (dir: string) => join(dir, "jobs");
export const lockPath = (dir: string, host: string) => join(jobsDir(dir), `${host}.lock`);

interface Held {
  pid: number;
  /** The process's start time (pid.ts): with the pid, it names the process, even after the system reuses the pid. */
  pidStart: string | null;
  command: string;
  started: string;
}

const heldBy = (path: string): Held | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Held;
  } catch {
    return null;
  }
};

/** Takes the instance's lock, or throws which job holds it. A lock of a process that stopped (or of its reused pid) is free. The result frees it. */
export function takeLock(dir: string, host: string, command: string): () => void {
  mkdirSync(jobsDir(dir), { recursive: true });
  const path = lockPath(dir, host);
  for (let tries = 0; tries < 3; tries++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, pidStart: ownStart(), command, started: new Date().toISOString() } satisfies Held));
      closeSync(fd);
      return () => {
        if (heldBy(path)?.pid == process.pid) rmSync(path, { force: true });
      };
    } catch (e) {
      if ((e as { code?: string }).code != "EEXIST") throw e;
    }
    const held = heldBy(path);
    // A lock with no text yet: another process makes it now.
    const young = !held && existsSync(path) && Date.now() - statSync(path).mtimeMs < 5000;
    if ((held && alive(held.pid, held.pidStart)) || young)
      throw new Error(
        `${host} is locked: ${held ? `${held.command} (process ${held.pid}) runs since ${held.started}` : "a job starts on it now"}. Wait for it to end (the lock: ${path}).`
      );
    rmSync(path, { force: true });
  }
  throw new Error(`${host}'s lock (${path}) changed while this command took it. Run the command again.`);
}

export interface Job {
  path: string;
  /** One line of the job's output: printed, and added to the record. */
  log: (line: string) => void;
  /** A fact of the job, added to the record. */
  note: (fact: Record<string, unknown>) => void;
  end: (result: "ok" | "failed", error?: string) => void;
}

/** Where a job's command was typed: a terminal, or the ops page (ops-page.ts runs the CLI with ERGA_JOB_FROM=page). */
export type From = "terminal" | "page";

/** This process's environment without ERGA_JOB_FROM: for the tests a merge or a deploy runs, which are no job of the page. */
export const testEnv = () => {
  const env = { ...process.env };
  delete env.ERGA_JOB_FROM;
  return env;
};

/** A job's record, .erga/jobs/<when>-<host>-<pid>.jsonl: its start, its output as it comes, and its result, one JSON per line. */
export function startJob(dir: string, o: { command: string; host: string; from?: From; print?: (line: string) => void }): Job {
  mkdirSync(jobsDir(dir), { recursive: true });
  const started = new Date().toISOString();
  const path = join(jobsDir(dir), `${started.replace(/[:.]/g, "-")}-${o.host.replace(/[^\w.-]/g, "_")}-${process.pid}.jsonl`);
  const add = (x: Record<string, unknown>) => appendFileSync(path, `${JSON.stringify(x)}\n`, { mode: 0o600 });
  add({ command: o.command, host: o.host, from: o.from ?? "terminal", pid: process.pid, pidStart: ownStart(), started });
  const print = o.print ?? console.log;
  return {
    path,
    log: (line) => {
      print(line);
      add({ out: line });
    },
    note: add,
    end: (result, error) => add({ result, ...(error ? { error } : {}), ended: new Date().toISOString() }),
  };
}

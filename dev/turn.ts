// One run of `bun run test` at a time on this machine, across all work folders: a run needs all the cores, so two at
// once make both slow and their tests fail on time limits. The lock is the gate's (deploy/cli/test-run.ts):
// .erga/jobs/tests.lock in the main clone. A run that must wait takes a ticket in .erga/jobs/tests.queue/, and the
// oldest ticket goes first. While it waits, it says its place and the wait to expect, one line for each change.
//
// A run that the lock's holder started (the gate runs `bun run test` under its own lock) has its turn already.
// The quick check (bun run check) and a run of named files (bun run test:e2e <file>) take no turn.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockPath, takeLock } from "../deploy/cli/jobs";
import { alive, ownStart } from "../deploy/cli/pid";

/** The time of the last run, in seconds (60 before the first), for the wait to expect: e2e/run.ts notes it. */
const lastFile = (dir: string) => join(dir, "jobs", "tests.seconds");
export const noteRun = (dir: string, seconds: number) => writeFileSync(lastFile(dir), `${Math.round(seconds)}\n`);
const runSeconds = (dir: string) => {
  try {
    return Number(readFileSync(lastFile(dir), "utf8")) || 60;
  } catch {
    return 60;
  }
};

/** The process's ancestors, nearest first. */
function ancestors(pid: number): number[] {
  const out: number[] = [];
  for (let p = pid; p > 1 && out.length < 64; ) {
    p =
      Number(
        Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(p)], { stdout: "pipe", stderr: "ignore" })
          .stdout.toString()
          .trim()
      ) || 0;
    if (p > 1) out.push(p);
  }
  return out;
}

export interface Turn {
  /** How long it waited. */
  waitedMs: number;
  free(): void;
}

/** Waits for this process's turn and takes it. `dir`: .erga in the main clone. `pollMs`, `parents` and `isAlive` are for the tests. */
export async function takeTurn(o: {
  dir: string;
  what: string;
  log: (line: string) => void;
  pollMs?: number;
  parents?: number[];
  isAlive?: (pid: number, start: unknown) => boolean;
}): Promise<Turn> {
  const t0 = Date.now();
  const isAlive = o.isAlive ?? alive;
  const holder = () => {
    try {
      return JSON.parse(readFileSync(lockPath(o.dir, "tests"), "utf8")) as { pid: number; pidStart: string | null; started: string };
    } catch {
      return null;
    }
  };
  const held = holder();
  if (held && (o.parents ?? ancestors(process.pid)).includes(held.pid)) return { waitedMs: 0, free() {} };

  const queue = join(o.dir, "jobs", "tests.queue");
  mkdirSync(queue, { recursive: true });
  const mine = `${String(t0).padStart(15, "0")}-${process.pid}`;
  writeFileSync(join(queue, mine), JSON.stringify({ pid: process.pid, pidStart: ownStart() }));
  const leave = () => rmSync(join(queue, mine), { force: true });
  /** The live tickets before this one; a ticket of a process that is gone is removed. */
  const before = () =>
    readdirSync(queue)
      .filter((name) => name < mine)
      .filter((name) => {
        try {
          const t = JSON.parse(readFileSync(join(queue, name), "utf8")) as { pid: number; pidStart: string | null };
          if (isAlive(t.pid, t.pidStart)) return true;
        } catch {}
        rmSync(join(queue, name), { force: true });
        return false;
      }).length;
  let said = -1;
  try {
    for (;;) {
      const ahead = before();
      if (!ahead)
        try {
          const free = takeLock(o.dir, "tests", o.what);
          return { waitedMs: Date.now() - t0, free };
        } catch (e) {
          if (!/ is locked: /.test((e as Error).message)) throw e;
        }
      // The runs before this one: each ticket, and the run that holds the lock now.
      const place = ahead + 1;
      if (place != said) {
        const h = holder();
        const each = runSeconds(o.dir);
        const left = Math.max(5, each - (h ? (Date.now() - Date.parse(h.started)) / 1000 : 0));
        o.log(
          `waiting for the tests' turn: place ${place} in the queue, about ${Math.round(left + ahead * each)} s (one run at a time on this machine)`
        );
        said = place;
      }
      await Bun.sleep(o.pollMs ?? 500);
    }
  } finally {
    leave();
  }
}

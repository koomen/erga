// dev/turn.ts: one run of `bun run test` at a time. A run waits while another holds the lock or an older ticket waits,
// says its place one time, and goes when the lock is free; the lock holder's own child has its turn already.

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPath, takeLock } from "../deploy/cli/jobs";
import { ownStart } from "../deploy/cli/pid";
import { takeTurn } from "../dev/turn";

const dir = () => mkdtempSync(join(tmpdir(), "erga-turn-"));

test("a free machine gives the turn at once, and frees the lock after", async () => {
  const d = dir();
  const said: string[] = [];
  const turn = await takeTurn({ dir: d, what: "a run", log: (l) => said.push(l) });
  expect(existsSync(lockPath(d, "tests"))).toBe(true);
  expect(said).toEqual([]);
  turn.free();
  expect(existsSync(lockPath(d, "tests"))).toBe(false);
  expect(readdirSync(join(d, "jobs", "tests.queue"))).toEqual([]);
});

test("a run waits for the holder, says its place one time, and goes when the lock is free", async () => {
  const d = dir();
  const free = takeLock(d, "tests", "the gate's run");
  const said: string[] = [];
  let got = false;
  const waiting = takeTurn({ dir: d, what: "a run", log: (l) => said.push(l), pollMs: 5, parents: [] }).then((t) => ((got = true), t));
  while (!said.length) await Bun.sleep(1);
  expect(said).toEqual([expect.stringMatching(/^waiting for the tests' turn: place 1 in the queue, about \d+ s/)]);
  expect(got).toBe(false);
  free();
  const turn = await waiting;
  expect(said.length).toBe(1);
  expect(turn.waitedMs).toBeGreaterThan(0);
  turn.free();
});

test("an older ticket goes first; the ticket of a process that is gone does not count", async () => {
  const d = dir();
  const queue = join(d, "jobs", "tests.queue");
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(queue, "000000000000001-1"), JSON.stringify({ pid: process.pid, pidStart: ownStart() }));
  writeFileSync(join(queue, "000000000000002-2"), JSON.stringify({ pid: 999_999_999, pidStart: "never" }));
  const said: string[] = [];
  let got = false;
  const waiting = takeTurn({ dir: d, what: "a run", log: (l) => said.push(l), pollMs: 5, parents: [] }).then((t) => ((got = true), t));
  while (!said.length) await Bun.sleep(1);
  expect(said[0]).toContain("place 2 in the queue");
  expect(got).toBe(false);
  rmSync(join(queue, "000000000000001-1"));
  (await waiting).free();
  expect(readdirSync(queue)).toEqual([]);
});

test("a run that the lock's holder started has its turn already", async () => {
  const d = dir();
  const free = takeLock(d, "tests", "the gate's run");
  const turn = await takeTurn({ dir: d, what: "its bun run test", log: () => {}, parents: [process.pid] });
  expect(turn.waitedMs).toBe(0);
  turn.free();
  expect(existsSync(lockPath(d, "tests"))).toBe(true);
  free();
});

// What the room must still write of each file (document/writes.ts): one state for each path, a write that takes
// what's due, and a commit that fails gives it back and waits longer each time.

import { expect, test } from "bun:test";
import { NOTHING, nextWrites, retryIn, type Look, type Writes } from "../document/writes";

const looks = (m: Record<string, Look>) => (p: string) => m[p] ?? "text";
const write = (w: Writes, now: number, all = false, look = looks({})) => nextWrites(w, { on: "write", now, all, fileDelay: 2000, look });

test("an edited file waits fileDelay, then goes; one removed goes at once; one as storage has it is dropped", () => {
  let w = nextWrites(NOTHING, { on: "edited", paths: ["a.html", "same.html"] }).writes;
  w = nextWrites(w, { on: "removed", path: "old.html" }).writes;
  const first = write(w, 1000, false, looks({ "same.html": "same" }));
  expect(first.commit).toEqual({ write: [], remove: ["old.html"], later: ["a.html"] });
  expect([...first.writes.paths]).toEqual([["a.html", "waiting"]]);
  expect(first.writes.since).toBe(1000);
  // An edit to a waiting file doesn't make it wait longer.
  w = nextWrites(first.writes, { on: "edited", paths: ["a.html"] }).writes;
  expect(write(w, 2500).commit!.later).toEqual(["a.html"]);
  const due = write(w, 3000);
  expect(due.commit).toEqual({ write: ["a.html"], remove: [], later: [] });
  expect(due.writes).toEqual({ paths: new Map(), since: 0, failures: 0 });
});

test("one state for each path: a removed file written again is edited; a blob put there needs no write", () => {
  let w = nextWrites(NOTHING, { on: "removed", path: "x.html" }).writes;
  w = nextWrites(w, { on: "edited", paths: ["x.html"] }).writes;
  expect(write(w, 0, true).commit).toEqual({ write: ["x.html"], remove: [], later: [] });
  w = nextWrites(w, { on: "stored", path: "x.html" }).writes;
  expect(w.paths.size).toBe(0);
});

test("a commit that fails gives its files back, and the writer waits longer after each failure, up to a minute", () => {
  let w = nextWrites(NOTHING, { on: "edited", paths: ["a.html", "b.html"] }).writes;
  w = nextWrites(w, { on: "removed", path: "gone.html" }).writes;
  const t = write(w, 0, true);
  // b.html is edited again while the commit runs.
  w = nextWrites(t.writes, { on: "edited", paths: ["b.html"] }).writes;
  w = nextWrites(w, { on: "failed", commit: t.commit! }).writes;
  expect(Object.fromEntries(w.paths)).toEqual({ "a.html": "waiting", "b.html": "edited", "gone.html": "removed" });
  expect(retryIn(w, 400)).toBe(800);
  w = nextWrites(w, { on: "failed", commit: t.commit! }).writes;
  expect(retryIn(w, 400)).toBe(1600);
  expect(retryIn({ ...w, failures: 20 }, 400)).toBe(60_000);
  w = nextWrites(w, { on: "committed" }).writes;
  expect(retryIn(w, 400)).toBe(400);
});

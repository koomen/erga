// The homepage's two pure machines: what / does with its copies of the snapshot (server/home/snapshot.ts), and the
// deploy state (server/home/deploy-state.ts). No IO.

import { expect, test } from "bun:test";
import { type Deploy, type Event, INITIAL, next, RETRY_MS } from "../server/home/deploy-state.ts";
import { type Copy, decide, KEEP_MS, kept, type LivePage, settle, STALE_MAX_MS } from "../server/home/snapshot.ts";

const page: LivePage = {
  gen: "g1",
  docId: "d1",
  address: "/_home",
  before: "<h1>Home</h1>",
  after: "",
  files: ["index.html"],
  site: { bars: true, redirects: [] },
  at: 1,
  version: 3,
};
const copy = (checked: number): Copy => ({ page, checked });

test("decide: a fresh copy serves; a stale one serves and asks after; a too old one never serves", () => {
  expect(decide(copy(1000), undefined, 2000, 5000)).toEqual({ do: "serve", copy: copy(1000), refresh: false });
  expect(decide(copy(1000), undefined, 7000, 5000)).toEqual({ do: "serve", copy: copy(1000), refresh: true });
  // Older than STALE_MAX_MS: a later deploy may have deleted its files. The edge's copy may be newer.
  expect(decide(copy(0), undefined, STALE_MAX_MS, 5000)).toEqual({ do: "cache" });
  expect(decide(copy(0), copy(STALE_MAX_MS - 1), STALE_MAX_MS, 5000)).toEqual({
    do: "serve",
    copy: copy(STALE_MAX_MS - 1),
    refresh: false,
  });
  expect(decide(copy(0), null, STALE_MAX_MS, 5000)).toEqual({ do: "ask" });
  expect(decide(null, undefined, 0, 5000)).toEqual({ do: "cache" });
  expect(decide(copy(1000), copy(1000), 1000, 0)).toEqual({ do: "ask" });
});

test("settle: an answer of another shape, or `same` for a snapshot forgotten meanwhile, keeps the copy as it was", () => {
  const { site: _, ...old } = page;
  expect(settle(null, { same: false, page: old }, 5)).toBe("keep");
  expect(settle(null, { same: true, gen: "g1" }, 5)).toBe("keep");
  expect(settle(page, { same: true, gen: "g1" }, 5)).toEqual(copy(5));
  expect(settle(page, { same: false, page: { ...page, gen: "g2" } }, 5)).toEqual({ page: { ...page, gen: "g2" }, checked: 5 });
  expect(settle(page, null, 5)).toBeNull();
});

test("kept: a deploy keeps the snapshot before, and every one an isolate may still serve", () => {
  const first = kept("g2", "g1", [], 1000);
  expect([...first.keep].sort()).toEqual(["g1", "g2"]);
  const second = kept("g3", "g2", first.retired, 2000);
  expect([...second.keep].sort()).toEqual(["g1", "g2", "g3"]);
  expect([...kept("g4", "g3", second.retired, 1000 + KEEP_MS).keep].sort()).toEqual(["g2", "g3", "g4"]);
});

/** The state after these events, and every effect on the way. */
function run(events: Event[], s: Deploy = INITIAL) {
  const fx = [];
  for (const e of events) {
    const r = next(s, e);
    s = r.s;
    fx.push(r.fx);
  }
  return { s, fx };
}
const ok = (epoch = 0, docId: string | null = "d1"): Event => ({ type: "ran", epoch, outcome: { docId }, now: 10 });
const failed = (now: number, epoch = 0): Event => ({ type: "ran", epoch, outcome: { error: "broken" }, now });

test("a deploy runs on the alarm, and ends deployed", () => {
  const r = run([{ type: "home", doc: "d1", liveDoc: null }, { type: "alarm" }, ok(1)]);
  expect(r.fx[0]).toEqual({ drop: true, tell: [null, "d1"], alarm: "set" });
  expect(r.fx[1]).toEqual({ tell: ["d1"], run: 1 });
  expect(r.s).toMatchObject({ state: "deployed", docId: "d1", running: false });
});

test("a deploy asked for after the run ended, while it still tells its end, sets the alarm, and the alarm runs it", () => {
  const deployed = run([{ type: "deploy", by: "ada" }, { type: "alarm" }, ok()]).s;
  const r = run([{ type: "deploy", by: "ada" }, { type: "alarm" }], deployed);
  expect(r.fx[0].alarm).toBe("set");
  expect(r.fx[1].run).toBe(0);
});

test("a deploy asked for while one runs runs once more after it", () => {
  const r = run([{ type: "deploy", by: "ada" }, { type: "alarm" }, { type: "deploy", by: "bo" }, { type: "alarm" }, ok(), ok()]);
  expect(r.fx[3]).toEqual({});
  expect(r.fx[4].run).toBe(0);
  expect(r.s).toMatchObject({ state: "deployed", by: "bo", running: false });
});

test("a new homepage during a run throws the run away and deploys the new one after it", () => {
  const r = run([{ type: "deploy", by: null }, { type: "alarm" }, { type: "home", doc: "d2", liveDoc: "d1" }, ok(0, "d1"), ok(1, "d2")]);
  expect(r.fx[2].alarm).toBeUndefined();
  expect(r.fx[3].run).toBe(1);
  expect(r.s).toMatchObject({ state: "deployed", docId: "d2" });
});

test("a homepage that always fails, with no snapshot: a / starts no other deploy before RETRY_MS", () => {
  const s = run([{ type: "home", doc: "d1", liveDoc: null }, { type: "alarm" }, failed(100, 1)]).s;
  expect(s).toMatchObject({ state: "failed", error: "broken" });
  expect(next(s, { type: "ensure", doc: "d1", live: false, now: 100 + RETRY_MS - 1 }).fx).toEqual({});
  expect(next(s, { type: "ensure", doc: "d1", live: false, now: 100 + RETRY_MS })).toMatchObject({
    s: { state: "deploying" },
    fx: { alarm: "set" },
  });
  // Deploy does at once.
  expect(next(s, { type: "deploy", by: "ada" }).fx.alarm).toBe("set");
});

test("load: a run stopped in the middle runs again; a stored state of another shape is what the snapshot says", () => {
  const running = run([{ type: "deploy", by: null }, { type: "alarm" }]).s;
  expect(next(INITIAL, { type: "load", stored: running, liveDoc: null })).toEqual({
    s: { ...running, running: false },
    fx: { alarm: "set" },
  });
  const old = { state: "deployed", at: 1, version: 3, error: null, docId: "d1", again: false };
  expect(next(INITIAL, { type: "load", stored: old, liveDoc: "d1" }).s).toMatchObject({ state: "deployed", docId: "d1", running: false });
  expect(next(INITIAL, { type: "load", stored: undefined, liveDoc: null }).s).toEqual(INITIAL);
});

test("forget: the homepage's document goes, and so does its snapshot", () => {
  const s = run([{ type: "deploy", by: null }, { type: "alarm" }, ok()]).s;
  expect(next(s, { type: "forget", docId: "other", liveDoc: "d1" }).fx).toEqual({});
  expect(next(s, { type: "forget", docId: "d1", liveDoc: "d1" })).toEqual({
    s: { ...INITIAL, epoch: 1 },
    fx: { drop: true, alarm: "delete" },
  });
});

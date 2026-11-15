// A domain's two pure machines: what a request does with its copies of the snapshot (server/sites/snapshot.ts), and
// the domain's publishing state (server/sites/state.ts). No IO.

import { expect, test } from "bun:test";
import { type Event, FREE, type Site, statusOf, step } from "../server/sites/state.ts";
import { type Copy, decide, KEEP_MS, kept, type LivePage, type Served, settle, STALE_MAX_MS, tagOf } from "../server/sites/snapshot.ts";

const page: LivePage = {
  gen: "g1",
  docId: "d1",
  address: "/_home",
  before: "<h1>Home</h1>",
  after: "",
  files: ["index.html"],
  site: { redirects: [] },
  at: 1,
  version: 3,
};
const served: Served = { page, bars: true };
const copy = (checked: number): Copy => ({ served, checked });

test("decide: a fresh copy serves; a stale one serves and asks after; a too old one never serves", () => {
  expect(decide(copy(1000), undefined, 2000, 5000)).toEqual({ do: "serve", copy: copy(1000), refresh: false });
  expect(decide(copy(1000), undefined, 7000, 5000)).toEqual({ do: "serve", copy: copy(1000), refresh: true });
  // Older than STALE_MAX_MS: a later publish may have deleted its files. The edge's copy may be newer.
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

test("settle: an answer of another shape, or `same` for a copy forgotten meanwhile, keeps the copy as it was", () => {
  const { site: _, ...old } = page;
  expect(settle(null, { same: false, served: { page: old, bars: true } }, 5)).toBe("keep");
  expect(settle(null, { same: true, tag: tagOf(served) }, 5)).toBe("keep");
  expect(settle(served, { same: true, tag: tagOf(served) }, 5)).toEqual(copy(5));
  // Another snapshot, or the header bar turned off, is another copy.
  const next = { page: { ...page, gen: "g2" }, bars: true };
  expect(settle(served, { same: false, served: next }, 5)).toEqual({ served: next, checked: 5 });
  expect(tagOf({ page, bars: false })).not.toBe(tagOf(served));
  expect(settle(served, null, 5)).toBeNull();
});

test("kept: a publish keeps the snapshot before, and every one an isolate may still serve", () => {
  const first = kept("g2", "g1", [], 1000);
  expect([...first.keep].sort()).toEqual(["g1", "g2"]);
  const second = kept("g3", "g2", first.retired, 2000);
  expect([...second.keep].sort()).toEqual(["g1", "g2", "g3"]);
  expect([...kept("g4", "g3", second.retired, 1000 + KEEP_MS).keep].sort()).toEqual(["g2", "g3", "g4"]);
});

/** The state after these events, and every effect on the way. */
function run(events: Event[], s: Site = FREE) {
  const fx = [];
  for (const e of events) {
    const r = step(s, e);
    s = r.s;
    fx.push(r.fx);
  }
  return { s, fx };
}
const link = (doc = "d1", bars = true): Event => ({ type: "link", doc, bars, by: "ada", at: 5 });
const replace = (doc: string): Event => ({ type: "replace", doc, bars: false, by: "bo", at: 6 });
const publish = (doc = "d1", by = "ada"): Event => ({ type: "publish", doc, by });
const ready = (epoch: number, doc = "d1", version = 3): Event => ({ type: "ready", epoch, live: { doc, version, at: 10 } });
const fail = (epoch: number): Event => ({ type: "fail", epoch, error: "broken" });
/** d1, linked and published: its version 3 is live. */
const published = () => run([link(), publish(), { type: "alarm" }, ready(1)]).s;

test("a link publishes nothing: the domain is linked, and serves nothing until a publish", () => {
  const r = run([link()]);
  expect(r.s).toMatchObject({ state: "linked", doc: "d1", bars: true, live: null, linked: { at: 5, by: "ada" } });
  expect(r.fx[0]).toEqual({ alarm: "delete", tell: ["d1"] });
  expect(statusOf(r.s)).toMatchObject({ state: "linked", doc: "d1", live: null });
});

test("a publish runs on the alarm, and ends published, with its version live", () => {
  const r = run([link(), publish(), { type: "alarm" }, ready(1)]);
  expect(r.fx[1]).toEqual({ alarm: "set", tell: ["d1"] });
  expect(r.fx[2]).toEqual({ tell: ["d1"], run: { epoch: 1, doc: "d1" } });
  expect(r.s).toMatchObject({ state: "published", doc: "d1", by: "ada", running: false, live: { doc: "d1", version: 3 } });
});

test("a publish of a document that the domain doesn't have is refused: it names the one that has it", () => {
  expect(step(FREE, publish()).fx).toEqual({ refused: { unlinked: true } });
  expect(step(published(), publish("d2")).fx).toEqual({ refused: { claimed: "d1" } });
});

test("a link to a claimed domain is refused; a replace links the new document, and the old version stays live", () => {
  const s = published();
  expect(step(s, link("d2"))).toEqual({ s, fx: { refused: { claimed: "d1" } } });
  const r = step(s, replace("d2"));
  expect(r.s).toMatchObject({ state: "linked", doc: "d2", bars: false, live: { doc: "d1", version: 3 }, epoch: 2 });
  expect(r.fx).toEqual({ alarm: "delete", tell: ["d1", "d2"] });
  // The new document's publish replaces what is live.
  expect(run([publish("d2", "bo"), { type: "alarm" }, ready(2, "d2", 1)], r.s).s).toMatchObject({
    state: "published",
    live: { doc: "d2", version: 1 },
  });
});

test("the header bar of the domain's own document changes at once, with no publish", () => {
  const s = published();
  const r = step(s, link("d1", false));
  expect(r.s).toMatchObject({ state: "published", bars: false, epoch: 1, live: { doc: "d1" } });
  expect(r.fx).toEqual({ tell: ["d1"] });
  expect(step(s, link("d1", true))).toEqual({ s, fx: {} });
});

test("unlink (Not published): the domain is free at once, and its snapshot goes", () => {
  const s = published();
  expect(step(s, { type: "unlink", doc: "other" })).toEqual({ s, fx: {} });
  expect(step(s, { type: "unlink", doc: "d1" })).toEqual({ s: { ...FREE, epoch: 2 }, fx: { drop: true, alarm: "delete", tell: ["d1"] } });
});

test("a publish asked for after the run ended sets the alarm, and the alarm runs it", () => {
  const r = run([publish(), { type: "alarm" }], published());
  expect(r.fx[0].alarm).toBe("set");
  expect(r.fx[1].run).toEqual({ epoch: 1, doc: "d1" });
});

test("a publish asked for while one runs runs once more after it", () => {
  const r = run([link(), publish(), { type: "alarm" }, publish("d1", "bo"), { type: "alarm" }, ready(1), ready(1)]);
  expect(r.fx[4]).toEqual({});
  expect(r.fx[5].run).toEqual({ epoch: 1, doc: "d1" });
  expect(r.s).toMatchObject({ state: "published", by: "bo", running: false });
});

test("a replace during a run throws the run away; the new document publishes only when asked", () => {
  const r = run([link(), publish(), { type: "alarm" }, replace("d2"), ready(1)]);
  expect(r.s).toMatchObject({ state: "linked", doc: "d2", running: false, live: null });
  // Asked while the old run still goes: it runs when that one ends.
  const again = run([link(), publish(), { type: "alarm" }, replace("d2"), publish("d2"), { type: "alarm" }, fail(1), ready(2, "d2")]);
  expect(again.fx[5]).toEqual({});
  expect(again.fx[6].run).toEqual({ epoch: 2, doc: "d2" });
  expect(again.s).toMatchObject({ state: "published", live: { doc: "d2" } });
});

test("a failed publish leaves the last live version, with the error", () => {
  const r = run([publish(), { type: "alarm" }, fail(1)], published());
  expect(r.s).toMatchObject({ state: "failed", error: "broken", live: { doc: "d1", version: 3 } });
  expect(statusOf(r.s).error).toBe("broken");
  expect(step(r.s, publish()).fx.alarm).toBe("set");
});

test("load: a run stopped in the middle runs again; a stored state of another shape is what the snapshot says", () => {
  const running = run([link(), publish(), { type: "alarm" }]).s;
  expect(step(FREE, { type: "load", stored: running, live: null })).toEqual({ s: { ...running, running: false }, fx: { alarm: "set" } });
  // The homepage's deploy state of the release before, with its snapshot: the same document, published to the domain.
  const old = { state: "deployed", docId: "d1", by: null, epoch: 4, running: false };
  const live = { doc: "d1", version: 7, at: 1 };
  expect(step(FREE, { type: "load", stored: old, live }).s).toEqual({
    state: "published",
    doc: "d1",
    bars: true,
    live,
    linked: null,
    by: null,
    epoch: 0,
    running: false,
  });
  expect(step(FREE, { type: "load", stored: old, live: null }).s).toEqual(FREE);
  expect(step(FREE, { type: "load", stored: undefined, live: null }).s).toEqual(FREE);
  // A published state whose snapshot is gone is linked: the domain serves nothing.
  expect(step(FREE, { type: "load", stored: published(), live: null }).s).toMatchObject({ state: "linked", doc: "d1", live: null });
});

test("forget: a deleted document leaves its domain free; a replaced one's version goes, and the link stays", () => {
  const s = published();
  expect(step(s, { type: "forget", doc: "other" }).fx).toEqual({});
  expect(step(s, { type: "forget", doc: "d1" })).toEqual({ s: { ...FREE, epoch: 2 }, fx: { drop: true, alarm: "delete", tell: ["d1"] } });
  const replaced = step(s, replace("d2")).s;
  expect(step(replaced, { type: "forget", doc: "d1" })).toEqual({ s: { ...replaced, live: null }, fx: { drop: true } });
});

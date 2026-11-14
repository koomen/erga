// The page editor's one state (libs/text/ui/frame-state.ts): each step, with no page and no room.
import { expect, test } from "bun:test";
import { step, type Editing, type FrameEvent, type State } from "../libs/text/ui/frame-state.ts";

const mode = (key = "k1"): Editing => ({
  type: "erga-mode",
  mode: "edit",
  doc: "https://erga.dev/d/1",
  key,
  me: { kind: "person", name: "Pete", color: "#000" } as Editing["me"],
  path: "index.html",
  tab: "t",
  zoom: 1,
  tall: 800,
  pinched: false,
});

/** The steps in turn, from idle: the state after the last, and every effect on the way. */
function run(...events: FrameEvent[]) {
  let s: State = { phase: "idle", run: 0 };
  const effects: string[] = [];
  for (const e of events) {
    const n = step(s, e);
    s = n.state;
    effects.push(...n.effects);
  }
  return { phase: s.phase, run: s.run, effects };
}

test("edit: the page loads, the editor joins the room, then edits", () => {
  expect(run({ type: "edit", mode: mode() }, { type: "loaded", run: 1 }, { type: "joined", run: 1 })).toEqual({
    phase: "editing",
    run: 1,
    effects: ["start", "join", "edit"],
  });
});

test("edit again (a new key) changes the key, and starts nothing", () => {
  let s: State = { phase: "idle", run: 0 };
  s = step(s, { type: "edit", mode: mode("k1") }).state;
  const n = step(s, { type: "edit", mode: mode("k2") });
  expect(n.effects).toEqual([]);
  expect("mode" in n.state && n.state.mode.key).toBe("k2");
});

test("view during a wait: its end does nothing", () => {
  // Before the page loaded.
  expect(run({ type: "edit", mode: mode() }, { type: "view" }, { type: "loaded", run: 1 })).toEqual({
    phase: "stopped",
    run: 1,
    effects: ["start", "stop"],
  });
  // Before the room answered.
  expect(run({ type: "edit", mode: mode() }, { type: "loaded", run: 1 }, { type: "view" }, { type: "joined", run: 1 }).effects).toEqual([
    "start",
    "join",
    "stop",
  ]);
});

test("view while the page waits to load again: it doesn't load again", () => {
  const r = run(
    { type: "edit", mode: mode() },
    { type: "loaded", run: 1 },
    { type: "joined", run: 1 },
    { type: "reload" },
    { type: "view" },
    { type: "flushed", run: 1 }
  );
  expect(r).toEqual({ phase: "stopped", run: 1, effects: ["start", "join", "edit", "flush", "stop"] });
});

test("a reload loads the page again once the room has the edits; a second asks for nothing more", () => {
  const r = run(
    { type: "edit", mode: mode() },
    { type: "loaded", run: 1 },
    { type: "joined", run: 1 },
    { type: "reload" },
    { type: "reload" },
    { type: "flushed", run: 1 }
  );
  expect(r).toEqual({ phase: "reloading", run: 1, effects: ["start", "join", "edit", "flush", "reload"] });
});

test("a wait of an earlier run doesn't count in a later one", () => {
  const r = run(
    { type: "edit", mode: mode() },
    { type: "view" },
    { type: "edit", mode: mode() },
    { type: "loaded", run: 1 },
    { type: "loaded", run: 2 }
  );
  expect(r).toEqual({ phase: "joining", run: 2, effects: ["start", "stop", "start", "join"] });
});

test("the room doesn't answer: the editor waits for it again, then edits", () => {
  const r = run(
    { type: "edit", mode: mode() },
    { type: "loaded", run: 1 },
    { type: "failed", run: 1 },
    { type: "failed", run: 1 },
    { type: "joined", run: 1 }
  );
  expect(r).toEqual({ phase: "editing", run: 1, effects: ["start", "join", "retry", "retry", "edit"] });
});

test("view before the editor ever started still stops (the keys held for it go back to the page)", () => {
  expect(run({ type: "view" })).toEqual({ phase: "stopped", run: 0, effects: ["stop"] });
});

test("a reload asked for outside the editor does nothing", () => {
  expect(run({ type: "reload" })).toEqual({ phase: "idle", run: 0, effects: [] });
  expect(run({ type: "edit", mode: mode() }, { type: "reload" }).effects).toEqual(["start"]);
});

// Where a replica's first state comes from, with no replica (libs/text/ui/replica-state.ts): the start's answer, the
// socket's first sync, or what this browser kept.

import { expect, test } from "bun:test";
import {
  holdsState,
  replicaStep,
  STARTING,
  type Replica,
  type ReplicaDo,
  type ReplicaEvent,
} from "../libs/text/ui/replica-state";

function run(r: Replica, ...events: ReplicaEvent[]) {
  const effects: ReplicaDo[] = [];
  for (const e of events) {
    const t = replicaStep(r, e);
    r = t.state;
    effects.push(...t.effects);
  }
  return { state: r, effects };
}
const started = (got: boolean, kept: boolean, connecting = false): ReplicaEvent => ({ type: "started", got, kept, connecting });

test("the start brings the state: what this browser kept goes in first, then the hello, then the editor starts", () => {
  expect(run(STARTING, started(true, true))).toEqual({ state: { at: "room" }, effects: ["merge", "greet", "ready", "ask"] });
  expect(run(STARTING, started(true, false)).effects).toEqual(["greet", "ready", "ask"]);
});

test("the start brings nothing: the socket's sync brings the state, with what this browser kept", () => {
  const empty = run(STARTING, started(false, true));
  expect(empty).toEqual({ state: { at: "empty", kept: true, failed: false }, effects: ["ask"] });
  expect(holdsState(empty.state)).toBe(false);
  expect(run(empty.state, { type: "synced" })).toEqual({ state: { at: "room" }, effects: ["merge", "ready"] });
  expect(run(STARTING, started(false, false), { type: "synced" }).effects).toEqual(["ask", "ready"]);
});

test("no room to reach, and this browser kept the replica: it opens from there, whichever fails first", () => {
  // The socket fails, then the start answers with nothing.
  expect(run(STARTING, { type: "failed" }, started(false, true, true))).toEqual({ state: { at: "kept" }, effects: ["openKept", "ready"] });
  // The start answers with nothing, then the socket fails.
  expect(run(STARTING, started(false, true, true), { type: "failed" })).toEqual({
    state: { at: "kept" },
    effects: ["ask", "openKept", "ready"],
  });
  // The socket failed before, but it is open again as the start answers: the sync will bring the state.
  expect(run(STARTING, { type: "failed" }, started(false, true, false)).state.at).toBe("empty");
  // Nothing kept: it waits for the room.
  const waits = run(STARTING, { type: "failed" }, started(false, false, true), { type: "failed" });
  expect(waits).toEqual({ state: { at: "empty", kept: false, failed: true }, effects: ["ask"] });
});

test("a replica open from what this browser kept joins the room at the socket's sync; nothing goes in twice", () => {
  const kept = run(STARTING, { type: "failed" }, started(false, true, true)).state;
  expect(holdsState(kept)).toBe(true);
  expect(run(kept, { type: "synced" })).toEqual({ state: { at: "room" }, effects: [] });
  expect(run({ at: "room" }, { type: "synced" }, { type: "failed" }, started(true, true))).toEqual({ state: { at: "room" }, effects: [] });
});

test("the socket syncs before the start answers: the editor starts, and what this browser kept goes in when it is read", () => {
  const early = run(STARTING, { type: "synced" });
  expect(early).toEqual({ state: { at: "starting", synced: true, failed: false }, effects: ["ready"] });
  expect(holdsState(early.state)).toBe(true);
  expect(run(early.state, { type: "failed" }).state).toEqual(early.state);
  expect(run(early.state, started(false, true))).toEqual({ state: { at: "room" }, effects: ["merge", "ask"] });
});

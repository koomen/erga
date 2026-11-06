// The page editor's one state (frame.ts), and what moves it: the viewer's word (edit, view), and the end of each of the
// editor's waits. Each wait carries the run it began in, and its end counts only in that run and in the state that
// waits for it: a "view" during a wait ends it.
//
//   idle | stopped --edit--> starting --loaded--> joining --joined--> editing --reload--> reloading --flushed--> (the page loads again)
//   joining --failed--> joining (it waits for the room again, and says so)
//   any --view--> stopped (the editor stops, and lets go of the keys it held)

import type { EditMode } from "./mode";

export type Editing = Extract<EditMode, { mode: "edit" }>;

export type State =
  | { phase: "idle" | "stopped"; run: number }
  | { phase: "starting" | "joining" | "editing" | "reloading"; run: number; mode: Editing };

export type FrameEvent =
  /** The viewer says edit: the first time, or again with a new key or zoom. */
  | { type: "edit"; mode: Editing }
  | { type: "view" }
  /** The page has loaded, and the browser's copy is ready. */
  | { type: "loaded"; run: number }
  /** The first sync with the room is done. */
  | { type: "joined"; run: number }
  /** The room didn't answer in time. */
  | { type: "failed"; run: number }
  /** The editor asks for the page made afresh from the text. */
  | { type: "reload" }
  /** The room has this editor's edits (or the wait for them ended). */
  | { type: "flushed"; run: number };

/**
 * What frame.ts does on a step: start (wait for the page's load), join (the room), retry (wait for the room again),
 * edit (the editor on the page), flush (wait for the room to have the edits), reload (the page loads again), stop.
 */
export type Effect = "start" | "join" | "retry" | "edit" | "flush" | "reload" | "stop";

export function step(s: State, e: FrameEvent): { state: State; effects: Effect[] } {
  const none = { state: s, effects: [] };
  switch (e.type) {
    case "view":
      return { state: { phase: "stopped", run: s.run }, effects: ["stop"] };
    case "edit":
      if (!("mode" in s)) return { state: { phase: "starting", run: s.run + 1, mode: e.mode }, effects: ["start"] };
      return { state: { ...s, mode: e.mode }, effects: [] };
    case "reload":
      return s.phase == "editing" ? { state: { ...s, phase: "reloading" }, effects: ["flush"] } : none;
  }
  // The end of a wait: only in its own run, and in the state that waits for it.
  if (e.run != s.run) return none;
  if (e.type == "loaded" && s.phase == "starting") return { state: { ...s, phase: "joining" }, effects: ["join"] };
  if (e.type == "joined" && s.phase == "joining") return { state: { ...s, phase: "editing" }, effects: ["edit"] };
  if (e.type == "failed" && s.phase == "joining") return { state: s, effects: ["retry"] };
  if (e.type == "flushed" && s.phase == "reloading") return { state: s, effects: ["reload"] };
  return none;
}

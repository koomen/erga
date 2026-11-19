// The page editor's one state (frame.ts), and what moves it: the viewer's word (edit, standby, view), and the end of
// each of the editor's waits. Each wait carries the run it began in, and its end counts only in that run and in the
// state that waits for it: a "view" during a wait ends it.
//
//   idle | stopped --edit or standby--> starting --loaded--> joining --joined--> standby or editing (the last word)
//   standby --edit--> editing --standby--> standby (in the room all the while: nothing to wait for)
//   editing --reload--> reloading --flushed--> (the page loads again)
//   joining --failed--> joining (it waits for the room again, and says so)
//   any --view--> stopped (the editor stops, leaves the room, and lets go of the keys it held)

import type { EditMode } from "./mode";

/** The viewer's word, edit or standby, with what both say: where the room is, the key, who this is. */
export type Editing = Exclude<EditMode, { mode: "view" }>;

/** (While it starts and joins, `mode` is the last word: where it goes once it is in the room.) */
export type State =
  | { phase: "idle" | "stopped"; run: number }
  | { phase: "starting" | "joining" | "standby" | "editing" | "reloading"; run: number; mode: Editing };

export type FrameEvent =
  /** The viewer says edit or standby: the first time, the other one, or the same again with a new key. */
  | { type: "told"; mode: Editing }
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
 * edit (the editor on the page), rest (the editor off the page, still in the room), flush (wait for the room to have
 * the edits), reload (the page loads again), stop (off the page and out of the room).
 */
export type Effect = "start" | "join" | "retry" | "edit" | "rest" | "flush" | "reload" | "stop";

export function step(s: State, e: FrameEvent): { state: State; effects: Effect[] } {
  const none = { state: s, effects: [] };
  switch (e.type) {
    case "view":
      return { state: { phase: "stopped", run: s.run }, effects: ["stop"] };
    case "told": {
      if (!("mode" in s)) return { state: { phase: "starting", run: s.run + 1, mode: e.mode }, effects: ["start"] };
      const edit = e.mode.mode == "edit";
      if (s.phase == "standby" && edit) return { state: { ...s, phase: "editing", mode: e.mode }, effects: ["edit"] };
      // (Standby as it loads again: the page stays, as for "view".)
      if ((s.phase == "editing" || s.phase == "reloading") && !edit)
        return { state: { ...s, phase: "standby", mode: e.mode }, effects: ["rest"] };
      return { state: { ...s, mode: e.mode }, effects: [] };
    }
    case "reload":
      return s.phase == "editing" ? { state: { ...s, phase: "reloading" }, effects: ["flush"] } : none;
  }
  // The end of a wait: only in its own run, and in the state that waits for it.
  if (e.run != s.run) return none;
  if (e.type == "loaded" && s.phase == "starting") return { state: { ...s, phase: "joining" }, effects: ["join"] };
  if (e.type == "joined" && s.phase == "joining")
    return s.mode.mode == "edit"
      ? { state: { ...s, phase: "editing" }, effects: ["edit"] }
      : { state: { ...s, phase: "standby" }, effects: [] };
  if (e.type == "failed" && s.phase == "joining") return { state: s, effects: ["retry"] };
  if (e.type == "flushed" && s.phase == "reloading") return { state: s, effects: ["reload"] };
  return none;
}

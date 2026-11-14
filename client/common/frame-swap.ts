// The document's page loads again (an edit that needs it) with no start position on the screen: the page that shows
// stays as it is, the new one loads in a second frame, out of sight, and takes the first one's place once it shows the
// same view (client/inline/reader.ts says erga-placed), or WAIT_MS after it is up. One state, and `step`, the one
// function that says what the viewer does. No IO here: client/inline/viewer-frames.ts does what `step` returns.
//
// Trap: a frame's entries in the tab's history go with the frame. A page whose frame has entries of its own (`deep`:
// a link to another of the document's pages was followed in it) loads again in that frame, so Back still works.
//
// Trap: the wait begins when the new page is up, not when its load begins. Until then the old page has the editor and
// the keys that the person types: a slow load that ended the wait lost them, with the old frame.

/**
 * `one`: one frame, which shows the page. `loading`: a second frame loads the page, under the first. `placing`: that
 * page is up, and has WAIT_MS to show its view. `n` counts the loads.
 */
export type Swap = { at: "one" | "loading" | "placing"; n: number };

export type SwapEvent =
  /** The page must load again. `deep`: its frame has entries of its own in the tab's history. */
  | { type: "reload"; deep: boolean }
  /** The page of load `n` is up: it said hello, or its frame's load ended (a page that says nothing). */
  | { type: "up"; n: number }
  /** The page of load `n` shows its view. */
  | { type: "placed"; n: number }
  /** WAIT_MS after the page of load `n` was up. */
  | { type: "timeout"; n: number };

/**
 * `mount`: a new frame with the page, under the one that shows. `replace`: the page loads in the frame that has it (the
 * one that shows, or the new one, out of sight still). `wait`: "timeout" for this load after WAIT_MS. `show`: the new
 * frame takes the old one's place.
 */
export type SwapEffect = "mount" | "replace" | "wait" | "show";

/** The new page shows this long after it is up, placed or not. */
export const WAIT_MS = 4000;

export const initial: Swap = { at: "one", n: 0 };

export function step(s: Swap, e: SwapEvent): { state: Swap; effects: SwapEffect[] } {
  const none = { state: s, effects: [] };
  switch (e.type) {
    case "reload":
      if (s.at != "one") return { state: { at: "loading", n: s.n + 1 }, effects: ["replace"] };
      if (e.deep) return { state: { at: "one", n: s.n + 1 }, effects: ["replace"] };
      return { state: { at: "loading", n: s.n + 1 }, effects: ["mount"] };
    case "up":
      return s.at == "loading" && e.n == s.n ? { state: { at: "placing", n: s.n }, effects: ["wait"] } : none;
    case "placed":
      return s.at != "one" && e.n == s.n ? { state: { at: "one", n: s.n }, effects: ["show"] } : none;
    case "timeout":
      return s.at == "placing" && e.n == s.n ? { state: { at: "one", n: s.n }, effects: ["show"] } : none;
  }
}

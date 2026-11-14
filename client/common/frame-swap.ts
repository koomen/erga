// The document's page loads again (an edit that needs it) with no start position on the screen: the page that shows
// stays as it is, the new one loads in a second frame, out of sight, and takes the first one's place once it shows the
// same view (client/inline/reader.ts says erga-placed), or after WAIT_MS. One state, and `step`, the one function that
// says what the viewer does. No IO here: client/inline/viewer-frames.ts does what `step` returns.
//
// Trap: a frame's entries in the tab's history go with the frame. A page whose frame has entries of its own (`deep`:
// a link to another of the document's pages was followed in it) loads again in that frame, so Back still works.

/** `one`: one frame, which shows the page. `two`: a second frame loads the page, under the first. `n` counts the loads. */
export type Swap = { at: "one" | "two"; n: number };

export type SwapEvent =
  /** The page must load again. `deep`: its frame has entries of its own in the tab's history. */
  | { type: "reload"; deep: boolean }
  /** The page of load `n` shows its view. */
  | { type: "placed"; n: number }
  /** WAIT_MS after load `n` began. */
  | { type: "timeout"; n: number };

/**
 * `mount`: a new frame with the page, under the one that shows. `replace`: the page loads in the frame that has it (the
 * one that shows, or the new one, out of sight still). `wait`: "timeout" for this load after WAIT_MS. `show`: the new
 * frame takes the old one's place.
 */
export type SwapEffect = "mount" | "replace" | "wait" | "show";

/** The new page shows after this long, placed or not. */
export const WAIT_MS = 4000;

export const initial: Swap = { at: "one", n: 0 };

export function step(s: Swap, e: SwapEvent): { state: Swap; effects: SwapEffect[] } {
  switch (e.type) {
    case "reload":
      if (s.at == "two") return { state: { at: "two", n: s.n + 1 }, effects: ["replace", "wait"] };
      if (e.deep) return { state: { at: "one", n: s.n + 1 }, effects: ["replace"] };
      return { state: { at: "two", n: s.n + 1 }, effects: ["mount", "wait"] };
    case "placed":
    case "timeout":
      return s.at == "two" && e.n == s.n ? { state: { at: "one", n: s.n }, effects: ["show"] } : { state: s, effects: [] };
  }
}

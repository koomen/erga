// The pages origin refused the pass of the page in the viewer's frame (server/documents/pages-origin.ts, refused): the
// viewer's page is an old one (the browser's copy of it: client/inline/offline-sw.ts; or a tab that stayed open), and
// its pass ended. The viewer asks the server for the page, one time, and loads it; with no answer it says so on the
// page, with Try again. One state, and `step`, the one function that says what the viewer does. No IO here:
// client/inline/viewer-refused.ts does what `step` returns.
//
//   ok --refused--> asking --fresh--> ok (the page loads again)
//                   asking --none--> failed --retry--> asking
//   ok --refused, again--> failed          (the page that just loaded again is refused too: no loop)

/** `ok`: nothing refused. `asking`: the viewer asks the server for the page. `failed`: the page says that it has none. */
export type Refused = "ok" | "asking" | "failed";

export type RefusedEvent =
  /** The frame's page was refused. `again`: this tab loaded a new page for a refusal a moment ago. */
  | { type: "refused"; again: boolean }
  /** The server answered the viewer's request for the page. */
  | { type: "fresh" }
  /** It did not answer. */
  | { type: "none" }
  /** Try again. */
  | { type: "retry" };

/** `ask`: ask the server for the page ("fresh" or "none"). `load`: load the page again, from the server. `say`: say that the page has none, with Try again. */
export type RefusedEffect = "ask" | "load" | "say";

export function step(s: Refused, e: RefusedEvent): { state: Refused; effects: RefusedEffect[] } {
  const none = { state: s, effects: [] };
  switch (e.type) {
    case "refused":
      if (s != "ok") return none;
      return e.again ? { state: "failed", effects: ["say"] } : { state: "asking", effects: ["ask"] };
    case "fresh":
      return s == "asking" ? { state: "ok", effects: ["load"] } : none;
    case "none":
      return s == "asking" ? { state: "failed", effects: ["say"] } : none;
    case "retry":
      return s == "failed" ? { state: "asking", effects: ["ask"] } : none;
  }
}

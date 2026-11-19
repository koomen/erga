// The save mark, left of the buttons' bar and touching it (server/pages/bars.ts, SAVE_MARK): a gray check while
// everything is saved, a gray circle that turns while something saves, a red x when a save failed. It is the one place that says so: no "Saved"
// note, no Save button. A hover says which it is. On the red x, a hover or a click opens its card, which says what failed
// and how it is tried again: a click keeps it open until Escape or a press anywhere else.
//
// The pointer over the mark is state here, not CSS's :hover: over a page in a frame of another site (the editor's), the
// browser may not say that the pointer left, and the frame's own pointer says so (`left`).
//
// Many things save at one time (the page editor's copy of the room, the shell's): each is a source, with a key. The mark
// shows the worst of them:
//
//   saved --a source saves--> saving --all saved, and HOLD_MS more--> saved
//   saving --a source fails--> error --it saves--> saving or saved
//
// One state, and `step`, the one function that says what the mark shows. No IO in it: `mountSaveMark` draws it.

import { ms } from "../../libs/text/ui/timescale";

export type At = "saved" | "saving" | "error";
/** Why a save failed, in the card: what failed, and how it is tried again. */
export interface Why {
  title: string;
  detail: string;
}
/** One thing that is not saved: `why` with an error. (A saved source is not in the state.) */
export interface Source {
  key: string;
  at: "saving" | "error";
  why?: Why;
}
export interface State {
  sources: Source[];
  /** The person opened the card with a click: it stays until they close it, or the error ends. */
  open: boolean;
  /** The pointer is over the mark or its card. */
  over: boolean;
  /**
   * What the mark shows: the worst of its sources, but the circle for HOLD_MS more after the last save. While a person
   * types, each key saves in a moment: the circle stays, and turns on, and the check comes when the typing rests.
   */
  shown: At;
  /** The number of the hold that runs: the end of an older one (something saved again meanwhile) counts for nothing. */
  n: number;
}
export type Event =
  /** A source's state now. */
  | { t: "set"; key: string; at: At; why?: Why }
  /** A click on the mark. */
  | { t: "press" }
  /** The pointer came over the mark or its card, or left. */
  | { t: "over"; on: boolean }
  /** Escape, or a press anywhere else. */
  | { t: "close" }
  /** A hold's end, with its number. */
  | { t: "held"; n: number };
export type Effect = { t: "draw" } | { t: "hold"; n: number };

/** How long the circle stays after the last save. */
export const HOLD_MS = 400;

export const initial: State = { sources: [], open: false, over: false, shown: "saved", n: 0 };

/** The worst of the sources: what the mark shows, but for the hold (State.shown). */
export const markOf = (s: State): At => (s.sources.some((x) => x.at == "error") ? "error" : s.sources.length ? "saving" : "saved");
/** What failed, for the card: each reason one time. */
export const failures = (s: State): Why[] =>
  s.sources
    .flatMap((x) => (x.at == "error" && x.why ? [x.why] : []))
    .filter((w, i, all) => all.findIndex((o) => o.title == w.title && o.detail == w.detail) == i);

export function step(s: State, e: Event): [State, Effect[]] {
  if (e.t == "set") {
    const was = s.sources.find((x) => x.key == e.key);
    if (was ? was.at == e.at && was.why?.title == e.why?.title && was.why?.detail == e.why?.detail : e.at == "saved") return [s, []];
    const others = s.sources.filter((x) => x != was);
    const sources = e.at == "saved" ? others : [...others, { key: e.key, at: e.at, ...(e.why ? { why: e.why } : {}) }];
    const next = { ...s, sources },
      worst = markOf(next);
    // The last one saved: the circle holds a moment more.
    if (worst == "saved" && s.shown == "saving") return [{ ...next, n: s.n + 1 }, [{ t: "hold", n: s.n + 1 }]];
    return [{ ...next, shown: worst, open: worst == "error" && s.open }, [{ t: "draw" }]];
  }
  if (e.t == "held")
    return e.n == s.n && s.shown == "saving" && markOf(s) == "saved" ? [{ ...s, shown: "saved" }, [{ t: "draw" }]] : [s, []];
  if (e.t == "press") return markOf(s) == "error" ? [{ ...s, open: !s.open }, [{ t: "draw" }]] : [s, []];
  if (e.t == "over") return e.on == s.over ? [s, []] : [{ ...s, over: e.on }, [{ t: "draw" }]];
  return s.open ? [{ ...s, open: false }, [{ t: "draw" }]] : [s, []];
}

const LABEL: Record<At, string> = { saved: "Saved", saving: "Saving…", error: "Not saved" };

/** The mark in `root` (SAVE_MARK's element): keeps the state and draws it. */
export function mountSaveMark(root: HTMLElement) {
  const mark = root.querySelector<HTMLButtonElement>(".save-mark")!,
    card = root.querySelector<HTMLElement>(".save-card")!;
  let state = initial;
  function draw() {
    const at = state.shown;
    root.dataset.at = at;
    root.classList.toggle("open", state.open);
    root.classList.toggle("over", state.over);
    mark.setAttribute("aria-label", LABEL[at]);
    mark.setAttribute("aria-expanded", String(state.open));
    // (The page's words, as text.)
    card.replaceChildren(
      ...failures(state).flatMap((w) => {
        const title = document.createElement("p"),
          detail = document.createElement("p");
        title.className = "save-title";
        title.textContent = w.title;
        detail.textContent = w.detail;
        return [title, detail];
      })
    );
  }
  function send(e: Event) {
    const [next, effects] = step(state, e);
    state = next;
    for (const f of effects) {
      if (f.t == "draw") draw();
      else setTimeout(() => send({ t: "held", n: f.n }), ms(HOLD_MS));
    }
  }
  mark.addEventListener("click", () => send({ t: "press" }));
  // (A finger has no hover: its tap is the click.)
  root.addEventListener("pointerenter", (e) => e.pointerType == "mouse" && send({ t: "over", on: true }));
  root.addEventListener("pointerleave", () => send({ t: "over", on: false }));
  document.addEventListener("pointerdown", (e) => {
    if (!e.composedPath().includes(root)) send({ t: "close" });
  });
  root.addEventListener("keydown", (e) => {
    if (e.key == "Escape" && state.open) {
      e.stopPropagation();
      send({ t: "close" });
    }
  });
  draw();
  return {
    /** A source's state now; `why` with an error. */
    set: (key: string, at: At, why?: Why) => send({ t: "set", key, at, ...(at == "error" && why ? { why } : {}) }),
    /** The pointer is somewhere else: in the page's frame, where this window hears no pointer. */
    left: () => send({ t: "over", on: false }),
    /** Closes the card, if the person opened it (Escape). False: it was not open. */
    close() {
      const open = state.open;
      send({ t: "close" });
      return open;
    },
  };
}

export type SaveMark = ReturnType<typeof mountSaveMark>;

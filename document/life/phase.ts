// A document's room through its life: closed, opening, open, closing (idle: its room writes its last edits), and
// destroying (deleted, or replaced by a snapshot: its storage is emptied). One value, and one pure step from it, so
// a call that comes at any moment does one clear thing: it uses the room, opens it, waits, or is refused. The Document
// (document.ts) keeps the value and does what each step says.

export type Phase<O> =
  | { is: "closed" }
  | { is: "opening"; load: Promise<O | null> }
  | { is: "open"; opened: O }
  | { is: "closing"; done: Promise<void> }
  | { is: "destroying"; done: Promise<void> };

export type PhaseEvent<O> =
  /** A call needs the room. */
  | { on: "use" }
  /** The room starts to load. */
  | { on: "load"; load: Promise<O | null> }
  /** It loaded (null: there's no such document, or it failed to open). */
  | { on: "loaded"; opened: O | null }
  /** Idle: the room starts to close. */
  | { on: "closing"; done: Promise<void> }
  | { on: "closed" }
  /** Its storage is about to go (a delete, a snapshot): what the room holds must be closed first. */
  | { on: "destroy" }
  | { on: "destroying"; done: Promise<void> }
  | { on: "destroyed" };

/** What the Document does after a step. */
export type PhaseDo<O> =
  /** Use the open room. */
  | { do: "use"; opened: O }
  /** Load the room (then `load`). */
  | { do: "load" }
  /** Wait for the room that loads, then step again. */
  | { do: "await"; load: Promise<O | null> }
  /** Wait for a close or a destroy, then step again. */
  | { do: "wait"; done: Promise<void> }
  /** There's no room to use: the document is going. */
  | { do: "refuse" }
  /** Close what the room becomes (null: nothing to close), then empty storage (then `destroying`). */
  | { do: "teardown"; room: Promise<O | null> };

export function next<O>(phase: Phase<O>, e: PhaseEvent<O>): { phase: Phase<O>; do?: PhaseDo<O> } {
  switch (e.on) {
    case "use":
      return { phase, do: use(phase) };
    case "load":
      return phase.is == "closed" ? { phase: { is: "opening", load: e.load } } : { phase };
    case "loaded":
      // A destroy that came meanwhile closes the room itself (its teardown awaits the load).
      if (phase.is != "opening") return { phase };
      return { phase: e.opened ? { is: "open", opened: e.opened } : { is: "closed" } };
    case "closing":
      return phase.is == "open" ? { phase: { is: "closing", done: e.done } } : { phase };
    case "closed":
      return phase.is == "closing" ? { phase: { is: "closed" } } : { phase };
    case "destroy":
      return { phase, do: destroy(phase) };
    case "destroying":
      return phase.is == "destroying" ? { phase } : { phase: { is: "destroying", done: e.done } };
    case "destroyed":
      return phase.is == "destroying" ? { phase: { is: "closed" } } : { phase };
  }
}

function use<O>(phase: Phase<O>): PhaseDo<O> {
  switch (phase.is) {
    case "closed":
      return { do: "load" };
    case "opening":
      return { do: "await", load: phase.load };
    case "open":
      return { do: "use", opened: phase.opened };
    case "closing":
      return { do: "wait", done: phase.done };
    case "destroying":
      return { do: "refuse" };
  }
}

function destroy<O>(phase: Phase<O>): PhaseDo<O> {
  switch (phase.is) {
    case "closed":
      return { do: "teardown", room: Promise.resolve(null) };
    case "opening":
      return { do: "teardown", room: phase.load.catch(() => null) };
    case "open":
      return { do: "teardown", room: Promise.resolve(phase.opened) };
    case "closing":
      return { do: "teardown", room: phase.done.then(() => null) };
    case "destroying":
      return { do: "wait", done: phase.done };
  }
}

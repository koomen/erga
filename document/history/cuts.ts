// The edits no version holds yet, and the cut that makes one (history.ts): clean, dirty (a burst of edits, and who
// made them), or cutting (the burst the cut takes, and the edits that came meanwhile). One value and one pure step
// from it; History keeps the value, runs the timers and notes in storage what each step says. A cut that fails gives
// its burst back, so the next cut takes it again.

/** A burst of edits: who made them (an edit by nobody known adds no one). */
export type Burst = readonly string[];

export type Cuts =
  | { is: "clean" }
  | { is: "dirty"; burst: Burst }
  /** `taken`: the burst the cut holds (null: a cut with no edits, as the room opens); `after`: edits since it began. */
  | { is: "cutting"; taken: Burst | null; after: Burst | null };

export type CutEvent =
  | { on: "edit"; author: string | null }
  /** A cut begins (one at a time). */
  | { on: "cut" }
  /** The cut ended: a version was stored (or nothing had changed), or it failed. */
  | { on: "cut-ended"; ok: boolean }
  /** Storage was emptied or replaced: nothing is pending. */
  | { on: "reset" };

/**
 * What History does after a step: "uncut" notes in storage that edits no version holds exist, "clean" that none
 * do; "idle" starts the idle timer again; "max" starts the timer of the burst's longest time; "stop" stops both.
 */
export type CutEffect = "uncut" | "clean" | "idle" | "max" | "stop";

const add = (b: Burst | null, author: string | null): Burst => {
  const authors = b ?? [];
  return author && !authors.includes(author) ? [...authors, author] : authors;
};

export function nextCut(s: Cuts, e: CutEvent): { cuts: Cuts; effects: CutEffect[] } {
  switch (e.on) {
    case "edit":
      if (s.is == "clean") return { cuts: { is: "dirty", burst: add(null, e.author) }, effects: ["uncut", "max", "idle"] };
      if (s.is == "dirty") return { cuts: { is: "dirty", burst: add(s.burst, e.author) }, effects: ["idle"] };
      return { cuts: { ...s, after: add(s.after, e.author) }, effects: s.after ? ["idle"] : ["uncut", "max", "idle"] };
    case "cut":
      if (s.is == "cutting") return { cuts: s, effects: [] };
      return { cuts: { is: "cutting", taken: s.is == "dirty" ? s.burst : null, after: null }, effects: ["stop"] };
    case "cut-ended":
      if (s.is != "cutting") return { cuts: s, effects: [] };
      if (e.ok) return s.after ? { cuts: { is: "dirty", burst: s.after }, effects: [] } : { cuts: { is: "clean" }, effects: ["clean"] };
      // Failed: the burst it took is pending again, with what came since, and its timers start again.
      if (!s.taken) return { cuts: s.after ? { is: "dirty", burst: s.after } : { is: "clean" }, effects: [] };
      return { cuts: { is: "dirty", burst: [...new Set([...s.taken, ...(s.after ?? [])])] }, effects: ["stop", "max", "idle"] };
    case "reset":
      return { cuts: { is: "clean" }, effects: ["stop"] };
  }
}

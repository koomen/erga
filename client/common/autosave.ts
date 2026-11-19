// A field that saves by itself: there is no Save button. A switch or a choice saves as soon as it changes; a field a
// person types in saves when the typing pauses (PAUSE_MS) or the focus leaves it. One save at a time: a change during a
// save sends the newest value after it, so the server ends with the last one shown. A refused save keeps the person's
// value in the field, and says why; the value the server has is `saved`.
//
//   idle --change--> waiting --pause, or the focus leaves--> saving --done--> idle
//   idle --change of a switch or a choice--> saving
//   saving --refused--> failed --change, or Try again--> waiting or saving
//   any --the value is the saved one again--> idle
//
// Each pause has a number, and its end carries it: the end of an older pause (the person typed on) counts for nothing.
// One state, and `autoStep`, the one function that says what happens. No IO in it: `autosave` keeps the timer, calls the
// save and tells the save mark (save-mark.ts).

import type { At, SaveMark } from "./save-mark";

/** How long the typing rests before a typed value is saved. */
export const PAUSE_MS = 800;

export interface Auto {
  at: "idle" | "waiting" | "saving" | "failed";
  /** What the field shows, and what the server has. */
  value: string;
  saved: string;
  /** What the save that runs, or the one that failed, sent. */
  sent: string;
  /** The number of the pause that runs. */
  n: number;
}
export type AutoEvent =
  /** The field shows `value` now. `now`: save at once (a switch, a choice, the focus left the field). */
  { t: "change"; value: string; now: boolean } | { t: "pause"; n: number } | { t: "done" } | { t: "refused"; why: string } | { t: "retry" };
export type AutoEffect = { t: "wait"; n: number } | { t: "save"; value: string } | { t: "mark"; at: At; why?: string };

export const autoStart = (saved: string): Auto => ({ at: "idle", value: saved, saved, sent: saved, n: 0 });

export function autoStep(s: Auto, e: AutoEvent): [Auto, AutoEffect[]] {
  const save = (value: string, mark = true): [Auto, AutoEffect[]] => [
    { ...s, at: "saving", value, sent: value },
    [{ t: "save", value }, ...(mark ? [{ t: "mark" as const, at: "saving" as const }] : [])],
  ];
  switch (e.t) {
    case "change": {
      // (During a save: the answer looks at the value then.)
      if (s.at == "saving") return [{ ...s, value: e.value }, []];
      if (e.value == s.saved) return [{ ...s, at: "idle", value: e.value }, s.at == "idle" ? [] : [{ t: "mark", at: "saved" }]];
      // (The value that the server refused, again: it stays refused until it changes, or Try again.)
      if (s.at == "failed" && e.value == s.sent) return [s, []];
      if (e.now) return save(e.value, s.at != "waiting");
      const n = s.n + 1;
      return [
        { ...s, at: "waiting", value: e.value, n },
        [{ t: "wait", n }, ...(s.at == "waiting" ? [] : [{ t: "mark" as const, at: "saving" as const }])],
      ];
    }
    case "pause":
      return s.at == "waiting" && e.n == s.n ? save(s.value, false) : [s, []];
    case "done": {
      if (s.at != "saving") return [s, []];
      const has = { ...s, saved: s.sent };
      if (s.value != s.sent) return [{ ...has, sent: s.value }, [{ t: "save", value: s.value }]];
      return [{ ...has, at: "idle" }, [{ t: "mark", at: "saved" }]];
    }
    case "refused": {
      if (s.at != "saving") return [s, []];
      // A newer value meanwhile: that one is tried. The saved one again: nothing to save.
      if (s.value == s.saved) return [{ ...s, at: "idle" }, [{ t: "mark", at: "saved" }]];
      if (s.value != s.sent) return [{ ...s, sent: s.value }, [{ t: "save", value: s.value }]];
      return [{ ...s, at: "failed" }, [{ t: "mark", at: "error", why: e.why }]];
    }
    case "retry":
      return s.at == "failed" ? save(s.value) : [s, []];
  }
}

export interface Autosave {
  /** The save mark, and this field's key in it. */
  mark: SaveMark;
  key: string;
  /** What the field is called, in the mark's card: "Daily token limit". */
  label: string;
  /** What the field shows now, and what the server has (as `read` gives it). */
  read: () => string;
  saved: string;
  /** Sends a value; it throws the server's reason (an Error). */
  save: (value: string) => Promise<unknown>;
  /** Whether the value may be sent before the focus leaves the field (a number field that is empty for a moment: no). */
  ready?: () => boolean;
  /**
   * The field's row, where the page's rows follow the server (client/common/live-rows.ts): it has data-unsaved while the
   * field holds a value that the server does not have, and its new state from the server waits until then.
   */
  row?: HTMLElement;
  /** After each save: `why` is the reason it was refused, or null (saved): the field's own line says it, in place. */
  ended?: (why: string | null) => void;
}

/** Keeps a field saved. `changed(now)` after each change of it (`now`: at once), and as the focus leaves it. */
export function autosave(o: Autosave) {
  let state = autoStart(o.saved),
    gone = false;
  function send(e: AutoEvent) {
    if (gone) return;
    const [next, effects] = autoStep(state, e);
    state = next;
    for (const f of effects) {
      if (f.t == "wait") setTimeout(() => (o.ready && !o.ready() ? null : send({ t: "pause", n: f.n })), PAUSE_MS);
      else if (f.t == "mark") {
        o.row?.toggleAttribute("data-unsaved", f.at != "saved");
        if (f.at != "saving") o.ended?.(f.why ?? null);
        o.mark.set(o.key, f.at, { title: `${o.label} not saved`, detail: `${f.why ?? ""} The field keeps your value.` }, () =>
          send({ t: "retry" })
        );
      } else
        o.save(f.value).then(
          () => send({ t: "done" }),
          (err: Error) => send({ t: "refused", why: err.message })
        );
    }
  }
  return {
    changed: (now: boolean) => send({ t: "change", value: o.read(), now }),
    /** The value the server has, as far as this knows. */
    get saved() {
      return state.saved;
    },
    /** The field is gone (its row was drawn again): its saves' answers count for nothing, and the mark forgets it. */
    stop() {
      gone = true;
      o.row?.removeAttribute("data-unsaved");
      o.mark.set(o.key, "saved");
    },
  };
}

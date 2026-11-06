// The homepage's deploy state, pure: one value (Deploy), and next(), which takes it and an event and gives the new
// value and what to do. deploys.ts does the IO it asks for, and stores the value.

import * as Schema from "effect/Schema";

const common = {
  /** The homepage's document, as last seen. */
  docId: Schema.NullOr(Schema.String),
  /** Who asked for the latest deploy (byLine); null: the system's own (a new homepage). */
  by: Schema.NullOr(Schema.String),
  /** Bumped whenever the homepage changes to another document, or goes: a run for the one before is thrown away. */
  epoch: Schema.Number,
  /** A run is under way in this object (of any epoch): only one runs at a time. */
  running: Schema.Boolean,
};

export const Deploy = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle"), ...common }),
  /** A run is wanted: the alarm starts it, or it runs, and `again`: it runs once more after (asked for meanwhile). */
  Schema.Struct({ state: Schema.Literal("deploying"), again: Schema.Boolean, ...common }),
  Schema.Struct({ state: Schema.Literal("deployed"), ...common }),
  Schema.Struct({ state: Schema.Literal("failed"), error: Schema.String, failedAt: Schema.Number, ...common }),
]);
export type Deploy = typeof Deploy.Type;

export const INITIAL: Deploy = { state: "idle", docId: null, by: null, epoch: 0, running: false };

/** After a failed deploy, a / with no snapshot starts no other one for this long (Deploy does, at once). */
export const RETRY_MS = 60_000;

export type Event =
  /** The object starts: what it stored (any shape), and the snapshot's document if it has one. */
  | { type: "load"; stored: unknown; liveDoc: string | null }
  /** Someone deploys. */
  | { type: "deploy"; by: string | null }
  /** The landing_document setting may name another homepage (`doc`), or none. */
  | { type: "home"; doc: string | null; liveDoc: string | null }
  /** A / found no snapshot (`live`: the object has one after all). */
  | { type: "ensure"; doc: string | null; live: boolean; now: number }
  /** A document was deleted. */
  | { type: "forget"; docId: string; liveDoc: string | null }
  /** The alarm rings. */
  | { type: "alarm" }
  /** A run of `epoch` ended: the snapshot's document (null: there's no homepage), or why it failed. */
  | { type: "ran"; epoch: number; outcome: { docId: string | null } | { error: string }; now: number };

/** What to do, in this order. The new value is stored after `alarm`, whenever it's another. */
export interface Effects {
  /** Drop the snapshot and every deploy's files. */
  drop?: true;
  alarm?: "set" | "delete";
  /** Tell these documents' readers that the state changed. */
  tell?: (string | null)[];
  /** Run a deploy for this epoch, then send its "ran". */
  run?: number;
}

const base = (s: Deploy) => ({ docId: s.docId, by: s.by, epoch: s.epoch, running: s.running });

export function next(s: Deploy, e: Event): { s: Deploy; fx: Effects } {
  const none = { s, fx: {} };
  switch (e.type) {
    case "load": {
      // Another shape (an older release's) is no state: what the snapshot says, else nothing.
      const stored: Deploy = Schema.is(Deploy)(e.stored)
        ? e.stored
        : e.liveDoc
          ? { ...INITIAL, state: "deployed", docId: e.liveDoc }
          : INITIAL;
      // Nothing runs in an object that just started: a run stopped in the middle (it moved or restarted) runs again.
      if (stored.state == "deploying") return { s: { ...stored, running: false, again: false }, fx: { alarm: "set" } };
      return { s: { ...stored, running: false }, fx: {} };
    }
    case "deploy":
      if (s.state == "deploying") return { s: { ...s, by: e.by, again: s.running }, fx: { tell: [s.docId] } };
      return { s: { ...base(s), state: "deploying", by: e.by, again: false }, fx: { alarm: "set", tell: [s.docId] } };
    case "home": {
      if (e.doc && e.doc == e.liveDoc && e.doc == s.docId) return none;
      // What's live is the old one's, so it goes; the new one deploys at once, or after the run under way.
      const c = { docId: e.doc, by: null, epoch: s.epoch + 1, running: s.running };
      const fx: Effects = { drop: true, tell: [s.docId, e.doc] };
      if (!e.doc) return { s: { ...c, state: "idle" }, fx };
      return { s: { ...c, state: "deploying", again: s.running }, fx: s.running ? fx : { ...fx, alarm: "set" } };
    }
    case "ensure":
      if (e.live || s.state == "deploying" || !e.doc) return none;
      if (e.doc != s.docId) return next(s, { type: "home", doc: e.doc, liveDoc: null });
      if (s.state == "failed" && e.now - s.failedAt < RETRY_MS) return none;
      return { s: { ...base(s), state: "deploying", again: false }, fx: { alarm: "set", tell: [e.doc] } };
    case "forget":
      if (e.liveDoc != e.docId && s.docId != e.docId) return none;
      return { s: { ...INITIAL, epoch: s.epoch + 1, running: s.running }, fx: { drop: true, alarm: "delete" } };
    case "alarm":
      if (s.state != "deploying" || s.running) return none;
      return { s: { ...s, running: true, again: false }, fx: { tell: [s.docId], run: s.epoch } };
    case "ran": {
      // A run is still wanted (asked for again, or for a new homepage): it runs now, as the alarm can't start it.
      if (s.state == "deploying" && (s.again || e.epoch != s.epoch))
        return { s: { ...s, again: false }, fx: { tell: [s.docId], run: s.epoch } };
      if (e.epoch != s.epoch) return { s: { ...s, running: false }, fx: {} };
      const c = { ...base(s), running: false };
      const fx = { tell: [s.docId] };
      if ("error" in e.outcome) return { s: { ...c, state: "failed", error: e.outcome.error, failedAt: e.now }, fx };
      if (e.outcome.docId == null) return { s: { ...c, state: "idle", docId: null }, fx };
      return { s: { ...c, state: "deployed", docId: e.outcome.docId }, fx };
    }
  }
}

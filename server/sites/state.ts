// A domain's publishing state, pure: one value (Site), and step(), which takes it and an event and gives the new value
// and what to do. publishing.ts does the IO it asks for, and stores the value.
//
//   free                      the domain serves nothing
//   linked(doc)               its live version, if there is one: after a replace, the old document's
//   publishing(doc)           the last live version, until the new one is ready
//   published(doc)            that version
//   failed(doc, error)        the last live version
//
// Events: link, replace, publish, ready, fail, unlink; and the object's own: load, alarm, forget (a document was deleted).
// Nothing publishes by itself: a link only names the document, and the domain changes when someone publishes.

import * as Schema from "effect/Schema";

/** The version a domain serves: whose it is, its number, and when it went live. */
const Live = Schema.Struct({ doc: Schema.String, version: Schema.NullOr(Schema.Number), at: Schema.Number });
export type Live = typeof Live.Type;

const common = {
  /** What the domain serves now (the snapshot's); null: nothing. */
  live: Schema.NullOr(Live),
  /** Bumped whenever the domain's document changes, or goes: a run for the one before is thrown away. */
  epoch: Schema.Number,
  /** A run is under way in this object (of any epoch): only one runs at a time. */
  running: Schema.Boolean,
};
const linked = {
  ...common,
  /** The document linked to the domain. */
  doc: Schema.String,
  /** Erga's header bar on the published site (the Erga domain only). */
  bars: Schema.Boolean,
  /** When it was linked, and by whom (byLine); null: not known (a state read from the snapshot alone). */
  linked: Schema.NullOr(Schema.Struct({ at: Schema.Number, by: Schema.String })),
  /** Who asked for the latest publish (byLine); null: nobody yet. */
  by: Schema.NullOr(Schema.String),
};

export const Site = Schema.Union([
  Schema.Struct({ state: Schema.Literal("free"), ...common }),
  Schema.Struct({ state: Schema.Literal("linked"), ...linked }),
  /** A run is wanted: the alarm starts it, or it runs, and `again`: it runs once more after (asked for meanwhile). */
  Schema.Struct({ state: Schema.Literal("publishing"), again: Schema.Boolean, ...linked }),
  Schema.Struct({ state: Schema.Literal("published"), ...linked }),
  Schema.Struct({ state: Schema.Literal("failed"), error: Schema.String, ...linked }),
]);
export type Site = typeof Site.Type;

export const FREE: Site = { state: "free", live: null, epoch: 0, running: false };

export type Event =
  /** The object starts: what it stored (any shape), and what its snapshot serves, if it has one. */
  | { type: "load"; stored: unknown; live: Live | null }
  /** A document takes a free domain, or the domain's own document changes its bar. */
  | { type: "link"; doc: string; bars: boolean; by: string; at: number }
  /** A document takes the domain, also from another document (the user confirmed). */
  | { type: "replace"; doc: string; bars: boolean; by: string; at: number }
  /** The document's current version goes live. */
  | { type: "publish"; doc: string; by: string }
  /** "Not published": the document leaves the domain. */
  | { type: "unlink"; doc: string }
  /** A document was deleted. */
  | { type: "forget"; doc: string }
  /** The alarm rings. */
  | { type: "alarm" }
  /** A run of `epoch` ended: its version is live. */
  | { type: "ready"; epoch: number; live: Live }
  /** A run of `epoch` ended: why it failed. */
  | { type: "fail"; epoch: number; error: string };

/** Why an event did nothing: another document has the domain (`claimed`), or this one doesn't (`unlinked`). */
export type Refusal = { claimed: string } | { unlinked: true };

/** What to do, in this order. The new value is stored after `alarm`, whenever it's another. */
export interface Effects {
  /** Drop the snapshot and every version's files. */
  drop?: true;
  alarm?: "set" | "delete";
  /** Tell these documents' open pages that the state changed. */
  tell?: string[];
  /** Publish `doc` for this epoch, then send its "ready" or "fail". */
  run?: { epoch: number; doc: string };
  refused?: Refusal;
}

/** A domain's state, as the API gives it. */
export interface SiteStatus {
  state: Site["state"];
  /** The document linked to the domain, or null. */
  doc: string | null;
  bars: boolean;
  /** What the domain serves now: whose version, its number, and when it went live; null: nothing. */
  live: Live | null;
  /** Why the last publish failed, while it's failed. */
  error: string | null;
  /** Who asked for the latest publish: "ada", "ada, via their admin agent", "the system". */
  by: string | null;
  linked: { at: number; by: string } | null;
}

export const statusOf = (s: Site): SiteStatus =>
  s.state == "free"
    ? { state: "free", doc: null, bars: false, live: null, error: null, by: null, linked: null }
    : { state: s.state, doc: s.doc, bars: s.bars, live: s.live, error: s.state == "failed" ? s.error : null, by: s.by, linked: s.linked };

type Linked = Exclude<Site, { state: "free" }>;
const base = (s: Linked) => ({ live: s.live, epoch: s.epoch, running: s.running, doc: s.doc, bars: s.bars, linked: s.linked, by: s.by });
const docOf = (s: Site) => (s.state == "free" ? null : s.doc);

export function step(s: Site, e: Event): { s: Site; fx: Effects } {
  const none = { s, fx: {} };
  switch (e.type) {
    case "load": {
      // Another shape (another release's) is no state: what the snapshot says, else nothing.
      const stored: Site = Schema.is(Site)(e.stored)
        ? e.stored
        : e.live
          ? { ...FREE, state: "published", live: e.live, doc: e.live.doc, bars: true, linked: null, by: null }
          : FREE;
      // What it serves is what the snapshot says: without this document's version there, it is linked, not published.
      const now: Site =
        stored.state == "published" && e.live?.doc != stored.doc
          ? { ...base(stored), state: "linked", live: e.live }
          : { ...stored, live: e.live };
      // Nothing runs in an object that just started: a run stopped in the middle (it moved or restarted) runs again.
      if (now.state == "publishing") return { s: { ...now, running: false, again: false }, fx: { alarm: "set" } };
      return { s: { ...now, running: false }, fx: {} };
    }
    case "link":
    case "replace": {
      if (s.state != "free" && s.doc == e.doc) return s.bars == e.bars ? none : { s: { ...s, bars: e.bars }, fx: { tell: [s.doc] } };
      if (s.state != "free" && e.type == "link") return { s, fx: { refused: { claimed: s.doc } } };
      // The old document's version stays live until this one is published; a run for the old one is thrown away.
      const next: Site = {
        state: "linked",
        live: s.live,
        epoch: s.epoch + 1,
        running: s.running,
        doc: e.doc,
        bars: e.bars,
        linked: { at: e.at, by: e.by },
        by: null,
      };
      return { s: next, fx: { alarm: "delete", tell: [...(s.state == "free" ? [] : [s.doc]), e.doc] } };
    }
    case "publish":
      if (s.state == "free" || s.doc != e.doc) return { s, fx: { refused: s.state == "free" ? { unlinked: true } : { claimed: s.doc } } };
      if (s.state == "publishing") return { s: { ...s, by: e.by, again: s.running }, fx: { tell: [s.doc] } };
      return { s: { ...base(s), state: "publishing", by: e.by, again: false }, fx: { alarm: "set", tell: [s.doc] } };
    case "unlink":
      if (s.state == "free" || s.doc != e.doc) return none;
      return { s: { ...FREE, epoch: s.epoch + 1, running: s.running }, fx: { drop: true, alarm: "delete", tell: [s.doc] } };
    case "forget":
      if (docOf(s) == e.doc) return step(s, { type: "unlink", doc: e.doc });
      // The version of a document that was replaced here, and is now gone: the domain serves nothing until the next publish.
      return s.live?.doc == e.doc ? { s: { ...s, live: null }, fx: { drop: true } } : none;
    case "alarm":
      if (s.state != "publishing" || s.running) return none;
      return { s: { ...s, running: true, again: false }, fx: { tell: [s.doc], run: { epoch: s.epoch, doc: s.doc } } };
    case "ready":
    case "fail": {
      // A run is still wanted (asked for again, or for a document linked since): it runs now, as the alarm can't start it.
      if (s.state == "publishing" && (s.again || e.epoch != s.epoch))
        return { s: { ...s, running: true, again: false }, fx: { tell: [s.doc], run: { epoch: s.epoch, doc: s.doc } } };
      if (e.epoch != s.epoch || s.state != "publishing") return { s: { ...s, running: false }, fx: {} };
      const c = { ...base(s), running: false };
      const fx = { tell: [s.doc] };
      if (e.type == "fail") return { s: { ...c, state: "failed", error: e.error }, fx };
      return { s: { ...c, state: "published", live: e.live }, fx };
    }
  }
}

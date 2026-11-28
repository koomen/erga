// A participant's workspace: what the document's operations (operations.ts)
// do to its text for one participant: read a file, and change it by exact
// edits. It works on the room's own text, with no copy: each change goes
// through the room's door (`room.as`) as that participant, and reaches every
// tab like a user's typing. It keeps the texts that the participant last
// read, which a write merges from.
//
// Edits aim by exact match against the *current* text at the moment they
// apply. If the text the participant read has since changed under it
// (someone typed there), the match fails cleanly and it reads again; that's
// what makes a stale picture of the file safe. Each operation is minimal
// deletes and inserts, landing at once in one transaction (one undo step),
// so concurrent edits anywhere else in the file survive. Others see it as
// typing: their editor plays it so, with the participant's caret (which goes
// to where its edit ends: `cursor`).
//
// Each operation is an Effect that fails with a WorkspaceError: its reason
// says what went wrong, its message says it to the model.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Y from "yjs";
import { changesBetween, rebase } from "../model/merge";
import { applyChanges, assets, files, folders } from "../model/content";
import { cleanPath } from "../model/pages";
import { aligned, type Change } from "./minimal";
import { aimEdits, type TextEdit } from "../../shared/text-edits";
import { broke } from "./faults";
import { filesNote, nearestNote } from "./nearest";
import type { Participant, Room } from "./room";

/** The edits' form, as the edit tool takes them, and view_page's and eval_in_page's preview. */
export const EDITS = Schema.Array(
  Schema.Struct({
    oldText: Schema.optionalKey(Schema.String.annotate({ description: "Exact, unique text; or give selector or cssRule" })),
    selector: Schema.optionalKey(Schema.String),
    cssRule: Schema.optionalKey(Schema.String),
    newText: Schema.String,
    replaceAll: Schema.optionalKey(Schema.Boolean.annotate({ description: "Every match of oldText" })),
  })
);

/** Where an edit landed: the first changed position, for the agent's cursor. */
export interface EditResult { path: string; at: number; summary: string }

/** Puts the participant's caret (head null) or selection in a file, as positions that move with others' typing. */
export type Cursor = (path: string, anchor: Y.RelativePosition, head: Y.RelativePosition | null) => void;

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  reason: Schema.Literals([
    "outside",
    "noPath",
    "binary",
    "missing",
    "noEdits",
    "emptyEdit",
    "notFound",
    "changed",
    "ambiguous",
    "overlap",
    "selector",
    "readOnly",
    "locked",
    "single",
  ]),
  message: Schema.String,
}) {}

/** A change's summary, and under it what the change broke in the page's HTML (./faults.ts), if anything. */
const withFaults = (summary: string, path: string, before: string, t: Y.Text) =>
  [summary, broke(path, before, t.toString())].filter(Boolean).join("\n");

const fail = (reason: WorkspaceError["reason"], message: string) => Effect.fail(new WorkspaceError({ reason, message }));

/** A path the model gives (document/model/pages.ts cleanPath: a leading ./ or / is fine), refused if it leaves the folder or names nothing. */
export function modelPath(path: string): Effect.Effect<string, WorkspaceError> {
  const clean = cleanPath(path);
  if (clean == null) return fail("outside", `${path} is outside the document's folder`);
  if (!clean) return fail("noPath", "give a file path");
  return Effect.succeed(clean);
}

export class Workspace {
  /** Each file as the participant last saw it (read or wrote): the base `write` merges from. */
  private seen = new Map<string, string>();
  private seenWhen = new Map<string, number>();

  constructor(
    private room: Room,
    /** Whose workspace it is: each change is theirs, with their right to edit checked as it is made (room.as). */
    private p: Participant,
    /** A document that's a single file: the one path it holds (no other files can be made). */
    private only: string | null = null,
    /** Shows where each edit ends, as the participant's caret. */
    private cursor: Cursor = () => {}
  ) {}

  private get doc(): Y.Doc {
    return this.room.doc;
  }

  private text(path: string): Effect.Effect<Y.Text, WorkspaceError> {
    const t = files(this.doc).get(path);
    if (t) return Effect.succeed(t);
    if (assets(this.doc).has(path)) return fail("binary", `${path} is a file kept whole (not text), so it can't be edited: read shows it, and write's content_base64 replaces it.`);
    return fail("missing", `${path} doesn't exist.${filesNote(this.paths())}`);
  }

  isText(path: string): boolean { return files(this.doc).has(path); }

  /** When the participant last saw the file (read or wrote it), as a timestamp; null if it hasn't. */
  seenAt(path: string): number | null { return this.seenWhen.get(path) ?? null; }

  /** What the participant now believes the file says, and since when. */
  private see(path: string, text: string) {
    this.seen.set(path, text);
    this.seenWhen.set(path, Date.now());
  }

  /** Every path, text and binary, sorted. */
  paths(): string[] {
    return [...files(this.doc).keys(), ...assets(this.doc).keys()].sort();
  }

  /** The folders made as such (empty ones too), sorted; folders holding files are in `paths` too. */
  folders(): string[] {
    return [...folders(this.doc).keys()].sort();
  }

  read(path: string): Effect.Effect<string, WorkspaceError> {
    const self = this;
    return Effect.gen(function* () {
      path = yield* modelPath(path);
      const text = (yield* self.text(path)).toString();
      self.see(path, text);
      return text;
    });
  }

  edit(path: string, edits: readonly TextEdit[]): Effect.Effect<EditResult, WorkspaceError> {
    const self = this;
    return Effect.gen(function* () {
      path = yield* modelPath(path);
      yield* self.mayEdit();
      const t = yield* self.text(path);
      const current = t.toString();
      const aimed = aimEdits(current, edits, path);
      if ("reason" in aimed) {
        if (aimed.reason != "notFound") return yield* fail(aimed.reason, aimed.message);
        // In the text the agent last saw, but not in the text now: the file changed under it (a restore, someone typing).
        const seen = self.seen.get(path),
          e = edits[aimed.index];
        if (seen != null && seen != current && seen.includes(e.oldText!))
          return yield* fail(
            "changed",
            `${aimed.label} isn't in the current text of ${path}: the file changed since the text your edit was based on (what you last read or wrote of it). Read ${path} again and retry.`
          );
        return yield* fail(
          "notFound",
          `${aimed.label} isn't in the current text of ${path}${seen == current ? ", which is the same as when you last read it" : ""}.${
            nearestNote(current, e.oldText ?? "") || (seen == current ? " Check oldText against it." : " Read the file again and retry.")
          }`
        );
      }
      const spans = aimed.spans;
      // Each as the smallest change that leaves tags whole: trim what old and new share at both ends.
      const minimal = aligned(current, spans);
      if (!minimal.length) return { path, at: spans[0].from, summary: `No change: the new text is the same as the old.` };
      const at = self.apply(path, t, minimal);
      // (What each replaced, as text: an edit by selector names it otherwise.)
      const done = self.edited(
        path,
        t,
        spans.map((x) => ({ oldText: current.slice(x.from, x.to), newText: x.insert })),
        minimal,
        at
      );
      // An oldText found only with other white space: the agent learns the file's own.
      const which = aimed.loose.map((i) => (edits.length > 1 ? `edits[${i}]` : "oldText")).join(", ");
      const summary = which ? `${done.summary} (${which}: found with other white space than given.)` : done.summary;
      return { ...done, summary: withFaults(summary, path, current, t) };
    });
  }

  /**
   * Applies changes in one transaction (all in the current text's positions), and puts the participant's caret where
   * the last one ends; returns that place.
   */
  private apply(path: string, t: Y.Text, changes: Change[]): number {
    this.room.as(this.p, () => {
      for (const c of [...changes].reverse()) {
        if (c.to > c.from) t.delete(c.from, c.to - c.from);
        if (c.insert) t.insert(c.from, c.insert);
      }
    });
    const last = changes[changes.length - 1];
    const shift = changes.slice(0, -1).reduce((n, c) => n + c.insert.length - (c.to - c.from), 0);
    const end = last.from + shift + last.insert.length;
    this.cursor(path, Y.createRelativePositionFromTypeIndex(t, end, -1), null);
    return end;
  }

  /**
   * Changes to a page's text, made by one of the page's edits (its own API, or libs/text/api/edits.ts), against the
   * text as it is now (`was`: the text they were made from; if it changed since, nothing is changed). Returns where
   * they end.
   */
  change(path: string, was: string, changes: Change[]): Effect.Effect<EditResult, WorkspaceError> {
    const self = this;
    return Effect.gen(function* () {
      path = yield* modelPath(path);
      yield* self.mayEdit();
      const t = yield* self.text(path);
      const current = t.toString();
      if (current != was) return yield* fail("changed", `${path} changed while the edit was made (someone typed there): call it again.`);
      const minimal = aligned(
        current,
        [...changes].sort((a, b) => a.from - b.from)
      );
      if (!minimal.length) return { path, at: 0, summary: `No change to ${path}.` };
      const at = self.apply(path, t, minimal);
      self.see(path, t.toString());
      return {
        path,
        at,
        summary: withFaults(`Edited ${path} (${minimal.length} change${minimal.length > 1 ? "s" : ""}).`, path, current, t),
      };
    });
  }
  /** The edit's result, and what the participant now believes the file says: what it saw, with its edits. */
  private edited(path: string, t: Y.Text, edits: { oldText: string; newText: string }[], minimal: Change[], at: number): EditResult {
    let seen: string | null = this.seen.get(path) ?? null;
    for (const e of edits) seen = seen != null && seen.split(e.oldText).length == 2 ? seen.replace(e.oldText, () => e.newText) : null;
    this.see(path, seen ?? t.toString());
    return { path, at, summary: `Edited ${path} (${minimal.length} change${minimal.length > 1 ? "s" : ""}).` };
  }

  write(path: string, content: string): Effect.Effect<EditResult, WorkspaceError> {
    const self = this;
    return Effect.gen(function* () {
      path = yield* modelPath(path);
      yield* self.mayEdit();
      if (assets(self.doc).has(path)) return yield* fail("binary", `${path} is a file kept whole (not text): replace it with write's content_base64, or rm it first to make it a text file.`);
      if (self.only != null && path != self.only) return yield* fail("single", `This document is the single file ${self.only}: you can't make other files in it.`);
      return yield* self.merge(path, content);
    });
  }

  /** Creates the file, or merges the participant's version of it into the current text, at once. */
  private merge(path: string, content: string): Effect.Effect<EditResult, WorkspaceError> {
    const self = this;
    return Effect.gen(function* () {
      let t = files(self.doc).get(path);
      if (!t) {
        self.see(path, content);
        self.room.as(self.p, () => {
          t = new Y.Text();
          t.insert(0, content);
          files(self.doc).set(path, t);
        });
        self.cursor(path, Y.createRelativePositionFromTypeIndex(t!, content.length, -1), null);
        return { path, at: content.length, summary: withFaults(`Created ${path}.`, path, "", t!) };
      }
      // Never a wholesale replace. The participant's change is what it did to the
      // version it last saw, rebased over what others have done since (the
      // same merge the room uses for edits on disk), so their edits survive.
      const base = self.seen.get(path);
      const current = t.toString();
      const changes = base != null ? rebase(base, current, content) : changesBetween(current, content);
      let at = 0;
      changes.iterChanges((_fa, _ta, _fb, toB) => { at = toB; });
      if (!changes.empty) {
        self.room.as(self.p, () => void applyChanges(t!, changes));
        self.cursor(path, Y.createRelativePositionFromTypeIndex(t, at, -1), null);
      }
      self.see(path, t.toString());
      return { path, at, summary: changes.empty ? `No change to ${path}.` : withFaults(`Wrote ${path}.`, path, current, t) };
    });
  }

  /** The room's door would refuse the change (room.refusal): said first, in the caller's words. */
  private mayEdit(): Effect.Effect<void, WorkspaceError> {
    const no = this.room.refusal(this.p);
    if (!no) return Effect.void;
    return fail("readOnly", "Your user can only view this document, so you can't change it.");
  }
}

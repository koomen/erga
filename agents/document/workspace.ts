// The agent's workspace: what its tools can do to the document, as a small
// interface (read, edit, write, list, find, grep, view the page), and an
// implementation over a replica of the shared Yjs doc. The agent never
// touches the disk: its edits are Yjs transactions on the replica, which
// reach the room and everyone in it like a person's typing.
//
// Edits aim by exact match against the *current* text at the moment they
// apply. If the text the agent read has since changed under it (someone
// typed there), the match fails cleanly and it reads again; that's what
// makes an agent's stale picture of the file safe. Each tool call is
// minimal deletes and inserts (streamed in steps, with a Pacer: one undo
// step), so concurrent edits anywhere else in the file survive.
//
// Each operation is an Effect that fails with a WorkspaceError: its reason
// says what went wrong, its message says it to the model.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Y from "yjs";
import { changesBetween, rebase } from "../../document/merge";
import { applyChanges, assets, files, folders, stamp, type Author } from "../../document/content";
import { cleanPath } from "../../document/pages";
import { aligned, pieces, type Piece } from "./typing";

export interface Workspace {
  read(path: string): Effect.Effect<string, WorkspaceError>;
  edit(path: string, edits: { oldText: string; newText: string }[]): Effect.Effect<EditResult, WorkspaceError>;
  write(path: string, content: string): Effect.Effect<EditResult, WorkspaceError>;
  /** Every path, text and binary, sorted. */
  paths(): string[];
  /** The folders made as such (empty ones too), sorted; folders holding files are in `paths` too. */
  folders(): string[];
  isText(path: string): boolean;
  /** When the agent last saw the file (read or wrote it), as a timestamp; null if it hasn't. */
  seenAt(path: string): number | null;
}

/** Where an edit landed: the first changed position, for the agent's cursor. */
export interface EditResult { path: string; at: number; summary: string }

/**
 * How the agent's edits show while they apply (agents/document/session.ts): its
 * selection on the text each change replaces, then the new text streamed in
 * many small steps, as a model's answer is. Without one, an edit applies at once.
 */
export interface Pacer {
  /** Puts the agent's selection (head null: a caret) in the file, as positions that move with others' typing. */
  cursor(path: string, anchor: Y.RelativePosition, head: Y.RelativePosition | null): void;
  wait(ms: number): Promise<void>;
  /** Takes back what this call applied so far (it's one undo step), when a later change of it can't land. */
  revert(): void;
}

/** The pace of an edit: the selection on the old text, then the new text streamed in steps. */
export const PACE = {
  /** How long each change's selection shows, and at most all of them in one call. */
  showMs: 150,
  showBudgetMs: 600,
  /** The time between steps, and the characters each second (a tag counts as one). */
  stepMs: 33,
  cps: 600,
  /** A call's time: when its text wouldn't fit at `cps`, the rate rises so it does. */
  budgetMs: 2000,
  /** A call that inserts more characters than this applies at once. */
  wholeChars: 20_000,
};

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  reason: Schema.Literals(["outside", "noPath", "binary", "missing", "noEdits", "emptyEdit", "notFound", "changed", "ambiguous", "overlap", "readOnly", "single"]),
  message: Schema.String,
}) {}

const fail = (reason: WorkspaceError["reason"], message: string) => Effect.fail(new WorkspaceError({ reason, message }));

/** A path the model gives (document/pages.ts cleanPath: a leading ./ or / is fine), refused if it leaves the folder or names nothing. */
export function modelPath(path: string): Effect.Effect<string, WorkspaceError> {
  const clean = cleanPath(path);
  if (clean == null) return fail("outside", `${path} is outside the document's folder`);
  if (!clean) return fail("noPath", "give a file path");
  return Effect.succeed(clean);
}

export class YjsWorkspace implements Workspace {
  /** Each file as the agent last saw it (read or wrote): the base `write` merges from. */
  private seen = new Map<string, string>();
  private seenWhen = new Map<string, number>();

  constructor(
    private doc: Y.Doc,
    /** Who its edits are by (a function: an outside agent's calls are by it, via its token: agents/document/session.ts). */
    private me: Author | (() => Author),
    /** The agent acts with its user's permissions, checked as it acts. */
    private canEdit: () => boolean,
    /** Transaction origin for the agent's edits (its undo manager tracks it). */
    private origin: object,
    /** A document that's a single file: the one path it holds (no other files can be made). */
    private only: string | null = null,
    /** Why a new file can't be made at a path (a document's second page), or null. */
    private refuse: (path: string) => string | null = () => null,
    /** Shows each edit as it applies; without it, an edit applies at once. */
    private pacer: Pacer | null = null
  ) {}

  private text(path: string): Effect.Effect<Y.Text, WorkspaceError> {
    const t = files(this.doc).get(path);
    if (t) return Effect.succeed(t);
    if (assets(this.doc).has(path)) return fail("binary", `${path} is a file kept whole (not text), so it can't be edited: read shows it, and write's content_base64 replaces it.`);
    return fail("missing", `${path} doesn't exist`);
  }

  isText(path: string): boolean { return files(this.doc).has(path); }

  seenAt(path: string): number | null { return this.seenWhen.get(path) ?? null; }

  /** What the agent now believes the file says, and since when. */
  private see(path: string, text: string) {
    this.seen.set(path, text);
    this.seenWhen.set(path, Date.now());
  }

  paths(): string[] {
    return [...files(this.doc).keys(), ...assets(this.doc).keys()].sort();
  }

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

  edit(path: string, edits: { oldText: string; newText: string }[]): Effect.Effect<EditResult, WorkspaceError> {
    const self = this;
    return Effect.gen(function* () {
      path = yield* modelPath(path);
      yield* self.mayEdit();
      const t = yield* self.text(path);
      const current = t.toString();
      if (!edits.length) return yield* fail("noEdits", "no edits given");
      // Aim every edit at the current text first; apply only if all of them land.
      const spans: { from: number; to: number; insert: string }[] = [];
      for (const [i, e] of edits.entries()) {
        const label = edits.length > 1 ? `edits[${i}]` : "oldText";
        if (!e.oldText) return yield* fail("emptyEdit", `${label} is empty`);
        const at = current.indexOf(e.oldText);
        if (at < 0) {
          // In the text the agent last saw, but not in the text now: the file changed under it (a restore, someone typing).
          const seen = self.seen.get(path);
          if (seen != null && seen != current && seen.includes(e.oldText)) return yield* fail("changed", `${label} isn't in the current text of ${path}: the file changed since the text your edit was based on (what you last read or wrote of it). Read ${path} again and retry.`);
          return yield* fail("notFound", `${label} isn't in the current text of ${path}${seen == current ? ", which is the same as when you last read it: check oldText against it" : ""}. Read the file again and retry.`);
        }
        if (current.indexOf(e.oldText, at + 1) >= 0) return yield* fail("ambiguous", `${label} matches more than once in ${path}; include more surrounding text to make it unique.`);
        spans.push({ from: at, to: at + e.oldText.length, insert: e.newText });
      }
      spans.sort((a, b) => a.from - b.from);
      for (let i = 1; i < spans.length; i++) if (spans[i].from < spans[i - 1].to) return yield* fail("overlap", "two edits overlap; merge them into one");
      // Each as the smallest change that leaves tags whole: trim what old and new share at both ends.
      const minimal = aligned(current, spans);
      if (!minimal.length) return { path, at: spans[0].from, summary: `No change: the new text is the same as the old.` };
      const at = self.pacer ? yield* self.paced(path, t, current, minimal, self.pacer) : self.apply(t, minimal);
      return self.edited(path, t, edits, minimal, at);
    });
  }

  private by(): Author {
    return typeof this.me == "function" ? this.me() : this.me;
  }

  /** Applies changes that all landed in one transaction (`current`'s positions); returns where the last one ends. */
  private apply(t: Y.Text, changes: { from: number; to: number; insert: string }[]): number {
    this.doc.transact(() => {
      for (const c of [...changes].reverse()) {
        if (c.to > c.from) t.delete(c.from, c.to - c.from);
        if (c.insert) t.insert(c.from, c.insert);
      }
      if (changes.every((c) => !c.insert)) stamp(this.doc, this.by());
    }, this.origin);
    const last = changes[changes.length - 1];
    const shift = changes.slice(0, -1).reduce((n, c) => n + c.insert.length - (c.to - c.from), 0);
    return last.from + shift + last.insert.length;
  }
  /**
   * Applies the changes one by one, as a person would make them: the agent's
   * selection on the text a change replaces for a moment, then its new text
   * streamed in, a few characters at a time (typing.ts), with the caret
   * after it. Each change aims by positions that move with others' typing,
   * and checks before each step that its old text (then what it typed so
   * far) is still there; if it isn't (someone typed in it), the call takes
   * back what it applied and fails, as an edit against changed text does.
   * The rate rises so a call's text fits its time; a very large one applies at once.
   */
  private paced(
    path: string,
    t: Y.Text,
    current: string,
    changes: { from: number; to: number; insert: string }[],
    pacer: Pacer,
    /** The call already changed the document (it made the file): a failure takes that back too. */
    made = false
  ): Effect.Effect<number, WorkspaceError> {
    const self = this;
    if (changes.reduce((n, c) => n + c.insert.length, 0) > PACE.wholeChars) {
      return Effect.sync(() => {
        const end = self.apply(t, changes);
        pacer.cursor(path, Y.createRelativePositionFromTypeIndex(t, end, -1), null);
        return end;
      });
    }
    const rel = (i: number, assoc = 0) => Y.createRelativePositionFromTypeIndex(t, i, assoc);
    const abs = (r: Y.RelativePosition) => Y.createAbsolutePositionFromRelativePosition(r, self.doc)?.index ?? -1;
    // From the first character of the old text (or after the one before, for an insertion) to its last one.
    const aims = changes.map((c) => ({
      ...c,
      old: current.slice(c.from, c.to),
      start: c.to > c.from ? rel(c.from) : rel(c.from, -1),
      end: rel(c.to, -1),
      pieces: pieces(c.insert, current.slice(Math.max(0, c.from - 200), c.from)),
    }));
    // Characters per step: the base rate, or faster if the call's text wouldn't fit its time.
    const weight = aims.reduce((n, a) => n + a.pieces.reduce((w, p) => w + p.weight, 0), 0);
    const showMs = Math.min(PACE.showMs, PACE.showBudgetMs / aims.length);
    const perStep = (Math.max(PACE.cps, weight / ((PACE.budgetMs - showMs * aims.length) / 1000)) * PACE.stepMs) / 1000;
    return Effect.gen(function* () {
      let applied = made,
        caret = 0;
      const wait = (ms: number) => Effect.promise(() => pacer.wait(ms));
      /** Where the change's old text is now; null if it isn't there any more. */
      const find = (a: (typeof aims)[number]) => {
        const from = abs(a.start),
          to = a.old ? abs(a.end) : from;
        return from >= 0 && t.toString().slice(from, to) == a.old ? { from, to } : null;
      };
      const changed = (i: number) => {
        if (applied) pacer.revert();
        return fail(
          "changed",
          `The text of change ${i + 1} changed while you edited ${path} (someone typed there), so nothing was changed. Read ${path} again and retry.`
        );
      };
      for (const [i, a] of aims.entries()) {
        let at = find(a);
        if (at) {
          pacer.cursor(path, a.start, a.old ? a.end : null);
          yield* wait(showMs);
          at = find(a);
        }
        if (!at) return yield* changed(i);
        // The new text so far, from `start` (its first character, once there is one); the caret is `typed` into it.
        let start: Y.RelativePosition | null = null,
          sofar = "",
          typed = 0,
          k = 0,
          quota = 0;
        do {
          let from = at.from;
          if (start) {
            from = abs(start);
            if (from < 0 || t.toString().slice(from, from + sofar.length) != sofar) return yield* changed(i);
          }
          // This step's pieces: at least one, and as many as its share of characters allows.
          quota += perStep;
          const step: Piece[] = [];
          while (k < a.pieces.length && (!step.length || quota >= a.pieces[k].weight)) {
            quota -= a.pieces[k].weight;
            step.push(a.pieces[k++]);
          }
          const first = !start;
          self.doc.transact(() => {
            if (first && at!.to > at!.from) t.delete(at!.from, at!.to - at!.from);
            for (const p of step) {
              if (p.insert) t.insert(from + typed, p.insert);
              sofar = sofar.slice(0, typed) + p.insert + sofar.slice(typed);
              typed += p.advance;
            }
            if (!a.insert) stamp(self.doc, self.by());
          }, self.origin);
          applied = true;
          if (sofar && !start) start = rel(from);
          caret = from + typed;
          pacer.cursor(path, caret > 0 ? rel(caret, -1) : rel(0), null);
          if (k < a.pieces.length) yield* wait(PACE.stepMs);
        } while (k < a.pieces.length);
      }
      return caret;
    });
  }

  /** The edit's result, and what the agent now believes the file says: what it saw, with its edits. */
  private edited(
    path: string,
    t: Y.Text,
    edits: { oldText: string; newText: string }[],
    minimal: { from: number; to: number; insert: string }[],
    at: number
  ): EditResult {
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
      const refused = files(self.doc).has(path) ? null : self.refuse(path);
      if (refused) return yield* fail("single", refused);
      return yield* self.merge(path, content);
    });
  }

  /** Creates the file, or merges the agent's version of it into the current text: streamed in, with a Pacer. */
  private merge(path: string, content: string): Effect.Effect<EditResult, WorkspaceError> {
    const self = this;
    return Effect.gen(function* () {
      let t = files(self.doc).get(path);
      if (!t) {
        self.see(path, content);
        const paced = self.pacer && content.length <= PACE.wholeChars;
        self.doc.transact(() => {
          t = new Y.Text();
          if (!paced) t.insert(0, content);
          files(self.doc).set(path, t);
        }, self.origin);
        if (paced && content) yield* self.paced(path, t!, "", [{ from: 0, to: 0, insert: content }], self.pacer!, true);
        return { path, at: content.length, summary: `Created ${path}.` };
      }
      // Never a wholesale replace. The agent's change is what it did to the
      // version it last saw, rebased over what others have done since (the
      // same merge the room uses for edits on disk), so their edits survive.
      const base = self.seen.get(path);
      const current = t.toString();
      const changes = base != null ? rebase(base, current, content) : changesBetween(current, content);
      let at = 0;
      changes.iterChanges((_fa, _ta, _fb, toB) => { at = toB; });
      if (self.pacer && !changes.empty) {
        const list: { from: number; to: number; insert: string }[] = [];
        changes.iterChanges((from, to, _fb, _tb, ins) => list.push({ from, to, insert: ins.sliceString(0, ins.length, "\n") }));
        at = yield* self.paced(path, t, current, aligned(current, list), self.pacer);
      } else {
        self.doc.transact(() => {
          const { inserted, deleted } = applyChanges(t!, changes);
          if (deleted && !inserted) stamp(self.doc, self.by());
        }, self.origin);
      }
      self.see(path, t.toString());
      return { path, at, summary: changes.empty ? `No change to ${path}.` : `Wrote ${path}.` };
    });
  }

  private mayEdit(): Effect.Effect<void, WorkspaceError> {
    return this.canEdit() ? Effect.void : fail("readOnly", "Your user can only view this document, so you can't change it.");
  }
}

// ------------------------------------------------------------ search helpers

/** A glob ("*.css", "**\/*.md", "img/*") as a regular expression over paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c == "*") {
      if (glob[i + 1] == "*") { re += glob[i + 2] == "/" ? "(?:.*/)?" : ".*"; i += glob[i + 2] == "/" ? 2 : 1; }
      else re += "[^/]*";
    } else if (c == "?") re += "[^/]";
    else if (c == "{") { const end = glob.indexOf("}", i); if (end > i) { re += "(?:" + glob.slice(i + 1, end).split(",").map(escapeRe).join("|") + ")"; i = end; } else re += "\\{"; }
    else re += escapeRe(c);
  }
  // A pattern without a slash matches at any depth, like find -name.
  return new RegExp(glob.includes("/") ? `^${re}$` : `(?:^|/)${re}$`);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

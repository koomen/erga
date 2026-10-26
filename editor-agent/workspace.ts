// The agent's workspace: what its tools can do to the document, as a small
// interface (read, edit, write, list, find, grep, view the page), and an
// implementation over a replica of the shared Yjs doc. The agent never
// touches the disk: its edits are Yjs transactions on the replica, which
// reach the room and everyone in it like a person's typing.
//
// Edits aim by exact match against the *current* text at the moment they
// apply. If the text the agent read has since changed under it (someone
// typed there), the match fails cleanly and it reads again; that's what
// makes an agent's stale picture of the file safe. Each tool call is one
// transaction of minimal deletes and inserts, so concurrent edits anywhere
// else in the file survive.
//
// Each operation is an Effect that fails with a WorkspaceError: its reason
// says what went wrong, its message says it to the model.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Y from "yjs";
import { changesBetween, rebase } from "../document/merge";
import { applyChanges, assets, files, folders, stamp, type Author } from "../document/content";

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
 * How the agent's edits show while they apply (editor-agent/session.ts): its
 * selection on the text each change replaces, then the new text typed in a
 * few steps, as a person's would. Without one, an edit applies at once.
 */
export interface Pacer {
  /** Puts the agent's selection (head null: a caret) in the file, as positions that move with others' typing. */
  cursor(path: string, anchor: Y.RelativePosition, head: Y.RelativePosition | null): void;
  wait(ms: number): Promise<void>;
  /** Takes back what this call applied so far (it's one undo step), when a later change of it can't land. */
  revert(): void;
}

/** The delays of a paced edit: the selection on the old text, then each step of the new. */
export const PACE = {
  showMs: 150,
  stepMs: 40,
  /** At most this many steps for one change's new text; at least this many characters in each. */
  maxSteps: 5,
  minStep: 4,
  /** A change longer than this (old or new) applies at once, with the caret at its end. */
  maxChars: 200,
  /** Once a call has waited this long, its other changes apply at once. */
  budgetMs: 1500,
};

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  reason: Schema.Literals(["outside", "noPath", "binary", "missing", "noEdits", "emptyEdit", "notFound", "changed", "ambiguous", "overlap", "readOnly", "single"]),
  message: Schema.String,
}) {}

const fail = (reason: WorkspaceError["reason"], message: string) => Effect.fail(new WorkspaceError({ reason, message }));

/** Normalises a path the model gives (leading ./ or /) and refuses ones that leave the folder. */
export function cleanPath(path: string): Effect.Effect<string, WorkspaceError> {
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (!seg || seg == ".") continue;
    if (seg == "..") return fail("outside", `${path} is outside the document's folder`);
    parts.push(seg);
  }
  if (!parts.length) return fail("noPath", "give a file path");
  return Effect.succeed(parts.join("/"));
}

export class YjsWorkspace implements Workspace {
  /** Each file as the agent last saw it (read or wrote): the base `write` merges from. */
  private seen = new Map<string, string>();
  private seenWhen = new Map<string, number>();

  constructor(
    private doc: Y.Doc,
    /** Who its edits are by (a function: an outside agent's calls are by it, via its token: editor-agent/session.ts). */
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
      path = yield* cleanPath(path);
      const text = (yield* self.text(path)).toString();
      self.see(path, text);
      return text;
    });
  }

  edit(path: string, edits: { oldText: string; newText: string }[]): Effect.Effect<EditResult, WorkspaceError> {
    const self = this;
    return Effect.gen(function* () {
      path = yield* cleanPath(path);
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
      // Each as the smallest change: trim what old and new share at both ends.
      const minimal = spans.map(({ from, to, insert }) => {
        let s = 0;
        while (from + s < to && s < insert.length && current[from + s] == insert[s]) s++;
        let e = 0;
        while (to - e > from + s && insert.length - e > s && current[to - 1 - e] == insert[insert.length - 1 - e]) e++;
        return { from: from + s, to: to - e, insert: insert.slice(s, insert.length - e) };
      }).filter((c) => c.from < c.to || c.insert);
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
   * in a few steps, with the caret after it. Each change aims by positions
   * that move with others' typing, and checks that its old text is still
   * there right before it applies; if it isn't (someone typed in it), the
   * call takes back what it applied and fails, as an edit against changed
   * text does. A long change, and every change once the call has waited
   * long enough, applies at once; new text with markup in it goes in whole.
   */
  private paced(
    path: string,
    t: Y.Text,
    current: string,
    changes: { from: number; to: number; insert: string }[],
    pacer: Pacer
  ): Effect.Effect<number, WorkspaceError> {
    const self = this;
    const rel = (i: number, assoc = 0) => Y.createRelativePositionFromTypeIndex(t, i, assoc);
    const abs = (r: Y.RelativePosition) => Y.createAbsolutePositionFromRelativePosition(r, self.doc)?.index ?? -1;
    // From the first character of the old text (or after the one before, for an insertion) to its last one.
    const aims = changes.map((c) => ({
      ...c,
      old: current.slice(c.from, c.to),
      start: c.to > c.from ? rel(c.from) : rel(c.from, -1),
      end: rel(c.to, -1),
    }));
    return Effect.gen(function* () {
      let waited = 0,
        applied = false,
        caret = 0;
      const wait = (ms: number) =>
        Effect.promise(async () => {
          await pacer.wait(ms);
          waited += ms;
        });
      /** Where the change's old text is now; null if it isn't there any more. */
      const find = (a: (typeof aims)[number]) => {
        const from = abs(a.start),
          to = a.old ? abs(a.end) : from;
        return from >= 0 && t.toString().slice(from, to) == a.old ? { from, to } : null;
      };
      for (const [i, a] of aims.entries()) {
        let at = find(a);
        const slow = waited < PACE.budgetMs && a.old.length <= PACE.maxChars && a.insert.length <= PACE.maxChars;
        if (at && slow) {
          pacer.cursor(path, a.start, a.old ? a.end : null);
          yield* wait(PACE.showMs);
          at = find(a);
        }
        if (!at) {
          if (applied) pacer.revert();
          return yield* fail(
            "changed",
            `The text of change ${i + 1} changed while you edited ${path} (someone typed there), so nothing was changed. Read ${path} again and retry.`
          );
        }
        // New text with markup in it goes in whole: a tag typed in parts would break the page for a moment.
        const steps = slow && !/[<>&]/.test(a.insert) ? Math.max(1, Math.min(PACE.maxSteps, Math.ceil(a.insert.length / PACE.minStep))) : 1;
        const size = Math.ceil(a.insert.length / steps);
        // The new text goes in after the last of it typed so far (after the deletion, at first).
        let after = at.from > 0 ? rel(at.from, -1) : null;
        for (let k = 0; k < steps; k++) {
          const piece = a.insert.slice(k * size, (k + 1) * size);
          self.doc.transact(() => {
            const pos = after ? abs(after) : 0;
            if (k == 0 && at!.to > at!.from) t.delete(at!.from, at!.to - at!.from);
            if (piece) t.insert(k == 0 ? at!.from : pos, piece);
            if (!a.insert) stamp(self.doc, self.by());
          }, self.origin);
          applied = true;
          const end = (k == 0 ? at.from : abs(after!)) + piece.length;
          caret = end;
          after = end > 0 ? rel(end, -1) : null;
          pacer.cursor(path, after ?? rel(0), null);
          if (k < steps - 1) yield* wait(PACE.stepMs);
        }
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
      path = yield* cleanPath(path);
      yield* self.mayEdit();
      if (assets(self.doc).has(path)) return yield* fail("binary", `${path} is a file kept whole (not text): replace it with write's content_base64, or rm it first to make it a text file.`);
      if (self.only != null && path != self.only) return yield* fail("single", `This document is the single file ${self.only}: you can't make other files in it.`);
      const refused = files(self.doc).has(path) ? null : self.refuse(path);
      if (refused) return yield* fail("single", refused);
      return self.merge(path, content);
    });
  }

  /** Creates the file, or merges the agent's version of it into the current text. */
  private merge(path: string, content: string): EditResult {
    const t = files(this.doc).get(path);
    if (!t) {
      this.see(path, content);
      this.doc.transact(() => {
        const nt = new Y.Text();
        nt.insert(0, content);
        files(this.doc).set(path, nt);
      }, this.origin);
      return { path, at: content.length, summary: `Created ${path}.` };
    }
    // Never a wholesale replace. The agent's change is what it did to the
    // version it last saw, rebased over what others have done since (the
    // same merge the room uses for edits on disk), so their edits survive.
    const base = this.seen.get(path);
    const current = t.toString();
    const changes = base != null ? rebase(base, current, content) : changesBetween(current, content);
    let at = 0;
    changes.iterChanges((_fa, _ta, _fb, toB) => { at = toB; });
    this.doc.transact(() => {
      const { inserted, deleted } = applyChanges(t, changes);
      if (deleted && !inserted) stamp(this.doc, this.by());
    }, this.origin);
    this.see(path, t.toString());
    return { path, at, summary: changes.empty ? `No change to ${path}.` : `Wrote ${path}.` };
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

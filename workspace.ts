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
import { changesBetween, rebase } from "./src/page/merge";
import { applyChanges, assets, files, stamp, type Author } from "./src/room/doc";

export interface Workspace {
  read(path: string): Effect.Effect<string, WorkspaceError>;
  edit(path: string, edits: { oldText: string; newText: string }[]): Effect.Effect<EditResult, WorkspaceError>;
  write(path: string, content: string): Effect.Effect<EditResult, WorkspaceError>;
  /** Every path, text and binary, sorted. */
  paths(): string[];
  isText(path: string): boolean;
}

/** Where an edit landed: the first changed position, for the agent's cursor. */
export interface EditResult { path: string; at: number; summary: string }

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  reason: Schema.Literals(["outside", "noPath", "binary", "missing", "noEdits", "emptyEdit", "notFound", "ambiguous", "overlap", "readOnly"]),
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

  constructor(
    private doc: Y.Doc,
    private me: Author,
    /** The agent acts with its user's permissions, checked as it acts. */
    private canEdit: () => boolean,
    /** Transaction origin for the agent's edits (its undo manager tracks it). */
    private origin: object,
  ) {}

  private text(path: string): Effect.Effect<Y.Text, WorkspaceError> {
    const t = files(this.doc).get(path);
    if (t) return Effect.succeed(t);
    if (assets(this.doc).has(path)) return fail("binary", `${path} is a binary file; it can't be read or edited as text`);
    return fail("missing", `${path} doesn't exist`);
  }

  isText(path: string): boolean { return files(this.doc).has(path); }

  paths(): string[] {
    return [...files(this.doc).keys(), ...assets(this.doc).keys()].sort();
  }

  read(path: string): Effect.Effect<string, WorkspaceError> {
    const self = this;
    return Effect.gen(function* () {
      path = yield* cleanPath(path);
      const text = (yield* self.text(path)).toString();
      self.seen.set(path, text);
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
        if (at < 0) return yield* fail("notFound", `${label} isn't in the current text of ${path}. It may have just changed (someone could be editing it); read the file again and retry.`);
        if (current.indexOf(e.oldText, at + 1) >= 0) return yield* fail("ambiguous", `${label} matches more than once in ${path}; include more surrounding text to make it unique.`);
        spans.push({ from: at, to: at + e.oldText.length, insert: e.newText });
      }
      spans.sort((a, b) => a.from - b.from);
      for (let i = 1; i < spans.length; i++) if (spans[i].from < spans[i - 1].to) return yield* fail("overlap", "two edits overlap; merge them into one");
      return self.apply(path, t, current, edits, spans);
    });
  }

  /** Applies edits that all landed, each as its smallest change, in one transaction. */
  private apply(path: string, t: Y.Text, current: string, edits: { oldText: string; newText: string }[], spans: { from: number; to: number; insert: string }[]): EditResult {
    // Each as the smallest change: trim what old and new share at both ends.
    const minimal = spans.map(({ from, to, insert }) => {
      let s = 0;
      while (from + s < to && s < insert.length && current[from + s] == insert[s]) s++;
      let e = 0;
      while (to - e > from + s && insert.length - e > s && current[to - 1 - e] == insert[insert.length - 1 - e]) e++;
      return { from: from + s, to: to - e, insert: insert.slice(s, insert.length - e) };
    }).filter((c) => c.from < c.to || c.insert);
    if (!minimal.length) return { path, at: spans[0].from, summary: `No change: the new text is the same as the old.` };
    this.doc.transact(() => {
      for (const c of [...minimal].reverse()) {
        if (c.to > c.from) t.delete(c.from, c.to - c.from);
        if (c.insert) t.insert(c.from, c.insert);
      }
      if (minimal.every((c) => !c.insert)) stamp(this.doc, this.me);
    }, this.origin);
    // What the agent now believes the file says: what it saw, with its edits.
    let seen: string | null = this.seen.get(path) ?? null;
    for (const e of edits) seen = seen != null && seen.split(e.oldText).length == 2 ? seen.replace(e.oldText, () => e.newText) : null;
    this.seen.set(path, seen ?? t.toString());
    const last = minimal[minimal.length - 1];
    const shift = minimal.slice(0, -1).reduce((n, c) => n + c.insert.length - (c.to - c.from), 0);
    return { path, at: last.from + shift + last.insert.length, summary: `Edited ${path} (${minimal.length} change${minimal.length > 1 ? "s" : ""}).` };
  }

  write(path: string, content: string): Effect.Effect<EditResult, WorkspaceError> {
    const self = this;
    return Effect.gen(function* () {
      path = yield* cleanPath(path);
      yield* self.mayEdit();
      if (assets(self.doc).has(path)) return yield* fail("binary", `${path} is a binary file; it can't be written as text`);
      return self.merge(path, content);
    });
  }

  /** Creates the file, or merges the agent's version of it into the current text. */
  private merge(path: string, content: string): EditResult {
    const t = files(this.doc).get(path);
    if (!t) {
      this.seen.set(path, content);
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
      if (deleted && !inserted) stamp(this.doc, this.me);
    }, this.origin);
    this.seen.set(path, t.toString());
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

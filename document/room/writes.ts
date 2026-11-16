// What the room (room.ts) must still write of each file: one state for each path, and one pure step from it. A path
// that isn't here is as storage has it. "edited": changed since the last write; "waiting": its text waits to be
// written (lazily, `fileDelay` after the first of them began to wait); "removed": deleted in the room, and storage
// may still have it. A write takes what's due into one commit; a commit that fails gives it back, and the next try
// waits longer each time.

export type PathState = "edited" | "waiting" | "removed";

export interface Writes {
  readonly paths: ReadonlyMap<string, PathState>;
  /** Since when the waiting files wait (0: due at once, or none waits). */
  readonly since: number;
  /** Commits that failed in a row. */
  readonly failures: number;
}

export const NOTHING: Writes = { paths: new Map(), since: 0, failures: 0 };

/** What a commit carries: the files written, the files deleted, and those that still wait. */
export interface Commit {
  write: string[];
  remove: string[];
  later: string[];
}

/** What the room has of a file now: text that storage has as it is, other text, no file, or a file kept whole. */
export type Look = "same" | "text" | "gone" | "asset";

export type WriteEvent =
  /** Edited in the room (or a text arriving whole: a removed path has a file again). */
  | { on: "edited"; paths: Iterable<string> }
  /** The journal names these as not written yet (the room opened): due at once. */
  | { on: "waiting"; paths: Iterable<string> }
  | { on: "removed"; path: string }
  /** Storage has it as the room does (a blob put there): nothing to write. */
  | { on: "stored"; path: string }
  /** A write begins: what's due goes into one commit (`all`: every file). */
  | { on: "write"; now: number; all: boolean; fileDelay: number; look: (path: string) => Look }
  | { on: "committed" }
  | { on: "failed"; commit: Commit };

export function nextWrites(w: Writes, e: WriteEvent): { writes: Writes; commit?: Commit } {
  const paths = new Map(w.paths);
  switch (e.on) {
    case "edited":
      // A waiting file is written as it is when it's due: an edit doesn't make it wait longer.
      for (const p of e.paths) if (paths.get(p) != "waiting") paths.set(p, "edited");
      return { writes: { ...w, paths } };
    case "waiting":
      for (const p of e.paths) paths.set(p, "waiting");
      return { writes: { ...w, paths, since: paths.size ? 1 : w.since } };
    case "removed":
      paths.set(e.path, "removed");
      return { writes: { ...w, paths } };
    case "stored":
      paths.delete(e.path);
      return { writes: { ...w, paths } };
    case "write": {
      const states = [...w.paths.values()];
      // Files edited now start to wait, unless others already do (they're written together).
      const since = states.includes("edited") && !states.includes("waiting") ? e.now : w.since;
      const due = e.all || e.now - since >= e.fileDelay;
      const commit: Commit = { write: [], remove: [], later: [] };
      paths.clear();
      for (const [p, state] of w.paths) {
        const look = state == "removed" ? "gone" : e.look(p);
        if (look == "gone") commit.remove.push(p);
        else if (look == "text") {
          if (due) commit.write.push(p);
          else {
            commit.later.push(p);
            paths.set(p, "waiting");
          }
        }
      }
      return { writes: { ...w, paths, since: commit.later.length ? since : 0 }, commit };
    }
    case "committed":
      return { writes: { ...w, failures: 0 } };
    case "failed":
      // Tried again: nothing is lost. A file edited or removed since keeps that state.
      for (const p of e.commit.write) if (!paths.has(p)) paths.set(p, "waiting");
      for (const p of e.commit.remove) if (!paths.has(p)) paths.set(p, "removed");
      return { writes: { paths, since: w.since, failures: w.failures + 1 } };
  }
}

/** How long the writer waits before its next write: its delay, doubled for each commit that failed, up to a minute. */
export const retryIn = (w: Writes, writeDelay: number): number =>
  w.failures ? Math.min(writeDelay * 2 ** w.failures, 60_000) : writeDelay;

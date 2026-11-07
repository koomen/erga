// A document's history as it is edited: the edits no version holds yet, the
// versions cut from them (one cut at a time) and their descriptions, and the
// reads and restores of versions. versions.ts keeps them in storage; the
// Document owns one History.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type { Author } from "./content.ts";
import { nextCut, type CutEvent, type Cuts } from "./cuts.ts";
import type { DocumentDeps, DocumentInfo, FileData } from "./document.ts";
import { later, stop } from "./later.ts";
import type { Opened } from "./open.ts";
import { io, type NoSuchDocument, type StoreError } from "./room.ts";
import { kvOf } from "./storage.ts";
import type { Published } from "./uploads.ts";
import {
  describeChange,
  fallbackDescription,
  publicVersion,
  versionNumber,
  Versions,
  type RestoreResult,
  type StoredVersion,
  type Version,
  type VersionsState,
} from "./versions.ts";

/** What the history needs of its document. */
export interface HistoryHost {
  deps: DocumentDeps;
  /** The document once it's open; null while it isn't. */
  opened(): Opened | null;
  /** The document, opened if it isn't (null if there's no such document). */
  room(): Promise<Opened | null>;
  info(): Promise<DocumentInfo | null>;
  updateInfo(change: (info: DocumentInfo | null) => DocumentInfo | null): Promise<DocumentInfo | null>;
  /** Something happened: the document stays open a while longer. */
  activity(): void;
  /** Files arriving whole (uploads.ts): what a restore writes. */
  publish(files: Record<string, FileData>, remove: string[], by: string): Effect.Effect<Published, StoreError | NoSuchDocument>;
}

export class History {
  /** Its versions, in the document's own storage. */
  versions: Versions;
  /** Edits not yet in a version, and the cut under way (cuts.ts); the timers that cut one (see `noteEdit` for the rule). */
  private cuts: Cuts = { is: "clean" };
  private timers = { idle: null as Fiber.Fiber<void> | null, max: null as Fiber.Fiber<void> | null };
  /** Cuts, one at a time. */
  cutting: Promise<unknown> = Promise.resolve();

  constructor(private host: HistoryHost) {
    this.versions = new Versions(kvOf(host.deps.storage), Date.now, host.deps.blobs);
  }

  private get idleMs() {
    return this.host.deps.timing.idleMs;
  }
  private get maxMs() {
    return this.host.deps.timing.maxMs;
  }

  /** Storage was emptied or replaced: its versions are read from it again, and nothing is pending. */
  forget(): void {
    this.versions = new Versions(kvOf(this.host.deps.storage), Date.now, this.host.deps.blobs);
    this.reset();
  }

  /** Nothing is pending: the document is going (or its storage is replaced). */
  reset(): void {
    void this.step({ on: "reset" });
  }

  /** Whether it has edits no version holds yet (or a cut under way). */
  get dirty(): boolean {
    return this.cuts.is != "clean";
  }

  /** Takes a step (cuts.ts) and does what it says; done once what it notes in storage is noted. */
  private step(e: CutEvent): Promise<void> {
    const { cuts, effects } = nextCut(this.cuts, e);
    this.cuts = cuts;
    const t = this.timers;
    const notes: Promise<void>[] = [];
    for (const f of effects) {
      if (f == "uncut" || f == "clean") notes.push(this.markUncut(f == "uncut"));
      else if (f == "stop") {
        if (t.idle) stop(t.idle);
        if (t.max) stop(t.max);
        t.idle = t.max = null;
      } else {
        if (t[f]) stop(t[f]);
        t[f] = later(
          f == "idle" ? this.idleMs : this.maxMs,
          () => {
            t[f] = null;
            void this.cutSoon(f == "idle" ? "idle" : "burst");
          },
          () => (this.agentWorking() ? this.idleMs : 0)
        );
      }
    }
    return Promise.all(notes).then(() => {});
  }

  /**
   * An edit reached the room (a file's text, or another file, changed), by
   * `author`. When to cut a version, so that a burst of edits is one version:
   *
   * - edits pause for `idleMs` (30 seconds);
   * - a burst has gone on for `maxMs` (5 minutes) since its first edit;
   * - an agent's turn ends (the embedded agent's, or an external agent's
   *   calls, 8 seconds after its last), so an agent's turn is one version:
   *   while any agent works, the two rules above wait for it;
   * - the last person who may edit leaves (their room connection closes);
   * - when the room opens, if what it holds isn't the latest version (edits
   *   made while timers couldn't run: the object was evicted).
   *
   * A cut that finds nothing changed since the latest version makes none.
   */
  noteEdit(author: string | null): void {
    this.host.activity();
    // The first of a burst is noted in storage, so a document stopped before it cut the version cuts it as it opens again.
    void this.step({ on: "edit", author });
  }

  /** Notes in its record whether it has edits no version holds yet (only when that changes). */
  private async markUncut(uncut: boolean): Promise<void> {
    await this.host
      .updateInfo((info) => {
        if (!info || !!info.uncut == uncut) return info;
        const { uncut: _, ...rest } = info;
        return uncut ? { ...rest, uncut } : rest;
      })
      .catch((e) => this.host.deps.log(`couldn't note the edits: ${e}`));
  }

  /** Whether any agent in the room is in the middle of a turn (its busy flag, on awareness). */
  agentWorking(): boolean {
    const room = this.host.opened()?.room;
    if (!room) return false;
    for (const state of room.awareness.getStates().values()) {
      const s = state as { busy?: boolean; user?: Author } | null;
      if (s?.busy && s.user?.kind == "agent") return true;
    }
    return false;
  }

  /** Cuts a version of what the document holds now (after any cut under way); the new version, or null if nothing changed. */
  cutSoon(reason: string, as?: { authors: string[]; description: string }): Promise<StoredVersion | null> {
    const run = this.cutting.then(() => Effect.runPromise(this.cutVersion(as)));
    this.cutting = run.catch((e) => this.host.deps.log(`couldn't cut a version (${reason}): ${e instanceof Error ? e.stack : e}`));
    return run;
  }

  private cutVersion(as?: { authors: string[]; description: string }): Effect.Effect<StoredVersion | null, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      // Edits from in-process peers (agents) sync on microtasks: they've reached the room by the next macrotask.
      yield* Effect.sleep(0);
      const opened = self.host.opened();
      const info = yield* Effect.promise(() => self.host.info());
      if (!opened || !info) return null;
      yield* Effect.promise(() => self.step({ on: "cut" }));
      const c = self.cuts as Extract<Cuts, { is: "cutting" }>;
      const authors = as?.authors ?? [...(c.taken ?? [])];
      // Its edits stay pending until the version is stored: a cut that fails gives them back.
      const r = yield* Effect.gen(function* () {
        const entries = yield* Effect.promise(() => opened.entries());
        const first = (yield* self.versions.head) == 0;
        const description = as?.description ?? (first ? "First version" : null);
        return yield* self.versions.cut(entries, info.index, authors, description, opened.room.folderPaths());
      }).pipe(Effect.onExit((exit) => Effect.promise(() => self.step({ on: "cut-ended", ok: Exit.isSuccess(exit) }))));
      // At a version, a long log becomes a snapshot: the next open reads less.
      yield* opened.room.settle;
      if (!r) return null;
      opened.broadcast({ type: "versions" });
      self.countEdits(authors);
      if (r.previous && !as) self.host.deps.background(Effect.runPromise(self.describe(r.version, r.previous, info)));
      return r.version;
    });
  }

  /** A version's edits, one for each of its authors that's a person ("koomen", "koomen, via their agent"), in the day's counts. */
  private countEdits(authors: readonly string[]): void {
    const logins = new Set(authors.map((a) => a.split(", via ")[0]).filter((a) => /^[a-z0-9][a-z0-9-]*$/.test(a)));
    const dir = this.host.deps.directory;
    for (const login of logins)
      this.host.deps.background(dir.activity.add(login, { edit: 1 }).catch((e) => this.host.deps.log(`couldn't count an edit: ${e}`)));
  }

  /** Writes a version's description in the background: the model's five words, or the fallback. Never in the way of editing. */
  private describe(version: StoredVersion, previous: StoredVersion, info: DocumentInfo): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const changes = yield* self.versions.changes(previous, version);
      // The agent's key, as it is now (an admin may have stored one since the document opened).
      const key = info.test ? "" : yield* Effect.promise(() => self.host.deps.agents.descriptionKey());
      // Its tokens are the server's key's, and nobody's in the day's counts.
      const used = (input: number, output: number) =>
        self.host.deps.background(
          self.host.deps.directory.activity.add(null, { "in:server": input, "out:server": output }).catch(() => {})
        );
      const text = (key ? yield* describeChange(key, changes, used) : null) ?? fallbackDescription(changes);
      yield* self.versions.describe(version.n, text);
      self.host.opened()?.broadcast({ type: "versions" });
    }).pipe(
      Effect.catchCause((cause) => Effect.sync(() => self.host.deps.log(`couldn't describe version ${version.n}: ${Cause.pretty(cause)}`)))
    );
  }

  /** Opens the document and waits for any cut under way (the first, when it opens, makes sure there is a version). */
  async ready(): Promise<{ opened: Opened; info: DocumentInfo } | null> {
    const opened = await this.host.room();
    if (!opened) return null;
    await this.cutting;
    if ((await Effect.runPromise(this.versions.head)) == 0) await this.cutSoon("first");
    const info = await this.host.info();
    return info ? { opened, info } : null;
  }

  /** Its versions, newest first (`limit`, before version `before`), and the current one. Null if there's no such document. */
  versionsState(opts: { before?: string | number | null; limit?: number } = {}): Effect.Effect<VersionsState | null, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const r = yield* io(() => self.ready());
      if (!r) return null;
      const before = opts.before != null ? versionNumber(opts.before) : null;
      const { versions, total } = yield* self.versions.list({ before, limit: opts.limit });
      const latest = (yield* self.versions.latest)!;
      return { current: publicVersion(latest), versions: versions.map(publicVersion), total, pending: self.dirty };
    });
  }

  /** One version (by id or number), with its files' paths; null if there's none. */
  version(ref: string | number): Effect.Effect<(Version & { files: string[]; index: string }) | null, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const n = versionNumber(ref);
      if (!(yield* io(() => self.ready())) || n == null) return null;
      const v = yield* self.versions.get(n);
      return v && { ...publicVersion(v), index: v.index, files: Object.keys(v.files) };
    });
  }

  /** One file of a version; null if there's no such version or file. */
  versionFile(ref: string | number, path: string): Effect.Effect<Uint8Array | null, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const n = versionNumber(ref);
      if (!(yield* io(() => self.ready())) || n == null) return null;
      const v = yield* self.versions.get(n);
      return v ? yield* self.versions.file(v, path) : null;
    });
  }

  /**
   * Brings a version back over the document as it is now (files it didn't have go), as an edit open editors see live:
   * a new current version by `by`, "Restored version <n>". With `path`, only that file ("Restored <path> from version
   * <n>"). Edits not yet in a version become one first, so nothing is lost.
   */
  restore(ref: string | number, by: string, path?: string | null): Effect.Effect<RestoreResult, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const r = yield* io(() => self.ready());
      if (!r) return { ok: false, status: 404, error: "There's no such document." } as const;
      const n = versionNumber(ref);
      const v = n != null ? yield* self.versions.get(n) : null;
      if (!v)
        return {
          ok: false,
          status: 404,
          error: `There's no version ${ref} of this document: its versions are v1 to v${yield* self.versions.head}.`,
        } as const;
      if (path != null) {
        path = path.replace(/^\.?\/+/, "");
        if (!(path in v.files))
          return {
            ok: false,
            status: 404,
            error: `Version ${v.n} has no file ${path}: its files are ${Object.keys(v.files).sort().join(", ")}.`,
          } as const;
      }
      yield* io(() => self.cutSoon("restore"));
      const files = yield* self.versions.entries(v);
      // The document went while it was restored: as if it had never been there.
      const gone = (put: Record<string, FileData>, remove: string[]): Published => ({
        written: [],
        removed: [],
        refused: [...Object.keys(put), ...remove].map((p) => ({ path: p, why: "there's no such document" })),
      });
      const publish = (put: Record<string, FileData>, remove: string[]) =>
        Effect.catchTag(self.host.publish(put, remove, by), "NoSuchDocument", () => Effect.succeed(gone(put, remove)));
      if (path != null) {
        const out = yield* publish({ [path]: files.get(path)! }, []);
        if (out.refused.length) return { ok: false, status: 409, error: `Couldn't restore ${path}: ${out.refused[0].why}.` } as const;
        const made = yield* io(() => self.cutSoon("restored", { authors: [by], description: `Restored ${path} from version ${v.n}` }));
        return { ok: true, current: publicVersion(made ?? (yield* self.versions.latest)!), from: v.id, files: [path] } as const;
      }
      const room = r.opened.room;
      // Folders it didn't have go (unless something of it is inside); then its files over the current ones; then its folders.
      const keep = [...files.keys(), ...(v.folders ?? [])];
      for (const d of room.folderPaths())
        if (!keep.some((p) => p == d || p.startsWith(`${d}/`)) && room.exists(d) == "folder") yield* Effect.ignore(room.remove(d));
      const now = new Set((yield* io(() => r.opened.current())).keys());
      const out = yield* publish(
        Object.fromEntries(files),
        [...now].filter((p) => !files.has(p))
      );
      for (const d of v.folders ?? []) if (room.exists(d) != "folder") yield* Effect.ignore(room.mkdir(d));
      if (out.refused.length) self.host.deps.log(`restoring ${v.id}: ${out.refused.map((x) => `${x.path} (${x.why})`).join(", ")}`);
      const made = yield* io(() => self.cutSoon("restored", { authors: [by], description: `Restored version ${v.n}` }));
      return {
        ok: true,
        current: publicVersion(made ?? (yield* self.versions.latest)!),
        from: v.id,
        files: [...files.keys()].sort(),
      } as const;
    });
  }

  /**
   * The document as it is now (up to the keystroke), with its current
   * version: what the homepage and the document's site deploy.
   */
  currentFiles(): Effect.Effect<{ version: Version; index: string; files: Map<string, Uint8Array> } | null, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const r = yield* io(() => self.ready());
      if (!r) return null;
      return { version: publicVersion((yield* self.versions.latest)!), index: r.info.index, files: yield* io(() => r.opened.current()) };
    });
  }
}

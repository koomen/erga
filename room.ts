// The document room: one per document, holding the shared Yjs doc (see
// src/room/doc.ts) that every participant edits. Editor tabs join over a
// WebSocket, agent sessions in process (`joinLocal`), and both speak the
// same Yjs sync and awareness protocol, so the room can't tell them apart.
//
// While it's open the room is the source of truth. It writes each text file
// back to storage 400ms after the last edit to it, so publishing, the CLI
// and git still see ordinary files, and edits that arrive as files (an
// editor, git) are merged in as ordinary edits:
// diffed word by word against the last version both sides agreed on and
// rebased over the room's edits since (src/page/merge.ts). Writes and merges
// take turns on one queue, so neither can slip between the other's read and
// write.
//
// The room also keeps its Yjs state (`StateStore`), saved with every write.
// A restarted room picks up the same history, so tabs that stayed open
// reconnect and merge as if nothing happened. Without it (the state lost),
// the room starts a new *epoch* from the files: a tab still holding the old
// history would merge two unrelated histories and double the document, so
// the room refuses it (`connect` returns null) and the tab reloads.
//
// Platform-neutral on purpose: storage is the small `FileStore` and
// `StateStore` services and connections are `send` callbacks, so the same
// room can run in the local host (open.ts) or a Durable Object, and tests
// give it storage in memory.
//
// A room is a scoped resource (`Room.make`): it writes on a fiber in its
// scope, and closing the scope writes whatever is still unsaved. Talking to
// participants stays synchronous (`connect`, `text`), since Yjs and the
// sockets are callback APIs; everything that touches storage is an Effect.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as sync from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { rebase } from "./src/page/merge";
import { applyChanges, assets, files, hasSeen, introduce, isTextPath, roomInfo, stamp, type Author } from "./src/room/doc";

/** Storage failed: a file couldn't be listed, read or written. */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", { message: Schema.String }) {}

/** Where a room's files live: a folder on disk here, R2 when hosted. */
export class FileStore extends Context.Service<FileStore, {
  /** Every file's path, relative, "/"-separated. */
  readonly list: Effect.Effect<string[], StoreError>;
  /** A file's bytes, or null if it doesn't exist. */
  readonly read: (path: string) => Effect.Effect<Uint8Array | null, StoreError>;
  readonly write: (path: string, text: string) => Effect.Effect<void, StoreError>;
}>()("erga/FileStore") {}

/** Where the room keeps its Yjs state between runs: a cache file here, Durable Object storage when hosted. */
export class StateStore extends Context.Service<StateStore, {
  readonly load: Effect.Effect<Uint8Array | null, StoreError>;
  readonly save: (state: Uint8Array) => Effect.Effect<void, StoreError>;
}>()("erga/StateStore") {
  /** No saved state: every run starts a new epoch from the files. */
  static readonly none = Layer.succeed(StateStore, { load: Effect.succeed(null), save: () => Effect.void });
}

const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_QUERY_AWARENESS = 3;
const MAX_TEXT = 2_000_000;

/** One participant's connection to the room. */
export interface Connection {
  /** Handles a message; false if it was malformed (the caller should hang up). */
  receive(message: Uint8Array): boolean;
  close(): void;
}

/** Why a file pushed to the room wasn't taken. */
export type PushResult = { ok: true; etag: string } | { ok: false; etag: string | null; reason: "stale" | "binary" };

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /** Each text file as storage last had it: the base for merging edits made there. */
  private stored = new Map<string, string>();
  private dirty = new Set<string>();
  /** Open while there are edits to write: the writer waits on it. */
  private pending = Latch.makeUnsafe(false);
  /** Writes and merges, one at a time. */
  private turn = Semaphore.makeUnsafe(1);
  private conns = new Map<object, { send: (m: Uint8Array) => void; clients: Set<number> }>();
  private readonly me: Author = { user: "disk", name: "On disk", color: "#6b7280", kind: "disk" };
  private decoder = new TextDecoder("utf-8", { fatal: true });

  private constructor(private store: FileStore["Service"], private state: StateStore["Service"], private log: (line: string) => void, readonly writeDelay: number) {
    // The room itself is not a visible participant.
    this.awareness.setLocalState(null);
  }

  /**
   * Opens the room on its storage, for as long as the scope lasts.
   * `writeDelay`: how long after the last edit to a file it's written (400ms
   * unless a test wants it sooner).
   */
  static make(opts: { log?: (line: string) => void; writeDelay?: number } = {}): Effect.Effect<Room, StoreError, FileStore | StateStore | Scope.Scope> {
    return Effect.gen(function* () {
      const room = new Room(yield* FileStore, yield* StateStore, opts.log ?? (() => {}), opts.writeDelay ?? 400);
      yield* room.restore();
      room.doc.on("update", (update: Uint8Array, origin: unknown) => room.broadcast(syncUpdate(update), origin));
      room.doc.on("afterTransaction", (tr: Y.Transaction) => room.noteDirty(tr));
      room.awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
        const conn = origin != null ? room.conns.get(origin) : undefined;
        if (conn) { for (const c of added) conn.clients.add(c); for (const c of removed) conn.clients.delete(c); }
        room.broadcast(awarenessMessage(room.awareness, [...added, ...updated, ...removed]), origin);
      });
      // The writer: once there's something to write, wait out the delay
      // (edits made meanwhile ride along), then write it all.
      yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
        yield* room.pending.await;
        yield* Effect.sleep(room.writeDelay);
        yield* room.flush;
      })));
      // Closing: everything not yet written goes to storage.
      yield* Effect.addFinalizer(() => room.flush.pipe(Effect.andThen(Effect.sync(() => room.awareness.destroy()))));
      return room;
    });
  }

  /** The room's epoch: which history it holds (see the top of this file). */
  get epoch(): string { return roomInfo(this.doc).get("epoch") as string; }

  /**
   * Loads the saved state if there is one, then reconciles it with storage:
   * files changed while the room was closed come in as edits on top.
   * Without saved state, a new epoch starts from the files.
   */
  private restore(): Effect.Effect<void, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const saved = yield* Effect.orElseSucceed(self.state.load, () => null);
      self.reopen(saved);
      const paths = new Set(yield* self.store.list);
      for (const path of paths) {
        const bytes = yield* self.store.read(path);
        if (bytes) self.reconcile(path, bytes);
      }
      self.forgetMissing(paths);
      yield* self.saveState;
    });
  }

  /** Takes the saved state if it loads whole, and makes sure the room has an epoch. */
  private reopen(saved: Uint8Array | null): void {
    if (saved) {
      // Tried on a scratch doc first: a state that doesn't load whole is no base.
      try {
        const probe = new Y.Doc();
        Y.applyUpdate(probe, saved);
        if (roomInfo(probe).get("epoch")) Y.applyUpdate(this.doc, saved, this);
        else this.log("  saved room state has no epoch; starting afresh");
      } catch (e) { this.log(`  saved room state unreadable, starting afresh: ${(e as Error).message}`); }
    }
    if (!roomInfo(this.doc).get("epoch")) this.doc.transact(() => roomInfo(this.doc).set("epoch", crypto.randomUUID()), this);
    introduce(this.doc, this.me);
  }

  /** Brings one file from storage into the restored room. */
  private reconcile(path: string, bytes: Uint8Array): void {
    const text = this.asText(path, bytes);
    const t = files(this.doc).get(path);
    if (text == null) { this.doc.transact(() => assets(this.doc).set(path, digest(bytes)), this); return; }
    this.stored.set(path, text);
    if (!t) {
      this.doc.transact(() => { const nt = new Y.Text(); nt.insert(0, text); files(this.doc).set(path, nt); }, this);
    } else if (t.toString() != text) {
      // Changed in storage while the room was closed. The state is saved
      // with every write, so the two agree unless someone else changed the
      // file since: their version wins, applied as an edit (the history
      // stays, so open tabs still merge).
      this.mergeText(t, t.toString(), text);
    }
  }

  /** Files deleted while the room was closed. */
  private forgetMissing(paths: Set<string>): void {
    for (const path of [...files(this.doc).keys()]) if (!paths.has(path)) this.doc.transact(() => files(this.doc).delete(path), this);
    for (const path of [...assets(this.doc).keys()]) if (!paths.has(path)) this.doc.transact(() => assets(this.doc).delete(path), this);
  }

  private asText(path: string, bytes: Uint8Array): string | null {
    if (!isTextPath(path) || bytes.length > MAX_TEXT) return null;
    try { return this.decoder.decode(bytes); } catch { return null; }
  }

  // ------------------------------------------------------------ participants

  /**
   * A participant joins: `send` carries the room's messages to it. A tab
   * that already holds a history names its epoch; if it isn't this room's,
   * it's refused (null) rather than merged.
   */
  connect(send: (message: Uint8Array) => void, opts: { epoch?: string | null } = {}): Connection | null {
    if (opts.epoch && opts.epoch != this.epoch) return null;
    const key = {};
    this.conns.set(key, { send, clients: new Set() });
    const hello = encoding.createEncoder();
    encoding.writeVarUint(hello, MSG_SYNC);
    sync.writeSyncStep1(hello, this.doc);
    send(encoding.toUint8Array(hello));
    const present = [...this.awareness.getStates().keys()];
    if (present.length) send(awarenessMessage(this.awareness, present));
    return {
      receive: (message) => {
        try {
          const decoder = decoding.createDecoder(message);
          const type = decoding.readVarUint(decoder);
          if (type == MSG_SYNC) {
            const reply = encoding.createEncoder();
            encoding.writeVarUint(reply, MSG_SYNC);
            sync.readSyncMessage(decoder, reply, this.doc, key);
            if (encoding.length(reply) > 1) send(encoding.toUint8Array(reply));
          } else if (type == MSG_AWARENESS) {
            awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), key);
          } else if (type == MSG_QUERY_AWARENESS) {
            send(awarenessMessage(this.awareness, [...this.awareness.getStates().keys()]));
          }
          return true;
        } catch (e) {
          this.log(`  dropped a malformed message: ${(e as Error).message}`);
          return false;
        }
      },
      close: () => {
        const conn = this.conns.get(key);
        if (!conn) return;
        this.conns.delete(key);
        awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.clients], null);
      },
    };
  }

  private broadcast(message: Uint8Array, origin: unknown): void {
    for (const [key, conn] of this.conns) if (key !== origin) conn.send(message);
  }

  /**
   * Completes once the room has every edit a participant had (its state
   * vector), and everyone in process has too, or after a timeout.
   */
  waitFor(vector: string, timeout = "2 seconds" as const): Effect.Effect<void> {
    const seen = Effect.callback<void>((resume) => {
      const check = () => { if (hasSeen(this.doc, vector)) { this.doc.off("update", check); resume(Effect.void); } };
      this.doc.on("update", check);
      check();
      return Effect.sync(() => this.doc.off("update", check));
    });
    // Then a macrotask: the in-process peers sync on microtasks, so they've caught up by then.
    return seen.pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.void }), Effect.andThen(Effect.sleep(0)));
  }

  // ------------------------------------------------------------ storage

  /** The current text of a file, if the room holds it as text. */
  text(path: string): string | null {
    return files(this.doc).get(path)?.toString() ?? null;
  }

  /** A version tag for what storage holds for a file (for conditional pushes). */
  etag(path: string): Effect.Effect<string | null, StoreError> {
    return Semaphore.withPermit(this.turn, Effect.map(this.store.read(path), (b) => b ? digest(b) : null));
  }

  private noteDirty(tr: Y.Transaction): void {
    for (const [type, keys] of tr.changed) {
      if (type === (files(this.doc) as Y.AbstractType<any>)) { for (const k of keys) if (k) this.dirty.add(k); }
      else { const path = pathOf(type); if (path != null) this.dirty.add(path); }
    }
    if (this.dirty.size) this.pending.openUnsafe();
  }

  private markDirty(path: string): void {
    this.dirty.add(path);
    this.pending.openUnsafe();
  }

  /** Writes every file that changed since storage last saw it, then the room's state. */
  get flush(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.pending.closeUnsafe();
      const paths = [...this.dirty];
      this.dirty.clear();
      const write = (path: string) => {
        const text = this.text(path);
        if (text == null || text == this.stored.get(path)) return Effect.void;
        return this.store.write(path, text).pipe(
          Effect.map(() => { this.stored.set(path, text); }),
          Effect.catch((e) => Effect.sync(() => { this.log(`  could not write ${path}: ${e.message}`); this.markDirty(path); })),
        );
      };
      return Semaphore.withPermit(this.turn, Effect.forEach(paths, write, { discard: true }).pipe(Effect.andThen(this.saveState)));
    });
  }

  private get saveState(): Effect.Effect<void> {
    return Effect.suspend(() => this.state.save(Y.encodeStateAsUpdate(this.doc))).pipe(
      Effect.catch((e) => Effect.sync(() => this.log(`  could not save the room's state: ${e.message}`))),
    );
  }

  /** Applies storage's change (from `base` to `incoming`) on top of the room's text. */
  private mergeText(t: Y.Text, base: string, incoming: string): void {
    const changes = rebase(base, t.toString(), incoming);
    if (changes.empty) return;
    this.doc.transact(() => {
      const { inserted, deleted } = applyChanges(t, changes);
      if (deleted && !inserted) stamp(this.doc, this.me);
    }, this);
  }

  /**
   * A file changed in storage (the watcher says so). If it's not a write of
   * ours, merge it in: the change from the last version both sides agreed on
   * is rebased over the room's edits since, so nobody's work is lost.
   */
  fileChanged(path: string): Effect.Effect<void, StoreError> {
    return Semaphore.withPermit(this.turn, Effect.map(this.store.read(path), (bytes) => this.take(path, bytes)));
  }

  /**
   * An edit that arrives as a whole file (a publish): written to storage
   * and merged into the room in one turn of the queue. With `ifMatch` (an
   * etag from `etag`), it's refused if storage has moved on since, so a
   * file based on an old version can't undo newer edits.
   */
  push(path: string, text: string, ifMatch: string | null = null): Effect.Effect<PushResult, StoreError> {
    const self = this;
    return Semaphore.withPermit(this.turn, Effect.gen(function* () {
      if (!isTextPath(path)) return { ok: false, etag: null, reason: "binary" } as const;
      const before = yield* self.store.read(path);
      const current = before ? digest(before) : null;
      if (ifMatch != null && ifMatch != current) return { ok: false, etag: current, reason: "stale" } as const;
      yield* self.store.write(path, text);
      const bytes = new TextEncoder().encode(text);
      self.take(path, bytes);
      return { ok: true, etag: digest(bytes) } as const;
    }));
  }

  /** Takes storage's version of a file into the room (inside the queue). */
  private take(path: string, bytes: Uint8Array | null): void {
    const t = files(this.doc).get(path);
    if (!bytes) {
      // Deleted (or renamed away). Text the room has unsaved edits to stays.
      if (t && t.toString() == this.stored.get(path)) this.doc.transact(() => files(this.doc).delete(path), this);
      if (assets(this.doc).has(path)) this.doc.transact(() => assets(this.doc).delete(path), this);
      this.stored.delete(path);
      return;
    }
    const text = this.asText(path, bytes);
    if (text == null) {
      const h = digest(bytes);
      if (assets(this.doc).get(path) != h) this.doc.transact(() => assets(this.doc).set(path, h), this);
      return;
    }
    if (!t) {
      this.stored.set(path, text);
      this.doc.transact(() => { const nt = new Y.Text(); nt.insert(0, text); files(this.doc).set(path, nt); }, this);
      this.log(`  new file: ${path}`);
      return;
    }
    const base = this.stored.get(path) ?? "";
    if (text == base) return;
    this.stored.set(path, text);
    this.mergeText(t, base, text);
    this.log(`  changed on disk: ${path}`);
    // The room had edits storage didn't: write the merge back.
    if (t.toString() != text) this.markDirty(path);
  }
}

interface AwarenessChange { added: number[]; updated: number[]; removed: number[] }

/** The files-map key a changed Y.Text lives under. */
function pathOf(type: Y.AbstractType<any>): string | null {
  const item = type._item;
  if (!item || !(item.parent instanceof Y.Map) || item.parentSub == null) return null;
  return item.parentSub;
}

function syncUpdate(update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_SYNC);
  sync.writeUpdate(e, update);
  return encoding.toUint8Array(e);
}

function awarenessMessage(awareness: awarenessProtocol.Awareness, clients: number[]): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_AWARENESS);
  encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(e);
}

/** A short content hash: an asset's versioned reference, and a file's etag. */
export function digest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha1").update(bytes).digest("hex").slice(0, 16);
}

/**
 * Joins a doc to the room in process, as an ordinary peer: the same sync
 * and awareness messages a tab sends over its WebSocket, delivered on the
 * microtask queue (in order, never re-entrantly). Returns a leave function.
 */
export function joinLocal(room: Room, doc: Y.Doc, awareness: awarenessProtocol.Awareness): () => void {
  let open = true;
  const conn = room.connect((message) => queueMicrotask(() => { if (open) receive(message); }))!;
  const toRoom = (message: Uint8Array) => queueMicrotask(() => { if (open) conn.receive(message); });
  function receive(message: Uint8Array) {
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    if (type == MSG_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MSG_SYNC);
      sync.readSyncMessage(decoder, reply, doc, conn);
      if (encoding.length(reply) > 1) toRoom(encoding.toUint8Array(reply));
    } else if (type == MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), conn);
    }
  }
  const onUpdate = (update: Uint8Array, origin: unknown) => { if (origin !== conn) toRoom(syncUpdate(update)); };
  const onAwareness = ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
    if (origin === conn) return;
    toRoom(awarenessMessage(awareness, [...added, ...updated, ...removed]));
  };
  doc.on("update", onUpdate);
  awareness.on("update", onAwareness);
  const hello = encoding.createEncoder();
  encoding.writeVarUint(hello, MSG_SYNC);
  sync.writeSyncStep1(hello, doc);
  toRoom(encoding.toUint8Array(hello));
  if (awareness.getLocalState()) toRoom(awarenessMessage(awareness, [doc.clientID]));
  return () => {
    awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], "leave");
    queueMicrotask(() => { open = false; conn.close(); });
    doc.off("update", onUpdate);
    awareness.off("update", onAwareness);
  };
}

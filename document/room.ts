// The document room: one per document, holding the shared Yjs doc (see
// document/content.ts) that every participant edits. Editor tabs join over a
// WebSocket, agent sessions in process (`joinLocal`), and both speak the
// same Yjs sync and awareness protocol, so the room can't tell them apart.
//
// While it's open the room is the source of truth. Its history is a journal
// (`StateStore`): each write appends the Yjs update made since the one
// before (400ms after the edits that make it), and now and then the whole
// state becomes one snapshot in place of the log. A room opens from that
// journal alone: the snapshot and the log after it, one read of storage.
//
// The files are a view of the room, written from it, so publishing, the CLI
// and git still see ordinary files. Over a journal they're written lazily
// (each at most every `fileDelay`, 2 seconds, and all of them as the room
// closes), and the journal names the files storage doesn't have yet, so a
// room stopped before writing them writes them as it opens again. After each
// write that leaves no file behind, the room tells every participant what the
// files hold now ("stored"). Edits that
// arrive as files (an editor, git) are merged in as ordinary edits: diffed
// word by word against the last version both sides agreed on and rebased
// over the room's edits since. Writes and merges take turns on one queue, so
// neither can slip between the other's read and write.
//
// A restarted room picks up the same history, so tabs that stayed open
// reconnect and merge as if nothing happened. Without it (the state lost),
// the room starts a new *epoch* from the files: a tab still holding the old
// history would merge two unrelated histories and double the document, so
// the room refuses it (`connect` returns null) and the tab reloads. A store
// whose files change while the room is closed (a folder on disk) says so:
// the room then reads every file as it opens, and merges what changed.
//
// Platform-neutral on purpose: storage is the small `FileStore` and
// `StateStore` services and connections are `send` callbacks, so the same
// room runs in a Durable Object, and tests
// give it storage in memory.
//
// A room is a scoped resource (`Room.make`): it writes on a fiber in its
// scope, and closing the scope writes whatever is still unsaved. Talking to
// participants stays synchronous (`connect`, `text`), since Yjs and the
// sockets are callback APIs; everything that touches storage is an Effect.

import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Y from "yjs";
import {
  Encoder,
  Decoder,
  Awareness,
  type AwarenessChange,
  writeSyncStep1,
  writeUpdate,
  readSyncMessage,
  SYNC_STEP1,
  MSG_STORED,
  writeVector,
  applyAwarenessUpdate,
  removeAwarenessStates,
  encodeAwarenessUpdate,
} from "../shared/yjs-protocol.ts";
import { rebase } from "./merge";
import { applyChanges, assets, files, folders, introduce, isTextPath, roomInfo, stamp, type Author } from "./content";
import { TEXT_MAX, type BlobRef } from "./blobs";
import { parentOf } from "./pages";
import { NOTHING, nextWrites, retryIn, type Commit as Planned, type WriteEvent, type Writes } from "./writes";

/** Storage failed: a file couldn't be listed, read or written. */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", { message: Schema.String }) {}

/** A storage call's failure, as a StoreError. */
const storeError = (e: unknown) => (e instanceof StoreError ? e : new StoreError({ message: e instanceof Error ? e.message : String(e) }));
/** A call to the document's storage (or to the directory, the blob store: Promise-based, from outside), its failure a StoreError. */
export const io = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: storeError });

/** Asked of a document that doesn't exist (not made yet, or deleted). */
export class NoSuchDocument extends Schema.TaggedError<NoSuchDocument>()("NoSuchDocument", { message: Schema.String }) {}

/**
 * Where a room's files live: a Durable Object's storage, or a folder on disk
 * (local development). The folder operations are optional: a store without
 * them keeps no folders of its own (the room's are then only in its state)
 * and can't delete or copy files.
 */
export class FileStore extends Context.Service<FileStore, {
  /** Every file's path, relative, "/"-separated. */
  readonly list: Effect.Effect<string[], StoreError>;
  /** A file's bytes, or null if it doesn't exist. */
  readonly read: (path: string) => Effect.Effect<Uint8Array | null, StoreError>;
  readonly write: (path: string, text: string) => Effect.Effect<void, StoreError>;
  /** Writes a file that isn't text (an image moved elsewhere). */
  readonly writeBytes?: (path: string, bytes: Uint8Array) => Effect.Effect<void, StoreError>;
  /** Deletes a file (nothing if it isn't there). */
  readonly remove?: (path: string) => Effect.Effect<void, StoreError>;
  /** Every folder made as one, empty ones included (folders holding files may be left out). */
  readonly folders?: Effect.Effect<string[], StoreError>;
  /** Makes a folder (and those it's in). */
  readonly mkdir?: (path: string) => Effect.Effect<void, StoreError>;
  /** Deletes a folder and whatever is still in it. */
  readonly rmdir?: (path: string) => Effect.Effect<void, StoreError>;
  /** A file kept as a blob: its ref; null for any other (document/blobs.ts). Absent: the store keeps no blobs. */
  readonly ref?: (path: string) => Effect.Effect<BlobRef | null, StoreError>;
  /** Makes a file the blob `ref`, whose bytes the blob store has. */
  readonly putBlob?: (path: string, ref: BlobRef) => Effect.Effect<void, StoreError>;
  /** Copies a file to another path, a blob by its ref (no bytes read); false if there's no such file. */
  readonly copy?: (from: string, to: string) => Effect.Effect<boolean, StoreError>;
  /** What storage knows of its files beyond their bytes: a blob's size, hash and time, a text file's last write. */
  readonly stats?: Effect.Effect<Map<string, { size?: number; at?: number; hash?: string }>, StoreError>;
}>()("erga/FileStore") {}

/** What a room saved: its history (a snapshot, then the updates after it, in order). */
export interface Saved {
  updates: Uint8Array[];
  /** Storage's files may differ from the history (changed while the room was closed): read and merge each one. */
  reconcile: boolean;
  /** Files whose latest text storage doesn't have yet: the room writes them. */
  unwritten: string[];
}

/** One write: the Yjs update since the last one, the text files written with it, and the files deleted. */
export interface Commit {
  update: Uint8Array | null;
  write: [path: string, text: string][];
  remove: string[];
  /** Files whose latest text storage still lacks after this commit (written later). */
  unwritten: string[];
}

/**
 * How the room keeps its history between runs (the journal in a Durable
 * Object's storage, document/storage.ts), and writes its files with it.
 */
export class StateStore extends Context.Service<StateStore, {
  /** The saved history, or null if there's none. */
  readonly load: Effect.Effect<Saved | null, StoreError>;
  /** Writes one commit: in one transaction where storage has them. */
  readonly commit: (c: Commit) => Effect.Effect<void, StoreError>;
  /**
   * Makes the whole state (`state()`, asked only if needed) the snapshot in
   * place of the log, if `when` calls for it: "log" when the log is long,
   * "cut" (a version) when it's long for the snapshot, "always". Whether it did.
   */
  readonly compact: (state: () => Uint8Array, when: "log" | "cut" | "always") => Effect.Effect<boolean, StoreError>;
  /** Its files may be written after the journal (lazily): it keeps the history, and nothing else changes them. */
  readonly lazyFiles: boolean;
}>()("erga/StateStore") {
  /** No saved history: every run starts a new epoch from the files, written through the FileStore at every write. */
  static readonly none = Layer.effect(StateStore, Effect.gen(function* () {
    const files = yield* FileStore;
    return StateStore.of({
      load: Effect.succeed(null),
      commit: (c) => Effect.gen(function* () {
        for (const [path, text] of c.write) yield* files.write(path, text);
        if (files.remove) for (const path of c.remove) yield* files.remove(path);
      }),
      compact: () => Effect.succeed(false),
      lazyFiles: false,
    });
  }));
}

const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_QUERY_AWARENESS = 3;

/** One participant's connection to the room. */
export interface Connection {
  /** Handles a message; false if it was malformed (the caller should hang up). */
  receive(message: Uint8Array): boolean;
  close(): void;
  /** Takes the lock for source edits as `by` (its name, for the others): null when it has it, else whose it is. */
  lock(by: string): string | null;
  /** Lets go of the lock, if it has it. */
  unlock(): void;
  /** Whose the lock is, if another participant has it. */
  lockedBy(): string | null;
}

/** How long the lock for source edits holds with no edit from its holder: a stuck agent can't keep the document. */
export const LOCK_IDLE_MS = 30_000;

/** Why a file pushed to the room wasn't taken. */
export type PushResult = { ok: true; etag: string } | { ok: false; etag: string | null; reason: "stale" | "binary" };

export class Room {
  readonly awareness: Awareness;
  /** Each text file as storage last had it: the base for merging edits made there. */
  private stored = new Map<string, string>();
  /**
   * What the files hold of the history: each client's clock at the last write that left no file behind (none: the
   * files are behind since the room opened). A new epoch starts from the files, so a page takes this, and nothing
   * that the room only has in memory or in its journal, as the base of its edits (libs/text/ui/collab.ts, adopt).
   */
  private filed = new Map<number, number>();
  /** What it must still write of each file (writes.ts). */
  private writes: Writes = NOTHING;
  /** The Yjs updates made since the last write, for the journal. */
  private unsaved: Uint8Array[] = [];
  /** Open while there are edits to write: the writer waits on it. */
  private pending = Latch.makeUnsafe(false);
  /** Writes and merges, one at a time. */
  private turn = Semaphore.makeUnsafe(1);
  private conns = new Map<object, { send: (m: Uint8Array) => void; clients: Set<number> }>();
  /**
   * The lock for source edits: the participant that holds it (its connection's key) and whose it is. An agent's run of
   * edits to the source takes it (agents/document/session.ts); meanwhile the room drops everyone else's edits, and asks
   * for them again when it lets go. It's in the shared doc too (roomInfo's "lock": its name), so every tab sees it
   * and shows the page read-only (libs/text/ui/frame.ts).
   */
  private locked: { key: object; by: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly me: Author = { user: "disk", name: "On disk", color: "#6b7280", kind: "disk" };
  private decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  /** Who hears that the tree changed (a file or folder added, removed or moved). */
  private treeListeners = new Set<() => void>();
  private treeQueued = false;
  /** How long a file's text may wait to be written: no wait without a journal. */
  readonly fileDelay: number;

  private constructor(readonly doc: Y.Doc, private store: FileStore["Service"], private state: StateStore["Service"], private log: (line: string) => void, readonly writeDelay: number, fileDelay: number) {
    this.awareness = new Awareness(doc);
    // The room itself is not a visible participant.
    this.awareness.setLocalState(null);
    this.fileDelay = state.lazyFiles ? fileDelay : 0;
  }

  /**
   * Opens the room on its storage, for as long as the scope lasts.
   * `writeDelay`: how long after an edit it's written to the journal (400ms
   * unless a test wants it sooner); `fileDelay`: how long a file's text may
   * wait to be written (2 seconds, or `writeDelay` if that's longer).
   */
  static make(opts: { log?: (line: string) => void; writeDelay?: number; fileDelay?: number } = {}): Effect.Effect<Room, StoreError, FileStore | StateStore | Scope.Scope> {
    return Effect.gen(function* () {
      const store = yield* FileStore, state = yield* StateStore;
      const log = opts.log ?? (() => {});
      const writeDelay = opts.writeDelay ?? 400;
      // A history that fails to load fails the open (the next request tries again): it's never written over.
      const saved = yield* state.load;
      const doc = saved && saved.updates.length ? docOf(saved.updates, log) : null;
      const room = new Room(doc ?? new Y.Doc(), store, state, log, writeDelay, Math.max(writeDelay, opts.fileDelay ?? 2000));
      // Every change from here on goes to the journal with the next write.
      room.doc.on("update", (update: Uint8Array) => { room.unsaved.push(update); room.pending.openUnsafe(); });
      yield* room.restore(!doc || saved!.reconcile, saved?.unwritten ?? []);
      // A lock from before the room closed has no holder now.
      if (roomInfo(room.doc).has("lock")) room.act(() => roomInfo(room.doc).delete("lock"));
      // The files are as the room is, unless the journal names some that wait.
      if (!room.writes.paths.size) room.filed = Y.decodeStateVector(Y.encodeStateVector(room.doc));
      room.doc.on("update", (update: Uint8Array, origin: unknown) => room.broadcast(syncUpdate(update), origin));
      room.doc.on("afterTransaction", (tr: Y.Transaction) => room.noteDirty(tr));
      // The tree changed: files or folders came or went (a file's text changing isn't one).
      const treeChanged = (e: { keysChanged: Set<string> }) => { if (e.keysChanged.size) room.treeChanged(); };
      files(room.doc).observe(treeChanged);
      assets(room.doc).observe(treeChanged);
      folders(room.doc).observe(treeChanged);
      room.awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
        const conn = origin != null ? room.conns.get(origin) : undefined;
        if (conn) { for (const c of added) conn.clients.add(c); for (const c of removed) conn.clients.delete(c); }
        room.broadcast(awarenessMessage(room.awareness, [...added, ...updated, ...removed]), origin);
      });
      // The writer: once there's something to write, wait out the delay
      // (edits made meanwhile ride along), then write it; files not yet
      // written wake it when they're due.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const due = room.waitingDue();
            if (due != null) yield* Effect.raceFirst(room.pending.await, Effect.sleep(due));
            else yield* room.pending.await;
            // After a commit that failed, longer each time.
            yield* Effect.sleep(retryIn(room.writes, room.writeDelay));
            yield* Semaphore.withPermit(room.turn, room.write(false));
          })
        )
      );
      // Closing: everything not yet written goes to storage, and the lock's timer stops.
      yield* Effect.addFinalizer(() =>
        room.flush.pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (room.locked) clearTimeout(room.locked.timer);
              room.locked = null;
              room.awareness.destroy();
            })
          )
        )
      );
      return room;
    });
  }

  /**
   * One change by the room itself (a file taken from storage, the tree):
   * the first one says who the room is, so its edits are attributed ("On
   * disk"). A room that changes nothing adds nothing to the history.
   */
  act(f: () => void): void {
    this.doc.transact(() => {
      if (!this.introduced) { this.introduced = true; introduce(this.doc, this.me); }
      f();
    }, this);
  }
  private introduced = false;

  /** The room's epoch: which history it holds (see the top of this file). */
  get epoch(): string { return roomInfo(this.doc).get("epoch") as string; }

  /**
   * Takes the saved history as what storage's files hold (each file its
   * text, but those the journal names as unwritten, which are written
   * soon), or, with `reconcile`, reads every file and merges in what
   * changed while the room was closed; without a history, a new epoch
   * starts from the files, and the history starts over as one snapshot.
   */
  private restore(reconcile: boolean, unwritten: string[]): Effect.Effect<void, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      if (!roomInfo(self.doc).get("epoch")) self.act(() => roomInfo(self.doc).set("epoch", crypto.randomUUID()));
      if (!reconcile) {
        const behind = new Set(unwritten);
        for (const [path, t] of files(self.doc)) if (!behind.has(path)) self.stored.set(path, t.toString());
        // Due at once: storage has an older text of these.
        const waiting = [...files(self.doc).keys()].filter((path) => behind.has(path));
        if (waiting.length) {
          self.step({ on: "waiting", paths: waiting });
          self.pending.openUnsafe();
        }
        return;
      }
      const paths = new Set(yield* self.store.list);
      for (const path of paths) {
        const bytes = yield* self.store.read(path);
        if (bytes) self.reconcile(path, bytes);
      }
      self.forgetMissing(paths);
      yield* self.syncFolders;
      self.unsaved = [];
      yield* Effect.catch(self.state.compact(() => Y.encodeStateAsUpdate(self.doc), "always"), (e) => Effect.sync(() => {
        self.log(`  could not save the room's state: ${e.message}`);
        // The next write takes it all instead.
        self.unsaved.push(Y.encodeStateAsUpdate(self.doc));
        self.pending.openUnsafe();
      }));
    });
  }

  /** Brings one file from storage into the restored room. */
  private reconcile(path: string, bytes: Uint8Array): void {
    const text = this.asText(path, bytes);
    const t = files(this.doc).get(path);
    if (text == null) {
      this.act(() => assets(this.doc).set(path, digest(bytes)));
      return;
    }
    this.stored.set(path, text);
    if (!t) {
      this.act(() => {
        const nt = new Y.Text();
        nt.insert(0, text);
        files(this.doc).set(path, nt);
      });
    } else if (t.toString() != text) {
      // Changed in storage while the room was closed (on disk). The room
      // writes its files with its history, so the two agree unless someone
      // else changed the file since: their version wins, applied as an edit
      // (the history stays, so open tabs still merge).
      this.mergeText(t, t.toString(), text);
    }
  }

  /** Files deleted while the room was closed. */
  private forgetMissing(paths: Set<string>): void {
    for (const path of [...files(this.doc).keys()]) if (!paths.has(path)) this.act(() => files(this.doc).delete(path));
    for (const path of [...assets(this.doc).keys()]) if (!paths.has(path)) this.act(() => assets(this.doc).delete(path));
  }

  private asText(path: string, bytes: Uint8Array): string | null {
    if (!isTextPath(path) || bytes.length > TEXT_MAX) return null;
    try { return this.decoder.decode(bytes); } catch { return null; }
  }

  // ------------------------------------------------------------ participants

  /**
   * A participant joins: `send` carries the room's messages to it. A tab
   * that already holds a history names its epoch; if it isn't this room's,
   * it's refused (null) rather than merged. A read-only one (someone who may
   * only view the document) gets everything, and its own edits are dropped;
   * its caret still shows.
   */
  connect(send: (message: Uint8Array) => void, opts: { epoch?: string | null; readOnly?: boolean } = {}): Connection | null {
    if (opts.epoch && opts.epoch != this.epoch) return null;
    const key = {};
    this.conns.set(key, { send, clients: new Set() });
    const hello = new Encoder();
    hello.writeUint(MSG_SYNC);
    writeSyncStep1(hello, this.doc);
    send(hello.toBytes());
    const present = [...this.awareness.getStates().keys()];
    if (present.length) send(awarenessMessage(this.awareness, present));
    // All that the files hold: a participant that was away catches up.
    if (this.filed.size) send(storedMessage(this.filed));
    return {
      receive: (message) => {
        try {
          const decoder = new Decoder(message);
          const type = decoder.readUint();
          if (type == MSG_SYNC) {
            const update = decoder.peekUint() != SYNC_STEP1;
            // Read-only: only its request for what it's missing (step 1); its updates are dropped. So are everyone's
            // but the lock's holder's while it's held: asked for again when it's let go (unlock).
            if (update && (opts.readOnly || (this.locked && this.locked.key !== key))) return true;
            if (update && this.locked?.key === key) this.holdLock();
            const reply = new Encoder();
            reply.writeUint(MSG_SYNC);
            readSyncMessage(decoder, reply, this.doc, key);
            if (reply.length > 1) send(reply.toBytes());
          } else if (type == MSG_AWARENESS) {
            applyAwarenessUpdate(this.awareness, decoder.readBytes(), key);
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
        removeAwarenessStates(this.awareness, [...conn.clients], null);
        this.unlock(key);
      },
      lock: (by) => {
        if (this.locked && this.locked.key !== key) return this.locked.by;
        if (!this.locked) {
          this.locked = { key, by, timer: setTimeout(() => this.unlock(key), LOCK_IDLE_MS) };
          this.act(() => roomInfo(this.doc).set("lock", by));
        }
        this.holdLock();
        return null;
      },
      unlock: () => this.unlock(key),
      lockedBy: () => (this.locked && this.locked.key !== key ? this.locked.by : null),
    };
  }

  /** The lock's holder edited: it holds for LOCK_IDLE_MS more. */
  private holdLock(): void {
    const l = this.locked;
    if (!l) return;
    clearTimeout(l.timer);
    l.timer = setTimeout(() => this.unlock(l.key), LOCK_IDLE_MS);
  }

  /** Lets go of the lock (if `key` holds it): everyone may edit again, and the edits it dropped meanwhile come again. */
  private unlock(key: object): void {
    if (this.locked?.key !== key) return;
    clearTimeout(this.locked.timer);
    this.locked = null;
    this.act(() => roomInfo(this.doc).delete("lock"));
    // Each participant's step 2 answers with what the room lacks: what it typed while it was locked out.
    const ask = new Encoder();
    ask.writeUint(MSG_SYNC);
    writeSyncStep1(ask, this.doc);
    const message = ask.toBytes();
    for (const conn of this.conns.values()) conn.send(message);
  }

  private broadcast(message: Uint8Array, origin: unknown): void {
    for (const [key, conn] of this.conns) if (key !== origin) conn.send(message);
  }

  /** The files hold the history up to `vector` (a state vector) now: every participant hears what is new in it. */
  private sayStored(vector: Uint8Array): void {
    const news = new Map<number, number>();
    for (const [client, clock] of Y.decodeStateVector(vector)) {
      if (this.filed.get(client) == clock) continue;
      this.filed.set(client, clock);
      news.set(client, clock);
    }
    if (news.size) this.broadcast(storedMessage(news), null);
  }

  // ------------------------------------------------------------ storage

  /** The current text of a file, if the room holds it as text. */
  text(path: string): string | null {
    return files(this.doc).get(path)?.toString() ?? null;
  }

  private noteDirty(tr: Y.Transaction): void {
    const edited: string[] = [];
    for (const [type, keys] of tr.changed) {
      if (type === (files(this.doc) as Y.AbstractType<any>)) {
        for (const k of keys) if (k) edited.push(k);
      } else {
        const path = pathOf(type);
        if (path != null) edited.push(path);
      }
    }
    if (edited.length) this.markDirty(...edited);
  }

  private markDirty(...paths: string[]): void {
    this.step({ on: "edited", paths });
    this.pending.openUnsafe();
  }

  private step(e: WriteEvent): Planned | undefined {
    const t = nextWrites(this.writes, e);
    this.writes = t.writes;
    return t.commit;
  }

  /** In how many ms the files that wait are due; null if none waits. */
  private waitingDue(): number | null {
    if (![...this.writes.paths.values()].includes("waiting")) return null;
    return Math.max(0, this.writes.since + this.fileDelay - Date.now());
  }

  /** Whether storage has everything the room holds: nothing waits to be written. */
  get saved(): boolean {
    return this.writes.paths.size == 0 && this.unsaved.length == 0;
  }

  /**
   * Who the room's own edits in this turn of the queue are by (a publish's `by`: the files arriving whole), for the
   * version; null: nobody named.
   */
  get by(): string | null {
    return this.actor;
  }
  private actor: string | null = null;

  /** Runs `work` in one turn of the queue, its edits by `by`: one turn at a time, so two publishes never mix. */
  private inTurn<A, E>(by: string | null, work: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Semaphore.withPermit(
      this.turn,
      Effect.suspend(() => {
        this.actor = by;
        return Effect.ensuring(
          work,
          Effect.sync(() => {
            this.actor = null;
          })
        );
      })
    );
  }

  /** Writes everything: the journal, and every file whose text storage doesn't have yet. */
  get flush(): Effect.Effect<void> {
    return Semaphore.withPermit(this.turn, this.write(true));
  }

  /**
   * One write (inside the queue): the updates since the last one go to the
   * journal, with the files that are due (all of them with `all`, else
   * once they've waited `fileDelay`) and the files deleted, in one commit.
   * Then, if the log has grown long, it becomes a snapshot.
   */
  private write(all: boolean): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.pending.closeUnsafe();
      const before = this.writes;
      const c = this.step({
        on: "write",
        now: Date.now(),
        all,
        fileDelay: this.fileDelay,
        look: (path) => {
          const text = this.text(path);
          // Deleted in the room by a participant (an agent's undo taking back a file it made): storage follows.
          if (text == null) return assets(this.doc).has(path) ? "asset" : "gone";
          return text == this.stored.get(path) ? "same" : "text";
        },
      })!;
      const updates = this.unsaved;
      if (!updates.length && !c.write.length && !c.remove.length && c.later.length == before.paths.size) return Effect.void;
      this.unsaved = [];
      const update = updates.length == 0 ? null : updates.length == 1 ? updates[0] : Y.mergeUpdates(updates);
      const write = c.write.map((path) => [path, this.text(path)!] as [string, string]);
      // With no file left for later, the files are the room as it is at this moment.
      const filed = c.later.length ? null : Y.encodeStateVector(this.doc);
      return this.state.commit({ update, write, remove: c.remove, unwritten: c.later }).pipe(
        Effect.map(() => {
          this.step({ on: "committed" });
          for (const [path, text] of write) this.stored.set(path, text);
          for (const path of c.remove) this.stored.delete(path);
          if (filed) this.sayStored(filed);
        }),
        Effect.andThen(
          Effect.catch(
            this.state.compact(() => Y.encodeStateAsUpdate(this.doc), "log"),
            (e) => Effect.sync(() => this.log(`  could not compact the room's history: ${e.message}`))
          )
        ),
        Effect.catch((e) =>
          Effect.sync(() => {
            // Tried again with the next write, a little later each time: nothing is lost.
          this.log(`  could not write the room's edits: ${e.message}`);
          this.unsaved = [...updates, ...this.unsaved];
          this.step({ on: "failed", commit: c });
          this.pending.openUnsafe();
        })),
      );
    });
  }

  /**
   * At a version: writes what's left, and makes the history one snapshot
   * if its log has grown long against the snapshot (document.ts cuts one).
   */
  get settle(): Effect.Effect<void> {
    return Semaphore.withPermit(this.turn, this.write(true).pipe(
      Effect.andThen(Effect.catch(Effect.suspend(() => this.state.compact(() => Y.encodeStateAsUpdate(this.doc), "cut")), (e) => Effect.sync(() => this.log(`  could not compact the room's history: ${e.message}`)))),
    ));
  }

  /** Applies storage's change (from `base` to `incoming`) on top of the room's text. */
  private mergeText(t: Y.Text, base: string, incoming: string): void {
    const changes = rebase(base, t.toString(), incoming);
    if (changes.empty) return;
    this.act(() => {
      const { inserted, deleted } = applyChanges(t, changes);
      if (deleted && !inserted) stamp(this.doc, this.me);
    });
  }

  /**
   * A file changed in storage (the watcher says so). If it's not a write of
   * ours, merge it in: the change from the last version both sides agreed on
   * is rebased over the room's edits since, so nobody's work is lost.
   */
  fileChanged(path: string, by: string | null = null): Effect.Effect<void, StoreError> {
    return this.inTurn(
      by,
      Effect.map(this.store.read(path), (bytes) => this.take(path, bytes))
    );
  }

  /**
   * An edit that arrives as a whole file (a publish): written to storage
   * and merged into the room in one turn of the queue. With `ifMatch` (an
   * etag from `etag`), it's refused if storage has moved on since, so a
   * file based on an old version can't undo newer edits.
   */
  push(path: string, text: string, ifMatch: string | null = null, by: string | null = null): Effect.Effect<PushResult, StoreError> {
    const self = this;
    return this.inTurn(
      by,
      Effect.gen(function* () {
        // Big text arriving whole is a blob (D5): only an edit makes a text that big.
        if (!isTextPath(path) || new TextEncoder().encode(text).length > TEXT_MAX)
          return { ok: false, etag: null, reason: "binary" } as const;
      const before = yield* self.store.read(path);
      const current = before ? digest(before) : null;
      if (ifMatch != null && ifMatch != current) return { ok: false, etag: current, reason: "stale" } as const;
      const bytes = new TextEncoder().encode(text);
      if (current == digest(bytes) && self.text(path) == text) return { ok: true, etag: current } as const;
      // The file was made from what storage holds: the room's edits since (not written yet) stay, merged with it.
      const base = before && self.asText(path, before);
      if (base != null) self.stored.set(path, base);
      self.takeText(path, text);
      yield* self.write(true);
      return { ok: true, etag: digest(bytes) } as const;
    }));
  }

  /**
   * A text arriving whole that storage doesn't have yet (a push, a new
   * page, a moved file): merged in as storage's would be, and written with
   * the next write, in the same commit as the change to the history.
   */
  private takeText(path: string, text: string): void {
    // Text in place of a file kept whole (a blob): the file is text from now on.
    if (assets(this.doc).has(path)) this.act(() => assets(this.doc).delete(path));
    this.take(path, new TextEncoder().encode(text));
    this.stored.delete(path);
    this.step({ on: "edited", paths: [path] });
  }

  /** Takes storage's version of a file into the room (inside the queue). */
  private take(path: string, bytes: Uint8Array | null): void {
    const t = files(this.doc).get(path);
    if (!bytes) {
      // Deleted (or renamed away). Text the room has unsaved edits to stays.
      if (t && t.toString() == this.stored.get(path)) this.act(() => files(this.doc).delete(path));
      if (assets(this.doc).has(path)) this.act(() => assets(this.doc).delete(path));
      this.stored.delete(path);
      return;
    }
    const text = this.asText(path, bytes);
    if (text == null) {
      const h = digest(bytes);
      if (assets(this.doc).get(path) != h) this.act(() => assets(this.doc).set(path, h));
      return;
    }
    if (!t) {
      this.stored.set(path, text);
      this.act(() => {
        const nt = new Y.Text();
        nt.insert(0, text);
        files(this.doc).set(path, nt);
      });
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

  // ------------------------------------------------------------ the tree
  //
  // Files and folders made, moved and deleted as such (document/pages.ts checks what's
  // asked first): storage and the shared doc change together, in one turn
  // of the queue, so every participant sees the new tree at once.

  /** Hears whenever the tree changes, from anyone (once per burst). Returns the way to stop. */
  onTree(listener: () => void): () => void {
    this.treeListeners.add(listener);
    return () => { this.treeListeners.delete(listener); };
  }

  private treeChanged(): void {
    if (this.treeQueued) return;
    this.treeQueued = true;
    queueMicrotask(() => { this.treeQueued = false; for (const l of this.treeListeners) l(); });
  }

  /** Every file the room holds, text or not. */
  paths(): string[] {
    return [...new Set([...files(this.doc).keys(), ...assets(this.doc).keys()])].sort();
  }

  /** The folders made as such (empty ones too). */
  folderPaths(): string[] {
    return [...folders(this.doc).keys()].sort();
  }

  /** Whether a file or folder is at a path. */
  exists(path: string): "file" | "folder" | null {
    if (files(this.doc).has(path) || assets(this.doc).has(path)) return "file";
    if (folders(this.doc).has(path)) return "folder";
    const inside = `${path}/`;
    for (const p of [...files(this.doc).keys(), ...assets(this.doc).keys(), ...folders(this.doc).keys()]) if (p.startsWith(inside)) return "folder";
    return null;
  }

  /** The folders storage keeps (empty ones included), into the shared doc: as the room opens, and when back in touch with disk. */
  get syncFolders(): Effect.Effect<void, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      if (!self.store.folders) return;
      const stored = new Set(yield* self.store.folders);
      const map = folders(self.doc);
      self.act(() => {
        for (const d of stored) if (!map.has(d)) map.set(d, true);
        for (const d of [...map.keys()]) if (!stored.has(d)) map.delete(d);
      });
    });
  }

  /** Makes a folder, and those it's in. */
  mkdir(path: string): Effect.Effect<void, StoreError> {
    return Semaphore.withPermit(this.turn, this.makeFolder(path));
  }

  private makeFolder(path: string): Effect.Effect<void, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const map = folders(self.doc);
      const all = path.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
      if (self.store.mkdir) yield* self.store.mkdir(path);
      self.act(() => {
        for (const d of all) if (!map.has(d)) map.set(d, true);
      });
    });
  }

  /** A new text file (a page from the template): written, and in the room. */
  create(path: string, text: string): Effect.Effect<void, StoreError> {
    const self = this;
    return Semaphore.withPermit(this.turn, Effect.suspend(() => {
      self.takeText(path, text);
      return self.write(true);
    }));
  }

  /** Deletes a file, or a folder and everything in it. */
  remove(path: string): Effect.Effect<void, StoreError> {
    const self = this;
    return Semaphore.withPermit(this.turn, Effect.gen(function* () {
      if (files(self.doc).has(path) || assets(self.doc).has(path)) {
        self.removeFile(path);
        // The folder it was in stays, as a folder on disk would, even if that was its last file.
        if (path.includes("/")) yield* self.makeFolder(parentOf(path));
        return yield* self.write(true);
      }
      const inside = `${path}/`;
      for (const p of self.paths()) if (p.startsWith(inside)) self.removeFile(p);
      yield* self.write(true);
      if (self.store.rmdir) yield* self.store.rmdir(path);
      const map = folders(self.doc);
      self.act(() => {
        for (const d of [...map.keys()]) if (d == path || d.startsWith(inside)) map.delete(d);
      });
    })
  );
  }

  /** Deletes one file (a publish that removes it); nothing if the room has no such file. */
  removeOne(path: string, by: string | null = null): Effect.Effect<boolean> {
    return this.inTurn(
      by,
      Effect.suspend(() => {
        if (!files(this.doc).has(path) && !assets(this.doc).has(path)) return Effect.succeed(false);
      this.removeFile(path);
      return Effect.as(this.write(true), true);
    }));
  }

  /**
   * Makes a file the blob `ref` (its bytes already in the blob store: an
   * upload, an agent's write of bytes), in one turn of the queue: storage
   * keeps the ref, and the room the hash, so every tab sees the new file at
   * once. A text file at the path is replaced: a file changes kind only so,
   * replaced whole, never while someone edits it.
   */
  putBlob(path: string, ref: BlobRef, by: string | null = null): Effect.Effect<void, StoreError> {
    const self = this;
    return this.inTurn(
      by,
      Effect.gen(function* () {
        if (!self.store.putBlob) return yield* Effect.fail(new StoreError({ message: "this document keeps no files but text" }));
      // A text there goes first (its stored copy with it), then the blob takes its place.
      if (files(self.doc).has(path)) { self.removeFile(path); yield* self.write(true); }
      yield* self.store.putBlob(path, ref);
      self.step({ on: "stored", path });
      if (assets(self.doc).get(path) != ref.hash) self.act(() => assets(self.doc).set(path, ref.hash));
      yield* self.write(true);
    }));
  }

  /** Takes a file out of the room; storage deletes it with the next write. */
  private removeFile(path: string): void {
    this.stored.delete(path);
    this.step({ on: "removed", path });
    this.act(() => {
      files(this.doc).delete(path);
      assets(this.doc).delete(path);
    });
  }

  /**
   * Moves (or renames) a file or a folder and everything in it. A text
   * file's text goes as it is now, unsaved edits included; it starts a new
   * history at its new path.
   */
  move(from: string, to: string): Effect.Effect<void, StoreError> {
    const self = this;
    return Semaphore.withPermit(this.turn, Effect.gen(function* () {
      const map = folders(self.doc);
      if (files(self.doc).has(from) || assets(self.doc).has(from)) {
        yield* self.copyFile(from, to);
        self.removeFile(from);
        if (from.includes("/")) yield* self.makeFolder(parentOf(from));
        return yield* self.write(true);
      }
      const inside = `${from}/`;
      // The folder itself, then every folder and file inside it, each at its new place.
      yield* self.makeFolder(to);
      for (const d of [...map.keys()]) if (d.startsWith(inside)) yield* self.makeFolder(to + d.slice(from.length));
      for (const p of self.paths()) if (p.startsWith(inside)) {
        yield* self.copyFile(p, to + p.slice(from.length));
        self.removeFile(p);
      }
      yield* self.write(true);
      if (self.store.rmdir) yield* self.store.rmdir(from);
      self.act(() => {
        for (const d of [...map.keys()]) if (d == from || d.startsWith(inside)) map.delete(d);
      });
    })
  );
  }

  private copyFile(from: string, to: string): Effect.Effect<void, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const text = self.text(from);
      if (text != null) return self.takeText(to, text);
      // A blob goes by its ref: no bytes read.
      const ref = self.store.ref ? yield* self.store.ref(from) : null;
      if (ref && self.store.copy) {
        if (!(yield* self.store.copy(from, to))) return;
        self.step({ on: "stored", path: to });
        return self.act(() => assets(self.doc).set(to, assets(self.doc).get(from) ?? ref.hash));
      }
      const bytes = yield* self.store.read(from);
      if (!bytes) return;
      if (!self.store.writeBytes) return yield* Effect.fail(new StoreError({ message: `${from} can't be moved here: only text files can` }));
      yield* self.store.writeBytes(to, bytes);
      self.take(to, bytes);
    });
  }
}

/** The doc a saved history makes, or null if it doesn't load whole or has no epoch (a new one starts). */
function docOf(updates: Uint8Array[], log: (line: string) => void): Y.Doc | null {
  const doc = new Y.Doc();
  try {
    doc.transact(() => { for (const u of updates) Y.applyUpdate(doc, u); });
  } catch (e) {
    log(`  saved room state unreadable, starting afresh: ${(e as Error).message}`);
    return null;
  }
  if (roomInfo(doc).get("epoch")) return doc;
  log("  saved room state has no epoch; starting afresh");
  return null;
}

/** Whether a room message is presence only (awareness): it changes nothing in the document. */
export const isAwareness = (message: Uint8Array) => message.length > 0 && message[0] == MSG_AWARENESS;

/** Whether a presence message reads as one, as applyAwarenessUpdate reads it: each client's number, clock and state. */
export function readsAsAwareness(message: Uint8Array): boolean {
  try {
    const d = new Decoder(new Decoder(message.subarray(1)).readBytes());
    for (let n = d.readUint(); n > 0; n--) {
      d.readUint();
      d.readUint();
      JSON.parse(d.readString());
    }
    return true;
  } catch {
    return false;
  }
}

/** The files-map key a changed Y.Text lives under. */
function pathOf(type: Y.AbstractType<any>): string | null {
  const item = type._item;
  if (!item || !(item.parent instanceof Y.Map) || item.parentSub == null) return null;
  return item.parentSub;
}

function syncUpdate(update: Uint8Array): Uint8Array {
  const e = new Encoder();
  e.writeUint(MSG_SYNC);
  writeUpdate(e, update);
  return e.toBytes();
}

function storedMessage(vector: Map<number, number>): Uint8Array {
  const e = new Encoder();
  e.writeUint(MSG_STORED);
  writeVector(e, vector);
  return e.toBytes();
}

function awarenessMessage(awareness: Awareness, clients: number[]): Uint8Array {
  const e = new Encoder();
  e.writeUint(MSG_AWARENESS);
  e.writeBytes(encodeAwarenessUpdate(awareness, clients));
  return e.toBytes();
}

/** A short content hash: an asset's versioned reference, and a file's etag. */
export function digest(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex").slice(0, 16);
}

/**
 * Joins a doc to the room in process, as an ordinary peer: the same sync
 * and awareness messages a tab sends over its WebSocket, delivered on the
 * microtask queue (in order, never re-entrantly). Returns how it leaves, and
 * how it takes and lets go of the lock for source edits.
 */
export function joinLocal(
  room: Room,
  doc: Y.Doc,
  awareness: Awareness
): { leave: () => void; lock: (by: string) => string | null; unlock: () => void; lockedBy: () => string | null } {
  let open = true;
  const conn = room.connect((message) => queueMicrotask(() => { if (open) receive(message); }))!;
  const toRoom = (message: Uint8Array) => queueMicrotask(() => { if (open) conn.receive(message); });
  function receive(message: Uint8Array) {
    const decoder = new Decoder(message);
    const type = decoder.readUint();
    if (type == MSG_SYNC) {
      const reply = new Encoder();
      reply.writeUint(MSG_SYNC);
      readSyncMessage(decoder, reply, doc, conn);
      if (reply.length > 1) toRoom(reply.toBytes());
    } else if (type == MSG_AWARENESS) {
      applyAwarenessUpdate(awareness, decoder.readBytes(), conn);
    }
  }
  const onUpdate = (update: Uint8Array, origin: unknown) => { if (origin !== conn) toRoom(syncUpdate(update)); };
  const onAwareness = ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
    if (origin === conn) return;
    toRoom(awarenessMessage(awareness, [...added, ...updated, ...removed]));
  };
  doc.on("update", onUpdate);
  awareness.on("update", onAwareness);
  const hello = new Encoder();
  hello.writeUint(MSG_SYNC);
  writeSyncStep1(hello, doc);
  toRoom(hello.toBytes());
  if (awareness.getLocalState()) toRoom(awarenessMessage(awareness, [doc.clientID]));
  return {
    leave: () => {
      removeAwarenessStates(awareness, [doc.clientID], "leave");
      queueMicrotask(() => { open = false; conn.close(); });
      doc.off("update", onUpdate);
      awareness.off("update", onAwareness);
    },
    // (At once: the edits made after it reach the room in a microtask, as the holder's.)
    lock: (by) => conn.lock(by),
    // (After the edits on their way, which are the holder's.)
    unlock: () => queueMicrotask(() => conn.unlock()),
    lockedBy: () => conn.lockedBy(),
  };
}

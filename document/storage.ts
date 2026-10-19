// What a document keeps between runs, as the small interface the document
// needs: values by key (its files, its folders, its record, the room's Yjs
// state, its versions), listed by prefix and in order, and one alarm (when
// an unedited document expires). A Durable Object's storage is one as it is
// (cloudflare/document-object.ts); MemoryStorage is one for the tests, and
// a folder on disk is one in local development (dev/).
//
// The room's history is a journal under `room/` (see `Journal`): a snapshot
// of the whole Yjs state, cut into parts of at most PART bytes, and a log of
// the updates since, one entry per write. It uses the same key-value
// storage as everything else (in a SQLite-backed Durable Object, one row per
// key), so a document's storage is still one list of keys: staging copies it
// whole (deploy/snapshot.ts), local development keeps it beside a folder on
// disk, and the tests keep it in memory.

import * as Effect from "effect/Effect";
import type { KV } from "./versions.ts";
import { FileStore, StateStore, StoreError } from "./room.ts";

export interface Storage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  /** Whether the key was there. */
  delete(key: string): Promise<boolean>;
  /** How many were there. */
  delete(keys: string[]): Promise<number>;
  /** Entries in key order: those with the prefix, after `startAfter`, at most `limit` of them. */
  list<T = unknown>(options?: { prefix?: string; startAfter?: string; limit?: number }): Promise<Map<string, T>>;
  /** Every entry goes; the alarm stays. */
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/**
 * Storage keys: a file's bytes, a folder made as one (empty ones too), what
 * the document is, the room's journal and the files whose latest text
 * storage doesn't have yet (in it). `state`: the room's whole Yjs state in
 * one value, as documents kept it before the journal (read once, then gone).
 */
export const KEYS = { file: "files/", dir: "folders/", meta: "info", room: "room/", unwritten: "room/unwritten", state: "room-state" } as const;

/** A Storage in memory, for the tests: `wake` runs when the alarm comes due. */
export class MemoryStorage implements Storage {
  readonly data = new Map<string, unknown>();
  private alarm: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private wake: () => void | Promise<void> = () => {}) {}

  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  async get<T>(key: string | string[]): Promise<unknown> {
    if (Array.isArray(key)) { const out = new Map<string, T>(); for (const k of key) if (this.data.has(k)) out.set(k, this.data.get(k) as T); return out; }
    return this.data.get(key) as T | undefined;
  }
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key == "string") this.data.set(key, value);
    else for (const [k, v] of Object.entries(key)) this.data.set(k, v);
  }
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) return key.reduce((n, k) => n + (this.data.delete(k) ? 1 : 0), 0);
    return this.data.delete(key);
  }
  async list<T = unknown>(options: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const k of [...this.data.keys()].sort()) {
      if (options.prefix != null && !k.startsWith(options.prefix)) continue;
      if (options.startAfter != null && k <= options.startAfter) continue;
      if (options.limit != null && out.size >= options.limit) break;
      out.set(k, this.data.get(k) as T);
    }
    return out;
  }
  async deleteAll(): Promise<void> { this.data.clear(); }
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async setAlarm(at: number): Promise<void> {
    await this.deleteAlarm();
    this.alarm = at;
    this.timer = setTimeout(() => { this.alarm = null; this.timer = null; void this.wake(); }, Math.max(0, at - Date.now()));
  }
  async deleteAlarm(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.alarm = null;
  }
}

const storeError = (e: unknown) => new StoreError({ message: e instanceof Error ? e.message : String(e) });

/**
 * The room's files in a Storage, as the FileStore it reads and writes:
 * `touch` runs for every change to them (the document is edited).
 */
export function fileStoreOf(storage: Storage, hooks: { touch: () => Promise<void> }): FileStore["Service"] {
  const { file: FILE, dir: DIR } = KEYS;
  return FileStore.of({
    list: Effect.tryPromise({ try: async () => [...(await storage.list({ prefix: FILE })).keys()].map((k) => k.slice(FILE.length)), catch: storeError }),
    read: (path) => Effect.tryPromise({ try: async () => (await storage.get<Uint8Array>(FILE + path)) ?? null, catch: storeError }),
    write: (path, text) => Effect.tryPromise({ try: () => Promise.all([storage.put(FILE + path, new TextEncoder().encode(text)), hooks.touch()]).then(() => {}), catch: storeError }),
    writeBytes: (path, bytes) => Effect.tryPromise({ try: () => Promise.all([storage.put(FILE + path, bytes), hooks.touch()]).then(() => {}), catch: storeError }),
    remove: (path) => Effect.tryPromise({ try: async () => { if (await storage.delete(FILE + path)) await hooks.touch(); }, catch: storeError }),
    folders: Effect.tryPromise({ try: async () => [...(await storage.list({ prefix: DIR })).keys()].map((k) => k.slice(DIR.length)), catch: storeError }),
    mkdir: (path) => Effect.tryPromise({
      try: async () => {
        const all = path.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
        await storage.put(Object.fromEntries(all.map((d) => [DIR + d, true])));
        await hooks.touch();
      },
      catch: storeError,
    }),
    rmdir: (path) => Effect.tryPromise({
      try: async () => {
        const keys = [...(await storage.list({ prefix: FILE + path + "/" })).keys(), ...(await storage.list({ prefix: DIR + path + "/" })).keys(), DIR + path];
        for (let i = 0; i < keys.length; i += BATCH) await storage.delete(keys.slice(i, i + BATCH));
        await hooks.touch();
      },
      catch: storeError,
    }),
  });
}

// ---------------------------------------------------------------- the journal

/** The most bytes one stored value holds: a SQLite-backed Durable Object takes 2 MiB, so a part has room to spare. */
export const PART = 1 << 20;
/** A Durable Object's storage takes at most 128 keys in one put or delete. */
const BATCH = 128;

/**
 * When the log becomes a snapshot. As the room writes ("log"): once it has
 * `logEntries` entries, or more bytes than the snapshot (and `logBytes`).
 * At a version ("cut"): sooner, `cutEntries`, or a quarter of the snapshot.
 */
export const COMPACT = { logEntries: 500, logBytes: 1 << 20, cutEntries: 100, cutBytes: 64 << 10 };

const HEAD = "room/head", SNAP = "room/s/", LOG = "room/u/";
/** A part's key after its record's prefix: `<record>/<part>-<parts>`. */
const PART_KEY = /^(\d{12})\/(\d{4})-(\d{4})$/;
const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Which snapshot is the history's (`gen`, in `parts` parts, `bytes` long), and the last log entry it holds (`through`). */
interface Head { gen: number; parts: number; through: number; bytes: number }

/** A record (a snapshot, a log entry) as keys of at most PART bytes each. */
function partsOf(record: string, bytes: Uint8Array): [string, Uint8Array][] {
  const count = Math.max(1, Math.ceil(bytes.length / PART));
  return Array.from({ length: count }, (_, i) => [
    `${record}/${pad(i, 4)}-${pad(count, 4)}`,
    // A view on a bigger buffer would be stored with all of it: each part gets its own.
    count == 1 && bytes.byteOffset == 0 && bytes.byteLength == bytes.buffer.byteLength ? bytes : bytes.slice(i * PART, (i + 1) * PART),
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length == 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Puts and deletes in one turn: a Durable Object's storage commits the
 * writes asked for in one turn as one transaction. `also`: more writes for
 * the same transaction (the document's record).
 */
async function writeAll(storage: Storage, put: Record<string, unknown>, del: string[], also?: () => Promise<void>): Promise<void> {
  const keys = Object.keys(put), work: Promise<unknown>[] = [];
  for (let i = 0; i < keys.length; i += BATCH) work.push(storage.put(Object.fromEntries(keys.slice(i, i + BATCH).map((k) => [k, put[k]]))));
  for (let i = 0; i < del.length; i += BATCH) work.push(storage.delete(del.slice(i, i + BATCH)));
  if (also) work.push(also());
  await Promise.all(work);
}

/**
 * The room's history in a Storage: a snapshot and the log after it.
 *
 *   room/head                         which snapshot is current, and the last log entry it holds
 *   room/s/<gen>/<part>-<parts>       the snapshot: the whole Yjs state, in parts
 *   room/u/<seq>/<part>-<parts>       a log entry: one write's Yjs update (one part, unless it's huge)
 *   room/unwritten                    the files whose latest text storage doesn't have yet
 *
 * A write appends one entry, in the same transaction as the files it
 * writes. A compaction writes the new snapshot's parts, then the head that
 * points at them, then deletes what they replace: stopped after any of
 * those steps, the history still loads whole (parts no head points at, and
 * entries the head already holds, are skipped and deleted later). Loading
 * is one list of `room/`.
 */
export class Journal {
  private head: Head = { gen: 0, parts: 0, through: 0, bytes: 0 };
  /** The current snapshot's keys. */
  private snapKeys: string[] = [];
  /** The log after the snapshot: each entry's number, keys and size. */
  private log: { seq: number; keys: string[]; bytes: number }[] = [];
  private seq = 0;
  /** Keys a compaction left behind (stopped half way): deleted with the next write. */
  private stale: string[] = [];
  /** The unwritten files as stored. */
  private unwritten = "";

  constructor(private storage: Storage, private limits = COMPACT) {}

  /**
   * The history, in order (the snapshot, then each log entry), and the files
   * storage doesn't have the latest text of; null if there's none. A
   * document from before the journal has its whole state in one value
   * (`legacy`): the room reads every file against it, once.
   */
  async load(): Promise<{ updates: Uint8Array[]; unwritten: string[]; legacy: boolean } | null> {
    const all = await this.storage.list<unknown>({ prefix: KEYS.room });
    if (!all.size) {
      const legacy = await this.storage.get<Uint8Array>(KEYS.state);
      if (legacy) this.stale = [KEYS.state];
      return legacy ? { updates: [legacy], unwritten: [], legacy: true } : null;
    }
    const head = (all.get(HEAD) as Head | undefined) ?? { gen: 0, parts: 0, through: 0, bytes: 0 };
    const snap: Uint8Array[] = [], snapKeys: string[] = [], stale: string[] = [];
    const entries = new Map<number, { parts: Uint8Array[]; keys: string[]; count: number }>();
    for (const [key, value] of all) {
      const record = key.startsWith(SNAP) ? SNAP : key.startsWith(LOG) ? LOG : null;
      if (!record) continue;
      const m = PART_KEY.exec(key.slice(record.length));
      if (!m) { stale.push(key); continue; }
      const [n, i, count] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (record == SNAP) {
        if (n == head.gen && count == head.parts) { snap[i] = value as Uint8Array; snapKeys.push(key); } else stale.push(key);
      } else if (n <= head.through) stale.push(key);
      else {
        const e = entries.get(n) ?? { parts: [], keys: [], count };
        e.parts[i] = value as Uint8Array;
        e.keys.push(key);
        entries.set(n, e);
      }
    }
    const missing = head.parts && Array.from({ length: head.parts }, (_, i) => snap[i]).some((p) => !p);
    if (missing) throw new Error(`the room's snapshot ${head.gen} is missing parts`);
    const updates = head.parts ? [concat(snap)] : [];
    const log: Journal["log"] = [];
    for (const [seq, e] of [...entries].sort(([a], [b]) => a - b)) {
      // Each entry is written in one transaction: one that isn't whole was never written.
      if (Array.from({ length: e.count }, (_, i) => e.parts[i]).some((p) => !p)) { stale.push(...e.keys); continue; }
      const bytes = concat(e.parts);
      updates.push(bytes);
      log.push({ seq, keys: e.keys, bytes: bytes.length });
    }
    const unwritten = (all.get(KEYS.unwritten) as string[] | undefined) ?? [];
    Object.assign(this, { head, snapKeys, log, stale, seq: Math.max(head.through, ...log.map((e) => e.seq)), unwritten: [...unwritten].sort().join("\n") });
    return { updates, unwritten, legacy: false };
  }

  /**
   * One write: `files` (keys and bytes) and the log entry for `update`, the
   * files deleted, and the unwritten list if it changed, in one transaction.
   */
  async commit(c: { update: Uint8Array | null; files: Record<string, Uint8Array>; remove: string[]; unwritten: string[] }, also?: () => Promise<void>): Promise<void> {
    const put: Record<string, unknown> = { ...c.files };
    const del = [...c.remove.map((p) => KEYS.file + p), ...this.stale];
    let entry: Journal["log"][number] | null = null;
    if (c.update) {
      const seq = this.seq + 1;
      const parts = partsOf(LOG + pad(seq, 12), c.update);
      for (const [k, v] of parts) put[k] = v;
      entry = { seq, keys: parts.map(([k]) => k), bytes: c.update.length };
    }
    const unwritten = [...c.unwritten].sort().join("\n");
    if (unwritten != this.unwritten) { if (unwritten) put[KEYS.unwritten] = [...c.unwritten].sort(); else del.push(KEYS.unwritten); }
    await writeAll(this.storage, put, del, also);
    if (entry) { this.seq = entry.seq; this.log.push(entry); }
    this.unwritten = unwritten;
    this.stale = [];
  }

  /** Whether the log is long enough to become a snapshot: at a write ("log"), at a version ("cut"), or "always". */
  wants(when: "log" | "cut" | "always"): boolean {
    if (when == "always") return true;
    const n = this.log.length, bytes = this.log.reduce((s, e) => s + e.bytes, 0);
    if (!n) return false;
    if (when == "log") return n >= this.limits.logEntries || bytes >= Math.max(this.limits.logBytes, this.head.bytes);
    return n >= this.limits.cutEntries || bytes >= Math.max(this.limits.cutBytes, this.head.bytes / 4);
  }

  /** Makes `state` (the whole Yjs state, holding every entry logged so far) the snapshot, in place of the log. */
  async compact(state: Uint8Array): Promise<void> {
    const gen = this.head.gen + 1;
    const parts = partsOf(SNAP + pad(gen, 12), state);
    const head: Head = { gen, parts: parts.length, through: this.seq, bytes: state.length };
    await writeAll(this.storage, Object.fromEntries(parts), []);
    await this.storage.put(HEAD, head);
    const replaced = [...this.snapKeys, ...this.log.flatMap((e) => e.keys), ...this.stale, KEYS.state];
    Object.assign(this, { head, snapKeys: parts.map(([k]) => k), log: [], stale: replaced });
    await writeAll(this.storage, {}, replaced);
    this.stale = [];
  }

  /** The log's length and size, and the snapshot's size (for the tests and the benchmark). */
  get size(): { entries: number; logBytes: number; snapshotBytes: number } {
    return { entries: this.log.length, logBytes: this.log.reduce((s, e) => s + e.bytes, 0), snapshotBytes: this.head.bytes };
  }
}

/**
 * The room's history in a Storage (a Journal), and its files written with
 * it. `reconcile`: the files can change while the room is closed (a folder
 * on disk), so the room reads them all as it opens, and writes them at
 * every write. `edited`: a file was written or deleted (the document's
 * record notes it, in the same transaction).
 */
export function stateStoreOf(storage: Storage, opts: { reconcile?: boolean; edited?: () => Promise<void>; journal?: Journal } = {}): StateStore["Service"] {
  const journal = opts.journal ?? new Journal(storage);
  const encoder = new TextEncoder();
  return StateStore.of({
    load: Effect.tryPromise({
      try: async () => {
        const saved = await journal.load();
        return saved && { updates: saved.updates, unwritten: saved.unwritten, reconcile: !!opts.reconcile || saved.legacy };
      },
      catch: storeError,
    }),
    commit: (c) => Effect.tryPromise({
      try: () => journal.commit(
        { update: c.update, files: Object.fromEntries(c.write.map(([path, text]) => [KEYS.file + path, encoder.encode(text)])), remove: c.remove, unwritten: c.unwritten },
        c.write.length || c.remove.length ? opts.edited : undefined,
      ),
      catch: storeError,
    }),
    compact: (state, when) => Effect.tryPromise({
      try: async () => {
        if (!journal.wants(when)) return false;
        await journal.compact(state());
        return true;
      },
      catch: storeError,
    }),
    lazyFiles: !opts.reconcile,
  });
}

/** A Storage as the versions' KV. */
export function kvOf(storage: Storage): KV {
  return {
    get: ((k: string | string[]) => storage.get(k as string)) as KV["get"],
    put: (entries) => storage.put(entries),
  };
}

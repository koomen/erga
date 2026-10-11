// What a document keeps between runs, as the small interface the document
// needs: values by key (its files, its folders, its record, the room's Yjs
// state, its versions), listed by prefix and in order, and one alarm (when
// an unedited document expires). A Durable Object's storage is one as it is
// (cloudflare/document-object.ts); MemoryStorage is one for the tests, and
// a folder on disk is one in local development (dev/).

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

/** Storage keys: a file's bytes, a folder made as one (empty ones too), what the document is, the room's Yjs state. */
export const KEYS = { file: "files/", dir: "folders/", meta: "info", state: "room-state" } as const;

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
 * `edited` runs for a text written (the document is edited only when its
 * bytes changed), `touch` for any other change to its files.
 */
export function fileStoreOf(storage: Storage, hooks: { edited: (path: string, text: string) => Promise<void>; touch: () => Promise<void> }): FileStore["Service"] {
  const { file: FILE, dir: DIR } = KEYS;
  return FileStore.of({
    list: Effect.tryPromise({ try: async () => [...(await storage.list({ prefix: FILE })).keys()].map((k) => k.slice(FILE.length)), catch: storeError }),
    read: (path) => Effect.tryPromise({ try: async () => (await storage.get<Uint8Array>(FILE + path)) ?? null, catch: storeError }),
    write: (path, text) => Effect.tryPromise({ try: () => hooks.edited(path, text), catch: storeError }),
    writeBytes: (path, bytes) => Effect.tryPromise({ try: async () => { await storage.put(FILE + path, bytes); await hooks.touch(); }, catch: storeError }),
    remove: (path) => Effect.tryPromise({ try: async () => { if (await storage.delete(FILE + path)) await hooks.touch(); }, catch: storeError }),
    folders: Effect.tryPromise({ try: async () => [...(await storage.list({ prefix: DIR })).keys()].map((k) => k.slice(DIR.length)), catch: storeError }),
    mkdir: (path) => Effect.tryPromise({
      try: async () => {
        const all = path.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
        for (const d of all) await storage.put(DIR + d, true);
        await hooks.touch();
      },
      catch: storeError,
    }),
    rmdir: (path) => Effect.tryPromise({
      try: async () => {
        const keys = [...(await storage.list({ prefix: FILE + path + "/" })).keys(), ...(await storage.list({ prefix: DIR + path + "/" })).keys(), DIR + path];
        for (let i = 0; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128));
        await hooks.touch();
      },
      catch: storeError,
    }),
  });
}

/** Writes a text file: the document is edited only when its bytes changed. */
export async function writeText(storage: Storage, path: string, text: string): Promise<{ changed: boolean }> {
  const before = await storage.get<Uint8Array>(KEYS.file + path);
  const bytes = new TextEncoder().encode(text);
  await storage.put(KEYS.file + path, bytes);
  return { changed: !(before && before.length == bytes.length && before.every((b, i) => b == bytes[i])) };
}

/** The room's Yjs state in a Storage. */
export function stateStoreOf(storage: Storage): StateStore["Service"] {
  return StateStore.of({
    load: Effect.tryPromise({ try: async () => (await storage.get<Uint8Array>(KEYS.state)) ?? null, catch: storeError }),
    save: (bytes) => Effect.tryPromise({ try: () => storage.put(KEYS.state, bytes), catch: storeError }),
  });
}

/** A Storage as the versions' KV. */
export function kvOf(storage: Storage): KV {
  return {
    get: ((k: string | string[]) => storage.get(k as string)) as KV["get"],
    put: (entries) => storage.put(entries),
  };
}

// The room's journal (document/storage.ts, `Journal`) under a real room
// (document/room.ts): a room opens again from its snapshot and log as it
// was, in one read of storage; the log becomes a snapshot when it grows; a
// compaction stopped half way, or a write cut short, leaves a history that
// still loads whole; big states are cut into parts; files the room hadn't
// written yet are written when it opens again.

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { FileStore, Room, StateStore } from "../document/room";
import { fileStoreOf, Journal, KEYS, MemoryStorage, PART, stateStoreOf, type Storage } from "../document/storage";
import { files, introduce } from "../document/content";
import { joinLocal } from "../document/room";
import { sleep } from "../shared/time";

const tick = () => new Promise((r) => setTimeout(r, 0));
const ada = { user: "ada", name: "Ada", color: "#2f6fec", kind: "person" as const };

/** MemoryStorage that counts reads, and can be made to fail a write (a crash at that point). */
class Shaky extends MemoryStorage {
  reads = 0;
  failPut: ((keys: string[]) => boolean) | null = null;
  failDelete = false;
  override async get(key: any): Promise<any> { this.reads++; return super.get(key); }
  override async list<T>(o?: { prefix?: string; startAfter?: string; limit?: number }): Promise<Map<string, T>> { this.reads++; return super.list<T>(o); }
  override async put(key: any, value?: any): Promise<void> {
    const keys = typeof key == "string" ? [key] : Object.keys(key);
    if (this.failPut?.(keys)) throw new Error("storage went away");
    return super.put(key, value);
  }
  override async delete(key: any): Promise<any> {
    if (this.failDelete) throw new Error("storage went away");
    return super.delete(key);
  }
}

/** A room on `storage` with a journal (`journal`: its own limits), open until `close`. */
async function open(storage: Storage, opts: { journal?: Journal; writeDelay?: number; fileDelay?: number } = {}) {
  const scope = Effect.runSync(Scope.make());
  let edits = 0;
  const room = await Effect.runPromise(Room.make({ writeDelay: opts.writeDelay ?? 5, fileDelay: opts.fileDelay }).pipe(
    Effect.provideService(FileStore, fileStoreOf(storage, { touch: async () => { edits++; } })),
    Effect.provideService(StateStore, stateStoreOf(storage, { journal: opts.journal, edited: async () => { edits++; } })),
    Scope.provide(scope),
  ));
  const doc = new Y.Doc(), aw = new Awareness(doc);
  aw.setLocalState({ user: ada });
  const leave = joinLocal(room, doc, aw);
  await tick();
  introduce(doc, ada);
  await tick();
  return {
    room, doc, edits: () => edits,
    text: (p = "index.html") => files(doc).get(p)!,
    /** Closes it as it closes normally: everything written. */
    close: async () => { leave(); aw.destroy(); await Effect.runPromise(Scope.close(scope, Exit.void)); },
    /** Stops it without its last writes (the object was evicted, the machine stopped). */
    drop: () => { leave(); aw.destroy(); room.awareness.destroy(); },
  };
}

const text = (s: Storage, p: string) => s.get<Uint8Array>(KEYS.file + p).then((b) => (b ? new TextDecoder().decode(b) : null));
const roomKeys = (s: MemoryStorage) => [...s.data.keys()].filter((k) => k.startsWith("room/")).sort();

test("a room opens again as it was: its snapshot and log in one read of storage, no file read", async () => {
  const s = new Shaky();
  await s.put(KEYS.file + "index.html", new TextEncoder().encode("<p>Hello</p>"));
  await s.put(KEYS.file + "notes.md", new TextEncoder().encode("# Notes"));
  const a = await open(s);
  for (let i = 0; i < 30; i++) { a.text().insert(3, `${i} `); await sleep(i % 5 == 0 ? 12 : 0); }
  files(a.doc).get("notes.md")!.insert(7, ", more");
  await tick();
  const before = Y.encodeStateVector(a.room.doc), want = a.room.text("index.html");
  await a.close();
  expect(await text(s, "index.html")).toBe(want);

  s.reads = 0;
  const b = await open(s);
  // The journal (one list), and nothing else: no file was read.
  expect(s.reads).toBe(1);
  expect(b.room.text("index.html")).toBe(want);
  expect(b.room.text("notes.md")).toBe("# Notes, more");
  expect(b.room.epoch).toBe(a.room.epoch);
  // Every edit it had, each client's as far as it went (the new peer adds its own).
  const after = Y.decodeStateVector(Y.encodeStateVector(b.room.doc));
  for (const [client, clock] of Y.decodeStateVector(before)) expect(after.get(client)).toBe(clock);
  await b.close();
});

test("the log becomes a snapshot when it grows, and the history still loads whole", async () => {
  const s = new MemoryStorage();
  await s.put(KEYS.file + "index.html", new TextEncoder().encode("<p></p>"));
  const journal = new Journal(s, { logEntries: 4, logBytes: 1 << 20, cutEntries: 2, cutBytes: 1 << 20 });
  const a = await open(s, { journal });
  for (let i = 0; i < 11; i++) { a.text().insert(3, "x"); await sleep(15); }
  // 11 writes, a snapshot every 4: the log never holds more than 3.
  expect(journal.size.entries).toBeLessThan(4);
  expect(roomKeys(s).filter((k) => k.startsWith("room/s/")).length).toBe(1);
  // At a version, a shorter log is enough (2 here).
  a.text().insert(3, "y");
  await sleep(15);
  a.text().insert(3, "y");
  await tick();
  await Effect.runPromise(a.room.settle);
  expect(journal.size.entries).toBeLessThan(2);
  const want = a.room.text("index.html");
  await a.close();
  const b = await open(s);
  expect(b.room.text("index.html")).toBe(want);
  expect(want).toBe("<p>yyxxxxxxxxxxx</p>");
  await b.close();
});

test("a compaction stopped half way, or a write cut short, leaves a history that loads whole", async () => {
  const s = new Shaky();
  await s.put(KEYS.file + "index.html", new TextEncoder().encode("<p></p>"));
  const journal = new Journal(s, { logEntries: 1000, logBytes: 1 << 30, cutEntries: 1, cutBytes: 1 << 30 });
  const a = await open(s, { journal });
  a.text().insert(3, "one ");
  await sleep(20);

  // Stopped after writing the new snapshot's parts, before the head that points at them.
  s.failPut = (keys) => keys.includes("room/head");
  a.text().insert(3, "two ");
  await tick();
  await expect(Effect.runPromise(a.room.settle)).resolves.toBeUndefined();
  s.failPut = null;
  let b = await open(cloneOf(s));
  expect(b.room.text("index.html")).toBe("<p>two one </p>");
  b.drop();

  // Stopped after the head, before the old snapshot and log were deleted: they're skipped, and go with the next write.
  s.failDelete = true;
  a.text().insert(3, "three ");
  await tick();
  await Effect.runPromise(a.room.settle);
  s.failDelete = false;
  const left = cloneOf(s);
  expect(roomKeys(left).filter((k) => k.startsWith("room/s/")).length).toBeGreaterThan(1);
  b = await open(left);
  expect(b.room.text("index.html")).toBe("<p>three two one </p>");
  b.text().insert(3, "four ");
  await sleep(20);
  expect(roomKeys(left).filter((k) => k.startsWith("room/s/")).length).toBe(1);
  b.drop();

  // A write that fails (the room's update with its files) isn't lost: the next one takes it.
  s.failPut = (keys) => keys.some((k) => k.startsWith("room/u/"));
  a.text().insert(3, "five ");
  await sleep(20);
  s.failPut = null;
  await sleep(30);
  // Stopped before closing: what the journal has is what a new room finds.
  const after = cloneOf(s);
  a.drop();
  b = await open(after);
  expect(b.room.text("index.html")).toBe("<p>five three two one </p>");
  await b.close();
});

test("a state bigger than a stored value is cut into parts, each under the limit", async () => {
  const s = new MemoryStorage();
  // Two files of 1.4 MiB (a file is text up to 2 MB): 2.8 MiB of state.
  const big = "x".repeat(Math.round(PART * 1.4));
  await s.put(KEYS.file + "big.html", new TextEncoder().encode(big));
  await s.put(KEYS.file + "big2.html", new TextEncoder().encode(big));
  const a = await open(s);
  await a.close();
  const parts = roomKeys(s).filter((k) => k.startsWith("room/s/"));
  expect(parts.length).toBe(3);
  for (const k of parts) expect((s.data.get(k) as Uint8Array).length).toBeLessThanOrEqual(PART);
  // A huge edit is one log entry in parts too.
  const b = await open(s);
  files(b.doc).get("big.html")!.insert(0, "y".repeat(PART + 10));
  await tick();
  await sleep(30);
  const entry = roomKeys(s).filter((k) => k.startsWith("room/u/") && k.endsWith("-0002"));
  expect(entry.length).toBe(2);
  for (const k of entry) expect((s.data.get(k) as Uint8Array).length).toBeLessThanOrEqual(PART);
  b.drop();
  const c = await open(s);
  expect(c.room.text("big.html")!.length).toBe(big.length + PART + 10);
  await c.close();
});

test("files are written lazily: one stopped before writing them writes them as it opens again", async () => {
  const s = new MemoryStorage();
  await s.put(KEYS.file + "index.html", new TextEncoder().encode("<p>one</p>"));
  const a = await open(s, { fileDelay: 10_000 });
  a.text().insert(3, "new ");
  await sleep(30);
  // In the journal, not yet in the file: the journal says which file is behind.
  expect(await text(s, "index.html")).toBe("<p>one</p>");
  expect(s.data.get(KEYS.unwritten)).toEqual(["index.html"]);
  expect(a.edits()).toBe(0);
  a.drop();

  const b = await open(s, { fileDelay: 10_000 });
  await sleep(30);
  expect(await text(s, "index.html")).toBe("<p>new one</p>");
  expect(s.data.has(KEYS.unwritten)).toBe(false);
  expect(b.edits()).toBe(1);
  await b.close();
});

/** A copy of what storage holds now (another object opening the same document, the first never closed). */
function cloneOf(s: MemoryStorage): MemoryStorage {
  const c = new MemoryStorage();
  for (const [k, v] of s.data) c.data.set(k, v);
  return c;
}

#!/usr/bin/env bun
// What a large document costs its storage: how long its room takes to open
// cold (a new object on the same storage), how many reads and bytes that
// takes, and what 6 seconds of steady typing writes.
//
//   bun e2e/bench/room-storage.bench.ts
//
// Storage is MemoryStorage, counted: the times are the CPU's (Yjs, merging),
// the reads and bytes are what a Durable Object's storage would do.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Y from "yjs";
import { Awareness } from "../../shared/yjs-protocol";
import { Document, type DocumentDeps } from "../../document/document";
import { MemoryStorage } from "../../document/storage";
import { joinLocal } from "../../document/room";
import { files, introduce } from "../../document/content";
import { Directory, type Param, type Sql } from "../../server/directory/index.ts";
import { documentAgents } from "../../agents/document/session";
import { testSandbox } from "../../tests/helpers/sandbox";
import { promised } from "../../tests/helpers/promised";

const MIGRATIONS = new URL("../../server/migrations/", import.meta.url).pathname;
function memory(): Sql {
  const db = new Database(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + f, "utf8"));
  return {
    all: async <T>(sql: string, ...params: Param[]) => db.query(sql).all(...(params as never[])) as T[],
    run: async (sql: string, ...params: Param[]) => { db.query(sql).run(...(params as never[])); },
    batch: async (statements) => { db.transaction(() => { for (const [sql, ...params] of statements) db.query(sql).run(...(params as never[])); })(); },
  };
}

const sizeOf = (v: unknown) => (v instanceof Uint8Array ? v.length : JSON.stringify(v ?? null).length);

/** MemoryStorage that counts what goes through it. */
class Counted extends MemoryStorage {
  reads = 0; readBytes = 0; puts = 0; putBytes = 0;
  reset() { this.reads = this.readBytes = this.puts = this.putBytes = 0; }
  override async get(key: any): Promise<any> {
    const v = await super.get(key);
    this.reads++;
    if (v instanceof Map) for (const x of v.values()) this.readBytes += sizeOf(x); else if (v !== undefined) this.readBytes += sizeOf(v);
    return v;
  }
  override async list<T>(o?: { prefix?: string; startAfter?: string; limit?: number }): Promise<Map<string, T>> {
    const v = await super.list<T>(o);
    this.reads++;
    for (const x of v.values()) this.readBytes += sizeOf(x);
    return v;
  }
  override async put(key: any, value?: any): Promise<void> {
    this.puts++;
    if (typeof key == "string") this.putBytes += sizeOf(value); else for (const v of Object.values(key)) this.putBytes += sizeOf(v);
    return super.put(key, value);
  }
}

const dir = new Directory(memory(), { admins: ["ada"] });
const storage = new Counted();
const deps = (): DocumentDeps => ({
  storage, directory: dir,
  tabs: { count: () => 0, closeAll: () => {} },
  agents: documentAgents({ settings: async () => ({ missing: "none" }), sandbox: testSandbox }),
  home: { forget: async () => {} },
  timing: { idleMs: 3_600_000, maxMs: 3_600_000 },
  background: () => {}, log: () => {},
});
const req = () => new Request("http://doc/api/doc", { headers: { "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }), "x-erga-access": "edit" } });
const tick = () => new Promise((r) => setTimeout(r, 0));

// A large document: a 400 KB page, 40 other text files of 20 KB, 5 images of 200 KB.
const para = (i: number) => `<p id="p${i}">Paragraph ${i}: the quick brown fox jumps over the lazy dog, again and again, so the page is long.</p>\n`;
const page = `<!doctype html><html><body>\n${Array.from({ length: 3600 }, (_, i) => para(i)).join("")}</body></html>\n`;
const init: Record<string, string | Uint8Array> = { "index.html": page };
for (let i = 0; i < 40; i++) init[`notes/n${i}.md`] = `# Note ${i}\n\n` + "Some words in a note. ".repeat(900);
for (let i = 0; i < 5; i++) init[`img/i${i}.png`] = new Uint8Array(200_000).fill(i + 7);
await dir.add({ id: "bench123", owner: "ada", title: "Bench", created: Date.now(), expires: null });
const first = promised(new Document(deps()));
await first.create("ada", "bench123", init, "index.html", { expires: null });

// A history: 3,000 keystrokes, written after every 20 (as the room's writer would during steady typing).
const opened = (await first.admit(req()))!;
const room = opened.room;
const peer = new Y.Doc();
const aw = new Awareness(peer);
aw.setLocalState({ user: { user: "ada", name: "Ada", color: "#000", kind: "person" } });
joinLocal(room, peer, aw);
await tick();
introduce(peer, { user: "ada", name: "Ada", color: "#000", kind: "person" });
await tick();
const text = files(peer).get("index.html")!;
for (let i = 0; i < 3000; i++) {
  text.insert(200 + (i * 37) % 300_000, "x");
  if (i % 20 == 19) { await tick(); await Effect.runPromise(room.flush); }
}
await tick();
await Effect.runPromise(room.flush);

// Steady typing: a keystroke every 100 ms for 6 seconds, written by the room's own writer (every 400 ms).
storage.reset();
for (let i = 0; i < 60; i++) {
  text.insert(1000 + i, "y");
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 2500));
const typing = { puts: storage.puts, bytes: storage.putBytes, reads: storage.reads };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
aw.destroy();

// Cold: a new object on the same storage opens the room.
const times: number[] = [];
let coldReads = 0, coldBytes = 0;
for (let i = 0; i < 5; i++) {
  storage.reset();
  const t = performance.now();
  const cold = promised(new Document(deps()));
  const o = await cold.admit(req());
  times.push(performance.now() - t);
  coldReads = storage.reads; coldBytes = storage.readBytes;
  if (o!.room.text("index.html") != text.toString()) throw new Error("cold load lost an edit");
  o!.room.awareness.destroy();
}
let stored = 0;
for (const v of storage.data.values()) stored += sizeOf(v);
console.log(JSON.stringify({
  coldOpenMs: Math.round(median(times) * 10) / 10,
  coldReads, coldReadBytes: coldBytes,
  typing6s: { writes: typing.puts, bytesWritten: typing.bytes, reads: typing.reads },
  storedBytes: stored,
}, null, 2));
process.exit(0);

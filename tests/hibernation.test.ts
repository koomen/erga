// A document whose object sleeps while its tabs stay connected
// (document/tabs.ts, as cloudflare/document-object.ts uses it with the
// WebSocket hibernation API): the document closes when nothing happens,
// presence still passes between tabs, and the next edit opens it again from
// its journal, even in a new object that remembers nothing, with every tab
// joined to it.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as sync from "y-protocols/sync";
import { Document, type DocumentDeps } from "../document/document";
import { MemoryStorage } from "../document/storage";
import { Tabs, type Tab, type TabSocket } from "../document/tabs";
import { files } from "../document/content";
import { Directory, type Param, type Sql } from "../server/directory/index.ts";

const MIGRATIONS = new URL("../server/migrations/", import.meta.url).pathname;
function memory(): Sql {
  const db = new Database(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + f, "utf8"));
  return {
    all: async <T>(sql: string, ...params: Param[]) => db.query(sql).all(...(params as never[])) as T[],
    run: async (sql: string, ...params: Param[]) => { db.query(sql).run(...(params as never[])); },
    batch: async (statements) => { db.transaction(() => { for (const [sql, ...params] of statements) db.query(sql).run(...(params as never[])); })(); },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const syncMessage = (write: (e: encoding.Encoder) => void) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); write(e); return encoding.toUint8Array(e); };

/** A tab: its own replica of the doc, speaking the room's protocol over a pretend socket. */
class FakeTab implements TabSocket {
  readonly doc = new Y.Doc();
  closed: number | null = null;
  presence: Uint8Array[] = [];
  events: unknown[] = [];
  constructor(private world: World, public tab: Tab) {
    this.doc.on("update", (u: Uint8Array, origin: unknown) => { if (origin !== this) this.world.deliver(this, syncMessage((e) => sync.writeUpdate(e, u))); });
  }
  send(m: string | Uint8Array): void {
    if (typeof m == "string") { this.events.push(JSON.parse(m)); return; }
    const d = decoding.createDecoder(m);
    const type = decoding.readVarUint(d);
    if (type == 1) { this.presence.push(m); return; }
    if (type != 0) return;
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, 0);
    sync.readSyncMessage(d, reply, this.doc, this);
    if (encoding.length(reply) > 1) this.world.deliver(this, encoding.toUint8Array(reply));
  }
  close(code?: number): void { this.closed = code ?? 1000; this.world.sockets.delete(this); }
  text(p = "index.html") { return files(this.doc).get(p)?.toString() ?? null; }
  type(at: number, s: string) { files(this.doc).get("index.html")!.insert(at, s); }
}

/** One document's object: its storage and sockets outlive it; `boot` makes a new one (woken from a sleep, evicted). */
class World {
  readonly storage = new MemoryStorage();
  readonly sockets = new Set<FakeTab>();
  document!: Document;
  tabs!: Tabs<FakeTab>;
  private inflight: Promise<unknown>[] = [];
  constructor(readonly dir: Directory) { this.boot(); }

  boot(): void {
    const deps: DocumentDeps = {
      storage: this.storage, directory: this.dir,
      tabs: {
        count: () => this.sockets.size,
        closeAll: (code) => { for (const s of [...this.sockets]) s.close(code); },
        attach: (opened) => this.tabs.attachAll(opened),
        detach: () => this.tabs.detachAll(),
      },
      agentSettings: async () => ({ missing: "no key in the tests" }), serverTools: async () => [], takeDownSite: async () => null,
      home: { forget: async () => {}, publishedChanged: async () => {} }, siteChanged: async () => {},
      timing: { idleMs: 20, maxMs: 2000, writeDelay: 5, fileDelay: 30, closeIdleMs: 60 },
      background: () => {}, log: () => {},
    };
    this.document = new Document(deps);
    this.tabs = new Tabs<FakeTab>({ document: () => this.document, sockets: () => [...this.sockets], tabOf: (s) => s.tab, keep: (s, tab) => { s.tab = tab; } });
  }

  /** A tab connects (the fetch that upgrades): the document opens, the tab joins and asks for what it lacks. */
  async connect(kind: "room" | "events" = "room"): Promise<FakeTab> {
    const opened = (await this.document.admit(new Request("http://doc/api/room", { headers: { "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }), "x-erga-access": "edit" } })))!;
    const tab = new FakeTab(this, kind == "room" ? { id: crypto.randomUUID(), kind, readOnly: false, epoch: null } : { id: crypto.randomUUID(), kind, person: { id: "ada", name: "Ada" } });
    this.sockets.add(tab);
    expect(this.tabs.join(tab, opened, tab.tab)).toBe(true);
    if (kind == "room") this.deliver(tab, syncMessage((e) => sync.writeSyncStep1(e, tab.doc)));
    await this.settle();
    return tab;
  }

  /** A message from a tab reaches the object (and may wake it). */
  deliver(tab: FakeTab, m: Uint8Array): void {
    queueMicrotask(() => this.inflight.push(this.tabs.message(tab, m)));
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await sleep(2);
      const now = this.inflight.splice(0);
      if (!now.length && i > 3) return;
      await Promise.all(now);
    }
  }
}

async function made() {
  const dir = new Directory(memory(), { admins: ["ada"] });
  await dir.add({ id: "sleep123", owner: "ada", title: "Sleepy", created: Date.now(), expires: null });
  const w = new World(dir);
  await w.document.create("ada", "sleep123", { "index.html": "<p>Hi</p>" }, "index.html", { expires: null });
  return w;
}

const awareness = (bytes: number[]) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 1); encoding.writeVarUint8Array(e, new Uint8Array(bytes)); return encoding.toUint8Array(e); };

test("idle, the document closes and tabs stay; presence passes between them without opening it; an edit wakes it, in a new object too", async () => {
  const w = await made();
  const a = await w.connect(), b = await w.connect();
  const events = await w.connect("events");
  expect(a.text()).toBe("<p>Hi</p>");
  a.type(3, "one ");
  await w.settle();
  expect(b.text()).toBe("<p>one Hi</p>");
  // Each tab now holds this history: it's kept with its socket.
  expect(a.tab.kind == "room" && a.tab.epoch).toBeTruthy();

  // Nothing happens: a version is cut, then the document closes. The tabs stay connected.
  await sleep(250);
  expect(w.document.isOpen()).toBe(false);
  expect(a.closed).toBeNull();
  expect(b.closed).toBeNull();

  // Presence while closed goes straight to the other tabs, and opens nothing.
  const caret = awareness([1, 2, 3]);
  w.deliver(a, caret);
  await w.settle();
  expect(b.presence.at(-1)).toEqual(caret);
  expect(w.document.isOpen()).toBe(false);
  // A message for every tab reaches the event channels while it's closed.
  w.tabs.notify({ type: "home" });
  expect(events.events).toContainEqual({ type: "home" });

  // The object sleeps and wakes with nothing in memory: a new one, on the same storage and sockets.
  w.boot();
  b.type(3, "two ");
  await w.settle();
  expect(w.document.isOpen()).toBe(true);
  // B's edit reached the reopened room, and A (joined as it opened) got it.
  expect(a.text()).toBe("<p>two one Hi</p>");
  // And A's edits flow the other way, through the new object.
  a.type(0, "<!-- a -->");
  await w.settle();
  expect(b.text()).toBe("<!-- a --><p>two one Hi</p>");
  // The new object's events reach the event channel joined as it opened.
  w.document.notify({ type: "site" });
  expect(events.events).toContainEqual({ type: "site" });
  // Written: the file, through the reopened room.
  await sleep(100);
  const page = await w.storage.get<Uint8Array>("files/index.html");
  expect(new TextDecoder().decode(page!)).toBe("<!-- a --><p>two one Hi</p>");
});

test("a tab holding another history (the document's was lost) is closed as the document opens again, never merged", async () => {
  const w = await made();
  const a = await w.connect(), b = await w.connect();
  await sleep(250);
  expect(w.document.isOpen()).toBe(false);
  w.boot();
  // As if B's history were another epoch's.
  if (b.tab.kind == "room") b.tab = { ...b.tab, epoch: "another-epoch" };
  a.type(3, "x");
  await w.settle();
  expect(b.closed).toBe(4409);
  expect(a.closed).toBeNull();
  expect(a.text()).toBe("<p>xHi</p>");
});

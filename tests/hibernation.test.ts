// A document whose object sleeps while its tabs stay connected
// (document/tabs.ts, as cloudflare/objects/document.ts uses it with the
// WebSocket hibernation API): the document closes when nothing happens,
// presence still passes between tabs, and the next edit opens it again from
// its journal, even in a new object that remembers nothing, with every tab
// joined to it.

import * as Effect from "effect/Effect";
import { expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { Encoder, Decoder, writeSyncStep1, writeUpdate, readSyncMessage } from "../shared/yjs-protocol";
import { Document, type DocumentDeps } from "../document/document";
import { MemoryStorage } from "../document/storage";
import { Tabs, type Tab, type TabSocket } from "../document/tabs";
import { files } from "../document/content";
import { decodeStart } from "../shared/room-socket";
import { Directory } from "../server/directory/index.ts";
import { documentAgents } from "../agents/document/session";
import { testSandbox } from "./helpers/sandbox";
import { sleep } from "../shared/time";
import { until } from "./helpers/until";
import type { AgentSettings } from "../agents/models";
import { memory } from "./helpers/memory-sql";

const syncMessage = (write: (e: Encoder) => void) => {
  const e = new Encoder();
  e.writeUint(0);
  write(e);
  return e.toBytes();
};

/** A tab: its own replica of the doc, speaking the room's protocol over a pretend socket. */
class FakeTab implements TabSocket {
  readonly doc = new Y.Doc();
  closed: number | null = null;
  presence: Uint8Array[] = [];
  events: unknown[] = [];
  constructor(
    private world: World,
    public tab: Tab
  ) {
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== this)
        this.world.deliver(
          this,
          syncMessage((e) => writeUpdate(e, u))
        );
    });
  }
  send(m: string | Uint8Array): void {
    if (typeof m == "string") { this.events.push(JSON.parse(m)); return; }
    const d = new Decoder(m);
    const type = d.readUint();
    if (type == 1) { this.presence.push(m); return; }
    if (type != 0) return;
    const reply = new Encoder();
    reply.writeUint(0);
    readSyncMessage(d, reply, this.doc, this);
    if (reply.length > 1) this.world.deliver(this, reply.toBytes());
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
  constructor(
    readonly dir: Directory,
    private settings: () => Promise<AgentSettings> = async () => ({ missing: "no key in the tests" })
  ) {
    this.boot();
  }

  boot(): void {
    const deps: DocumentDeps = {
      storage: this.storage, directory: this.dir,
      tabs: {
        count: () => this.sockets.size,
        closeAll: (code) => { for (const s of [...this.sockets]) s.close(code); },
        attach: (opened) => this.tabs.attachAll(opened),
        detach: () => this.tabs.detachAll(),
      },
      agents: documentAgents({ settings: this.settings, sandbox: testSandbox }),
      home: { forget: async () => {} },
      timing: { idleMs: 20, maxMs: 2000, writeDelay: 5, fileDelay: 30, closeIdleMs: 60 },
      background: () => {}, log: () => {},
    };
    this.document = new Document(deps);
    this.tabs = new Tabs<FakeTab>({ document: () => this.document, sockets: () => [...this.sockets], tabOf: (s) => s.tab, keep: (s, tab) => { s.tab = tab; } });
  }

  /** A tab connects (the fetch that upgrades): the document opens, the tab joins and asks for what it lacks. `events`: an editor's tab, which hears events too. */
  async connect(events = false): Promise<FakeTab> {
    const opened = (await Effect.runPromise(
      this.document.admit(
        new Request("http://doc/api/room", {
          headers: { "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }), "x-erga-access": "edit" },
        })
      )
    ))!;
    const tab = new FakeTab(this, { id: crypto.randomUUID(), readOnly: false, epoch: null, person: { id: "ada", name: "Ada" }, events });
    this.sockets.add(tab);
    expect(this.tabs.join(tab, opened, tab.tab)).toBe(true);
    this.deliver(
      tab,
      syncMessage((e) => writeSyncStep1(e, tab.doc))
    );
    await this.settle();
    return tab;
  }

  /** A viewer's page connects (the fetch that upgrades, with ?watch=view): it only hears events. */
  async watch(): Promise<FakeTab> {
    const tab = new FakeTab(this, {
      id: crypto.randomUUID(),
      readOnly: true,
      epoch: null,
      person: { id: "bo", name: "Bo" },
      events: true,
      watch: true,
    });
    const socket = await Effect.runPromise(this.tabs.watch(tab.tab, () => (this.sockets.add(tab), tab)));
    expect(socket).toBe(tab);
    return tab;
  }

  /** A message from a tab reaches the object (and may wake it). */
  deliver(tab: FakeTab, m: Uint8Array): void {
    queueMicrotask(() => this.inflight.push(Effect.runPromise(this.tabs.message(tab, m))));
  }

  /** Until no message is on its way: each one goes in a microtask (so a tick sees it), and its answer may send more. */
  async settle(): Promise<void> {
    for (;;) {
      await sleep(0);
      const now = this.inflight.splice(0);
      if (!now.length) return;
      await Promise.all(now);
    }
  }
}

async function made(settings?: () => Promise<AgentSettings>) {
  const dir = new Directory(memory(), { admins: ["ada"] });
  await dir.add({ id: "sleep123", owner: "ada", title: "Sleepy", created: Date.now(), expires: null });
  const w = new World(dir, settings);
  await Effect.runPromise(w.document.create("ada", "sleep123", { "index.html": "<p>Hi</p>" }, "index.html", { expires: null }));
  return w;
}

const awareness = (bytes: number[]) => {
  const e = new Encoder();
  e.writeUint(1);
  e.writeBytes(new Uint8Array(bytes));
  return e.toBytes();
};

test("idle, the document closes and tabs stay; presence passes between them without opening it; an edit wakes it, in a new object too", async () => {
  const w = await made();
  const a = await w.connect(), b = await w.connect();
  const events = await w.connect(true);
  expect(a.text()).toBe("<p>Hi</p>");
  a.type(3, "one ");
  await w.settle();
  expect(b.text()).toBe("<p>one Hi</p>");
  // Each tab now holds this history: it's kept with its socket.
  expect(a.tab.epoch).toBeTruthy();
  // An editor's tab hears first who it is and what the document holds.
  expect(events.events[0]).toMatchObject({ type: "hello", info: { userId: "ada", path: "index.html" }, tree: { entries: [{ path: "index.html" }] } });
  // Its hello names the room's history, which the tab's start (GET /api/start) must be of.
  expect((events.events[0] as { epoch: string }).epoch).toBe(a.tab.epoch!);
  // The start: the same hello and the room's whole state, in one answer.
  const started = await Effect.runPromise(
    w.document.handle(
      new Request("http://doc/api/start", {
        headers: { "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }), "x-erga-who": JSON.stringify({ login: "ada" }) },
      })
    )
  );
  const { hello, state } = decodeStart<{ type: string; epoch: string }>(new Uint8Array(await started.arrayBuffer()));
  expect(hello).toMatchObject({ type: "hello", epoch: a.tab.epoch! });
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, state);
  expect(files(fresh).get("index.html")?.toString()).toBe("<p>one Hi</p>");

  // Nothing happens: a version is cut, then the document closes. The tabs stay connected.
  await until(() => !w.document.isOpen());
  expect(a.closed).toBeNull();
  expect(b.closed).toBeNull();

  // Presence while closed goes straight to the other tabs, and opens nothing.
  const here = new Encoder();
  here.writeUint(1);
  here.writeUint(7);
  here.writeUint(1);
  here.writeString('{"user":{"name":"Ada"}}');
  const caret = awareness([...here.toBytes()]);
  w.deliver(a, caret);
  await w.settle();
  expect(b.presence.at(-1)).toEqual(caret);
  expect(w.document.isOpen()).toBe(false);
  // Bytes that are no presence close their own socket, as when the document is open, and reach no other tab.
  const hostile = await w.connect();
  await until(() => !w.document.isOpen());
  const before = b.presence.length;
  w.deliver(hostile, awareness([5, 1, 2]));
  await w.settle();
  expect([hostile.closed, b.presence.length, w.document.isOpen()]).toEqual([4400, before, false]);
  // A message for every tab reaches the event channels while it's closed.
  w.tabs.notify({ type: "home" });
  expect(events.events).toContainEqual({ type: "home" });

  // The object sleeps and wakes with nothing in memory: a new one, on the same storage and sockets.
  w.boot();
  b.type(3, "two ");
  await w.settle();
  // B's edit reached the reopened room, and A (joined as it opened) got it. (Idle for 60 ms, it is closed again.)
  expect(a.text()).toBe("<p>two one Hi</p>");
  // And A's edits flow the other way, through the new object.
  a.type(0, "<!-- a -->");
  await w.settle();
  expect(b.text()).toBe("<!-- a --><p>two one Hi</p>");
  // The new object's events reach the event channel joined as it opened.
  w.document.notify({ type: "site" });
  expect(events.events).toContainEqual({ type: "site" });
  // Written: the file, through the reopened room.
  const page = async () => new TextDecoder().decode((await w.storage.get<Uint8Array>("files/index.html"))!);
  await until(async () => (await page()) == "<!-- a --><p>two one Hi</p>");
});

test("a tab holding another history (the document's was lost) is closed as the document opens again, never merged", async () => {
  const w = await made();
  const a = await w.connect(), b = await w.connect();
  await until(() => !w.document.isOpen());
  w.boot();
  // As if B's history were another epoch's.
  b.tab = { ...b.tab, epoch: "another-epoch" };
  a.type(3, "x");
  await w.settle();
  expect(b.closed).toBe(4409);
  expect(a.closed).toBeNull();
  expect(a.text()).toBe("<p>xHi</p>");
});

test("a viewer's page on a closed document opens nothing: it hears the version kept, and each change once someone edits", async () => {
  const w = await made();
  // What viewers see is kept with the document's files, as after any view of it.
  const ver = await Effect.runPromise(w.document.viewed());
  expect(ver).toBeTruthy();
  // A new object, with nothing in memory: the reader's page connects.
  w.boot();
  const reader = await w.watch();
  expect(w.document.isOpen()).toBe(false);
  expect(reader.events).toEqual([{ type: "view", ver }]);
  // Someone starts to edit: the room opens, the reader's page joins it and hears the new version.
  const a = await w.connect();
  a.type(3, "new ");
  await w.settle();
  const heard = (tab: FakeTab) => tab.events.some((e) => (e as { type: string }).type == "view" && (e as { ver: string }).ver != ver);
  await until(() => heard(reader));
  // On an open document, a viewer's page joins at once.
  const second = await w.watch();
  await until(() => heard(second));
  // No such document: no socket.
  const none = new World(w.dir);
  expect(
    await Effect.runPromise(
      none.tabs.watch({ id: "x", readOnly: true, epoch: null, person: { id: "bo", name: "Bo" }, events: true, watch: true }, () => {
        throw new Error("accepted");
      })
    )
  ).toBeNull();
});

test("truncated, corrupt and unknown Yjs messages: the room keeps its text, and edits still flow", async () => {
  const w = await made();
  const a = await w.connect();
  const text = a.text();
  const msg = (...parts: ((e: Encoder) => void)[]) => {
    const e = new Encoder();
    for (const p of parts) p(e);
    return e.toBytes();
  };
  const bad: Uint8Array[] = [
    msg((e) => e.writeUint(0)), // sync, nothing else
    msg(
      (e) => e.writeUint(0),
      (e) => e.writeUint(2)
    ), // update, no payload
    msg(
      (e) => e.writeUint(0),
      (e) => e.writeUint(2),
      (e) => e.writeBytes(new Uint8Array([1, 1, 200, 3, 0, 9, 9, 9]))
    ), // corrupt update
    msg(
      (e) => e.writeUint(0),
      (e) => e.writeUint(1),
      (e) => e.writeBytes(new Uint8Array([255, 255, 255, 255, 15]))
    ), // corrupt step 2
    msg(
      (e) => e.writeUint(1),
      (e) => e.writeBytes(new Uint8Array([5, 1, 2]))
    ), // corrupt awareness
    msg((e) => e.writeUint(99)), // unknown type
    msg(
      (e) => e.writeUint(0),
      (e) => e.writeUint(7)
    ), // unknown sync step
  ];
  // Each from a socket of its own, as a hostile client sends it; then a text frame that isn't binary.
  const raws: FakeTab[] = [];
  // A message the room can't read closes its own socket (4400: malformed), and no other. A corrupt update or step 2 is
  // dropped, and one of a type the room doesn't know is passed over: those sockets stay.
  const CLOSED = [4400, 4400, null, null, 4400, null, 4400];
  // (An update that Yjs can't read is logged where it is dropped: shared/yjs-protocol.ts.)
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const m of bad) {
      const raw = await w.connect();
      w.deliver(raw, m);
      await w.settle();
      raws.push(raw);
    }
    // (A socket's close can come after its message is taken, when the room was still opening for it: on a busy
    // machine the list read at once had a null where the close came a moment later.)
    await until(() => CLOSED.every((code, i) => code == null || raws[i].closed == code));
    await w.settle();
    expect(logged.mock.calls.map((c) => c[0])).toEqual(Array(2).fill("Caught error while handling a Yjs update"));
  } finally {
    logged.mockRestore();
  }
  const raw = await w.connect();
  await Effect.runPromise(w.tabs.message(raw, "a text frame, not binary"));
  expect(raw.closed).toBeNull();
  expect(raws.map((r) => r.closed)).toEqual(CLOSED);
  expect(a.closed).toBeNull();
  // The room holds the text from before, and still carries an edit between two newcomers. (Not a check that it is
  // open now: idle for 60 ms, this document closes, and on a busy machine it had.)
  const x = await w.connect(),
    y = await w.connect();
  expect(x.text()).toBe(text);
  x.type(3, "ALIVE ");
  await w.settle();
  expect(y.text()).toBe("<p>ALIVE Hi</p>");
  expect(a.text()).toBe("<p>ALIVE Hi</p>");
});

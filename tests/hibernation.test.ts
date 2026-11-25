// A document whose object sleeps while its tabs stay connected
// (document/room/participants.ts, as cloudflare/objects/document.ts uses it with the
// WebSocket hibernation API): the document closes when nothing happens,
// presence still passes between tabs, and the next edit opens it again from
// its journal, even in a new object that remembers nothing, with every tab
// joined to it.

import * as Effect from "effect/Effect";
import { expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import {
  Awareness,
  Encoder,
  Decoder,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  writeSyncStep1,
  writeUpdate,
  readSyncMessage,
} from "../shared/yjs-protocol";
import { type DocumentDeps } from "../document/life/document";
import { DocumentHost } from "../document/api/host";
import { MemoryStorage } from "../document/store/storage";
import type { Participants, Tab, TabSocket } from "../document/room/participants";
import { authorOf, authors, files, introduce } from "../document/model/content";
import { colorFor, type Author } from "../shared/author";
import { decodeStart } from "../shared/room-socket";
import { Directory } from "../server/directory/index.ts";
import { descriptionKey } from "../agents/models";
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
  binary: Uint8Array[] = [];
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
    this.binary.push(m);
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
  document!: DocumentHost<FakeTab>;
  get tabs(): Participants<FakeTab> {
    return this.document.participants;
  }
  private inflight: Promise<unknown>[] = [];
  constructor(
    readonly dir: Directory,
    private settings: () => Promise<AgentSettings> = async () => ({ missing: "no key in the tests" }),
    /** Idle for this long (ms), the document closes. */
    private closeIdleMs = 60
  ) {
    this.boot();
  }

  boot(): void {
    const deps: DocumentDeps = {
      storage: this.storage, directory: this.dir,
      tabs: {
        count: () => this.sockets.size,
        closeAll: (code) => {
          for (const s of [...this.sockets]) s.close(code);
        },
      },
      sandbox: testSandbox,
      descriptionKey: () => descriptionKey(this.settings),
      sites: { forget: async () => {} },
      timing: { idleMs: 20, maxMs: 2000, writeDelay: 5, fileDelay: 30, closeIdleMs: this.closeIdleMs },
      background: () => {}, log: () => {},
    };
    this.document = new DocumentHost<FakeTab>(deps, {
      all: () => [...this.sockets],
      tabOf: (s) => s.tab,
      keep: (s, tab) => {
        s.tab = tab;
      },
    });
  }

  /** A tab connects (the fetch that upgrades): the document opens, the tab joins and asks for what it lacks. `events`: an editor's tab, which hears events too. */
  async connect(events = false, person = { id: "ada", name: "Ada" }): Promise<FakeTab> {
    const opened = (await Effect.runPromise(
      this.document.admit(
        new Request("http://doc/api/room", {
          headers: { "x-erga-person": JSON.stringify(person), "x-erga-access": "edit" },
        })
      )
    ))!;
    const tab = new FakeTab(this, { id: crypto.randomUUID(), readOnly: false, epoch: null, person, events });
    this.sockets.add(tab);
    expect(this.tabs.join(tab, tab.tab)).toBe(true);
    this.deliver(
      tab,
      syncMessage((e) => writeSyncStep1(e, tab.doc))
    );
    await this.settle();
    return tab;
  }

  /** A shell tab connects (?events=1&shell=1): JSON hello, events and presence only, never Yjs sync. */
  async connectShell(person = { id: "ada", name: "Ada" }, opts: { readOnly?: boolean; who?: Tab["who"] } = {}): Promise<FakeTab> {
    await Effect.runPromise(
      this.document.admit(
        new Request("http://doc/api/room?events=1&shell=1", {
          headers: { "x-erga-person": JSON.stringify(person), "x-erga-access": opts.readOnly ? "view" : "edit" },
        })
      )
    );
    const tab = new FakeTab(this, {
      id: crypto.randomUUID(),
      readOnly: !!opts.readOnly,
      epoch: null,
      person,
      events: true,
      shell: true,
      ...(opts.who ? { who: opts.who } : {}),
    });
    this.sockets.add(tab);
    expect(this.tabs.join(tab, tab.tab)).toBe(true);
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

async function made(settings?: () => Promise<AgentSettings>, closeIdleMs?: number) {
  const dir = new Directory(memory(), { admins: ["ada"] });
  await dir.add({ id: "sleep123", owner: "ada", title: "Sleepy", created: Date.now(), expires: null });
  const w = new World(dir, settings, closeIdleMs);
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

  // Presence while closed goes straight to the other tabs, and opens nothing. It has the name of its socket, whatever
  // the tab says.
  const says = (state: object) => {
    const here = new Encoder();
    here.writeUint(1);
    here.writeUint(7);
    here.writeUint(1);
    here.writeString(JSON.stringify(state));
    return awareness([...here.toBytes()]);
  };
  w.deliver(a, says({ user: { name: "Someone else" }, cursor: null }));
  await w.settle();
  expect(b.presence.at(-1)).toEqual(says({ user: { user: "ada", name: "Ada", color: colorFor("ada"), kind: "person" }, cursor: null }));
  expect(w.document.isOpen()).toBe(false);
  // Bytes that are no presence close their own socket, as when the document is open, and reach no other tab.
  const hostile = await w.connect();
  await until(() => !w.document.isOpen());
  const before = b.presence.length;
  w.deliver(hostile, awareness([5, 1, 2]));
  await w.settle();
  expect([hostile.closed, b.presence.length, w.document.isOpen()]).toEqual([4400, before, false]);
  // A message for every tab reaches the event channels while it's closed.
  w.tabs.tellAll({ type: "publishing" });
  expect(events.events).toContainEqual({ type: "publishing" });

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
  w.tabs.tellAll({ type: "site" });
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

test("the server names each edit from its socket: a tab that writes another user's name gets its own", async () => {
  const w = await made();
  const versions = async () => (await Effect.runPromise(w.document.versionsState()))!;
  const bo = await w.connect(false, { id: "bo", name: "Bo" });
  // Bo's tab says that it is Ada: a tab writes its own entry of the authors map.
  introduce(bo.doc, { user: "ada", name: "Ada", color: "#2f6fec", kind: "person" });
  bo.type(3, "forged ");
  await w.settle();
  await until(async () => (await versions()).total == 2);
  expect((await versions()).current.authors).toEqual(["bo"]);
  // A delete that the tab does not stamp has Bo's name too.
  files(bo.doc).get("index.html")!.delete(3, 7);
  await w.settle();
  await until(async () => (await versions()).total == 3);
  expect((await versions()).current.authors).toEqual(["bo"]);
});

test("the server names each tab's presence and name tag from its socket: a tab that says it is another user shows as itself", async () => {
  // The document stays open: the room names the tabs here. (Closed, the tabs' relay does: the first test.)
  const w = await made(undefined, 60_000);
  const ada = await w.connect();
  const bo = await w.connect(false, { id: "bo", name: "Bo" });
  const forged: Author = { user: "ada", name: "Ada", color: colorFor("ada"), kind: "person" };
  const real: Author = { user: "bo", name: "Bo", color: colorFor("bo"), kind: "person" };
  // An honest tab's name tag is right already: the room writes nothing.
  const others = () => [...Y.decodeStateVector(Y.encodeStateVector(ada.doc))].filter(([client]) => client != ada.doc.clientID);
  const was = others();
  introduce(ada.doc, forged);
  ada.type(3, "Ada ");
  await w.settle();
  expect(others()).toEqual(was);
  expect(bo.text()).toBe("<p>Ada Hi</p>");

  // Bo's tab says in its presence that it is Ada: the others see Bo, with Bo's colour.
  const aw = new Awareness(bo.doc);
  const present = (n: number) => {
    aw.setLocalState({ user: forged, cursor: null, n });
    w.deliver(bo, awareness([...encodeAwarenessUpdate(aw, [bo.doc.clientID])]));
  };
  /** Bo's presence as a tab heard it last. */
  const heard = (tab: FakeTab) => {
    const all = new Awareness(new Y.Doc());
    for (const m of tab.presence.splice(0)) applyAwarenessUpdate(all, new Decoder(m.subarray(1)).readBytes(), null);
    const state = all.getStates().get(bo.doc.clientID);
    all.destroy();
    return state;
  };
  present(1);
  await w.settle();
  expect(heard(ada)).toEqual({ user: real, cursor: null, n: 1 });

  // Its name tag says Ada too: the mark on its edit, as Ada's tab shows it, has Bo's name, and so has the tag after.
  const marks: (string | undefined)[] = [];
  files(ada.doc)
    .get("index.html")!
    .observe((_e, tr) => marks.push(authorOf(ada.doc, tr)?.name));
  introduce(bo.doc, forged);
  bo.type(3, "forged ");
  await w.settle();
  expect(ada.text()).toBe("<p>forged Ada Hi</p>");
  expect(marks).toEqual(["Bo"]);
  expect(authors(ada.doc).get(String(bo.doc.clientID))).toEqual(real);
  // Bo's own tab hears what the room made of its tag.
  expect(authors(bo.doc).get(String(bo.doc.clientID))).toEqual(real);
  // It can't write Ada's tag, nor take it away.
  authors(bo.doc).set(String(ada.doc.clientID), { ...forged, name: "Nobody" });
  await w.settle();
  expect(authors(ada.doc).get(String(ada.doc.clientID))).toEqual(forged);
  authors(bo.doc).delete(String(ada.doc.clientID));
  await w.settle();
  expect(authors(ada.doc).get(String(ada.doc.clientID))).toEqual(forged);
  expect(authors(bo.doc).get(String(ada.doc.clientID))).toEqual(forged);
  // Nor can its presence speak for Ada's tab: Ada's caret stays hers.
  const adas = new Awareness(ada.doc);
  adas.setLocalState({ user: forged, cursor: null });
  w.deliver(ada, awareness([...encodeAwarenessUpdate(adas, [ada.doc.clientID])]));
  await w.settle();
  const fake = new Encoder();
  fake.writeUint(1);
  fake.writeUint(ada.doc.clientID);
  fake.writeUint(99);
  fake.writeString(JSON.stringify({ user: forged, cursor: { path: "index.html" } }));
  const before = bo.presence.length;
  w.deliver(bo, awareness([...fake.toBytes()]));
  await w.settle();
  const third = await w.connect(false, { id: "cy", name: "Cy" });
  const known = new Awareness(new Y.Doc());
  for (const m of third.presence) applyAwarenessUpdate(known, new Decoder(m.subarray(1)).readBytes(), null);
  expect(known.getStates().get(ada.doc.clientID)).toEqual({ user: forged, cursor: null });
  known.destroy();
  expect(bo.presence.length).toBe(before);

  aw.destroy();
  adas.destroy();
});

test("a shell tab (?shell=1) gets zero binary Yjs frames, receives hello, JSON presence, events, and survives hibernation", async () => {
  const dir = new Directory(memory(), { admins: ["ada"] });
  await dir.add({ id: "shell123", owner: "ada", title: "Shell Doc", created: Date.now(), expires: null });
  const w = new World(dir);
  await Effect.runPromise(
    w.document.create(
      "ada",
      "shell123",
      {
        "index.html": '<!doctype html><link rel="stylesheet" href="style.css"><p>Hi</p>',
        "plain.html": '<!doctype html><a href="https://example.com">External</a><p>Plain</p>',
      },
      "index.html",
      { expires: null }
    )
  );
  const shell = await w.connectShell({ id: "ada", name: "Ada" }, { who: { login: "ada" } });
  const a = await w.connect(false, { id: "ada", name: "Ada" });
  const bo = await w.connect(false, { id: "bo", name: "Bo" });

  // Hello arrives with relative-link metadata on pages, and zero binary frames ever hit the shell socket.
  await until(() => shell.events.some((e) => (e as { type?: string }).type == "hello"));
  const hello = shell.events.find((e) => (e as { type?: string }).type == "hello") as {
    type: string;
    tree: { entries: { path: string; relative?: boolean }[] };
  };
  expect(hello.tree.entries.find((e) => e.path == "index.html")?.relative).toBe(true);
  expect(hello.tree.entries.find((e) => e.path == "plain.html")?.relative).toBe(false);
  expect(shell.binary).toEqual([]);

  // Edits from full Yjs tabs do not send binary frames to the shell tab.
  a.type(a.text()!.indexOf("Hi"), "hello ");
  await w.settle();
  expect(bo.text()).toContain("hello Hi");
  expect(shell.binary).toEqual([]);

  // Awareness updates on the room broadcast plain JSON presence snapshots to the shell tab.
  const boAw = new Awareness(bo.doc);
  boAw.setLocalState({
    user: { user: "bo", name: "Bo", color: colorFor("bo"), kind: "person" },
    cursor: { path: "index.html", anchor: { type: null, tname: "files" }, head: null },
    active: 12345,
    tab: "bo-tab",
  });
  w.deliver(bo, awareness([...encodeAwarenessUpdate(boAw, [bo.doc.clientID])]));
  await w.settle();
  const lastPresence = [...shell.events].reverse().find((e) => (e as { type?: string }).type == "presence") as {
    type: "presence";
    list: { client: number; user: Author; cursorPath?: string | null; activeAt?: number; tab?: string }[];
  };
  expect(lastPresence.list).toContainEqual({
    client: bo.doc.clientID,
    user: { user: "bo", name: "Bo", color: colorFor("bo"), kind: "person" },
    cursorPath: "index.html",
    activeAt: 12345,
    tab: "bo-tab",
  });
  expect(shell.binary).toEqual([]);

  // User-targeted events (tabsOf / tell) and broadcast events (tellAll) reach the shell tab.
  expect(w.tabs.tabsOf("ada")).toEqual([shell]);
  w.tabs.tell("ada", { type: "open", path: "plain.html" });
  w.tabs.tellAll({ type: "publishing" });
  expect(shell.events).toContainEqual({ type: "open", path: "plain.html" });
  expect(shell.events).toContainEqual({ type: "publishing" });

  // Idle hibernation: document closes; binary awareness relayed while closed skips the shell tab.
  await until(() => !w.document.isOpen());
  const says = (state: object) => {
    const here = new Encoder();
    here.writeUint(1);
    here.writeUint(7);
    here.writeUint(1);
    here.writeString(JSON.stringify(state));
    return awareness([...here.toBytes()]);
  };
  w.deliver(a, says({ user: { name: "Ada" }, cursor: null }));
  await w.settle();
  expect(shell.binary).toEqual([]);
  expect(w.document.isOpen()).toBe(false);

  // Wake in a fresh object: shell tab re-attaches, gets a new hello and presence, still zero binary frames.
  const hellosBefore = shell.events.filter((e) => (e as { type?: string }).type == "hello").length;
  w.boot();
  a.type(0, "<!-- wake -->");
  await w.settle();
  await until(() => shell.events.filter((e) => (e as { type?: string }).type == "hello").length > hellosBefore);
  expect(shell.binary).toEqual([]);
  expect(shell.closed).toBeNull();

  // Shell title rename: sets title in the room, broadcasts { type: "name" }, and replies with title-ack.
  await Effect.runPromise(w.tabs.message(shell, JSON.stringify({ type: "title", id: 7, title: "Field notes" })));
  expect(shell.events).toContainEqual({ type: "title-ack", id: 7, ok: true });
  expect(shell.events).toContainEqual(expect.objectContaining({ type: "name", name: expect.objectContaining({ title: "Field notes" }) }));

  // Permissions change: role downgrade closes with 4408 (reconnect), unshare closes with 4403.
  const viewer = await w.connectShell({ id: "bo", name: "Bo" }, { readOnly: true, who: { login: "bo" } });
  await w.tabs.permissionsChanged(async (who) => (who.login == "ada" ? "viewer" : null));
  expect(shell.closed).toBe(4408);
  expect(viewer.closed).toBe(4403);
  boAw.destroy();
});

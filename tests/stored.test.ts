// The room tells each participant what its files hold ("stored": document/room.ts), and a page's replica takes only
// that as the base of its edits (libs/text/ui/collab.ts). A room that loses its history starts from its files, and the
// page then puts in what it has and the base has not. So an edit that the room had and did not store arrives one
// time, and so does one that it stored. A real Collab on a socket of this file's, which carries each message to a
// real room on storage in memory.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Y from "yjs";
import { ChangeSet } from "@codemirror/state";
import { FileStore, joinLocal, Room, StateStore } from "../document/room";
import { fileStoreOf, Journal, KEYS, MemoryStorage, stateStoreOf } from "../document/storage";
import { applyChanges, files } from "../document/content";
import { rebaseOnce } from "../document/merge";
import { Awareness, Decoder, MSG_STORED } from "../shared/yjs-protocol";
import { Collab } from "../libs/text/ui/collab";
import { until } from "./helpers/until";

const PAGE = "index.html";
const ada = { user: "ada", name: "Ada", color: "#2f6fec", kind: "person" as const };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A page's socket. It reaches `room` when the test opens it (`up`), and a new one takes its place after `down`. */
class Socket {
  static room: Room;
  static last: Socket;
  readyState: number = WebSocket.CONNECTING;
  /** What came before a script took the socket (the viewer's socket, open as the page parses). */
  early: ArrayBuffer[] = [];
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  private conn: ReturnType<Room["connect"]> = null;
  /** What the room's files hold, as this socket heard it: each "stored". */
  readonly stored: Map<number, number>[] = [];
  /** False: nothing that the page sends arrives, and nothing says so. */
  carries = true;
  constructor() {
    Socket.last = this;
  }
  up(): void {
    this.readyState = WebSocket.OPEN;
    // The room takes the socket as it opens: its first messages go out then.
    this.conn = Socket.room.connect((m) => {
      const data = m.slice().buffer;
      if (m[0] == MSG_STORED) this.stored.push(vectorOf(m));
      if (this.onmessage) queueMicrotask(() => this.onmessage?.({ data }));
      else this.early.push(data);
    });
    this.onopen?.();
  }
  down(): void {
    this.conn?.close();
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }
  send(m: Uint8Array): void {
    if (this.carries) queueMicrotask(() => this.conn?.receive(m));
  }
  close(): void {}
}

function vectorOf(m: Uint8Array): Map<number, number> {
  const d = new Decoder(m.subarray(1)),
    v = new Map<number, number>();
  for (let n = d.readUint(); n > 0; n--) v.set(d.readUint(), d.readUint());
  return v;
}

// What a Collab that keeps its replica asks of a page (pause.ts, its presence), and the sockets that it makes.
const g = globalThis as Record<string, unknown>;
const real = { WebSocket: g.WebSocket, window: g.window, document: g.document };
beforeAll(() => {
  Object.assign(Socket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  g.WebSocket = Socket;
  g.window = globalThis;
  g.document = { hidden: false, hasFocus: () => true, addEventListener() {}, removeEventListener() {} };
});
afterAll(() => Object.assign(g, real));

/** A room on `storage`. It writes its journal `writeDelay` ms after an edit, and its files `fileDelay` ms after. */
async function roomOn(storage: MemoryStorage, writeDelay: number, fileDelay = writeDelay) {
  const room = await Effect.runPromise(
    Room.make({ writeDelay, fileDelay }).pipe(
      Effect.provideService(FileStore, fileStoreOf(storage, { touch: async () => {} })),
      Effect.provideService(StateStore, stateStoreOf(storage)),
      Scope.provide(Effect.runSync(Scope.make()))
    )
  );
  Socket.room = room;
  return room;
}

/** Storage with the page "<h1>Launch notes</h1>", and a room on it that stores nothing by itself (`slow`), or at once. */
async function launch(slow: boolean) {
  const storage = new MemoryStorage();
  await storage.put(KEYS.file + PAGE, new TextEncoder().encode("<h1>Launch notes</h1>"));
  return { storage, room: await roomOn(storage, slow ? 60_000 : 2) };
}

/** A page's replica, kept in the browser. `early`: on a socket that was open before the page's script. */
function page(early = false) {
  const socket = new Socket();
  if (early) socket.up();
  let started!: (v: null) => void;
  const collab = new Collab({
    onEvent: () => {},
    onRemote: () => {},
    onFiles: () => {},
    onPresence: () => {},
    onStatus: () => {},
    onStale: () => {},
    url: () => "ws://room/",
    early: socket as unknown as WebSocket,
    start: new Promise<null>((r) => (started = r)),
    keep: "page",
  });
  collab.join(ada, PAGE, null);
  return {
    collab,
    /** The start's answer comes, with nothing: the socket's sync brings the state. */
    start: () => started(null),
    /** The page's socket now. */
    socket: () => Socket.last,
    /** The page in its usual order: the start's answer, the socket, the first sync. */
    async ready() {
      started(null);
      await tick();
      socket.up();
      await collab.ready();
      return collab;
    },
  };
}

/** One edit in the page: `text` after `after`, or (`remove`) that text deleted. */
function edit(c: Collab, after: string, text: string, remove = false) {
  const at = c.current().indexOf(after) + after.length;
  c.push(ChangeSet.of(remove ? { from: at, to: at + text.length } : { from: at, insert: text }, c.current().length));
}

/** A participant in the server, as an agent's session is: it has no page, and nothing keeps its replica. */
async function agent(room: Room) {
  const doc = new Y.Doc();
  joinLocal(room, doc, new Awareness(doc));
  const t = await until(() => files(doc).get(PAGE));
  return (after: string, text: string) => t.insert(t.toString().indexOf(after) + after.length, text);
}

/** The page's base: its text as the room's files hold it, as far as the page knows (collab.ts, baseTexts). */
const base = (c: Collab) => (c as unknown as { baseTexts(): Record<string, string> }).baseTexts()[PAGE];
const file = (s: MemoryStorage) => s.get<Uint8Array>(KEYS.file + PAGE).then((b) => new TextDecoder().decode(b));
const store = (room: Room) => Effect.runPromise(room.flush);

/** The room stops without a write (a kill), and its history is lost: a new room starts from the files. */
async function lostHistory(storage: MemoryStorage, room: Room) {
  for (const k of [...storage.data.keys()]) if (k.startsWith(KEYS.room)) storage.data.delete(k);
  const next = await roomOn(storage, 60_000);
  expect(next.epoch).not.toBe(room.epoch);
  return next;
}

/** The page loads again, and puts its kept replica into the new room (collab.ts, adopt: the same steps). */
function adopt(c: Collab, next: Room): string {
  const ours = c.current(),
    t = files(next.doc).get(PAGE)!;
  if (ours != base(c)) next.doc.transact(() => applyChanges(t, rebaseOnce(base(c), t.toString(), ours)));
  return t.toString();
}

test("an edit that the room has, and did not store before it lost its history, arrives one time", async () => {
  const { storage, room } = await launch(true);
  const c = await page().ready();
  await until(() => base(c) == "<h1>Launch notes</h1>");

  // Ada types. The room has it, and nothing is stored: not in the file, and not in the journal.
  edit(c, "notes", " offline");
  await until(() => room.text(PAGE) == "<h1>Launch notes offline</h1>");
  expect(await file(storage)).toBe("<h1>Launch notes</h1>");
  const journal = new Y.Doc();
  for (const u of (await new Journal(storage).load())?.updates ?? []) Y.applyUpdate(journal, u);
  expect(files(journal).get(PAGE)?.toString() ?? "").not.toContain(" offline");
  // So the base has it not: the room said nothing.
  await tick();
  expect(base(c)).toBe("<h1>Launch notes</h1>");

  const next = await lostHistory(storage, room);
  expect(next.text(PAGE)).toBe("<h1>Launch notes</h1>");
  expect(adopt(c, next)).toBe("<h1>Launch notes offline</h1>");
});

test("an edit that the room stored is in the base, and after a lost history it is there one time", async () => {
  const { storage, room } = await launch(true);
  const p = page();
  const c = await p.ready();
  edit(c, "notes", " offline");
  await until(() => room.text(PAGE) == "<h1>Launch notes offline</h1>");
  await store(room);
  await until(() => base(c) == "<h1>Launch notes offline</h1>");
  // Only what changed goes on the wire: this tab's clock (and the room's own first edit, which says who it is).
  expect(p.socket().stored.at(-1)!.size).toBeLessThanOrEqual(2);

  const next = await lostHistory(storage, room);
  expect(next.text(PAGE)).toBe("<h1>Launch notes offline</h1>");
  expect(adopt(c, next)).toBe("<h1>Launch notes offline</h1>");
});

// (Before, the page asked the room to confirm each edit. A replica whose first message from the room came before it
// could ask never asked on that socket: the viewer's, on each load.)
for (const [order, early, first] of [
  ["the viewer's socket, open before its script: the room's first messages wait on it", true, "socket"],
  ["the page's socket: it opens before the start's answer", false, "socket"],
  ["the page's socket: the start's answer comes first", false, "start"],
] as const)
  test(`a replica hears that the room stored an edit that it makes on its first socket (${order})`, async () => {
    const { storage, room } = await launch(false);
    const p = page(early);
    if (first == "start") {
      p.start();
      await tick();
    }
    if (!early) p.socket().up();
    await tick();
    if (first == "socket") p.start();
    await p.collab.ready();

    edit(p.collab, "notes", " offline");
    await until(() => base(p.collab) == "<h1>Launch notes offline</h1>");
    expect(await file(storage)).toBe("<h1>Launch notes offline</h1>");
    expect(room.saved).toBe(true);
  });

test("a write of the journal alone says nothing: the room says so after the write that leaves no file behind", async () => {
  const storage = new MemoryStorage();
  await storage.put(KEYS.file + PAGE, new TextEncoder().encode("<h1>Launch notes</h1>"));
  const room = await roomOn(storage, 2, 60_000);
  const p = page();
  const c = await p.ready();
  const said = p.socket().stored.length;
  expect(said, "as it joins, the socket hears all that the files hold").toBe(1);

  edit(c, "notes", " offline");
  const inJournal = async () => {
    const d = new Y.Doc();
    for (const u of (await new Journal(storage).load())!.updates) Y.applyUpdate(d, u);
    return files(d).get(PAGE)!.toString().includes(" offline");
  };
  await until(inJournal);
  await tick();
  expect(await file(storage)).toBe("<h1>Launch notes</h1>");
  expect(p.socket().stored.length).toBe(said);
  expect(base(c)).toBe("<h1>Launch notes</h1>");

  await store(room);
  expect(await file(storage)).toBe("<h1>Launch notes offline</h1>");
  await until(() => base(c) == "<h1>Launch notes offline</h1>");
});

test("the room's answer to a page that was away has two participants' edits, one of them stored: none of it is in the base before the files hold all of it", async () => {
  const { storage, room } = await launch(true);
  const p = page();
  const c = await p.ready();
  await until(() => base(c) == "<h1>Launch notes</h1>");
  const first = p.socket();
  first.down();

  // Meanwhile, two agents edit. The room stores the edit of the first one only.
  const bo = await agent(room),
    cy = await agent(room);
  bo("notes", " one");
  await until(() => room.text(PAGE) == "<h1>Launch notes one</h1>");
  await store(room);
  cy("one", " two");
  await until(() => room.text(PAGE) == "<h1>Launch notes one two</h1>");

  // The page comes back: it hears what the files hold, and gets both edits as one update.
  await until(() => p.socket() != first);
  p.socket().up();
  await until(() => c.current() == "<h1>Launch notes one two</h1>");
  await tick();
  expect(await file(storage)).toBe("<h1>Launch notes one</h1>");
  expect(base(c)).toBe("<h1>Launch notes</h1>");

  // The second agent has no replica that comes back: the page puts its edit in, and the stored one no second time.
  const next = await lostHistory(storage, room);
  expect(next.text(PAGE)).toBe("<h1>Launch notes one</h1>");
  expect(adopt(c, next)).toBe("<h1>Launch notes one two</h1>");
});

test("a deletion that the room did not store is not in the base, though the room stored a later edit: it arrives after a lost history", async () => {
  const { storage, room } = await launch(true);
  const p = page();
  const c = await p.ready();
  await until(() => base(c) == "<h1>Launch notes</h1>");

  // Ada's socket goes silent, and her only change is a deletion. (A deletion has no clock in Yjs: its stamp has.)
  p.socket().carries = false;
  edit(c, "Launch", " notes", true);
  expect(c.current()).toBe("<h1>Launch</h1>");
  const bo = await agent(room);
  bo("<h1>", "Big ");
  await until(() => c.current() == "<h1>Big Launch</h1>");
  await store(room);
  await until(() => base(c) == "<h1>Big Launch notes</h1>");
  expect(await file(storage)).toBe("<h1>Big Launch notes</h1>");

  const next = await lostHistory(storage, room);
  expect(adopt(c, next)).toBe("<h1>Big Launch</h1>");
});

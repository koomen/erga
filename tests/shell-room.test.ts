// Unit tests for ShellRoom (client/shell/shell-room.ts): lightweight JSON-only room socket for the editor shell.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Hello } from "../document/api/api";
import { PING, PONG } from "../shared/room-socket";
import { ShellRoom, type EarlySocket, type RoomStatus, type ShellPresence, type SocketEvent } from "../client/shell/shell-room";
import { until } from "./helpers/until";

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  sent: unknown[] = [];
  early?: (string | ArrayBuffer)[];
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: unknown): void {
    this.sent.push(data);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  close(code = 1000): void {
    if (this.readyState == 3) return;
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

const HELLO: Hello = {
  type: "hello",
  info: { name: "index.html", path: "index.html", dir: "ada", user: "Ada", userId: "ada", writeDelay: 400, canEdit: true },
  tree: { entries: [{ path: "index.html", type: "page", title: "Home", relative: false }], canEdit: true, moved: [], pages: 1 },
  epoch: "ep1",
};

const origStorage = globalThis.localStorage;
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
});
afterEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = origStorage;
});

function makeRoom(opts: { early?: FakeSocket; keep?: string; onReload?: () => void } = {}) {
  const sockets: FakeSocket[] = [];
  const events: SocketEvent[] = [];
  const statuses: RoomStatus[] = [];
  let presenceChanges = 0;
  const room = new ShellRoom({
    url: () => "ws://erga.test/d/doc1/api/room?events=1&shell=1",
    early: opts.early as unknown as EarlySocket | undefined,
    keep: opts.keep,
    onEvent: (m) => events.push(m),
    onPresence: () => presenceChanges++,
    onStatus: (s) => statuses.push(s),
    onReload: opts.onReload,
    createSocket: (url) => {
      const ws = new FakeSocket(url);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });
  return { room, sockets, events, statuses, presenceChanges: () => presenceChanges };
}

test("early socket handoff delivers buffered hello and presence, and ignores binary frames and PONG", async () => {
  const early = new FakeSocket("ws://erga.test/d/doc1/api/room?events=1&shell=1");
  early.readyState = 1;
  const list: ShellPresence[] = [
    { client: 1, user: { user: "ada", name: "Ada", color: "#2f6fec", kind: "person" }, cursorPath: "index.html", activeAt: 10 },
    { client: 2, user: { user: "bo", name: "Bo", color: "#d6409f", kind: "person" }, cursorPath: "index.html", activeAt: 20 },
  ];
  early.early = [JSON.stringify(HELLO), JSON.stringify({ type: "presence", list }), PONG, new ArrayBuffer(4)];

  const { room, sockets, events, statuses, presenceChanges } = makeRoom({ early });
  expect(sockets.length).toBe(0);
  expect(await room.hello).toEqual(HELLO);
  expect(room.connected).toBe(true);
  expect(room.status).toBe("up");
  expect(statuses).toEqual(["up"]);
  expect(events).toEqual([HELLO]);
  expect(presenceChanges()).toBe(1);
  expect(room.others().length).toBe(2);
  expect(room.others("ada").map((p) => p.user.user)).toEqual(["bo"]);
  expect(room.hasCaret(list[1], "index.html")).toBe(true);
  expect(room.hasCaret(list[1], "about.html")).toBe(false);
  room.close();
});

test("shown() deduplicates persons by activeAt then clientID, omits me, and keeps agents", async () => {
  const { room, sockets } = makeRoom();
  sockets[0].open();
  sockets[0].receive(JSON.stringify(HELLO));
  const list: ShellPresence[] = [
    { client: 1, user: { user: "ada", name: "Ada", color: "#2f6fec", kind: "person" }, activeAt: 500 },
    { client: 2, user: { user: "bo", name: "Bo", color: "#d6409f", kind: "person" }, cursorPath: "old.html", activeAt: 100 },
    { client: 3, user: { user: "bo", name: "Bo", color: "#d6409f", kind: "person" }, cursorPath: "new.html", activeAt: 200 },
    { client: 4, user: { user: "cy", name: "Cy", color: "#12a594", kind: "person" }, activeAt: 100 },
    { client: 9, user: { user: "cy", name: "Cy", color: "#12a594", kind: "person" }, cursorPath: "index.html", activeAt: 100 },
    { client: 10, user: { user: "ada", name: "Ada’s agent", color: "#8e4ec6", kind: "agent" }, busy: true, activity: "editing" },
  ];
  sockets[0].receive(JSON.stringify({ type: "presence", list }));
  const shown = room.shown("ada");
  expect(shown.map((p) => [p.user.user, p.user.kind, p.client, p.cursorPath ?? null])).toEqual([
    ["bo", "person", 3, "new.html"],
    ["cy", "person", 9, "index.html"],
    ["ada", "agent", 10, null],
  ]);
  // Disconnecting clears presence.
  sockets[0].close(1006);
  expect(room.presence).toEqual([]);
  room.close();
});

test("4404 marks status gone and rejects hello; 4403 reloads; 4408 reconnects", async () => {
  // 4404 before hello: rejects hello and ends as gone.
  const gone = makeRoom();
  gone.sockets[0].open();
  gone.sockets[0].close(4404);
  expect(gone.room.status).toBe("gone");
  expect(gone.room.connected).toBe(false);
  expect(gone.statuses).toEqual(["up", "gone"]);
  await expect(gone.room.hello).rejects.toThrow(/deleted/);
  gone.room.close();

  // 4403: calls onReload and never reconnects.
  let reloaded = 0;
  const unshared = makeRoom({ onReload: () => reloaded++ });
  unshared.sockets[0].open();
  unshared.sockets[0].close(4403);
  expect(reloaded).toBe(1);
  expect(unshared.room.status).toBe("down");
  unshared.room.close();

  // 4408: role changed -> reconnects after backoff.
  const role = makeRoom();
  role.sockets[0].open();
  role.sockets[0].receive(JSON.stringify(HELLO));
  role.sockets[0].close(4408);
  expect(role.room.status).toBe("down");
  await until(() => role.sockets.length == 2, 2000);
  role.room.close();
});

test("offline fallback resolves hello from localStorage cache and keeps retrying", async () => {
  store.set("erga:hello:/d/doc1", JSON.stringify(HELLO));
  const { room, sockets } = makeRoom({ keep: "/d/doc1" });
  // First connect fails while offline -> resolves hello from cache instead of refusing.
  sockets[0].close(1006);
  expect(await room.hello).toEqual(HELLO);
  expect(room.status).toBe("down");
  await until(() => sockets.length == 2, 2000);
  room.close();
});

test("never-connected socket with no cache rejects hello after refuseAfter failures", async () => {
  const { room, sockets } = makeRoom();
  sockets[0].close(1006);
  await until(() => sockets.length == 2, 2000);
  sockets[1].close(1006);
  await until(() => sockets.length == 3, 2000);
  sockets[2].close(1006);
  await expect(room.hello).rejects.toThrow(/refused/);
  room.close();
});

test("signedOut keeps open socket alive until close and prevents reconnect", async () => {
  const { room, sockets } = makeRoom();
  sockets[0].open();
  sockets[0].receive(JSON.stringify(HELLO));
  room.signedOut();
  expect(room.connected).toBe(true);
  sockets[0].close(1006);
  expect(room.connected).toBe(false);
  expect(sockets.length).toBe(1);
  // Opening primes the socket with PING so workerd hibernatable close frames arrive.
  expect(sockets[0].sent).toEqual([PING]);
  room.close();
});

test("sendTitle sends JSON title frame, resolves on title-ack, and rejects pending waits on close", async () => {
  const { room, sockets } = makeRoom();
  // Before open: returns false without sending.
  expect(await room.sendTitle("Draft")).toBe(false);
  sockets[0].open();
  sockets[0].receive(JSON.stringify(HELLO));
  const ok = room.sendTitle("Field notes");
  expect(sockets[0].sent).toEqual([PING, JSON.stringify({ type: "title", id: 1, title: "Field notes" })]);
  sockets[0].receive(JSON.stringify({ type: "title-ack", id: 1, ok: true }));
  expect(await ok).toBe(true);
  // Socket drops before ack -> resolves false so caller retries on reconnect.
  const dropped = room.sendTitle("Later");
  sockets[0].close(1006);
  expect(await dropped).toBe(false);
  room.close();
});

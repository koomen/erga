// A document's room, for the sync journeys (trimmed from the old multiplayer suite):
//
//   roomOf(address)   what the server stores and serves for the document's files, and its room's address
//   Person            a person with no browser: a Yjs replica joined to the room over a real WebSocket, with the
//                     messages and the habits of a tab (it names itself, it marks its deletions)
//   crowd()           the people of one test: join() makes each one, leave() closes them all at the test's end
//   secondPage        the document in another page of the test's browser, for a second person
//
// Trap: a Person's edit is on its own replica at once, and in the room a moment later. A check of the room, of a tab
// or of another Person waits for it (until, converged).

import * as Y from "yjs";
import { colorFor, files, introduce, roomInfo, stamp, type Author } from "../../document/content";
import {
  applyAwarenessUpdate,
  Awareness,
  type AwarenessChange,
  Decoder,
  Encoder,
  encodeAwarenessUpdate,
  readSyncMessage,
  removeAwarenessStates,
  SYNC_STEP2,
  writeSyncStep1,
  writeUpdate,
} from "../../shared/yjs-protocol";
import { editor, TIMESCALE, type Editor } from "../helpers/editor";
import { until, type Tab } from "../helpers/fixtures";

const MSG_SYNC = 0,
  MSG_AWARENESS = 1,
  MSG_QUERY_AWARENESS = 3;

export interface Room {
  /** The document's address (no ?edit): its API is under it. */
  base: string;
  /** The room's WebSocket address. */
  socket: string;
  /** What storage holds for a file, and its etag; null when it has no such file. */
  stored(path?: string): Promise<{ text: string; etag: string } | null>;
  /** What the server serves for a file to the page: the room's latest text. */
  served(path?: string): Promise<string | null>;
  /** An edit that arrives as a whole file (a publish), made from the stored version `ifMatch`. */
  push(text: string, ifMatch: string, path?: string): Promise<Response>;
}

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export function roomOf(address: string): Room {
  return {
    base: address,
    socket: `${address.replace(/^http/, "ws")}/api/room/doc`,
    async stored(path = "index.html") {
      const r = await fetch(`${address}/api/stored/${enc(path)}`);
      if (r.status == 404) return null;
      if (!r.ok) throw new Error(`stored ${path}: ${r.status}`);
      return { text: await r.text(), etag: (r.headers.get("etag") ?? "").replace(/"/g, "") };
    },
    async served(path = "index.html") {
      const r = await fetch(`${address}/doc/${enc(path)}`);
      return r.ok ? r.text() : null;
    },
    push: (text, ifMatch, path = "index.html") =>
      fetch(`${address}/api/stored/${enc(path)}`, { method: "PUT", body: text, headers: { "If-Match": `"${ifMatch}"` } }),
  };
}

/** A replica's socket to the room: the sync and awareness messages, as a tab sends them. It connects again after a close. */
class RoomSocket {
  readonly awareness: Awareness;
  ws: WebSocket | null = null;
  connected = false;
  /** The room's answer to this replica's state vector is in. */
  synced = false;
  /** The room refused this replica (its history is not the room's). */
  refused = false;
  shouldConnect = true;
  private failures = 0;
  private again: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly doc: Y.Doc,
    readonly params: Record<string, string>
  ) {
    this.awareness = new Awareness(doc);
    doc.on("update", this.onUpdate);
    this.awareness.on("update", this.onAwareness);
    this.connect();
  }

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    const e = new Encoder();
    e.writeUint(MSG_SYNC);
    writeUpdate(e, update);
    this.send(e.toBytes());
  };
  private onAwareness = ({ added, updated, removed }: AwarenessChange) => this.sendAwareness([...added, ...updated, ...removed]);

  private send(bytes: Uint8Array<ArrayBuffer>) {
    if (this.connected && this.ws?.readyState == WebSocket.OPEN) this.ws.send(bytes);
  }
  private sendAwareness(clients: number[]) {
    const e = new Encoder();
    e.writeUint(MSG_AWARENESS);
    e.writeBytes(encodeAwarenessUpdate(this.awareness, clients));
    this.send(e.toBytes());
  }

  connect() {
    this.shouldConnect = true;
    if (this.ws) return;
    const ws = new WebSocket(`${this.url}?${new URLSearchParams(this.params)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      const e = new Encoder();
      e.writeUint(MSG_SYNC);
      writeSyncStep1(e, this.doc);
      this.send(e.toBytes());
      if (this.awareness.getLocalState()) this.sendAwareness([this.doc.clientID]);
    };
    ws.onmessage = (m) => {
      const d = new Decoder(new Uint8Array(m.data as ArrayBuffer));
      const type = d.readUint();
      if (type == MSG_SYNC) {
        const reply = new Encoder();
        reply.writeUint(MSG_SYNC);
        if (readSyncMessage(d, reply, this.doc, this) == SYNC_STEP2) {
          this.synced = true;
          this.failures = 0;
        }
        if (reply.length > 1) this.send(reply.toBytes());
      } else if (type == MSG_AWARENESS) applyAwarenessUpdate(this.awareness, d.readBytes(), this);
      else if (type == MSG_QUERY_AWARENESS) this.sendAwareness([...this.awareness.getStates().keys()]);
    };
    ws.onerror = () => {};
    ws.onclose = (e) => this.closed(ws, e.code);
  }

  /** The socket is gone (closed by the room, or here): the others' carets go, and it connects again if it should. */
  private closed(ws: WebSocket, code: number | null) {
    if (this.ws != ws) return;
    this.ws = null;
    ws.onmessage = ws.onopen = ws.onclose = null;
    ws.close();
    this.failures++;
    if (this.connected)
      removeAwarenessStates(
        this.awareness,
        [...this.awareness.getStates().keys()].filter((c) => c != this.doc.clientID),
        this
      );
    this.connected = this.synced = false;
    if (code == 4409) {
      this.refused = true;
      this.shouldConnect = false;
    }
    if (this.shouldConnect) this.again = setTimeout(() => this.shouldConnect && this.connect(), Math.min(2 ** this.failures * 100, 500));
  }

  /** Closes the socket, and does not connect again: the room sees the close, and tells the others. */
  disconnect() {
    this.shouldConnect = false;
    if (this.again) clearTimeout(this.again);
    if (this.ws) this.closed(this.ws, null);
  }

  destroy() {
    this.disconnect();
    this.doc.off("update", this.onUpdate);
    this.awareness.off("update", this.onAwareness);
    this.awareness.destroy();
  }
}

export class Person {
  readonly ydoc = new Y.Doc();
  readonly socket: RoomSocket;
  readonly me: Author;
  private local = { person: true };
  private gone = false;

  constructor(
    readonly room: Room,
    readonly name: string
  ) {
    const id = name.toLowerCase();
    this.me = { user: id, name, color: colorFor(id), kind: "person" };
    this.socket = new RoomSocket(room.socket, this.ydoc, { user: name });
    this.socket.awareness.setLocalState({ user: this.me, cursor: null });
  }

  /** Whether the room refused this replica. */
  get refused(): boolean {
    return this.socket.refused;
  }
  get connected(): boolean {
    return this.socket.connected;
  }
  /** Connected, with the room's answer to its state in. */
  get synced(): boolean {
    return this.socket.connected && this.socket.synced;
  }
  get epoch(): string | undefined {
    return roomInfo(this.ydoc).get("epoch");
  }

  text(path = "index.html"): Y.Text | undefined {
    return files(this.ydoc).get(path);
  }
  str(path = "index.html"): string {
    return this.text(path)?.toString() ?? "";
  }

  /** One local edit, as this person's. */
  edit(f: (t: Y.Text) => void, path = "index.html"): void {
    const t = this.text(path);
    if (!t) throw new Error(`${this.name} has no ${path}`);
    this.ydoc.transact(() => {
      const before = Y.getState(this.ydoc.store, this.ydoc.clientID);
      f(t);
      // Deletions alone carry no client id: stamp them.
      if (Y.getState(this.ydoc.store, this.ydoc.clientID) == before) stamp(this.ydoc, this.me);
    }, this.local);
  }
  insert(pos: number, s: string) {
    this.edit((t) => t.insert(pos, s));
  }
  delete(pos: number, len: number) {
    this.edit((t) => t.delete(pos, len));
  }
  /** Inserts after the first `anchor` in the text. */
  insertAfter(anchor: string, s: string) {
    const i = this.str().indexOf(anchor);
    if (i < 0) throw new Error(`${this.name}: "${anchor}" is not in the text`);
    this.insert(i + anchor.length, s);
  }
  /** Inserts before the first `anchor` in the text. */
  insertBefore(anchor: string, s: string) {
    const i = this.str().indexOf(anchor);
    if (i < 0) throw new Error(`${this.name}: "${anchor}" is not in the text`);
    this.insert(i, s);
  }

  /** The names of the other people in the room, as this person's awareness has them. */
  others(): string[] {
    return [...this.socket.awareness.getStates()]
      .filter(([c, s]) => c != this.ydoc.clientID && s.user)
      .map(([, s]) => (s.user as Author).name);
  }

  /** Goes off the network. Its edits stay on its replica until it comes back. */
  offline() {
    this.socket.disconnect();
  }
  /** Comes back, in the background. */
  online() {
    this.socket.connect();
  }
  /** Waits until this person's text holds `s`: an edit of another person has arrived. */
  has(s: string, ms = 5000): Promise<void> {
    return new Promise((done, fail) => {
      const check = () => {
        if (!this.str().includes(s)) return;
        clearTimeout(limit);
        this.ydoc.off("update", check);
        done();
      };
      const limit = setTimeout(() => {
        this.ydoc.off("update", check);
        fail(new Error(`${this.name} did not get "${s}" within ${ms} ms`));
      }, ms);
      this.ydoc.on("update", check);
      check();
    });
  }

  /** Leaves the room for good: the socket closes, and the room tells the others. */
  leave() {
    if (this.gone) return;
    this.gone = true;
    this.socket.destroy();
    this.ydoc.destroy();
  }
}

/** The people with no browser of one test. */
export function crowd() {
  const all: Person[] = [];
  return {
    /** A person joins the room: with the room's text, and its name on its edits, as a tab's. */
    async join(room: Room, name: string): Promise<Person> {
      const p = new Person(room, name);
      all.push(p);
      await until(() => p.synced || p.refused, 10_000, `${name} joins the room`);
      if (p.refused) return p;
      introduce(p.ydoc, p.me);
      p.socket.params.epoch = p.epoch ?? "";
      return p;
    },
    /** Everyone leaves (at the end of a test, also one that failed). */
    leave() {
      for (const p of all.splice(0)) p.leave();
    },
  };
}

/** Waits until all the people hold the same text, and returns it. */
export async function converged(ps: Person[], ms = 5000): Promise<string> {
  await until(
    () => ps.every((p) => p.str() == ps[0].str()),
    ms,
    "the people have the same text",
    () => ps.map((p) => ({ who: p.name, connected: p.connected, length: p.str().length }))
  );
  return ps[0].str();
}

/** Seeded random numbers (mulberry32): a failure names its seed, and ERGA_SEED=n plays the same run again. */
export function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(next, {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
  });
}
export const SEED = Number(process.env.ERGA_SEED) || Date.now() % 1_000_000;

/**
 * The document of `first` in another page of the same browser, in the editor, as `user` (none: the same person in a
 * second tab). Its errors count as the test's. The page closes with the test's browser.
 */
export async function secondPage(tab: Tab, first: Editor, user?: string): Promise<Editor> {
  const page = await tab.page.context().newPage();
  page.on("pageerror", (e) => tab.errors.push(e.stack ?? e.message));
  page.on("console", (m) => {
    if (m.type() == "error") tab.errors.push(`console.error: ${m.text()}`);
  });
  const size = tab.page.viewportSize();
  if (size) await page.setViewportSize(size);
  // As openEditor's page: fast timers, the check that the page shows its HTML, and the agent pane closed.
  await page.addInitScript((timescale) => {
    if (window.top != window) return;
    (window as any).__ergaTimescale = timescale;
    (window as any).__ergaCheck = true;
    try {
      if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}');
    } catch {
      /* no storage */
    }
  }, TIMESCALE);
  await page.goto(`${first.address}${user ? `?user=${encodeURIComponent(user)}&edit` : "?edit"}`);
  const ed = editor(page, { address: first.address, dir: first.dir, file: first.file });
  await ed.loaded();
  await ed.frame(`${ed.F}.fonts.ready.then(() => true)`);
  return ed;
}

/** The names on the other people's carets on a person's page, "|"-joined. */
export const peerNames = (ed: Editor) =>
  ed.frame<string>(`[...${ed.F}.querySelectorAll("erga-peer-name")].map((e) => e.textContent).join("|")`);
/** Whether another person's caret on the page sits in the element. */
export const peerCaretIn = (ed: Editor, selector: string) =>
  ed.frame<boolean>(
    `(() => { const w = ${ed.W}, r = ${ed.F}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [...${ed.F}.querySelectorAll("erga-peer")].some((c) => { const y = parseFloat(c.style.top) - w.scrollY; return y >= r.top - 2 && y < r.bottom; }); })()`
  );

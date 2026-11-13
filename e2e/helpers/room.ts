// Someone in a document's room with no browser: a Yjs replica joined to the room over a real WebSocket, with the
// messages and the habits of a tab (it names itself, it marks its deletions, it connects again). The one room client of
// the journeys (sync, access, the agent) and of the bench; what each needs more is in its own file.
//
// Trap: an edit is on the replica at once, and in the room a moment later. A check of the room, of a tab or of another
// replica waits for it (until).

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
import { until } from "./fixtures";

const MSG_SYNC = 0,
  MSG_AWARENESS = 1,
  MSG_QUERY_AWARENESS = 3;

/** The address of the room's WebSocket, for the document at `address`. */
export const roomUrl = (address: string) => `${address.replace(/^http/, "ws")}/api/room/doc`;

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
    readonly params: Record<string, string>,
    private readonly headers: Record<string, string>
  ) {
    this.awareness = new Awareness(doc);
    // Not shown to the others, until the replica says so (Replica.present).
    this.awareness.setLocalState(null);
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
    const url = `${this.url}?${new URLSearchParams(this.params)}`;
    // (Bun's WebSocket takes headers: a deployment's sign-in.)
    const ws = Object.keys(this.headers).length ? new WebSocket(url, { headers: this.headers } as unknown as string[]) : new WebSocket(url);
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
      // (A text frame is an event for a tab: not the room's.)
      if (typeof m.data == "string") return;
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

export class Replica {
  readonly ydoc = new Y.Doc();
  readonly socket: RoomSocket;
  readonly me: Author;
  /** The origin of this replica's own edits: a change with another origin came from the room. */
  readonly local = {};
  private gone = false;

  /**
   * `url`: the room's WebSocket (roomUrl). `name`: who it is (local development's ?user=). `path`: the file that it
   * reads and edits. `headers`: what its socket's request carries (a deployment's sign-in).
   */
  constructor(
    url: string,
    readonly name: string,
    readonly path = "index.html",
    headers: Record<string, string> = {}
  ) {
    const id = name.toLowerCase();
    this.me = { user: id, name, color: colorFor(id), kind: "person" };
    this.socket = new RoomSocket(url, this.ydoc, { user: name }, headers);
  }

  /** Shows itself to the others in the room, as a tab does: its name, and no caret yet. */
  present(): this {
    this.socket.awareness.setLocalState({ user: this.me, cursor: null });
    return this;
  }

  /**
   * Waits for the room's answer to its state. Then, as a tab does, it puts its name on its edits and takes the room's
   * epoch (for when it connects again). A replica that the room refused (`refused`) comes back as it is.
   */
  async joined(ms = 10_000): Promise<this> {
    await until(() => this.synced || this.refused, ms, `${this.name} joins the room`);
    if (this.refused) return this;
    introduce(this.ydoc, this.me);
    this.socket.params.epoch = this.epoch ?? "";
    return this;
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

  text(path = this.path): Y.Text | undefined {
    return files(this.ydoc).get(path);
  }
  str(path = this.path): string {
    return this.text(path)?.toString() ?? "";
  }

  /** One local edit, as this replica's person. */
  edit(f: (t: Y.Text) => void, path = this.path): void {
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

  /** Leaves the room for good: the socket closes, and the room tells the others. */
  leave() {
    if (this.gone) return;
    this.gone = true;
    this.socket.destroy();
    this.ydoc.destroy();
  }
}

/** Joins the room of the document at `address` as `name`, and waits for the first sync. */
export const joinRoom = (address: string, name: string) => new Replica(roomUrl(address), name).joined();

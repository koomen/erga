// A headless participant: a Yjs replica joined to a document's room over a
// real WebSocket (RoomSocket below: the sync and awareness messages a tab
// sends), with the same conventions (introduce, stamp, epoch, relative-position cursors), but
// no browser. Many of them make a crowd; they can drop off the network,
// edit offline and come back.

import * as Y from "yjs";
import { authorOf, colorFor, files, introduce, roomInfo, stamp, type Author } from "../../../document/content";
import type { Doc } from "./target";
import { Failure } from "./harness";
import { until } from "../../helpers/fixtures";
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
} from "../../../shared/yjs-protocol";

const MSG_SYNC = 0,
  MSG_AWARENESS = 1,
  MSG_QUERY_AWARENESS = 3;

/**
 * A replica's socket to the room (at `${url}/${room}?<params>`): the sync and awareness messages, as a tab sends
 * them. It connects again after a close while `shouldConnect`, after at most `maxBackoffMs`.
 */
export class RoomSocket {
  readonly awareness: Awareness;
  ws: WebSocket | null = null;
  wsconnected = false;
  /** The room's answer to this replica's state vector is in. */
  synced = false;
  shouldConnect = true;
  private failures = 0;
  private closeListeners: ((e: CloseEvent | null) => void)[] = [];

  constructor(
    private readonly url: string,
    private readonly room: string,
    private readonly doc: Y.Doc,
    readonly opts: { params: Record<string, string>; WebSocket: typeof WebSocket; maxBackoffMs: number }
  ) {
    this.awareness = new Awareness(doc);
    doc.on("update", this.onUpdate);
    this.awareness.on("update", this.onAwareness);
    this.connect();
  }

  get params(): Record<string, string> {
    return this.opts.params;
  }
  on(_event: "connection-close", f: (e: CloseEvent | null) => void) {
    this.closeListeners.push(f);
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
    if (this.wsconnected && this.ws?.readyState == WebSocket.OPEN) this.ws.send(bytes);
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
    const ws = new this.opts.WebSocket(`${this.url}/${this.room}?${new URLSearchParams(this.params)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.wsconnected = true;
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
    ws.onclose = (e) => this.closed(ws, e);
  }

  /** The socket is gone (closed by the room, or here): the others' carets go, and it connects again if it should. */
  private closed(ws: WebSocket, e: CloseEvent | null) {
    if (this.ws != ws) return;
    this.ws = null;
    ws.onmessage = ws.onopen = ws.onclose = null;
    ws.close();
    this.failures++;
    if (this.wsconnected)
      removeAwarenessStates(
        this.awareness,
        [...this.awareness.getStates().keys()].filter((c) => c != this.doc.clientID),
        this
      );
    this.wsconnected = this.synced = false;
    for (const f of this.closeListeners) f(e);
    if (this.shouldConnect)
      setTimeout(() => this.shouldConnect && this.connect(), Math.min(2 ** this.failures * 100, this.opts.maxBackoffMs));
  }

  disconnect() {
    this.shouldConnect = false;
    if (this.ws) this.closed(this.ws, null);
  }

  destroy() {
    this.disconnect();
    this.doc.off("update", this.onUpdate);
    this.awareness.off("update", this.onAwareness);
    this.awareness.destroy();
  }
}

export interface Seen { author: string | null; kind: string | null; at: number; inserted: string }

export class Participant {
  readonly ydoc = new Y.Doc();
  readonly provider: RoomSocket;
  readonly me: Author;
  /** Remote changes to the document's text this participant has seen, with who made them. */
  readonly seen: Seen[] = [];
  /** Set when the room refused this replica (a stale epoch). */
  refused = false;
  private local = { participant: true };
  private sockets: WebSocket[] = [];

  private constructor(readonly doc: Doc, name: string, opts: { epoch?: string; ydoc?: Y.Doc }) {
    if (opts.ydoc) Y.applyUpdate(this.ydoc, Y.encodeStateAsUpdate(opts.ydoc));
    const id = name.toLowerCase();
    this.me = { user: id, name, color: colorFor(id), kind: "person" };
    const headers = doc.headersFor(name), sockets = this.sockets;
    // A WebSocket that carries the target's auth headers (Bun's WebSocket takes them).
    class AuthedSocket extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, Object.keys(headers).length ? ({ headers, protocols } as unknown as string[]) : protocols);
        sockets.push(this);
      }
    }
    this.provider = new RoomSocket(doc.roomUrl, doc.roomName, this.ydoc, {
      params: { user: name, ...(opts.epoch ? { epoch: opts.epoch } : {}) },
      WebSocket: AuthedSocket,
      maxBackoffMs: 500,
    });
    this.provider.awareness.setLocalState({ user: this.me, cursor: null });
    this.provider.on("connection-close", (e) => {
      if (e?.code == 4409) {
        this.refused = true;
        this.provider.shouldConnect = false;
      }
    });
  }

  /** Joins and waits for the first sync; then takes the room's epoch, as a tab does. */
  static async join(doc: Doc, name: string, opts: { epoch?: string; ydoc?: Y.Doc; timeoutMs?: number } = {}): Promise<Participant> {
    const p = new Participant(doc, name, opts);
    await until(() => p.provider.synced || p.refused, opts.timeoutMs ?? 10_000, `${name} syncing with the room`);
    if (p.refused) return p;
    introduce(p.ydoc, p.me);
    p.provider.params.epoch = p.epoch ?? "";
    p.text()?.observe((ev, tr) => {
      if (tr.origin === p.local) return;
      const a = authorOf(p.ydoc, tr);
      const inserted = ev.delta.map((op) => (typeof op.insert == "string" ? op.insert : "")).join("");
      p.seen.push({ author: a?.name ?? null, kind: a?.kind ?? null, at: performance.now(), inserted });
    });
    return p;
  }

  get epoch(): string | undefined { return roomInfo(this.ydoc).get("epoch"); }
  get connected(): boolean { return this.provider.wsconnected; }

  text(path = this.doc.path): Y.Text | undefined { return files(this.ydoc).get(path); }
  str(path = this.doc.path): string { return this.text(path)?.toString() ?? ""; }
  paths(): string[] { return [...files(this.ydoc).keys()].sort(); }

  /** One local edit transaction, attributed to this participant. */
  edit(f: (t: Y.Text) => void, path = this.doc.path): void {
    const t = this.text(path);
    if (!t) throw new Failure(`${this.me.name} has no ${path}`);
    this.ydoc.transact(() => {
      const before = Y.getState(this.ydoc.store, this.ydoc.clientID);
      f(t);
      // Deletions alone carry no client id: stamp them.
      if (Y.getState(this.ydoc.store, this.ydoc.clientID) == before) stamp(this.ydoc, this.me);
    }, this.local);
  }
  insert(pos: number, s: string, path?: string) { this.edit((t) => t.insert(pos, s), path); }
  delete(pos: number, len: number, path?: string) { this.edit((t) => t.delete(pos, len), path); }
  /** Inserts after the first occurrence of `anchor` (a readable way to aim). */
  insertAfter(anchor: string, s: string, path?: string) {
    const i = this.str(path).indexOf(anchor);
    if (i < 0) throw new Failure(`${this.me.name}: "${anchor}" isn't in ${path ?? this.doc.path}`);
    this.insert(i + anchor.length, s, path);
  }
  createFile(path: string, text: string) {
    this.ydoc.transact(() => { const t = new Y.Text(); t.insert(0, text); files(this.ydoc).set(path, t); }, this.local);
  }

  /** Publishes a caret at a position in the document. */
  setCursor(index: number, head: number | null = null) {
    const t = this.text()!;
    const rel = (i: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(t, i));
    this.provider.awareness.setLocalStateField("cursor", { path: this.doc.path, anchor: rel(index), head: head == null ? null : rel(head) });
  }
  /** Everyone else's awareness state. */
  others(): { client: number; user: Author; cursor?: { path: string; anchor: unknown; head: unknown } | null; busy?: boolean; activity?: string | null }[] {
    return [...this.provider.awareness.getStates()].filter(([c, s]) => c != this.ydoc.clientID && s.user).map(([client, s]) => ({ client, ...s })) as never;
  }
  /** Resolves another participant's caret to an index in this replica's text. */
  resolve(rel: unknown): number | null {
    const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel), this.ydoc);
    return pos && pos.type === this.text() ? pos.index : null;
  }

  /** Drops off the network politely (says goodbye on awareness). */
  disconnect() { this.provider.disconnect(); }
  /** Drops off abruptly: the socket just closes, no goodbye. */
  sever() {
    this.provider.shouldConnect = false;
    for (const s of this.sockets) { try { s.close(); } catch { /* already closed */ } }
  }
  async reconnect(timeoutMs = 10_000) {
    this.provider.connect();
    await until(() => this.provider.synced || this.refused, timeoutMs, `${this.me.name} re-syncing`);
  }
  destroy() { this.provider.destroy(); this.ydoc.destroy(); }
}

/** Waits until every participant holds the same text for every file, and returns it. */
export async function converged(ps: Participant[], ms: number, what = "participants converging"): Promise<Record<string, string>> {
  const snap = (p: Participant) => Object.fromEntries(p.paths().map((k) => [k, p.str(k)]));
  await until(() => {
    const a = JSON.stringify(snap(ps[0]));
    return ps.every((p) => JSON.stringify(snap(p)) == a);
  }, ms, what, () => ps.map((p) => ({ who: p.me.name, connected: p.connected, len: p.str().length, head: p.str().slice(0, 120) })));
  return snap(ps[0]);
}

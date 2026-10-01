// A headless participant: a Yjs replica joined to a document's room over a
// real WebSocket, with the same y-websocket client the shell uses and the
// same conventions (introduce, stamp, epoch, relative-position cursors), but
// no browser. Many of them make a crowd; they can drop off the network,
// edit offline and come back.

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { authorOf, colorFor, files, introduce, roomInfo, stamp, type Author } from "../../src/room/doc";
import type { Doc } from "./target";
import { Failure, until } from "./harness";

export interface Seen { author: string | null; kind: string | null; at: number; inserted: string }

export class Participant {
  readonly ydoc = new Y.Doc();
  readonly provider: WebsocketProvider;
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
    this.provider = new WebsocketProvider(doc.roomUrl, doc.roomName, this.ydoc, {
      params: { user: name, ...(opts.epoch ? { epoch: opts.epoch } : {}) },
      WebSocketPolyfill: AuthedSocket as unknown as typeof WebSocket,
      disableBc: true,
      maxBackoffTime: 500,
    });
    this.provider.awareness.setLocalState({ user: this.me, cursor: null });
    this.provider.on("connection-close", (e: CloseEvent | null) => { if (e?.code == 4409) { this.refused = true; this.provider.shouldConnect = false; } });
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
      // Deletions alone carry no client id: stamp them (src/room/doc.ts).
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

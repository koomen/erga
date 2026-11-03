// The messages a Yjs room and its peers send (document/room.ts, libs/text/ui/collab.ts, agents/document/session.ts):
// the binary encoding, the sync steps and the awareness (who is here, and their carets). The wire format is the one
// of y-protocols and lib0, byte for byte, so a peer that uses them still talks to the room.

import * as Y from "yjs";

/** Bytes written one after the other: unsigned numbers as varints (7 bits a byte), bytes and strings after their length. */
export class Encoder {
  private buf = new Uint8Array(64);
  length = 0;

  private room(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const bigger = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    bigger.set(this.buf.subarray(0, this.length));
    this.buf = bigger;
  }
  writeUint(n: number): void {
    this.room(8);
    while (n > 127) {
      this.buf[this.length++] = 128 | (n & 127);
      n = Math.floor(n / 128);
    }
    this.buf[this.length++] = n;
  }
  writeBytes(bytes: Uint8Array): void {
    this.writeUint(bytes.length);
    this.room(bytes.length);
    this.buf.set(bytes, this.length);
    this.length += bytes.length;
  }
  writeString(s: string): void {
    this.writeBytes(new TextEncoder().encode(s));
  }
  toBytes(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.length);
  }
}

/** Reads what an Encoder wrote. Reading past the end throws. */
export class Decoder {
  private pos = 0;
  constructor(private readonly arr: Uint8Array) {}

  readUint(): number {
    let n = 0,
      mult = 1;
    for (;;) {
      if (this.pos >= this.arr.length) throw new Error("Unexpected end of array");
      const b = this.arr[this.pos++];
      n += (b & 127) * mult;
      if (b < 128) return n;
      mult *= 128;
      if (mult > Number.MAX_SAFE_INTEGER) throw new Error("Integer out of range");
    }
  }
  peekUint(): number {
    const at = this.pos;
    try {
      return this.readUint();
    } finally {
      this.pos = at;
    }
  }
  readBytes(): Uint8Array {
    const n = this.readUint();
    if (this.pos + n > this.arr.length) throw new Error("Unexpected end of array");
    return this.arr.subarray(this.pos, (this.pos += n));
  }
  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }
}

// Sync: a peer sends its state vector (step 1); the other answers with what it lacks (step 2); then updates.
export const SYNC_STEP1 = 0,
  SYNC_STEP2 = 1,
  SYNC_UPDATE = 2;

export function writeSyncStep1(e: Encoder, doc: Y.Doc): void {
  e.writeUint(SYNC_STEP1);
  e.writeBytes(Y.encodeStateVector(doc));
}

export function writeUpdate(e: Encoder, update: Uint8Array): void {
  e.writeUint(SYNC_UPDATE);
  e.writeBytes(update);
}

/** Reads a sync message into `doc`; a step 1 writes its answer to `reply`. Returns the message's kind. */
export function readSyncMessage(d: Decoder, reply: Encoder, doc: Y.Doc, origin: unknown): number {
  const kind = d.readUint();
  if (kind == SYNC_STEP1) {
    reply.writeUint(SYNC_STEP2);
    reply.writeBytes(Y.encodeStateAsUpdate(doc, d.readBytes()));
  } else if (kind == SYNC_STEP2 || kind == SYNC_UPDATE) {
    const update = d.readBytes();
    try {
      Y.applyUpdate(doc, update, origin);
    } catch (error) {
      console.error("Caught error while handling a Yjs update", error);
    }
  } else throw new Error("Unknown message type");
  return kind;
}

// Awareness: each client's state (JSON, null when it left) with a clock that only goes up.

/** A state not renewed in this time is dropped; a client renews its own at half of it. */
export const OUTDATED_MS = 30_000;

export interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}
type Listener = (change: AwarenessChange, origin: unknown) => void;
type State = Record<string, any>;

/** Whether two JSON values are the same. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a != "object" || typeof b != "object" || !a || !b || Array.isArray(a) != Array.isArray(b)) return false;
  const ka = Object.keys(a),
    kb = Object.keys(b);
  return ka.length == kb.length && ka.every((k) => k in b && same((a as State)[k], (b as State)[k]));
}

export class Awareness {
  readonly clientID: number;
  readonly states = new Map<number, State>();
  readonly meta = new Map<number, { clock: number; lastUpdated: number }>();
  /** "change": a state that is new, different or gone. "update": also a state set again, the same. */
  private listeners = { change: new Set<Listener>(), update: new Set<Listener>() };
  private timer: ReturnType<typeof setInterval>;

  constructor(readonly doc: Y.Doc) {
    this.clientID = doc.clientID;
    this.timer = setInterval(() => {
      const now = Date.now();
      const mine = this.meta.get(this.clientID);
      if (this.getLocalState() !== null && mine && OUTDATED_MS / 2 <= now - mine.lastUpdated) this.setLocalState(this.getLocalState());
      const old = [...this.meta].filter(([c, m]) => c != this.clientID && OUTDATED_MS <= now - m.lastUpdated && this.states.has(c));
      if (old.length)
        removeAwarenessStates(
          this,
          old.map(([c]) => c),
          "timeout"
        );
    }, OUTDATED_MS / 10);
    doc.on("destroy", () => this.destroy());
    this.setLocalState({});
  }

  on(event: "change" | "update", f: Listener): void {
    this.listeners[event].add(f);
  }
  off(event: "change" | "update", f: Listener): void {
    this.listeners[event].delete(f);
  }
  emit(event: "change" | "update", change: AwarenessChange, origin: unknown): void {
    for (const f of [...this.listeners[event]]) f(change, origin);
  }

  destroy(): void {
    this.setLocalState(null);
    this.listeners.change.clear();
    this.listeners.update.clear();
    clearInterval(this.timer);
  }

  getLocalState(): State | null {
    return this.states.get(this.clientID) ?? null;
  }
  setLocalState(state: State | null): void {
    const id = this.clientID,
      prev = this.states.get(id);
    const clock = (this.meta.get(id)?.clock ?? -1) + 1;
    if (state === null) this.states.delete(id);
    else this.states.set(id, state);
    this.meta.set(id, { clock, lastUpdated: Date.now() });
    const added = state !== null && prev == null ? [id] : [];
    const updated = state !== null && prev != null ? [id] : [];
    const removed = state === null ? [id] : [];
    const changed = updated.filter(() => !same(prev, state));
    if (added.length || changed.length || removed.length) this.emit("change", { added, updated: changed, removed }, "local");
    this.emit("update", { added, updated, removed }, "local");
  }
  setLocalStateField(field: string, value: unknown): void {
    const state = this.getLocalState();
    if (state !== null) this.setLocalState({ ...state, [field]: value });
  }
  getStates(): Map<number, State> {
    return this.states;
  }
}

/** Marks these clients gone (they left, or their socket closed). */
export function removeAwarenessStates(awareness: Awareness, clients: number[], origin: unknown): void {
  const removed = clients.filter((c) => awareness.states.delete(c));
  const mine = awareness.meta.get(awareness.clientID);
  if (mine && removed.includes(awareness.clientID))
    awareness.meta.set(awareness.clientID, { clock: mine.clock + 1, lastUpdated: Date.now() });
  if (!removed.length) return;
  awareness.emit("change", { added: [], updated: [], removed }, origin);
  awareness.emit("update", { added: [], updated: [], removed }, origin);
}

/** These clients' states (null for one that left), with their clocks. */
export function encodeAwarenessUpdate(awareness: Awareness, clients: number[]): Uint8Array {
  const e = new Encoder();
  e.writeUint(clients.length);
  for (const c of clients) {
    e.writeUint(c);
    e.writeUint(awareness.meta.get(c)!.clock);
    e.writeString(JSON.stringify(awareness.states.get(c) ?? null));
  }
  return e.toBytes();
}

/** Takes the states that are newer than the ones known. Someone else's word that this client left is answered with a newer clock. */
export function applyAwarenessUpdate(awareness: Awareness, update: Uint8Array, origin: unknown): void {
  const d = new Decoder(update);
  const now = Date.now();
  const added: number[] = [],
    updated: number[] = [],
    changed: number[] = [],
    removed: number[] = [];
  for (let n = d.readUint(); n > 0; n--) {
    const client = d.readUint();
    let clock = d.readUint();
    const state = JSON.parse(d.readString()) as State | null;
    const meta = awareness.meta.get(client),
      prev = awareness.states.get(client);
    const known = meta?.clock ?? 0;
    if (!(known < clock || (known == clock && state === null && awareness.states.has(client)))) continue;
    if (state === null) {
      if (client == awareness.clientID && awareness.getLocalState() != null) clock++;
      else awareness.states.delete(client);
    } else awareness.states.set(client, state);
    awareness.meta.set(client, { clock, lastUpdated: now });
    if (meta === undefined && state !== null) added.push(client);
    else if (meta !== undefined && state === null) removed.push(client);
    else if (state !== null) {
      if (!same(state, prev)) changed.push(client);
      updated.push(client);
    }
  }
  if (added.length || changed.length || removed.length) awareness.emit("change", { added, updated: changed, removed }, origin);
  if (added.length || updated.length || removed.length) awareness.emit("update", { added, updated, removed }, origin);
}

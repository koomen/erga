// The shell's side of the document room: a replica of the shared Yjs doc,
// synced with the host over the tab's one WebSocket (/api/room?events=1:
// y-protocols' sync and awareness messages as binary frames, the person's
// events as text frames of JSON: document/tabs.ts), and the binding between
// it and the editor's CodeMirror state.
//
// The tab starts before this script has loaded (server/pages/viewer.ts,
// ergaConnect, as the page parses): one request for the document's details
// (its hello) and the room's whole state, on the connection the page came
// on (GET /api/start: shared/room-socket.ts), and the socket at the same
// time, which needs a connection of its own. This takes both over (the
// socket with whatever came on it before then). So the editor starts one
// round trip after the page, and never waits for the socket: an edit made
// before it's open goes as soon as it is. Once the state is in and the
// socket open, the tab asks for what changed since (sync step 1), as a tab
// that reconnects does; that one also names the history it holds (its
// epoch), and a socket on another history than the start's is refused.
//
// Local edits are CodeMirror transactions; each becomes one Yjs transaction
// on the document's Y.Text. Edits from anyone else arrive as Y.Text events,
// are turned back into CodeMirror changes and applied through the same path
// agent edits always took (`PageEditor.applyExternal`), so the page patches
// in place and marks the change, now in its author's colour. Presence rides
// on awareness: who is here, where their caret is (as Yjs relative
// positions, so it stays put while the text around it changes), when each
// tab was last used, and whether an agent is busy.

import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as sync from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import type { ChangeSet } from "@codemirror/state";
import type { Hello } from "../../document/api";
import {
  applyChanges,
  assets,
  authorOf,
  deltaToChanges,
  files,
  hasSeen,
  introduce,
  roomInfo,
  stamp,
  stateVector,
  type Author,
} from "../../document/content";
import { changesBetween } from "../../document/merge";
import { BASE } from "./base";
import { decodeStart, PING, PONG } from "../../shared/room-socket";
import { base64, fromBase64 } from "../../shared/bytes";

/** Someone in the room, from awareness. */
export interface Presence {
  client: number;
  user: Author;
  busy?: boolean;
  activity?: string | null;
  cursor?: { path: string; anchor: unknown; head: unknown | null } | null;
  /**
   * When this tab was last focused or used (ms). A person with several tabs
   * open is shown by the one they used last, so only its caret is drawn.
   */
  active?: number;
}

/** A message on the socket that isn't the room's: the document's details (hello), or one of its person's events. */
export type SocketEvent = Hello | { type: string; [k: string]: unknown };

export interface CollabOptions {
  /** A text message from the host: its hello (the first, and each time the document opens for this tab again), or an event. */
  onEvent: (msg: SocketEvent) => void;
  /** Someone else changed the document. */
  onRemote: (changes: ChangeSet, author: Author | null) => void;
  /** Another file in the folder changed (a stylesheet, a script, an image). */
  onFiles: (paths: string[]) => void;
  /** Who's here, or what they're doing, changed. */
  onPresence: () => void;
  onStatus: (connected: boolean) => void;
  /**
   * The room refused this tab: it holds a history from before the host lost
   * its state, and merging would double the document. Reload.
   */
  onStale: () => void;
}

/** y-protocols' message types, as the room sends them (document/room.ts). */
const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_QUERY_AWARENESS = 3;
/** How often an idle socket is checked (a PING, document/tabs.ts), and how long its answer may take before it's given up for dead. */
const PING_EVERY = 15_000, PONG_WITHIN = 8_000;

/** The socket the page opened as it parsed (server/pages/viewer.ts, ergaConnect), with what came on it before this script did. */
type EarlySocket = WebSocket & { early?: (string | ArrayBuffer)[] };
declare global { interface Window { ergaSocket?: EarlySocket; ergaStart?: Promise<ArrayBuffer | null> } }

export class Collab {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private text: Y.Text | null = null;
  /** The origin of this tab's own transactions, which the observer skips. */
  private readonly local = { tab: true };
  private me: Author | null = null;
  private path = "";
  private ws: WebSocket | null = null;
  /** The socket is open; and the room and this tab have each other's state since it opened. */
  private open = false;
  private syncedNow = false;
  /** The history this tab holds (once it's synced), which it names on every reconnect. */
  private epoch = "";
  /** Refused (a stale history): no reconnecting. */
  private stopped = false;
  /** The start's answer is in (or failed: then the socket's sync brings the state), and the history it was of. */
  private haveState = false;
  private startEpoch: string | null = null;
  private tries = 0;
  private pinger = 0;
  private answered = true;
  private gotHello!: (h: Hello) => void;
  private noHello!: (e: Error) => void;
  private greeted = false;
  /** The host's first hello (the start's); refused if neither the start nor the socket gets one (no such document, or not theirs to open). */
  readonly hello = new Promise<Hello>((resolve, reject) => { this.gotHello = resolve; this.noHello = reject; });
  private gotSynced!: () => void;
  private synced = new Promise<void>((r) => (this.gotSynced = r));
  /** Set once the first sync is done; until then everything arriving is the initial state. */
  private live = false;

  constructor(private opts: CollabOptions, private params: Record<string, string>) {
    this.hello.catch(() => {});
    this.awareness.on("change", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      // This tab's own cursor moving is no news to it.
      if ([...added, ...updated, ...removed].some((c) => c != this.doc.clientID)) opts.onPresence();
    });
    // What changes here goes to the room: this tab's edits and its presence (not what came from the room).
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      sync.writeUpdate(e, update);
      this.send(encoding.toUint8Array(e));
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin !== this) this.sendAwareness([...added, ...updated, ...removed]);
    });
    addEventListener("pagehide", () => awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "window unload"));
    files(this.doc).observeDeep((events) => this.filesChanged(events));
    assets(this.doc).observe((e) => { if (this.live) opts.onFiles([...e.keysChanged]); });
    // The page's socket, if it opened one (and it's not closed); else one of its own.
    const early = window.ergaSocket, start = window.ergaStart;
    window.ergaSocket = window.ergaStart = undefined;
    this.connect(early);
    void this.start(start ?? fetch(`${BASE}/api/start${params.user ? `?user=${encodeURIComponent(params.user)}` : ""}`).then((r) => (r.ok ? r.arrayBuffer() : null), () => null));
  }

  /** The start's answer: the hello, and the room's state, which this tab holds from now on. */
  private async start(answer: Promise<ArrayBuffer | null>): Promise<void> {
    const bytes = await answer;
    let got: { hello: Hello; state: Uint8Array } | null = null;
    try { if (bytes) got = decodeStart<Hello>(new Uint8Array(bytes)); } catch (e) { console.warn("the editor's start didn't decode", e); }
    if (got) {
      Y.applyUpdate(this.doc, got.state, this);
      this.startEpoch = got.hello.epoch;
      this.greeted = true;
      this.gotHello(got.hello);
      this.gotSynced();
    }
    this.haveState = true;
    this.askForChanges();
  }

  /** What the room has that this tab doesn't (and, in the answer to the room's own step 1, the other way): once it has a state, on each socket. */
  private askForChanges(): void {
    if (!this.open || !this.haveState) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    sync.writeSyncStep1(e, this.doc);
    this.send(encoding.toUint8Array(e));
  }

  /** Whether the socket is open now. */
  get connected(): boolean { return this.open; }

  /** Who this tab is and which page it edits (once the hello has said): its presence goes to the room from now on. */
  join(me: Author, path: string): void {
    this.me = me;
    this.path = path;
    this.awareness.setLocalState({ user: me, cursor: null, active: document.hasFocus() ? Date.now() : 0 });
  }

  /** Resolves with the document's text once the first sync with the room is done (after `join`). */
  async ready(timeoutMs = 8000): Promise<string> {
    await Promise.race([this.synced, new Promise((_, reject) => setTimeout(() => reject(new Error("the room didn't answer")), timeoutMs))]);
    introduce(this.doc, this.me!);
    // From now on this tab holds the room's history: say which, on every reconnect.
    this.epoch = roomInfo(this.doc).get("epoch") ?? "";
    this.live = true;
    this.bind();
    if (!this.text) throw new Error(`${this.path} isn't in the room`);
    return this.text.toString();
  }

  // ------------------------------------------------------------ the socket

  private url(): string {
    const q = new URLSearchParams({ events: "1", ...this.params, ...(this.epoch ? { epoch: this.epoch } : {}) });
    return `${location.protocol == "https:" ? "wss:" : "ws:"}//${location.host}${BASE}/api/room?${q}`;
  }

  private connect(early?: EarlySocket): void {
    const adopted = !!early && early.readyState < WebSocket.CLOSING && !this.epoch;
    const ws: EarlySocket = adopted ? early! : new WebSocket(this.url());
    if (early && !adopted) early.close();
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (e) => { if (this.ws == ws) this.receive(e.data); };
    ws.onopen = () => { if (this.ws == ws) this.opened(); };
    ws.onclose = (e) => { if (this.ws == ws) this.closed(e.code); };
    ws.onerror = () => {};
    // What came before this script did, in order (nothing new can come in between: each message is a task of its own).
    for (const data of ws.early?.splice(0) ?? []) this.receive(data);
    if (ws.readyState == WebSocket.OPEN) this.opened();
  }

  private opened(): void {
    if (this.open) return;
    this.open = true;
    this.tries = 0;
    this.askForChanges();
    if (this.awareness.getLocalState()) this.sendAwareness([this.doc.clientID]);
    this.answered = true;
    clearInterval(this.pinger);
    this.pinger = window.setInterval(() => this.ping(), PING_EVERY);
    this.opts.onStatus(true);
  }

  /** The socket went (or was given up on): presence of everyone else goes with it, and a new one opens a little later. */
  private closed(code: number): void {
    this.ws = null;
    clearInterval(this.pinger);
    const was = this.open;
    this.open = false;
    this.syncedNow = false;
    awarenessProtocol.removeAwarenessStates(this.awareness, [...this.awareness.getStates().keys()].filter((c) => c != this.doc.clientID), this);
    if (was) this.opts.onStatus(false);
    if (code == 4409) { this.stopped = true; this.opts.onStale(); return; }
    if (this.stopped) return;
    if (!was && !this.greeted && this.tries >= 2) { this.stopped = true; this.noHello(new Error("the host refused the connection")); return; }
    setTimeout(() => this.connect(), Math.min(2500, 100 * 2 ** this.tries++));
  }

  /** An idle socket that no longer answers (a laptop woken from sleep, a network that changed) is closed, and opens again. */
  private ping(): void {
    const ws = this.ws;
    if (!ws || !this.open) return;
    if (!this.answered) {
      ws.onclose = ws.onmessage = ws.onopen = null;
      try { ws.close(); } catch { /* gone */ }
      this.closed(1006);
      return;
    }
    this.answered = false;
    this.send(PING);
    setTimeout(() => { if (this.ws == ws && !this.answered) this.ping(); }, PONG_WITHIN);
  }

  private send(m: Uint8Array | string): void {
    if (this.ws?.readyState == WebSocket.OPEN) this.ws.send(m as string | Uint8Array<ArrayBuffer>);
  }

  private sendAwareness(clients: number[]): void {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_AWARENESS);
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    this.send(encoding.toUint8Array(e));
  }

  private receive(data: string | ArrayBuffer): void {
    this.answered = true;
    if (typeof data == "string") {
      if (data == PONG) return;
      let msg: SocketEvent;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg?.type == "hello") {
        // A socket on another history than the one this tab started from (the room lost its own in between): never merged.
        const epoch = (msg as Hello).epoch;
        if (this.startEpoch && epoch && epoch != this.startEpoch) { this.stopped = true; this.ws?.close(); this.opts.onStale(); return; }
        this.greeted = true;
        this.gotHello(msg as Hello);
      }
      this.opts.onEvent(msg);
      return;
    }
    const decoder = decoding.createDecoder(new Uint8Array(data));
    switch (decoding.readVarUint(decoder)) {
      case MSG_SYNC: {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MSG_SYNC);
        const kind = sync.readSyncMessage(decoder, reply, this.doc, this);
        if (encoding.length(reply) > 1) this.send(encoding.toUint8Array(reply));
        if (kind == sync.messageYjsSyncStep2 && !this.syncedNow) { this.syncedNow = true; this.gotSynced(); }
        return;
      }
      case MSG_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        return;
      case MSG_QUERY_AWARENESS:
        this.sendAwareness([this.doc.clientID]);
        return;
    }
  }

  /**
   * Another of the document's pages, from now on (the editor went to it without a reload): its text, or null if the
   * room has no such page (then nothing changes). This tab's caret leaves the page it was on.
   */
  setPath(path: string): string | null {
    if (!files(this.doc).get(path)) return null;
    this.setCursor(null, null);
    this.path = path;
    this.bind();
    return this.text!.toString();
  }

  private bind(): void {
    const t = files(this.doc).get(this.path) ?? null;
    if (t == this.text) return;
    this.text?.unobserve(this.observer);
    this.text = t;
    t?.observe(this.observer);
  }

  private observer = (event: Y.YTextEvent, tr: Y.Transaction) => {
    if (tr.origin === this.local) return;
    let inserted = 0, deleted = 0;
    for (const op of event.delta) {
      if (typeof op.insert == "string") inserted += op.insert.length;
      else if (op.delete != null) deleted += op.delete;
    }
    const before = this.text!.length - inserted + deleted;
    this.opts.onRemote(deltaToChanges(event.delta, before), authorOf(this.doc, tr));
  };

  private filesChanged(events: Y.YEvent<any>[]): void {
    if (!this.live) return;
    const others = new Set<string>();
    for (const e of events) {
      if (e.target === files(this.doc)) {
        for (const k of (e as Y.YMapEvent<Y.Text>).keysChanged) {
          if (k != this.path) { others.add(k); continue; }
          // The document itself was replaced (deleted and recreated on disk).
          const old = this.text?.toString() ?? "";
          this.bind();
          if (this.text) this.opts.onRemote(changesBetween(old, this.text.toString()), authorOf(this.doc, e.transaction));
        }
      } else if (e.target instanceof Y.Text && e.target !== this.text) {
        const item = e.target._item;
        if (item?.parentSub) others.add(item.parentSub);
      }
    }
    if (others.size) this.opts.onFiles([...others]);
  }

  /** A local edit: one Yjs transaction, attributed to this tab's person. */
  push(changes: ChangeSet): void {
    const t = this.text;
    if (!t || changes.empty) return;
    // Typing without keys (dictation, a paste from the menu) is using the tab too.
    this.activate();
    this.doc.transact(() => {
      const { inserted, deleted } = applyChanges(t, changes);
      if (deleted && !inserted) stamp(this.doc, this.me!);
    }, this.local);
  }

  /** The room's current text of the document (to check the editor agrees). */
  current(): string { return this.text?.toString() ?? ""; }

  /** The length of the room's current text (a check that costs nothing, before the whole text is compared). */
  currentLength(): number { return this.text?.length ?? 0; }

  /** Publishes where this tab's caret is (null when it isn't in the document). */
  setCursor(anchor: number | null, head: number | null): void {
    const t = this.text, aw = this.awareness;
    const prev = aw.getLocalState() ?? {};
    if (!t || anchor == null) { if (prev.cursor) aw.setLocalStateField("cursor", null); return; }
    const rel = (i: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(t, i));
    const cursor = { path: this.path, anchor: rel(anchor), head: head == null || head == anchor ? null : rel(head) };
    // A caret is a place in the text (relative to the character after it), so typing doesn't move it: nothing to
    // send then. (Awareness sends every set, the same or not.)
    if (prev.cursor && JSON.stringify(prev.cursor) == JSON.stringify(cursor)) return;
    aw.setLocalStateField("cursor", cursor);
  }

  /**
   * This tab was focused or used: make it the one its person is shown by.
   * Newer than any of their other tabs even if the clocks disagree, and
   * nothing is sent while it already is.
   */
  activate(): void {
    const aw = this.awareness;
    if (!this.me) return;
    const mine = (aw.getLocalState()?.active as number | undefined) ?? 0;
    let newest = -1;
    for (const p of this.others()) if (p.user.kind == "person" && p.user.user == this.me?.user) newest = Math.max(newest, p.active ?? 0);
    if (mine > newest) return;
    aw.setLocalStateField("active", Math.max(Date.now(), newest + 1));
  }

  /**
   * Everyone else as they're shown: one presence per person, from the tab
   * they used last, and none for your own other tabs. Agents are their own
   * participants, each shown as it is.
   */
  shown(): Presence[] {
    const out: Presence[] = [], persons = new Map<string, Presence>();
    for (const p of this.others()) {
      if (p.user.kind != "person") { out.push(p); continue; }
      if (p.user.user == this.me?.user) continue;
      const prev = persons.get(p.user.user);
      const newer = !prev || (p.active ?? 0) > (prev.active ?? 0) || ((p.active ?? 0) == (prev.active ?? 0) && p.client > prev.client);
      if (newer) persons.set(p.user.user, p);
    }
    return [...persons.values(), ...out];
  }

  /** Everyone else in the room. */
  others(): Presence[] {
    const out: Presence[] = [];
    for (const [client, s] of this.awareness.getStates()) {
      if (client != this.doc.clientID && s.user) out.push({ client, ...(s as Omit<Presence, "client">) });
    }
    return out;
  }

  /** A presence's caret and selection as positions in the document, if it's in it. */
  positions(p: Presence): { anchor: number; head: number | null } | null {
    const c = p.cursor;
    if (!c || c.path != this.path || !this.text) return null;
    const abs = (j: unknown) => {
      const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(j), this.doc);
      return pos && pos.type === this.text ? pos.index : null;
    };
    const anchor = abs(c.anchor);
    if (anchor == null) return null;
    return { anchor, head: c.head ? abs(c.head) : null };
  }

  /**
   * Whether this tab's edits are on their way to the room: connected, synced, and nothing left in the socket's buffer
   * (live.ts waits for it before a reload for a new release). False while offline: they're kept here until it's back.
   */
  async flushed(): Promise<boolean> {
    for (let i = 0; i < 60; i++) {
      const ws = this.ws;
      if (!this.open || !this.syncedNow || !ws) return false;
      if (ws.bufferedAmount == 0) { await new Promise((r) => setTimeout(r, 150)); return this.open; }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  /**
   * Everything this tab holds of the room, for the page that reloads in its place, with the room's epoch:
   * merged into the room after the reload, it brings back any edit that hadn't reached it (and changes nothing
   * otherwise). Null when it's too big to keep in the tab.
   */
  held(max = 1_500_000): { epoch: string; update: string } | null {
    const u = Y.encodeStateAsUpdate(this.doc);
    if (u.length * 4 / 3 > max) return null;
    return { epoch: String(roomInfo(this.doc).get("epoch") ?? ""), update: base64(u) };
  }

  /** Merges what the page before a reload held (held()), if it's of this same room's history. */
  merge(held: { epoch: string; update: string } | undefined): void {
    if (!held || typeof held.update != "string" || held.epoch != String(roomInfo(this.doc).get("epoch") ?? "")) return;
    try {
      Y.applyUpdate(this.doc, fromBase64(held.update), "held");
    } catch (e) {
      console.warn("couldn't merge the edits kept across the reload", e);
    }
  }

  /** This tab's state vector, so the host can wait until the room has its edits. */
  vector(): string { return stateVector(this.doc); }

  /** Waits until this tab has every edit some other participant had (a state vector), or gives up. */
  waitFor(vector: string, timeoutMs = 3000): Promise<boolean> {
    if (hasSeen(this.doc, vector)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = () => { if (hasSeen(this.doc, vector)) { this.doc.off("update", check); clearTimeout(timer); resolve(true); } };
      const timer = setTimeout(() => { this.doc.off("update", check); resolve(false); }, timeoutMs);
      this.doc.on("update", check);
    });
  }
}

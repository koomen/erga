// A replica of the document room's shared Yjs doc, synced with the host over one WebSocket (/api/room?events=1:
// Yjs's sync and awareness messages (shared/yjs-protocol.ts) as binary frames, the person's events as text frames of JSON:
// document/tabs.ts), and the binding between it and an editor's CodeMirror state. The page's editor (frame.ts) has
// one, on its socket from the pages origin with an edit key; the viewer (client/shell/main.ts) has one for the source
// view, the people in the document and the agent's events.
//
// The viewer starts before its script has loaded (server/pages/viewer.ts, ergaConnect, as the page parses): one
// request for the document's details (its hello) and the room's whole state, on the connection the page came on
// (GET /api/start: shared/room-socket.ts), and the socket at the same time. A Collab takes both over (`start`,
// `early`: the socket with whatever came on it before then). Without a start, the socket's own sync brings the state.
// Once the state is in and the socket open, the replica asks for what changed since (sync step 1), as one that
// reconnects does; that one also names the history it holds (its epoch), and a socket on another history than the
// start's is refused.
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
import {
  Encoder,
  Decoder,
  Awareness,
  writeSyncStep1,
  writeUpdate,
  readSyncMessage,
  SYNC_STEP1,
  SYNC_STEP2,
  applyAwarenessUpdate,
  removeAwarenessStates,
  encodeAwarenessUpdate,
} from "../../../shared/yjs-protocol.ts";
import type { ChangeSet } from "@codemirror/state";
import type { Hello } from "../../../document/api";
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
} from "../../../document/content";
import { changesBetween, rebase } from "../../../document/merge";
import { decodeStart, PING, PONG } from "../../../shared/room-socket";
import { base64, fromBase64 } from "../../../shared/bytes";
import { sleep } from "../../../shared/time";
import { claimKept, keepReplica, readKept, type Keeper, type Kept } from "./kept";
import type { Peer } from "./types";

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
   * The room refused this tab: it holds a history from before the host lost its state, and merging it would double the
   * document. Load the page again: with `keep`, this tab's edits go in as edits of the files' text (adopt).
   */
  onStale: () => void;
  /** The socket's address, with its query (`q`: the replica's own, as its epoch). */
  url: (q: URLSearchParams) => string;
  /** The hello and the room's whole state, asked for already (GET /api/start), if they were. */
  start?: Promise<ArrayBuffer | null>;
  /** The socket the page opened as it parsed, if it did (it's taken over, with what came on it before). */
  early?: EarlySocket;
  /**
   * The name this replica is kept under in this browser (kept.ts): it opens from there when the room can't be reached,
   * and what it held that the room hadn't (a tab closed offline) goes to the room once it can.
   */
  keep?: string;
}

/** The message types, as the room sends them (document/room.ts). */
const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_QUERY_AWARENESS = 3;
/** How often an idle socket is checked (a PING, document/tabs.ts), and how long its answer may take before it's given up for dead. */
const PING_EVERY = 15_000, PONG_WITHIN = 8_000;

/** The socket the page opened as it parsed (server/pages/viewer.ts, ergaConnect), with what came on it before this script did. */
export type EarlySocket = WebSocket & { early?: (string | ArrayBuffer)[] };

export class Collab {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
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
  /** The replica this browser kept (read as this starts), whether it went in yet, and what stops keeping it. */
  private kept: Kept | null = null;
  private keptIn = false;
  private keeping: Keeper | null = null;
  /** The room's whole state came (the start's, or the socket's sync); the socket failed at least once before it did. */
  private stateIn = false;
  private failed = false;
  /**
   * With `keep`: the room's state as the room confirmed it (what it sent, and this tab's edits it has answered for), the
   * base of this tab's edits if the room loses its history (adopt). A sync step 1 this tab sends is answered in order,
   * after everything sent before it: each answer confirms what this tab had sent when it asked (`acks`, oldest first;
   * null: nothing of its own yet). `replied`: this tab has answered the room's step 1 on this socket, so it has sent all
   * it holds.
   */
  private readonly confirmed: Y.Doc | null;
  private acks: (Uint8Array | null)[] = [];
  private replied = false;
  private ackAgain = false;
  /** The host's last hello, kept with the replica. */
  private lastHello: Hello | null = null;

  constructor(private opts: CollabOptions) {
    this.confirmed = opts.keep ? new Y.Doc() : null;
    this.hello.catch(() => {});
    this.awareness.on("change", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      // This tab's own cursor moving is no news to it.
      if ([...added, ...updated, ...removed].some((c) => c != this.doc.clientID)) opts.onPresence();
    });
    // What changes here goes to the room: this tab's edits and its presence (not what came from the room).
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) {
        if (this.confirmed) Y.applyUpdate(this.confirmed, update);
        return;
      }
      queueMicrotask(() => this.askAck());
      const e = new Encoder();
      e.writeUint(MSG_SYNC);
      writeUpdate(e, update);
      this.send(e.toBytes());
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin !== this) this.sendAwareness([...added, ...updated, ...removed]);
    });
    addEventListener("pagehide", () => removeAwarenessStates(this.awareness, [this.doc.clientID], "window unload"));
    // The browser lost its network: the socket is dead, though it can't say so yet.
    addEventListener("offline", () => {
      if (this.open) this.drop();
    });
    files(this.doc).observeDeep((events) => this.filesChanged(events));
    assets(this.doc).observe((e) => { if (this.live) opts.onFiles([...e.keysChanged]); });
    // The page's socket, if it opened one (and it's not closed); else one of its own.
    this.connect(opts.early);
    void this.start(opts.start ?? Promise.resolve(null));
  }

  /** The start's answer: the hello, and the room's state, which this tab holds from now on. */
  private async start(answer: Promise<ArrayBuffer | null>): Promise<void> {
    const [bytes, kept] = await Promise.all([answer, this.opts.keep ? readKept(this.opts.keep) : null]);
    this.kept = kept;
    let got: { hello: Hello; state: Uint8Array } | null = null;
    try { if (bytes) got = decodeStart<Hello>(new Uint8Array(bytes)); } catch (e) { console.warn("the editor's start didn't decode", e); }
    if (got) {
      Y.applyUpdate(this.doc, got.state, this);
      this.stateIn = true;
      this.startEpoch = got.hello.epoch;
      await this.mergeKept(got.hello.epoch);
      this.greeted = true;
      this.lastHello = got.hello;
      this.gotHello(got.hello);
      this.gotSynced();
    }
    this.haveState = true;
    this.askForChanges();
    this.offlineStart();
  }

  /**
   * What this browser kept of the replica, into it, once the room's state is in: as it is, if it's of the same history
   * (`epoch`); else its files' text, as edits (adopt).
   */
  private async mergeKept(epoch: string | undefined): Promise<void> {
    const k = this.kept;
    if (this.keptIn || !k) return;
    this.keptIn = true;
    if (k.epoch == epoch) Y.applyUpdate(this.doc, k.update, "kept");
    else await this.adopt(k);
  }

  /**
   * A replica of a history the room lost (it started anew from its files: a new epoch), which can't merge into it: its
   * edits go in as edits of the files' text instead, made against the text the room last had (`base`), as the room
   * takes an edit made on disk (document/merge.ts, rebase). One tab takes it (claimKept), so they go in once.
   */
  private async adopt(k: Kept): Promise<void> {
    if (!k.base || !this.opts.keep || !(await claimKept(this.opts.keep, k.epoch))) return;
    const was = new Y.Doc();
    Y.applyUpdate(was, k.update);
    this.doc.transact(() => {
      for (const [path, text] of files(was)) {
        const base = k.base![path],
          ours = text.toString(),
          t = files(this.doc).get(path);
        if (base == null || ours == base || !t) continue;
        applyChanges(t, rebase(base, t.toString(), ours));
      }
    }, "kept");
    was.destroy();
  }

  /** Each file's text as the room confirmed it: what this browser keeps beside the replica (`base`). */
  private confirmedTexts(): Record<string, string> {
    return Object.fromEntries([...files(this.confirmed!)].map(([p, t]) => [p, t.toString()]));
  }

  /**
   * Asks the room to confirm what this tab has sent: a sync step 1, which it answers in order. One at a time (another
   * after it, if this tab changed meanwhile). Not while the room holds a lock, when it drops other tabs' edits.
   */
  private askAck(): void {
    if (!this.confirmed || !this.open || !this.replied) return;
    if (this.acks.some((a) => a)) {
      this.ackAgain = true;
      return;
    }
    this.ackAgain = false;
    const unconfirmed = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(this.confirmed));
    if (roomInfo(this.doc).get("lock")) return;
    this.askForChanges(unconfirmed);
  }

  /**
   * No room to sync with (the start brought nothing, and the socket failed before it synced): the replica opens from
   * what this browser kept, and syncs once the socket opens.
   */
  private offlineStart(): void {
    const k = this.kept;
    if (!k || this.stateIn || !this.haveState || !this.failed || this.open || this.stopped) return;
    this.stateIn = true;
    this.keptIn = true;
    Y.applyUpdate(this.doc, k.update, "kept");
    this.startEpoch = k.epoch;
    const hello = k.extra as Hello | undefined;
    if (hello?.epoch == k.epoch) {
      this.greeted = true;
      this.lastHello = hello;
      this.gotHello(hello);
    }
    this.gotSynced();
  }

  /** What the room has that this tab doesn't (and, in the answer to the room's own step 1, the other way): once it has a state, on each socket. */
  private askForChanges(unconfirmed: Uint8Array | null = null): void {
    if (!this.open || !this.haveState) return;
    this.acks.push(unconfirmed);
    const e = new Encoder();
    e.writeUint(MSG_SYNC);
    writeSyncStep1(e, this.doc);
    this.send(e.toBytes());
  }

  /** Whether the socket is open now. */
  get connected(): boolean { return this.open; }

  /** The page this replica edits ("" before it joins). */
  get pagePath(): string {
    return this.path;
  }

  /**
   * Who this replica is and which page it edits (once the hello has said). With `presence` (null: none yet), its
   * presence goes to the room from now on, with those fields too.
   */
  join(me: Author, path: string, presence: Record<string, unknown> | null = {}): void {
    this.me = me;
    this.path = path;
    if (presence) this.present(presence);
  }

  /** Its presence goes to the room from now on: who it is, its caret (none yet), and `extra`. */
  present(extra: Record<string, unknown> = {}): void {
    this.awareness.setLocalState({ user: this.me, cursor: null, active: document.hasFocus() ? Date.now() : 0, ...extra });
  }

  /** Resolves with the document's text once the first sync with the room is done (after `join`). */
  async ready(timeoutMs = 8000): Promise<string> {
    await Promise.race([this.synced, new Promise((_, reject) => setTimeout(() => reject(new Error("the room didn't answer")), timeoutMs))]);
    introduce(this.doc, this.me!);
    // From now on this tab holds the room's history: say which, on every reconnect.
    this.epoch = roomInfo(this.doc).get("epoch") ?? "";
    this.live = true;
    this.bind();
    if (this.opts.keep && this.epoch && !this.keeping) {
      this.keeping = keepReplica(this.opts.keep, this.doc, this.epoch, this.lastHello ?? undefined);
      if (this.confirmed && files(this.confirmed).size) this.keeping.base(this.confirmedTexts());
    }
    if (!this.text) throw new Error(`${this.path} isn't in the room`);
    return this.text.toString();
  }

  // ------------------------------------------------------------ the socket

  private url(): string {
    return this.opts.url(new URLSearchParams(this.epoch ? { epoch: this.epoch } : {}));
  }

  /** Leaves the room for good: the socket closes, and this replica's presence goes with it. */
  close(): void {
    this.stopped = true;
    void this.keeping?.stop();
    this.keeping = null;
    clearInterval(this.pinger);
    removeAwarenessStates(this.awareness, [this.doc.clientID], "left");
    const ws = this.ws;
    this.ws = null;
    this.open = false;
    try {
      ws?.close();
    } catch {
      /* gone */
    }
  }

  /** Takes its presence out of the room; the replica itself stays in it. */
  leave(): void {
    this.awareness.setLocalState(null);
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
    removeAwarenessStates(
      this.awareness,
      [...this.awareness.getStates().keys()].filter((c) => c != this.doc.clientID),
      this
    );
    if (was) this.opts.onStatus(false);
    this.acks = [];
    this.replied = this.ackAgain = false;
    if (code == 4409) {
      this.stale();
      return;
    }
    // Its person may no longer open it: the page opens again, and says so. (4408, a role changed: it joins again below, as they may now.)
    if (code == 4403) {
      this.stopped = true;
      location.reload();
      return;
    }
    if (this.stopped) return;
    if (!this.stateIn) {
      this.failed = true;
      this.offlineStart();
    }
    // (Never in: no such document, or not theirs to open. One that was in keeps trying.)
    if (!was && !this.greeted && !this.live && !this.stateIn && this.tries >= 2) {
      this.stopped = true;
      this.noHello(new Error("the host refused the connection"));
      return;
    }
    setTimeout(() => this.connect(), Math.min(2500, 100 * 2 ** this.tries++));
  }

  /** An idle socket that no longer answers (a laptop woken from sleep, a network that changed) is closed, and opens again. */
  private ping(): void {
    const ws = this.ws;
    if (!ws || !this.open) return;
    if (!this.answered) {
      this.drop();
      return;
    }
    this.answered = false;
    this.send(PING);
    setTimeout(() => { if (this.ws == ws && !this.answered) this.ping(); }, PONG_WITHIN);
  }

  /**
   * The room refused this replica's history (it lost its own). What this browser keeps of it stays, whole: the page that
   * loads in its place puts its edits in (adopt).
   */
  private stale(): void {
    this.stopped = true;
    const keeping = this.keeping;
    this.keeping = null;
    void (keeping?.stop() ?? Promise.resolve()).then(() => this.opts.onStale());
  }

  /**
   * The socket is given up for dead at once (its close can't finish without a network: it would stay open meanwhile),
   * and a new one opens a little later.
   */
  private drop(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onclose = ws.onmessage = ws.onopen = null;
    try { ws.close(); } catch { /* gone */ }
    this.closed(1006);
  }

  private send(m: Uint8Array | string): void {
    if (this.ws?.readyState == WebSocket.OPEN) this.ws.send(m as string | Uint8Array<ArrayBuffer>);
  }

  private sendAwareness(clients: number[]): void {
    const e = new Encoder();
    e.writeUint(MSG_AWARENESS);
    e.writeBytes(encodeAwarenessUpdate(this.awareness, clients));
    this.send(e.toBytes());
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
        if (this.startEpoch && epoch && epoch != this.startEpoch) {
          this.ws?.close();
          this.stale();
          return;
        }
        this.greeted = true;
        this.lastHello = msg as Hello;
        this.gotHello(msg as Hello);
      }
      this.opts.onEvent(msg);
      return;
    }
    const decoder = new Decoder(new Uint8Array(data));
    switch (decoder.readUint()) {
      case MSG_SYNC: {
        const reply = new Encoder();
        reply.writeUint(MSG_SYNC);
        const kind = readSyncMessage(decoder, reply, this.doc, this);
        if (reply.length > 1) this.send(reply.toBytes());
        // The room's step 1, answered: this tab has sent it all it holds. A step 2 answers this tab's oldest step 1.
        if (kind == SYNC_STEP1) {
          this.replied = true;
          this.askAck();
        } else if (kind == SYNC_STEP2) {
          const sent = this.acks.shift();
          if (sent && this.confirmed) {
            Y.applyUpdate(this.confirmed, sent);
            this.keeping?.base(this.confirmedTexts());
          }
          if (this.ackAgain) this.askAck();
        }
        if (kind == SYNC_STEP2 && !this.syncedNow) {
          this.syncedNow = true;
          this.stateIn = true;
          void this.mergeKept(roomInfo(this.doc).get("epoch")).then(() => this.gotSynced());
        }
        return;
      }
      case MSG_AWARENESS:
        applyAwarenessUpdate(this.awareness, decoder.readBytes(), this);
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

  /**
   * Everyone else's caret here (as `shown`), with their name, to draw. An agent's shows while it works, so its edits
   * read like a person's typing; once it's idle, a caret left where it last edited would only linger and distract.
   */
  peers(): Peer[] {
    const peers: Peer[] = [];
    for (const p of this.shown()) {
      const agent = p.user.kind == "agent";
      if (agent && !p.busy) continue;
      const at = this.positions(p);
      if (at)
        peers.push({
          key: p.client,
          name: p.user.name,
          color: p.user.color,
          anchor: at.anchor,
          head: at.head,
          agent,
          activity: agent ? (p.activity ?? null) : null,
        });
    }
    return peers;
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
      if (ws.bufferedAmount == 0) {
        await sleep(150);
        return this.open;
      }
      await sleep(50);
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

// The editor shell's lightweight JSON-only room client (?events=1&shell=1): hears the document's hello, the user's
// events (renames, tree changes, uploads, live page asks, undo counts) and JSON presence snapshots. Holds no Yjs doc,
// no CodeMirror state, and writes nothing to IndexedDB. For offline reloads, it caches the small JSON hello in
// localStorage (cleared on sign-out in client/common/offline.ts).
//
// Trap: workerd's hibernatable WebSockets (ctx.acceptWebSocket) can drop server-initiated close frames (4403/4404/4408)
// on a socket that has never sent a client frame. Sending PING when the socket opens primes it (answered by
// setWebSocketAutoResponse without waking the Durable Object).

import type { Hello } from "../../document/api/api";
import type { Author } from "../../shared/author";
import { PING, PONG } from "../../shared/room-socket";
import { SIGNED_OUT, socketStep, type PhaseEffect, type PhaseEvent, type SocketPhase } from "../../shared/socket-phase";
import { keepWrite } from "../common/offline";

/** What the page shows of the socket. */
export type RoomStatus = "up" | "down" | "gone";

/** A message on the socket: the document's details (hello), or one of its events. */
export type SocketEvent = Hello | { type: string; [k: string]: unknown };

/** The socket the page opened as it parsed (client/inline/viewer-editing-head.ts), with any early messages buffered. */
export type EarlySocket = WebSocket & { early?: (string | ArrayBuffer)[] };

/** One participant in the room's JSON presence list (document/room/participants.ts). */
export interface ShellPresence {
  client: number;
  user: Author;
  busy?: boolean;
  activity?: string | null;
  cursorPath?: string | null;
  activeAt?: number;
  tab?: string;
}

export interface ShellRoomOptions {
  /** The socket's address. */
  url: () => string;
  /** The socket the page opened as it parsed, if any. */
  early?: EarlySocket;
  /** Cache key for offline hello persistence in localStorage (`erga:hello:${keep}`). */
  keep?: string;
  /** A text event from the host (hello, tree, name, uploads, live, open, undoable, access, versions, publishing). */
  onEvent: (msg: SocketEvent) => void;
  /** The JSON presence list changed. */
  onPresence: () => void;
  /** The socket is up, down (it comes back by itself), or gone (4404: the document was deleted). */
  onStatus: (status: RoomStatus) => void;
  /** Optional socket factory for unit tests. */
  createSocket?: (url: string) => WebSocket;
  /** Optional reload handler on 4403 (defaults to location.reload()). */
  onReload?: () => void;
}

/** 4404: deleted. 4403: unshared (reload). 4408: role changed (reconnects). Never connected: refused on 3rd failure. */
const roomStep = socketStep({ final: { 4404: "gone", 4403: "reload" }, refuseAfter: 2 });
const waitFor = (tries: number) => Math.min(2500, 100 * 2 ** tries) * (0.75 + Math.random() * 0.5);
const statusOf = (p: SocketPhase): RoomStatus => (p.at == "open" ? "up" : p.at == "ended" && p.why == "gone" ? "gone" : "down");

/** How often an idle socket sends PING, and how long PONG may take before the socket is dropped. */
const PING_EVERY = 30_000,
  PONG_WITHIN = 8_000;

export class ShellRoom {
  private ws: WebSocket | null = null;
  private phase: SocketPhase = { at: "connecting", tries: 0 };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pinger: ReturnType<typeof setInterval> | undefined;
  private ponger: ReturnType<typeof setTimeout> | undefined;
  private answered = true;
  private out = false;
  private greeted = false;
  private canPersist = false;
  private lastHello: Hello | null = null;
  private cached: Hello | null = null;
  private titleSeq = 0;
  private titleWaits = new Map<number, (ok: boolean) => void>();
  private readonly listening = new AbortController();
  private gotHello!: (h: Hello) => void;
  private noHello!: (e: Error) => void;
  readonly hello = new Promise<Hello>((resolve, reject) => {
    this.gotHello = resolve;
    this.noHello = reject;
  });
  /** Everyone currently present in the room, as last broadcast by the host. */
  presence: ShellPresence[] = [];

  constructor(private opts: ShellRoomOptions) {
    this.hello.catch(() => {});
    if (opts.keep) {
      try {
        const raw = localStorage.getItem(`erga:hello:${opts.keep}`);
        if (raw) {
          const parsed = JSON.parse(raw) as Hello | null;
          if (parsed?.type == "hello" && parsed.info && parsed.tree) this.cached = parsed;
        }
      } catch {
        /* no storage */
      }
    }
    if (typeof addEventListener == "function") {
      addEventListener(
        "offline",
        () => {
          if (this.connected) this.drop();
        },
        { signal: this.listening.signal }
      );
    }
    this.connect(opts.early);
  }

  /** Whether the socket is open now. */
  get connected(): boolean {
    return statusOf(this.phase) == "up";
  }

  /** What the page shows of the socket: up, down, or gone. */
  get status(): RoomStatus {
    return statusOf(this.phase);
  }

  /** Enables and flushes localStorage caching of the last live hello (call after keepOffline unmarks sign-out). */
  persist(): void {
    this.canPersist = true;
    if (!this.opts.keep || !this.lastHello || this.out) return;
    const key = `erga:hello:${this.opts.keep}`;
    const json = JSON.stringify(this.lastHello);
    void keepWrite(
      async () => {
        try {
          localStorage.setItem(key, json);
        } catch {
          /* no storage */
        }
      },
      async () => {
        try {
          localStorage.removeItem(key);
        } catch {
          /* no storage */
        }
      }
    );
  }

  /** This browser is signed out: an open socket stays, and no new try is made (shared/socket-phase.ts). */
  signedOut(): void {
    this.out = true;
    this.go({ type: "out" });
  }

  /** Closes the socket for good and stops listeners. */
  close(): void {
    this.listening.abort();
    this.failTitleWaits();
    this.go({ type: "stop" });
  }

  /** Sends a title rename over the shell socket (handled by document/room/participants.ts). */
  sendTitle(title: string): Promise<boolean> {
    const ws = this.ws;
    if (!ws || !this.connected || ws.readyState != 1) return Promise.resolve(false);
    const id = ++this.titleSeq;
    return new Promise((resolve) => {
      this.titleWaits.set(id, resolve);
      try {
        ws.send(JSON.stringify({ type: "title", id, title }));
      } catch {
        this.titleWaits.delete(id);
        resolve(false);
      }
    });
  }

  private failTitleWaits(): void {
    for (const done of this.titleWaits.values()) done(false);
    this.titleWaits.clear();
  }

  /**
   * Everyone present in the room (with no argument), or everyone except `meUser`'s own person tabs (agents stay).
   * Matches Collab.others() semantics for shell inspection and tests.
   */
  others(meUser?: string): ShellPresence[] {
    return meUser ? this.presence.filter((p) => p.user.kind != "person" || p.user.user != meUser) : [...this.presence];
  }

  /**
   * Everyone else as they're shown: one presence per other person from their most recently active tab, and none for
   * your own person tabs. Agents are their own participants, each shown as it is.
   */
  shown(meUser: string): ShellPresence[] {
    const agents: ShellPresence[] = [];
    const persons = new Map<string, ShellPresence>();
    for (const p of this.presence) {
      if (p.user.kind != "person") {
        agents.push(p);
        continue;
      }
      if (p.user.user == meUser) continue;
      const prev = persons.get(p.user.user);
      const pa = p.activeAt ?? 0;
      const preva = prev?.activeAt ?? 0;
      if (!prev || pa > preva || (pa == preva && p.client > prev.client)) persons.set(p.user.user, p);
    }
    return [...persons.values(), ...agents];
  }

  /** Whether participant `p` currently has a caret in `path`. */
  hasCaret(p: ShellPresence, path: string): boolean {
    return p.cursorPath == path;
  }

  private greet(h: Hello): void {
    this.greeted = true;
    this.gotHello(h);
  }

  private go(e: PhaseEvent): void {
    const { phase, effects } = roomStep(this.phase, e);
    this.phase = phase;
    if (phase.at != "backoff") clearTimeout(this.timer);
    for (const f of effects) this.effect(f);
  }

  private effect(f: PhaseEffect): void {
    switch (f.do) {
      case "connect":
        return this.connect();
      case "up":
        this.answered = true;
        if (this.ws?.readyState == 1) this.ws.send(PING);
        clearInterval(this.pinger);
        clearTimeout(this.ponger);
        this.pinger = setInterval(() => this.ping(), PING_EVERY);
        return this.opts.onStatus("up");
      case "down":
        if (f.open) this.opts.onStatus("down");
        return;
      case "retry":
        if (!this.greeted && this.cached) this.greet(this.cached);
        this.timer = setTimeout(() => this.go({ type: "timer" }), waitFor(f.tries));
        return;
      case "shut": {
        const ws = this.ws;
        this.ws = null;
        clearInterval(this.pinger);
        clearTimeout(this.ponger);
        if (ws) ws.onclose = ws.onmessage = ws.onopen = null;
        try {
          ws?.close();
        } catch {
          /* gone */
        }
        return;
      }
      case "end":
        if (f.why == "gone") {
          this.noHello(new Error("the document was deleted"));
          return this.opts.onStatus("gone");
        }
        if (f.why == "refused") return this.noHello(new Error("the host refused the connection"));
        if (f.open) this.opts.onStatus("down");
        if (f.why == SIGNED_OUT) return;
        return this.opts.onReload ? this.opts.onReload() : location.reload();
    }
  }

  private connect(early?: EarlySocket): void {
    const adopted = !!early && early.readyState < 2;
    const ws: EarlySocket = adopted ? early! : (this.opts.createSocket ?? ((u) => new WebSocket(u)))(this.opts.url());
    if (early && !adopted) {
      try {
        early.close();
      } catch {
        /* gone */
      }
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      if (this.ws == ws) this.receive(e.data);
    };
    ws.onopen = () => {
      if (this.ws == ws) this.go({ type: "opened" });
    };
    ws.onclose = (e) => {
      if (this.ws == ws) this.closed(e.code);
    };
    ws.onerror = () => {};
    if (ws.readyState == 1) this.go({ type: "opened" });
    for (const data of ws.early?.splice(0) ?? []) this.receive(data);
  }

  private closed(code: number): void {
    this.ws = null;
    clearInterval(this.pinger);
    clearTimeout(this.ponger);
    this.failTitleWaits();
    if (this.presence.length) {
      this.presence = [];
      this.opts.onPresence();
    }
    this.go({ type: "closed", code, known: this.greeted || !!this.cached, out: this.out });
  }

  private ping(): void {
    const ws = this.ws;
    if (!ws || !this.connected) return;
    if (!this.answered) {
      this.drop();
      return;
    }
    this.answered = false;
    if (ws.readyState == 1) ws.send(PING);
    clearTimeout(this.ponger);
    this.ponger = setTimeout(() => {
      if (this.ws == ws && !this.answered) this.ping();
    }, PONG_WITHIN);
  }

  private drop(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onclose = ws.onmessage = ws.onopen = null;
    try {
      ws.close();
    } catch {
      /* gone */
    }
    this.closed(1006);
  }

  private receive(data: unknown): void {
    this.answered = true;
    if (typeof data != "string" || data == PONG) return;
    let msg: SocketEvent;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const list = (msg as { list?: unknown }).list;
    if (msg?.type == "presence" && Array.isArray(list)) {
      this.presence = list as ShellPresence[];
      this.opts.onPresence();
      return;
    }
    const ack = msg as { id?: unknown; ok?: unknown };
    if (msg?.type == "title-ack" && typeof ack.id == "number") {
      const done = this.titleWaits.get(ack.id);
      if (done) {
        this.titleWaits.delete(ack.id);
        done(ack.ok === true);
      }
      return;
    }
    if (msg?.type == "hello") {
      const h = msg as Hello;
      this.lastHello = h;
      this.greet(h);
      if (this.canPersist) this.persist();
      if (this.phase.at == "open" && !this.phase.ready) this.go({ type: "ready" });
    }
    this.opts.onEvent(msg);
  }
}

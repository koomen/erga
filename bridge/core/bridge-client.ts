// Outbound WebSocket client to Erga's /api/agent/bridge endpoint.
// Keeps one persistent connection per Erga server, auto-reconnects with
// backoff, sends hello/bind/events/log/turn_done, and dispatches incoming
// browser prompt/abort/reset/answer/model requests to the daemon.

import { parseToBridge, type FromBridge, type ToBridge } from "../../shared/bridge-protocol.ts";
import { PING, PONG } from "../../shared/room-socket.ts";

const PING_MS = 15_000;

export interface BridgeClientOptions {
  origin: string;
  id: string;
  agent: string;
  label: string;
  token: () => Promise<string>;
  onMessage: (msg: ToBridge) => void;
  onStatus?: (connected: boolean) => void;
  log?: (line: string) => void;
}

export class ErgaBridgeClient {
  private ws: WebSocket | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tries = 0;
  private hasConnected = false;
  private closed = false;
  private readonly connThreadId = crypto.randomUUID();
  /** Active document bindings replayed automatically on every reconnect (keeping the same threadId). */
  private bindings = new Map<string, { label?: string; sessionId?: string | null; cwd?: string | null; threadId: string }>();
  private openResolve: (() => void) | null = null;

  constructor(private readonly opts: BridgeClientOptions) {}

  get connected(): boolean {
    return this.ws?.readyState == WebSocket.OPEN;
  }

  /** Connects to /api/agent/bridge and sends hello + any existing doc bindings. */
  async start(): Promise<void> {
    if (this.connected) return;
    await this.connect();
  }

  /** Binds a document to this bridge (auto-switches that document's panel to this agent's own thread). */
  bind(doc: string, info: { label?: string; sessionId?: string | null; cwd?: string | null; threadId?: string | null } = {}): void {
    const prev = this.bindings.get(doc);
    const threadId = info.threadId || info.sessionId || (prev && !prev.sessionId ? prev.threadId : crypto.randomUUID());
    const entry = { ...info, threadId };
    this.bindings.set(doc, entry);
    this.send({ type: "bind", doc, ...entry });
  }

  /** Rotates the stored threadId for `doc` after a browser reset so reconnects never resurrect the old thread. */
  rotateThread(doc: string): void {
    const prev = this.bindings.get(doc);
    if (!prev) return;
    this.bindings.set(doc, { ...prev, sessionId: null, threadId: crypto.randomUUID() });
  }

  unbind(doc: string): void {
    this.bindings.delete(doc);
    this.send({ type: "unbind", doc });
  }

  send(msg: FromBridge): boolean {
    if (this.ws?.readyState != WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    if (this.timer) clearTimeout(this.timer);
    try {
      this.ws?.close(1000, "closed");
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const token = await this.opts.token();
    const wsUrl = `${this.opts.origin.replace(/^http/, "ws")}/api/agent/bridge`;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      this.openResolve = () => finish(resolve);

      const ws = new (WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket)(wsUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.tries = 0;
        const reconnect = this.hasConnected;
        this.hasConnected = true;
        this.send({
          type: "hello",
          id: this.opts.id,
          agent: this.opts.agent,
          label: this.opts.label,
          threadId: this.connThreadId,
          ...(reconnect ? { reconnect: true } : {}),
        });
        for (const [doc, info] of this.bindings) this.send({ type: "bind", doc, ...info, ...(reconnect ? { reconnect: true } : {}) });
        if (this.pinger) clearInterval(this.pinger);
        this.pinger = setInterval(() => {
          try {
            if (this.ws?.readyState == WebSocket.OPEN) this.ws.send(PING);
          } catch {
            /* closing */
          }
        }, PING_MS);
        this.opts.onStatus?.(true);
        this.openResolve?.();
      });

      ws.addEventListener("message", (ev) => {
        const raw = String(ev.data);
        if (raw == PING) {
          try {
            ws.send(PONG);
          } catch {
            /* ignore */
          }
          return;
        }
        if (raw == PONG) return;
        const msg = parseToBridge(raw);
        if (msg) this.opts.onMessage(msg);
      });

      ws.addEventListener("close", () => {
        if (this.ws === ws) this.ws = null;
        if (this.pinger) {
          clearInterval(this.pinger);
          this.pinger = null;
        }
        this.opts.onStatus?.(false);
        if (!this.closed) this.scheduleReconnect();
        finish(resolve);
      });

      ws.addEventListener("error", () => {
        if (!settled) finish(() => reject(new Error(`Could not connect to ${wsUrl}`)));
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    const wait = Math.min(5_000, 300 * 2 ** Math.min(this.tries++, 5));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect().catch((e) => {
        this.opts.log?.(`bridge reconnect failed: ${e instanceof Error ? e.message : e}`);
        this.scheduleReconnect();
      });
    }, wait);
  }
}

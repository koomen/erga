// Outbound WebSocket client to Erga's /api/agent/bridge endpoint.
// Keeps one persistent connection per Erga server, auto-reconnects with
// backoff, replays document bindings (single terminal or whole space), and
// dispatches incoming PTY attach/input/resize/send/interrupt/update messages.

import type { AttachScope, BackendKind, FromBridge, TerminalSummary, ToBridge } from "../../shared/bridge-protocol.ts";
import { parseToBridge } from "../../shared/bridge-schema.ts";
import { PING, PONG } from "../../shared/room-socket.ts";

const PING_MS = 15_000;

export interface BridgeBinding {
  label?: string;
  scope: AttachScope;
  spaceId?: string | null;
  spaceName?: string | null;
  terminals: readonly TerminalSummary[];
  activeTerminal?: string | null;
}

export interface BridgeClientOptions {
  origin: string;
  id: string;
  backend: BackendKind;
  label: string;
  version: string;
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
  /** Active document bindings replayed automatically on every reconnect. */
  private bindings = new Map<string, BridgeBinding>();

  constructor(private readonly opts: BridgeClientOptions) {}

  get connected(): boolean {
    return this.ws?.readyState == WebSocket.OPEN;
  }

  async start(): Promise<void> {
    if (this.connected) return;
    await this.connect();
  }

  /** Binds a document to a single terminal or whole space (auto-switches that document's panel). */
  bind(doc: string, info: BridgeBinding): void {
    this.bindings.set(doc, info);
    this.send({ type: "bind", doc, ...info });
  }

  /** Updates the live terminal roster / OSC 7501 statuses for a bound document. */
  updateTerminals(doc: string, terminals: readonly TerminalSummary[], spaceName?: string | null): void {
    const prev = this.bindings.get(doc);
    if (prev) {
      prev.terminals = terminals;
      if (spaceName !== undefined) prev.spaceName = spaceName;
    }
    this.send({ type: "terminals", doc, terminals, ...(spaceName !== undefined ? { spaceName } : {}) });
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
          backend: this.opts.backend,
          label: this.opts.label,
          version: this.opts.version,
          ...(reconnect ? { reconnect: true } : {}),
        });
        for (const [doc, info] of this.bindings) {
          this.send({ type: "bind", doc, ...info, ...(reconnect ? { reconnect: true } : {}) });
        }
        if (this.pinger) clearInterval(this.pinger);
        this.pinger = setInterval(() => {
          try {
            if (this.ws?.readyState == WebSocket.OPEN) this.ws.send(PING);
          } catch {
            /* closing */
          }
        }, PING_MS);
        this.opts.onStatus?.(true);
        finish(resolve);
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

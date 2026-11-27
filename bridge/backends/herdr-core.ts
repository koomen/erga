// Direct Unix-socket client for herdr-core (JSON-RPC 2.0 + binary framed mode).
// Multiplexes RPC calls (channel 0), live terminal + herdr-app doc subscriptions,
// and multiple simultaneous bidirectional PTY attach streams over one socket.

import { connect, type Socket } from "node:net";
import { basename } from "node:path";
import type { Osc7501Kind, Osc7501State, TerminalStatus, TerminalSummary } from "../../shared/bridge-protocol.ts";
import {
  herdrSocketPath,
  type BackendEvent,
  type PtyAttachment,
  type ResolvedTarget,
  type SpaceInfo,
  type TerminalBackend,
} from "../core/backend.ts";

const FRAME_DATA = 0;
const FRAME_CREDIT = 1;
const FRAME_CLOSE = 2;
const FRAME_RESIZE = 3;
const CREDIT_STEP = 32 * 1024;

const utf8Dec = new TextDecoder();
const utf8Enc = new TextEncoder();

interface RawStatus {
  state?: string;
  kind?: string | null;
  progress?: number | null;
  app?: string;
  title?: string;
  msg?: string;
}

interface RawTerminal {
  address: string;
  name?: string | null;
  argv?: string[];
  cwd?: string;
  state: "live" | "finished";
  status?: RawStatus | null;
  turn?: number;
  parent?: string | null;
  labels?: Record<string, string>;
  title?: string;
  created_ms?: number;
  foreground?: { name?: string; cwd?: string } | null;
}

interface RawHerdrSpace {
  id?: string;
  name?: string;
  folder?: string;
  tabs?: Array<{ id?: string; name?: string; root?: unknown }>;
}

const VALID_STATES = new Set<Osc7501State>(["idle", "working", "done", "blocked", "error"]);
const VALID_KINDS = new Set<Osc7501Kind>(["permission", "question", "auth"]);

function normalizeStatus(raw: RawStatus | null | undefined): TerminalStatus | null {
  if (!raw || typeof raw.state != "string" || !VALID_STATES.has(raw.state as Osc7501State)) return null;
  const kind = raw.kind && VALID_KINDS.has(raw.kind as Osc7501Kind) ? (raw.kind as Osc7501Kind) : null;
  return {
    state: raw.state as Osc7501State,
    ...(kind ? { kind } : {}),
    ...(typeof raw.progress == "number" ? { progress: raw.progress } : {}),
    ...(raw.app ? { app: raw.app } : {}),
    ...(raw.title ? { title: raw.title } : {}),
    ...(raw.msg ? { msg: raw.msg } : {}),
  };
}

function appNameOf(t: RawTerminal): string {
  const fromStatus = t.status?.app?.trim();
  if (fromStatus) return fromStatus;
  const fromFg = t.foreground?.name?.trim();
  if (fromFg && fromFg != "sh" && fromFg != "zsh" && fromFg != "bash") return fromFg;
  const first = t.argv?.[0] ? basename(t.argv[0]) : "";
  return first || fromFg || "terminal";
}

function toSummary(t: RawTerminal): TerminalSummary {
  const app = appNameOf(t);
  const slash = t.address.indexOf("/");
  const host = slash > 0 ? t.address.slice(0, slash) : null;
  const label = t.name ? `${t.name} · ${t.address}` : `${app} · ${t.address}`;
  return {
    id: t.address,
    label,
    app,
    ...(t.cwd ? { cwd: t.cwd } : {}),
    state: t.state == "finished" ? "finished" : "live",
    status: normalizeStatus(t.status),
    turn: t.turn ?? 0,
    parent: t.parent ?? null,
    host,
  };
}

/** Recursively extracts every terminal ID referenced inside a herdr-app tab split tree. */
export function collectPaneTerminals(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node != "object") return out;
  const rec = node as Record<string, unknown>;
  const content = rec.content as Record<string, unknown> | undefined;
  if (content && typeof content.terminal == "string" && content.terminal) out.push(content.terminal);
  if (typeof rec.terminal == "string" && rec.terminal) out.push(rec.terminal);
  if (Array.isArray(rec.children)) for (const c of rec.children) collectPaneTerminals(c, out);
  if (rec.left) collectPaneTerminals(rec.left, out);
  if (rec.right) collectPaneTerminals(rec.right, out);
  if (rec.first) collectPaneTerminals(rec.first, out);
  if (rec.second) collectPaneTerminals(rec.second, out);
  return out;
}

/** Encodes one binary frame for herdr-core framed mode. */
export function encodeHcFrame(channel: number, kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, channel, true);
  dv.setUint8(4, kind);
  dv.setUint32(5, payload.length, true);
  out.set(payload, 9);
  return out;
}

interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onResult?: (v: unknown) => void;
}

interface ChannelHandler {
  onData: (bytes: Uint8Array) => void;
  onClose: (reason?: string) => void;
  consumed: number;
}

export interface HerdrCoreOptions {
  socketPath?: string;
  log?: (line: string) => void;
  reconnect?: boolean;
}

export class HerdrCoreBackend implements TerminalBackend {
  readonly id = "herdr-core" as const;
  readonly label = "herdr-core";

  private readonly socketPath: string;
  private readonly log: (line: string) => void;
  private readonly shouldReconnect: boolean;
  private sock: Socket | null = null;
  private mode: "line" | "framed" = "line";
  private rxBuf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private channels = new Map<number, ChannelHandler>();
  private listeners = new Set<(ev: BackendEvent) => void>();
  private terminals = new Map<string, RawTerminal>();
  private version = "0.0.0";
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tries = 0;

  constructor(opts: HerdrCoreOptions = {}) {
    this.socketPath = opts.socketPath ?? herdrSocketPath();
    this.log = opts.log ?? (() => {});
    this.shouldReconnect = opts.reconnect ?? true;
  }

  async connect(): Promise<{ version: string }> {
    this.closed = false;
    await this.openSocket();
    return { version: this.version };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket("closed");
  }

  subscribe(onEvent: (ev: BackendEvent) => void): () => void {
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }

  private emit(ev: BackendEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        /* listener isolation */
      }
    }
  }

  async listTerminals(): Promise<TerminalSummary[]> {
    const res = (await this.rpc("terminal.list", { all: false })) as { terminals?: RawTerminal[] };
    const list = res.terminals ?? [];
    this.terminals.clear();
    for (const t of list) this.terminals.set(t.address, t);
    return list.filter((t) => t.state == "live").map(toSummary);
  }

  async listSpaces(): Promise<SpaceInfo[]> {
    const [listRes, docRes] = await Promise.all([
      this.rpc("terminal.list", { all: false }) as Promise<{ terminals?: RawTerminal[] }>,
      this.rpc("doc.get", { name: "herdr-app" }).catch(() => ({ value: null, version: 0 })) as Promise<{ value?: unknown }>,
    ]);
    const live = (listRes.terminals ?? []).filter((t) => t.state == "live");
    this.terminals.clear();
    for (const t of live) this.terminals.set(t.address, t);
    const byId = new Map(live.map((t) => [t.address, t]));

    const rawSpaces = ((docRes.value as { spaces?: RawHerdrSpace[] } | null)?.spaces ?? []).filter(
      (s): s is RawHerdrSpace & { id: string } => typeof s.id == "string" && s.id.length > 0
    );

    const out: SpaceInfo[] = [];
    for (const sp of rawSpaces) {
      const orderedIds: string[] = [];
      const seen = new Set<string>();
      const add = (id: string) => {
        if (!seen.has(id) && byId.has(id)) {
          seen.add(id);
          orderedIds.push(id);
        }
      };
      // 1. Tab pane terminals in tab order.
      for (const tab of sp.tabs ?? []) for (const id of collectPaneTerminals(tab.root)) add(id);
      // 2. Any live terminal carrying labels["herdr.space"] === sp.id.
      for (const t of live) if (t.labels?.["herdr.space"] == sp.id) add(t.address);
      // 3. Spawned child workers (recursive parent chain) belonging to any member in this space.
      let grew = true;
      while (grew) {
        grew = false;
        for (const t of live) {
          if (!seen.has(t.address) && t.parent && seen.has(t.parent)) {
            add(t.address);
            grew = true;
          }
        }
      }
      out.push({
        id: sp.id,
        name: sp.name?.trim() || (sp.folder ? basename(sp.folder) : sp.id.slice(0, 8)),
        ...(sp.folder ? { folder: sp.folder } : {}),
        terminals: orderedIds.map((id) => toSummary(byId.get(id)!)),
      });
    }
    return out;
  }

  async resolveTarget(opts: {
    space?: boolean | string;
    terminal?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  }): Promise<ResolvedTarget> {
    const env = opts.env ?? process.env;
    const [spaces, live] = await Promise.all([this.listSpaces(), this.listTerminals()]);
    const findTerm = (ref?: string | null) => {
      if (!ref) return null;
      return live.find((t) => t.id == ref || this.terminals.get(t.id)?.name == ref) ?? null;
    };

    if (opts.terminal) {
      const exact = findTerm(opts.terminal);
      if (!exact) throw new Error(`Terminal "${opts.terminal}" is not running in herdr-core.`);
      return { scope: "single", spaceId: null, spaceName: null, terminals: [exact], activeTerminal: exact.id };
    }

    const byCwd = opts.cwd ? (live.find((t) => t.cwd == opts.cwd) ?? null) : null;
    const current = findTerm(env.HC_TERMINAL_ID) ?? byCwd ?? live[0] ?? null;

    if (opts.space) {
      let picked: SpaceInfo | null = null;
      if (typeof opts.space == "string") {
        const needle = opts.space.toLowerCase();
        picked = spaces.find((s) => s.id == opts.space || s.name.toLowerCase() == needle) ?? null;
        if (!picked) throw new Error(`Herdr space "${opts.space}" was not found.`);
      } else {
        if (current) picked = spaces.find((s) => s.terminals.some((t) => t.id == current.id)) ?? null;
        if (!picked && opts.cwd) picked = spaces.find((s) => s.folder && opts.cwd!.startsWith(s.folder)) ?? null;
        if (!picked) picked = spaces.find((s) => s.terminals.length > 0) ?? null;
      }
      if (picked && picked.terminals.length > 0) {
        const active = current && picked.terminals.some((t) => t.id == current.id) ? current.id : picked.terminals[0].id;
        return { scope: "space", spaceId: picked.id, spaceName: picked.name, terminals: picked.terminals, activeTerminal: active };
      }
      return {
        scope: "space",
        spaceId: "all",
        spaceName: opts.cwd ? basename(opts.cwd) : "All terminals",
        terminals: live,
        activeTerminal: current?.id ?? live[0]?.id ?? null,
      };
    }

    if (!current) return { scope: "single", spaceId: null, spaceName: null, terminals: [], activeTerminal: null };
    return { scope: "single", spaceId: null, spaceName: null, terminals: [current], activeTerminal: current.id };
  }

  async attach(
    terminalId: string,
    size: { cols: number; rows: number },
    onData: (bytes: Uint8Array) => void,
    onClose: (reason?: string) => void
  ): Promise<PtyAttachment> {
    let closed = false;
    let ch = -1;
    await this.rpc(
      "terminal.attach",
      {
        terminal: terminalId,
        cols: Math.max(20, Math.min(400, Math.round(size.cols || 80))),
        rows: Math.max(6, Math.min(200, Math.round(size.rows || 24))),
        history: 500,
      },
      (res) => {
        // Register synchronously before the next framed DATA packet in the same socket read is processed.
        ch = (res as { channel: number }).channel;
        this.channels.set(ch, {
          onData,
          onClose: (reason) => {
            if (closed) return;
            closed = true;
            onClose(reason);
          },
          consumed: 0,
        });
      }
    );
    return {
      terminalId,
      write: (bytes) => {
        if (!closed && bytes.length) this.writeFrame(ch, FRAME_DATA, bytes);
      },
      resize: (cols, rows) => {
        if (closed) return;
        const p = new Uint8Array(4);
        const dv = new DataView(p.buffer);
        dv.setUint16(0, Math.max(20, Math.min(400, Math.round(cols))), true);
        dv.setUint16(2, Math.max(6, Math.min(200, Math.round(rows))), true);
        this.writeFrame(ch, FRAME_RESIZE, p);
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.channels.delete(ch);
        this.writeFrame(ch, FRAME_CLOSE, new Uint8Array(0));
      },
    };
  }

  async send(terminalId: string, text: string): Promise<void> {
    await this.rpc("terminal.send", { terminal: terminalId, text, force: true });
  }

  async interrupt(terminalId: string): Promise<void> {
    await this.rpc("terminal.interrupt", { terminal: terminalId, timeout: 2 });
  }

  async spawn(opts: { cwd: string; argv?: string[]; spaceId?: string; name?: string }): Promise<TerminalSummary> {
    const labels: Record<string, string> = {};
    if (opts.spaceId && opts.spaceId != "all") labels["herdr.space"] = opts.spaceId;
    const res = (await this.rpc("terminal.run", {
      cwd: opts.cwd,
      ...(opts.argv?.length ? { argv: opts.argv } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(Object.keys(labels).length ? { labels } : {}),
      no_parent: true,
    })) as { terminal?: RawTerminal; address?: string };
    const term = res.terminal ?? ((await this.rpc("terminal.get", { terminal: res.address })) as RawTerminal);
    this.terminals.set(term.address, term);
    return toSummary(term);
  }

  async getState<T>(key: string): Promise<T | null> {
    try {
      const res = (await this.rpc("doc.get", { name: key })) as { value?: T | null; version?: number };
      return res.value ?? null;
    } catch {
      return null;
    }
  }

  async setState<T>(key: string, value: T): Promise<void> {
    const cur = (await this.rpc("doc.get", { name: key }).catch(() => ({ version: 0 }))) as { version?: number };
    await this.rpc("doc.set", { name: key, version: cur.version ?? 0, value });
  }

  // ---------------------------------------------------------------- socket & framing

  private async openSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const sock = connect(this.socketPath);
      this.sock = sock;
      this.mode = "line";
      this.rxBuf = Buffer.alloc(0);

      sock.on("connect", () => {
        const id = this.nextId++;
        this.pending.set(id, {
          resolve: (res) => {
            const h = res as { version?: string; framed?: boolean };
            this.version = h.version ?? "0.0.0";
            if (!h.framed) {
              done(() => reject(new Error("herdr-core refused framed mode.")));
              return;
            }
            this.mode = "framed";
            this.tries = 0;
            void this.subscribeChannels()
              .then(() => done(resolve))
              .catch((e) => done(() => reject(e instanceof Error ? e : new Error(String(e)))));
          },
          reject: (e) => done(() => reject(e)),
        });
        sock.write(JSON.stringify({ jsonrpc: "2.0", id, method: "hello", params: { framed: true } }) + "\n");
      });

      sock.on("data", (chunk: Buffer) => this.onData(chunk));
      sock.on("error", (err) => {
        if (!settled) done(() => reject(err));
      });
      sock.on("close", () => {
        if (this.sock !== sock) return;
        this.teardownSocket("herdr-core disconnected");
        if (!this.closed && this.shouldReconnect) this.scheduleReconnect();
      });
    });
  }

  private async subscribeChannels(): Promise<void> {
    const subTerm = (await this.rpc("events.subscribe", {}, (res) => {
      const r = res as { channel?: number };
      if (typeof r.channel == "number") this.attachEventChannel(r.channel, "terminals");
    })) as { channel?: number; terminals?: RawTerminal[] };
    this.terminals.clear();
    for (const t of subTerm.terminals ?? []) this.terminals.set(t.address, t);

    await this.rpc("events.subscribe", { docs: ["herdr-app"] }, (res) => {
      const r = res as { channel?: number };
      if (typeof r.channel == "number") this.attachEventChannel(r.channel, "docs");
    }).catch(() => null);
  }

  private attachEventChannel(ch: number, kind: "terminals" | "docs"): void {
    let lineBuf = "";
    this.channels.set(ch, {
      onData: (bytes) => {
        lineBuf += utf8Dec.decode(bytes, { stream: true });
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { method?: string; params?: Record<string, unknown> };
            this.handleEventLine(kind, msg);
          } catch {
            /* ignore malformed line */
          }
        }
      },
      onClose: () => {},
      consumed: 0,
    });
  }

  private handleEventLine(kind: "terminals" | "docs", msg: { method?: string; params?: Record<string, unknown> }): void {
    if (msg.method == "heartbeat") return;
    if (msg.method == "missed") {
      void this.listTerminals().then(
        () => this.emit({ type: "resync" }),
        () => {}
      );
      return;
    }
    if (msg.method != "event" || !msg.params) return;
    const type = String(msg.params.type ?? "");
    const addr = typeof msg.params.terminal == "string" ? msg.params.terminal : "";
    const data = (msg.params.data ?? {}) as Record<string, unknown>;

    if (kind == "docs" || type == "doc") {
      this.emit({ type: "spaces_changed" });
      return;
    }
    if (!addr) return;
    if (type == "created") {
      const t = data as unknown as RawTerminal;
      if (t.address) {
        this.terminals.set(t.address, t);
        this.emit({ type: "terminal_changed", terminal: toSummary(t) });
      }
      return;
    }
    if (type == "removed") {
      this.terminals.delete(addr);
      this.emit({ type: "terminal_removed", terminalId: addr });
      return;
    }
    const existing = this.terminals.get(addr);
    if (!existing) {
      void this.rpc("terminal.get", { terminal: addr }).then(
        (raw) => {
          const t = raw as RawTerminal;
          this.terminals.set(t.address, t);
          this.emit({ type: "terminal_changed", terminal: toSummary(t) });
        },
        () => {}
      );
      return;
    }
    if (type == "status") {
      existing.status = (data.status as RawStatus | null) ?? null;
      this.emit({ type: "terminal_changed", terminal: toSummary(existing) });
    } else if (type == "turn") {
      const turn = typeof data.turn == "number" ? data.turn : (existing.turn ?? 0) + 1;
      existing.turn = turn;
      this.emit({ type: "terminal_changed", terminal: toSummary(existing) });
      this.emit({ type: "turn_done", terminalId: addr, turn });
    } else if (type == "foreground") {
      existing.foreground = {
        name: typeof data.name == "string" ? data.name : undefined,
        cwd: typeof data.cwd == "string" ? data.cwd : undefined,
      };
      if (typeof data.cwd == "string") existing.cwd = data.cwd;
      this.emit({ type: "terminal_changed", terminal: toSummary(existing) });
    } else if (type == "labels") {
      existing.labels = (data.labels as Record<string, string>) ?? existing.labels;
      this.emit({ type: "spaces_changed" });
    } else if (type == "finished") {
      existing.state = "finished";
      existing.status = null;
      this.emit({ type: "terminal_changed", terminal: toSummary(existing) });
    }
  }

  private onData(chunk: Buffer): void {
    this.rxBuf = this.rxBuf.length ? Buffer.concat([this.rxBuf, chunk]) : chunk;
    if (this.mode == "line") {
      const nl = this.rxBuf.indexOf(10);
      if (nl < 0) return;
      const line = this.rxBuf.subarray(0, nl).toString("utf8");
      this.rxBuf = this.rxBuf.subarray(nl + 1);
      this.handleRpcReply(line);
      if ((this.mode as "line" | "framed") != "framed") return;
    }
    while (this.rxBuf.length >= 9) {
      const ch = this.rxBuf.readUInt32LE(0);
      const kind = this.rxBuf.readUInt8(4);
      const len = this.rxBuf.readUInt32LE(5);
      if (this.rxBuf.length < 9 + len) break;
      const payload = new Uint8Array(this.rxBuf.subarray(9, 9 + len));
      this.rxBuf = this.rxBuf.subarray(9 + len);
      if (ch == 0 && kind == FRAME_DATA) {
        this.handleRpcReply(utf8Dec.decode(payload));
        continue;
      }
      const handler = this.channels.get(ch);
      if (!handler) continue;
      if (kind == FRAME_DATA) {
        handler.onData(payload);
        handler.consumed += payload.length;
        if (handler.consumed >= CREDIT_STEP) {
          const credit = handler.consumed;
          handler.consumed = 0;
          const b = new Uint8Array(4);
          new DataView(b.buffer).setUint32(0, credit, true);
          this.writeFrame(ch, FRAME_CREDIT, b);
        }
      } else if (kind == FRAME_CLOSE) {
        this.channels.delete(ch);
        handler.onClose("closed");
      }
    }
  }

  private handleRpcReply(raw: string): void {
    let parsed: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return;
    }
    if (typeof parsed.id != "number") return;
    const p = this.pending.get(parsed.id);
    if (!p) return;
    this.pending.delete(parsed.id);
    if (parsed.error) p.reject(new Error(parsed.error.message ?? "herdr-core RPC error"));
    else {
      p.onResult?.(parsed.result);
      p.resolve(parsed.result);
    }
  }

  private writeFrame(channel: number, kind: number, payload: Uint8Array): void {
    if (!this.sock || this.sock.destroyed) return;
    try {
      this.sock.write(encodeHcFrame(channel, kind, payload));
    } catch {
      /* close listener will recover */
    }
  }

  private rpc(method: string, params: Record<string, unknown> = {}, onResult?: (v: unknown) => void): Promise<unknown> {
    if (!this.sock || this.sock.destroyed) return Promise.reject(new Error("herdr-core is not connected."));
    const id = this.nextId++;
    const payload = utf8Enc.encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onResult });
      this.writeFrame(0, FRAME_DATA, payload);
    });
  }

  private teardownSocket(reason: string): void {
    const s = this.sock;
    this.sock = null;
    if (s) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
    for (const h of this.channels.values()) h.onClose(reason);
    this.channels.clear();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const wait = Math.min(5_000, 250 * 2 ** Math.min(this.tries++, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket()
        .then(() => this.emit({ type: "resync" }))
        .catch((e) => {
          this.log(`[herdr-core] reconnect failed: ${e instanceof Error ? e.message : e}`);
          this.scheduleReconnect();
        });
    }, wait);
  }
}

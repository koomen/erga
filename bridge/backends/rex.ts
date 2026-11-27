// Superlogical Rex adapter implementing TerminalBackend (PTY + OSC 7501).
// Speaks to a local `rex` server via its JSON CLI (`rex ls --json`, `rex send`,
// `rex attach`, `rex new`) so sessions, windows, and blocks map cleanly into
// Erga's single-terminal and whole-space modes alongside herdr-core.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Osc7501Kind, Osc7501State, TerminalStatus, TerminalSummary } from "../../shared/bridge-protocol.ts";
import { ergaHome } from "../core/auth.ts";
import type { BackendEvent, PtyAttachment, ResolvedTarget, SpaceInfo, TerminalBackend } from "../core/backend.ts";

interface RawRexStatus {
  state?: string;
  kind?: string | null;
  progress?: number | null;
  app?: string;
  title?: string;
  msg?: string;
}

interface RawRexBlock {
  id: string;
  title?: string;
  command?: string;
  app?: string;
  cwd?: string;
  alive?: boolean;
  state?: "live" | "finished";
  status?: RawRexStatus | null;
  turn?: number;
}

interface RawRexWindow {
  id: string;
  name?: string;
  blocks?: RawRexBlock[];
}

interface RawRexSession {
  id: string;
  name?: string;
  cwd?: string;
  windows?: RawRexWindow[];
  blocks?: RawRexBlock[];
}

const VALID_STATES = new Set<Osc7501State>(["idle", "working", "done", "blocked", "error"]);
const VALID_KINDS = new Set<Osc7501Kind>(["permission", "question", "auth"]);

function normalizeRexStatus(raw: RawRexStatus | null | undefined): TerminalStatus | null {
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

function blockToSummary(b: RawRexBlock, windowName?: string): TerminalSummary {
  const app = b.status?.app || b.app || (b.command ? basename(b.command.split(/\s+/)[0]) : "terminal");
  const shortId = b.id.length > 10 ? b.id.slice(0, 8) : b.id;
  const label = windowName ? `${app} · ${windowName}` : `${app} · ${shortId}`;
  return {
    id: b.id,
    label,
    app,
    ...(b.cwd ? { cwd: b.cwd } : {}),
    state: b.alive === false || b.state == "finished" ? "finished" : "live",
    status: normalizeRexStatus(b.status),
    turn: b.turn ?? 0,
  };
}

export interface RexBackendOptions {
  bin?: string;
  pollMs?: number;
  log?: (line: string) => void;
}

export class RexBackend implements TerminalBackend {
  readonly id = "rex" as const;
  readonly label = "rex";

  private readonly bin: string;
  private readonly pollMs: number;
  private listeners = new Set<(ev: BackendEvent) => void>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot = new Map<string, string>();
  private lastTurns = new Map<string, number>();

  constructor(opts: RexBackendOptions = {}) {
    this.bin = opts.bin ?? process.env.REX_BIN ?? "rex";
    this.pollMs = opts.pollMs ?? 1_500;
  }

  async connect(): Promise<{ version: string }> {
    const out = await this.exec(["--version"]).catch(() => "0.0.0");
    const m = /(\d+\.\d+\.\d+)/.exec(out);
    if (!this.poller) {
      this.poller = setInterval(() => void this.pollOnce(), this.pollMs);
    }
    return { version: m?.[1] ?? (out.trim() || "0.0.0") };
  }

  async close(): Promise<void> {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
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
        /* isolate */
      }
    }
  }

  private async fetchSessions(): Promise<RawRexSession[]> {
    const raw = await this.exec(["ls", "--json"]);
    const parsed = JSON.parse(raw || "[]") as RawRexSession[] | { sessions?: RawRexSession[] };
    return Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
  }

  async listSpaces(): Promise<SpaceInfo[]> {
    const sessions = await this.fetchSessions();
    return sessions.map((s) => {
      const terminals: TerminalSummary[] = [];
      for (const w of s.windows ?? []) {
        for (const b of w.blocks ?? []) {
          const sum = blockToSummary(b, w.name);
          if (sum.state == "live") terminals.push(sum);
        }
      }
      for (const b of s.blocks ?? []) {
        const sum = blockToSummary(b);
        if (sum.state == "live" && !terminals.some((t) => t.id == sum.id)) terminals.push(sum);
      }
      return {
        id: s.id,
        name: s.name?.trim() || s.id.slice(0, 8),
        ...(s.cwd ? { folder: s.cwd } : {}),
        terminals,
      };
    });
  }

  async listTerminals(): Promise<TerminalSummary[]> {
    const spaces = await this.listSpaces();
    return spaces.flatMap((s) => s.terminals);
  }

  async resolveTarget(opts: {
    space?: boolean | string;
    terminal?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  }): Promise<ResolvedTarget> {
    const env = opts.env ?? process.env;
    const spaces = await this.listSpaces();
    const live = spaces.flatMap((s) => s.terminals);
    const findTerm = (id?: string | null) => (id ? (live.find((t) => t.id == id) ?? null) : null);

    if (opts.terminal) {
      const exact = findTerm(opts.terminal);
      if (!exact) throw new Error(`Rex block "${opts.terminal}" was not found.`);
      return { scope: "single", spaceId: null, spaceName: null, terminals: [exact], activeTerminal: exact.id };
    }

    const byCwd = opts.cwd ? (live.find((t) => t.cwd == opts.cwd) ?? null) : null;
    const current = findTerm(env.REX_BLOCK_ID) ?? byCwd ?? live[0] ?? null;

    if (opts.space) {
      let picked: SpaceInfo | null = null;
      if (typeof opts.space == "string") {
        const needle = opts.space.toLowerCase();
        picked = spaces.find((s) => s.id == opts.space || s.name.toLowerCase() == needle) ?? null;
        if (!picked) throw new Error(`Rex session "${opts.space}" was not found.`);
      } else {
        const envSess = env.REX_SESSION;
        if (envSess) picked = spaces.find((s) => s.id == envSess || s.name == envSess) ?? null;
        if (!picked && current) picked = spaces.find((s) => s.terminals.some((t) => t.id == current.id)) ?? null;
        if (!picked) picked = spaces.find((s) => s.terminals.length > 0) ?? null;
      }
      if (picked && picked.terminals.length > 0) {
        const active = current && picked.terminals.some((t) => t.id == current.id) ? current.id : picked.terminals[0].id;
        return { scope: "space", spaceId: picked.id, spaceName: picked.name, terminals: picked.terminals, activeTerminal: active };
      }
      return { scope: "space", spaceId: "all", spaceName: "Rex", terminals: live, activeTerminal: current?.id ?? null };
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
    const cols = Math.max(20, Math.min(400, Math.round(size.cols || 80)));
    const rows = Math.max(6, Math.min(200, Math.round(size.rows || 24)));
    // Attach to the Rex block via `rex attach --block <id>` inside a Bun PTY when available, else stdio pipe.
    const proc = Bun.spawn([this.bin, "attach", terminalId], {
      env: { ...process.env, COLUMNS: String(cols), LINES: String(rows), TERM: "xterm-256color" },
      terminal: {
        cols,
        rows,
        data(_term, data) {
          if (!closed) onData(new Uint8Array(data));
        },
        exit() {
          if (closed) return;
          closed = true;
          onClose("closed");
        },
      },
    });
    void proc.exited.then(() => {
      if (closed) return;
      closed = true;
      onClose("exited");
    });
    return {
      terminalId,
      write: (bytes) => {
        if (!closed && proc.terminal) proc.terminal.write(bytes);
      },
      resize: (c, r) => {
        if (!closed && proc.terminal) proc.terminal.resize(Math.max(20, Math.round(c)), Math.max(6, Math.round(r)));
      },
      close: () => {
        if (closed) return;
        closed = true;
        try {
          proc.terminal?.close();
          proc.kill();
        } catch {
          /* already exited */
        }
      },
    };
  }

  async send(terminalId: string, text: string): Promise<void> {
    await this.exec(["send", terminalId, text]);
  }

  async interrupt(terminalId: string): Promise<void> {
    await this.exec(["send", terminalId, "\x03"]);
  }

  async spawn(opts: { cwd: string; argv?: string[]; spaceId?: string; name?: string }): Promise<TerminalSummary> {
    const args = ["new", "--json", "--cwd", opts.cwd];
    if (opts.spaceId && opts.spaceId != "all") args.push("--session", opts.spaceId);
    if (opts.name) args.push("--name", opts.name);
    if (opts.argv?.length) args.push("--", ...opts.argv);
    const raw = await this.exec(args);
    const parsed = JSON.parse(raw) as RawRexBlock;
    return blockToSummary(parsed, opts.name);
  }

  async getState<T>(key: string): Promise<T | null> {
    const p = join(ergaHome(), `${key}.json`);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as T;
    } catch {
      return null;
    }
  }

  async setState<T>(key: string, value: T): Promise<void> {
    const p = join(ergaHome(), `${key}.json`);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, p);
  }

  private async pollOnce(): Promise<void> {
    if (!this.listeners.size) return;
    try {
      const live = await this.listTerminals();
      const seen = new Set<string>();
      for (const t of live) {
        seen.add(t.id);
        const key = JSON.stringify(t);
        if (this.lastSnapshot.get(t.id) != key) {
          this.lastSnapshot.set(t.id, key);
          this.emit({ type: "terminal_changed", terminal: t });
        }
        const prevTurn = this.lastTurns.get(t.id);
        if (prevTurn !== undefined && t.turn > prevTurn) {
          this.emit({ type: "turn_done", terminalId: t.id, turn: t.turn });
        }
        this.lastTurns.set(t.id, t.turn);
      }
      for (const oldId of [...this.lastSnapshot.keys()]) {
        if (!seen.has(oldId)) {
          this.lastSnapshot.delete(oldId);
          this.lastTurns.delete(oldId);
          this.emit({ type: "terminal_removed", terminalId: oldId });
        }
      }
    } catch {
      /* transient rex error */
    }
  }

  private async exec(args: string[]): Promise<string> {
    const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code != 0) throw new Error(`rex ${args[0]} failed (${code}): ${err.trim() || out.trim()}`);
    return out;
  }
}

// Generic Agent Client Protocol (ACP) stdio driver (https://agentclientprotocol.com).
// Speaks JSON-RPC 2.0 over stdin/stdout to any ACP-capable coding agent
// (Antigravity `agy acp`, or future ACP adapters for Codex / Zed).
// Translates streaming chunks, thinking deltas, tool calls, and interactive
// `session/request_permission` prompts into normalized DriverEvents.

import type { AskChoice } from "../../shared/agent-log.ts";
import {
  extractToolPath,
  type AgentDriver,
  type AgentHandle,
  type LocalAttachment,
  type ModelOption,
  type OpenSessionOptions,
} from "../core/driver.ts";
import { attachmentNote, DriverEvents, endProcess, readLines, spawnAgent, writeLine, type AgentProcess } from "./stdio.ts";

/** Synthetic choice id that approves the current prompt and auto-approves the rest of the session. */
export const ALLOW_SESSION_CHOICE = "__erga_allow_session__";

export interface AcpDriverConfig {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Optional CLI flag for adding extra directories (e.g. "--add-dir" for `agy acp`). */
  readonly addDirFlag?: string;
  /** Optional CLI flag for maximally permissive auto-approval (e.g. "--dangerously-skip-permissions"). */
  readonly autoApproveFlag?: string;
  /** Optional extra flags (e.g. "--sandbox"). */
  readonly extraArgs?: readonly string[];
  /** Optional agent-specific `_meta` payload for `session/new` and `session/resume`. */
  readonly sessionMeta?: (opts: OpenSessionOptions) => Record<string, unknown> | undefined;
  /** Startup timeout in milliseconds for ACP `initialize` / `session/new` (default 30s). */
  readonly initTimeoutMs?: number;
}

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name?: string;
  readonly kind?: string;
}

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface PendingPermission {
  rpcId: string | number;
  toolName: string;
  path: string | null;
  options: readonly AcpPermissionOption[];
}

interface AcpSessionResult {
  sessionId: string;
  models?: {
    currentModelId?: string;
    availableModels?: { modelId: string; name?: string }[];
  };
  modes?: {
    currentModeId?: string;
    availableModes?: { id: string; name?: string }[];
  };
}

/** Converts ACP `session/request_permission` options into panel choice buttons, plus a session-wide allow-all option. */
export function permissionChoices(options: readonly AcpPermissionOption[]): AskChoice[] {
  const mapped: AskChoice[] = options.map((o) => {
    const isDeny = o.kind?.includes("reject") || o.optionId == "deny" || o.optionId == "reject";
    const isAlways = !isDeny && (o.kind?.includes("always") || o.optionId.includes("always"));
    const rawName = o.name?.trim();
    const label = isDeny
      ? rawName || (o.kind == "reject_always" ? "Always deny" : "Deny")
      : isAlways
        ? rawName || "Always allow"
        : rawName && rawName.toLowerCase() != "allow"
          ? rawName
          : "Allow once";
    return { id: o.optionId, label, kind: isDeny ? "deny" : isAlways ? "always" : "allow" };
  });
  const rank = (k: AskChoice["kind"]) => (k == "deny" ? 0 : k == "allow" ? 1 : 2);
  mapped.sort((a, b) => rank(a.kind) - rank(b.kind));
  if (mapped.some((c) => c.kind != "deny") && !mapped.some((c) => c.id == ALLOW_SESSION_CHOICE)) {
    mapped.push({ id: ALLOW_SESSION_CHOICE, label: "Allow all (session)", kind: "always" });
  }
  return mapped;
}

function pickAllowOption(options: readonly AcpPermissionOption[]): AcpPermissionOption | undefined {
  return (
    options.find((o) => o.kind?.includes("always") && !o.kind.includes("reject")) ??
    options.find((o) => o.kind?.includes("allow") || o.optionId == "allow") ??
    options[0]
  );
}

function pickDenyOption(options: readonly AcpPermissionOption[]): AcpPermissionOption | undefined {
  return options.find((o) => o.kind?.includes("reject") || o.optionId == "deny") ?? options.at(-1);
}

class AcpHandle extends DriverEvents implements AgentHandle {
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private permissions = new Map<string, PendingPermission>();
  private activeTools = new Map<string, { name: string; path: string | null }>();
  private closeListeners = new Set<() => void>();
  private _closed = false;
  private _sessionId = "";
  private _models: ModelOption[] = [];
  private _model: string | null = null;
  private availableModes: string[] = [];
  private autoApproveSession = false;

  constructor(
    private readonly proc: AgentProcess,
    private readonly cfg: Pick<AcpDriverConfig, "sessionMeta" | "initTimeoutMs"> = {},
    private readonly log?: (line: string) => void
  ) {
    super();
  }

  get sessionId(): string {
    return this._sessionId;
  }
  get models(): readonly ModelOption[] {
    return this._models;
  }
  get model(): string | null {
    return this._model;
  }
  get closed(): boolean {
    return this._closed;
  }

  onClose(listener: () => void): () => void {
    if (this._closed) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private markClosed(): void {
    if (this._closed) return;
    this._closed = true;
    for (const fn of [...this.closeListeners]) fn();
    this.closeListeners.clear();
  }

  private failPermissions(detail: string): void {
    for (const [callId, perm] of this.permissions) {
      this.emit({ t: "tool", id: callId, name: perm.toolName, path: perm.path, status: "error", detail });
    }
    this.permissions.clear();
  }

  private write(msg: object): void {
    if (!this._closed) writeLine(this.proc, msg);
  }

  private request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this._closed) return Promise.reject(new Error("ACP session is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (fn: () => void) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        fn();
      };
      if (timeoutMs != null) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (r) => done(() => resolve(r as T)),
        reject: (err) => done(() => reject(err)),
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      } catch (e) {
        this.pending.delete(id);
        done(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });
  }

  async init(opts: OpenSessionOptions): Promise<void> {
    const initTimeout = this.cfg.initTimeoutMs ?? 30_000;
    readLines(
      this.proc,
      "acp",
      (msg) => this.handleMessage(msg),
      () => {
        if (this._closed) return;
        for (const [, p] of this.pending) p.reject(new Error("ACP process exited unexpectedly"));
        this.pending.clear();
        this.failPermissions("ACP process exited unexpectedly");
        this.activeTools.clear();
        this.markClosed();
      },
      this.log
    );
    await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: "erga-bridge", version: "0.1.0" },
      },
      initTimeout
    );

    const mcpServers = (opts.mcpServers ?? []).map((s) => ({
      name: s.name,
      command: s.command,
      args: [...s.args],
      env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })),
    }));
    const meta = this.cfg.sessionMeta?.(opts);

    let res: AcpSessionResult | null = null;
    if (opts.resumeId) {
      res = await this.request<AcpSessionResult>(
        "session/resume",
        {
          sessionId: opts.resumeId,
          cwd: opts.cwd,
          mcpServers,
          ...(meta ? { _meta: meta } : {}),
        },
        initTimeout
      ).catch((e) => {
        this.log?.(`session/resume ${opts.resumeId} failed, starting fresh session: ${e instanceof Error ? e.message : e}`);
        return null;
      });
    }
    if (!res) {
      res = await this.request<AcpSessionResult>(
        "session/new",
        {
          cwd: opts.cwd,
          mcpServers,
          ...(meta ? { _meta: meta } : {}),
        },
        initTimeout
      );
    }

    this._sessionId = res.sessionId;
    this._model = res.models?.currentModelId ?? null;
    this._models = (res.models?.availableModels ?? []).map((m) => ({ id: m.modelId, label: m.name || m.modelId }));
    this.availableModes = (res.modes?.availableModes ?? []).map((m) => m.id);
    this.autoApproveSession = Boolean(opts.autoApprove);

    if (opts.mode && this.availableModes.includes(opts.mode)) {
      await this.setMode(opts.mode).catch(() => {});
    }
    if (opts.model && this._models.some((m) => m.id == opts.model)) {
      await this.setModel(opts.model).catch(() => {});
    }
  }

  async prompt(input: { text: string; attachments?: readonly LocalAttachment[] }): Promise<void> {
    const blocks: Record<string, unknown>[] = [];
    if (input.text) blocks.push({ type: "text", text: input.text });
    for (const att of input.attachments ?? []) {
      if (att.kind == "image") {
        blocks.push({ type: "image", data: att.data, mimeType: att.type });
      } else {
        blocks.push({ type: "text", text: attachmentNote(att) });
      }
    }
    if (!blocks.length) return;
    this.emit({ t: "busy", busy: true });
    try {
      await this.request("session/prompt", { sessionId: this._sessionId, prompt: blocks });
    } catch (e) {
      this.emit({ t: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      // Mark any ask_question tool calls that were left pending as done when the turn yields for user reply.
      for (const [id, t] of this.activeTools) {
        if (t.name == "ask_question") this.emit({ t: "tool", id, name: t.name, path: t.path, status: "done" });
      }
      this.activeTools.clear();
      this.emit({ t: "busy", busy: false });
      this.emit({ t: "turn_done" });
    }
  }

  async abort(): Promise<void> {
    if (this._closed || !this._sessionId) return;
    // Cancel any open permission prompts first so the agent loop unblocks immediately.
    for (const [callId, perm] of this.permissions) {
      this.write({ jsonrpc: "2.0", id: perm.rpcId, result: { outcome: { outcome: "cancelled" } } });
      this.emit({ t: "tool", id: callId, name: perm.toolName, path: perm.path, status: "error", detail: "Canceled" });
    }
    this.permissions.clear();
    this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this._sessionId } });
  }

  async answer(callId: string, approve: boolean, choice?: string): Promise<boolean> {
    const perm = this.permissions.get(callId);
    if (!perm) return false;
    this.permissions.delete(callId);
    let pick: AcpPermissionOption | undefined;
    let granted = approve;
    if (choice == ALLOW_SESSION_CHOICE) {
      this.autoApproveSession = true;
      if (this.availableModes.includes("auto")) void this.setMode("auto").catch(() => {});
      pick = pickAllowOption(perm.options);
      granted = true;
    } else if (choice) {
      pick = perm.options.find((o) => o.optionId == choice) ?? (approve ? pickAllowOption(perm.options) : pickDenyOption(perm.options));
      granted = !(pick?.kind?.includes("reject") || pick?.optionId == "deny" || !approve);
    } else {
      pick = approve ? pickAllowOption(perm.options) : pickDenyOption(perm.options);
    }
    if (!pick) {
      this.write({ jsonrpc: "2.0", id: perm.rpcId, result: { outcome: { outcome: "cancelled" } } });
    } else {
      this.write({ jsonrpc: "2.0", id: perm.rpcId, result: { outcome: { outcome: "selected", optionId: pick.optionId } } });
    }
    this.emit({
      t: "tool",
      id: callId,
      name: perm.toolName,
      path: perm.path,
      status: granted ? "running" : "error",
      ...(granted ? {} : { detail: "Denied" }),
    });
    return true;
  }

  private async setMode(modeId: string): Promise<boolean> {
    if (!this._sessionId) return false;
    return this.request("session/set_mode", { sessionId: this._sessionId, modeId })
      .then(() => true)
      .catch(() =>
        this.request("session/set_config_option", { sessionId: this._sessionId, configId: "mode", value: modeId })
          .then(() => true)
          .catch(() => false)
      );
  }

  async setModel(modelId: string): Promise<boolean> {
    if (!this._sessionId) return false;
    const ok = await this.request("session/set_model", { sessionId: this._sessionId, modelId })
      .then(() => true)
      .catch(() =>
        this.request("session/set_config_option", { sessionId: this._sessionId, configId: "model", value: modelId })
          .then(() => true)
          .catch(() => false)
      );
    if (ok) this._model = modelId;
    return ok;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this.markClosed();
    for (const [, p] of this.pending) p.reject(new Error("ACP session closed"));
    this.pending.clear();
    this.failPermissions("ACP session closed");
    this.activeTools.clear();
    if (this._sessionId) {
      try {
        writeLine(this.proc, { jsonrpc: "2.0", id: this.nextId++, method: "session/close", params: { sessionId: this._sessionId } });
      } catch {
        /* process exiting */
      }
    }
    endProcess(this.proc);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Response to one of our outgoing requests.
    if (msg.method === undefined && typeof msg.id == "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = msg.error as { message?: string; code?: number };
        p.reject(new Error(err.message || `ACP error ${err.code ?? ""}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Incoming notification: session/update
    if (msg.method == "session/update") {
      const params = msg.params as { update?: Record<string, unknown> } | undefined;
      if (params?.update) this.handleUpdate(params.update);
      return;
    }

    // Incoming request from agent: session/request_permission
    if (msg.method == "session/request_permission" && (typeof msg.id == "string" || typeof msg.id == "number")) {
      const params = (msg.params ?? {}) as {
        toolCall?: {
          toolCallId?: string;
          name?: string;
          title?: string;
          args?: Record<string, unknown>;
          rawInput?: Record<string, unknown>;
        };
        options?: { optionId: string; name?: string; kind?: string }[];
      };
      const tc = params.toolCall ?? {};
      const callId = tc.toolCallId || `perm-${msg.id}`;
      const name = tc.name || "tool";
      const args = tc.args ?? tc.rawInput ?? {};
      const path = extractToolPath(name, args) ?? (tc.title && tc.title != name ? tc.title.slice(0, 140) : null);
      const options = params.options ?? [];
      if (this.autoApproveSession) {
        const pick = pickAllowOption(options);
        this.write({
          jsonrpc: "2.0",
          id: msg.id,
          result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } },
        });
        this.emit({ t: "tool", id: callId, name, path, status: "running" });
        return;
      }
      this.permissions.set(callId, { rpcId: msg.id, toolName: name, path, options });
      const choices = permissionChoices(options);
      this.emit({
        t: "tool",
        id: callId,
        name,
        path,
        status: "asking",
        detail: tc.title || `${name}${path ? ` ${path}` : ""}`,
        call: { tool: name, args },
        ...(choices.length ? { choices } : {}),
      });
    }
  }

  private handleUpdate(u: Record<string, unknown>): void {
    const kind = u.sessionUpdate;
    if (kind == "agent_message_chunk") {
      const content = u.content as { type?: string; text?: string } | undefined;
      if (content?.type == "text" && content.text) this.emit({ t: "text", delta: content.text });
      return;
    }
    if (kind == "agent_thought_chunk") {
      const content = u.content as { type?: string; text?: string } | undefined;
      if (content?.type == "text" && content.text) this.emit({ t: "thinking", delta: content.text });
      return;
    }
    if (kind == "tool_call" || kind == "tool_call_update") {
      const id = String(u.toolCallId ?? "");
      if (!id) return;
      const name = String(u.name ?? this.activeTools.get(id)?.name ?? "tool");
      const args = (u.args ?? u.rawInput) as Record<string, unknown> | undefined;
      const title = typeof u.title == "string" && u.title.trim() && u.title.trim() != name ? u.title.trim().slice(0, 140) : null;
      const path = extractToolPath(name, args) ?? title ?? this.activeTools.get(id)?.path ?? null;
      const rawStatus = String(u.status ?? "in_progress");
      // When waiting for permission, session/request_permission handles the `asking` card.
      if (rawStatus == "pending" && this.permissions.has(id)) return;
      if (rawStatus == "pending" && name == "ask_question") {
        this.activeTools.set(id, { name, path });
        return;
      }
      const status = rawStatus == "completed" ? "done" : rawStatus == "failed" || rawStatus == "cancelled" ? "error" : "running";
      if (status == "running") this.activeTools.set(id, { name, path });
      else this.activeTools.delete(id);
      const rawOut = u.rawOutput as { error?: string; message?: string } | undefined;
      const detail = status == "error" ? (rawOut?.error ?? rawOut?.message ?? String(u.title ?? "Failed")) : undefined;
      this.emit({ t: "tool", id, name, path, status, ...(detail ? { detail } : {}) });
    }
  }
}

/** Creates an AgentDriver backed by any ACP-compatible binary (e.g. `agy acp`). */
export function createAcpDriver(cfg: AcpDriverConfig, log?: (line: string) => void): AgentDriver {
  return {
    id: cfg.id,
    label: cfg.label,
    async open(opts: OpenSessionOptions): Promise<AgentHandle> {
      const args = [...cfg.args, ...(cfg.extraArgs ?? [])];
      if (opts.autoApprove && cfg.autoApproveFlag && !args.includes(cfg.autoApproveFlag)) args.push(cfg.autoApproveFlag);
      if (cfg.addDirFlag) {
        for (const dir of opts.addDirs ?? []) {
          if (dir && dir != opts.cwd) args.push(cfg.addDirFlag, dir);
        }
      }
      const handle = new AcpHandle(
        spawnAgent([cfg.command, ...args], opts.cwd),
        { sessionMeta: cfg.sessionMeta, initTimeoutMs: cfg.initTimeoutMs },
        log
      );
      try {
        await handle.init(opts);
        return handle;
      } catch (e) {
        await handle.close();
        throw e;
      }
    },
  };
}

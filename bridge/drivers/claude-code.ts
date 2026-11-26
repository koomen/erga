// Claude Code adapter:
//   (1) A prompt from Erga's browser panel runs in a Claude Code session that the
//       bridge starts: `claude -p` with stream-json input and output (Claude
//       Code's headless mode). Each permission prompt of that session goes to
//       the panel through `--permission-prompt-tool`, an MCP tool of the
//       bridge's own server (core/mcp-server.ts: erga_permission).
//   (2) The user's own terminal session reports its turns through the plugin's
//       hooks (plugins/claude-code/hooks/hooks.json), which claudeCodeHook turns
//       into the bridge's HookPayload: the panel shows them.
//
// Claude Code does not speak ACP itself, and its channels (the documented way
// to send a message into a running terminal session) are a research preview
// that an organization's policy can turn off: so a panel prompt never runs in
// the terminal session.
//
// Trap: a hook's output is a decision for Claude Code. `{}` decides nothing.
// Never answer a PreToolUse hook with an allow: it skips the user's own
// permission prompt in their terminal.

import {
  BRIDGE_SESSION_ENV,
  extractToolPath,
  type AgentDriver,
  type AgentHandle,
  type HookCall,
  type LocalAttachment,
  type ModelOption,
  type OpenSessionOptions,
} from "../core/driver.ts";
import type { HookPayload } from "../core/sessions.ts";
import { ALLOW_SESSION_CHOICE, permissionChoices } from "./acp.ts";
import { attachmentNote, DriverEvents, endProcess, readLines, spawnAgent, writeLine, type AgentProcess } from "./stdio.ts";

/** The MCP tool of the bridge's server that Claude Code asks for each permission. */
const PERMISSION_TOOL = "erga_permission";

const CHOICES = permissionChoices([
  { optionId: "allow", kind: "allow_once" },
  { optionId: "deny", kind: "reject_once" },
]);

const allow = (input: Record<string, unknown>) => ({ behavior: "allow", updatedInput: input });
const deny = (message: string) => ({ behavior: "deny", message });

interface Ask {
  name: string;
  path: string | null;
  input: Record<string, unknown>;
  answer: Promise<Record<string, unknown>>;
  resolve: (answer: Record<string, unknown>) => void;
}

type Block = Record<string, unknown>;
const blocksOf = (msg: Record<string, unknown>): Block[] => {
  const content = (msg.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
};

/** A tool result's text, for the card of a call that failed. */
function resultText(content: unknown): string {
  if (typeof content == "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).map((b) => (typeof b.text == "string" ? b.text : "")).join(" ");
}

class ClaudeCodeHandle extends DriverEvents implements AgentHandle {
  readonly sessionId = crypto.randomUUID();
  readonly models: readonly ModelOption[] = [];
  private _model: string | null;
  private proc: AgentProcess | null = null;
  /** A process of this session ran before: the next one resumes it. */
  private resumes = false;
  /** Ends the turn that runs now. */
  private turnDone: (() => void) | null = null;
  private asks = new Map<string, Ask>();
  private tools = new Map<string, { name: string; path: string | null }>();
  private allowAll: boolean;
  /** The last event was a finished block of text: the next text starts a new paragraph. */
  private gap = false;
  /** The text of the block that streams now, as far as its deltas gave it. */
  private streamed = "";
  private aborted = false;
  private closed = false;

  constructor(
    private readonly command: string,
    private readonly opts: OpenSessionOptions,
    private readonly onClose: () => void,
    private readonly log?: (line: string) => void
  ) {
    super();
    this._model = opts.model ?? null;
    this.allowAll = Boolean(opts.autoApprove);
  }

  get model(): string | null {
    return this._model;
  }

  private start(): AgentProcess {
    const o = this.opts;
    const env = { [BRIDGE_SESSION_ENV]: this.sessionId };
    const servers = Object.fromEntries(
      (o.mcpServers ?? []).map((s) => [s.name, { command: s.command, args: [...s.args], env: { ...s.env, ...env } }])
    );
    const asker = o.mcpServers?.[0]?.name;
    const args = [
      this.command,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...(this.resumes ? ["--resume", this.sessionId] : ["--session-id", this.sessionId]),
      // Only the bridge's own server: the user's plugin has the same server, and its tools must not show twice.
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: servers }),
      ...(asker ? ["--permission-prompt-tool", `mcp__${asker}__${PERMISSION_TOOL}`] : []),
      ...(o.addDirs ?? []).filter((d) => d && d != o.cwd).flatMap((d) => ["--add-dir", d]),
      ...(o.systemPromptAppend ? ["--append-system-prompt", o.systemPromptAppend] : []),
      ...(o.model ? ["--model", o.model] : []),
      ...(o.mode ? ["--permission-mode", o.mode] : []),
    ];
    const proc = spawnAgent(args, o.cwd, { ...process.env, ...env });
    readLines(
      proc,
      "claude",
      (msg) => this.handleMessage(msg),
      () => {
        if (this.proc !== proc) return;
        this.proc = null;
        this.endAsks("Claude Code ended.");
        if (this.turnDone && !this.aborted) this.emit({ t: "error", text: "Claude Code ended before it finished the turn." });
        this.turnDone?.();
      },
      this.log
    );
    return proc;
  }

  async prompt(input: { text: string; attachments?: readonly LocalAttachment[] }): Promise<void> {
    if (this.closed) throw new Error("This Claude Code session is closed.");
    const content: Block[] = [];
    if (input.text) content.push({ type: "text", text: input.text });
    for (const att of input.attachments ?? []) {
      if (att.kind == "image") content.push({ type: "image", source: { type: "base64", media_type: att.type, data: att.data } });
      else content.push({ type: "text", text: attachmentNote(att) });
    }
    if (!content.length) return;
    this.aborted = false;
    this.gap = false;
    this.streamed = "";
    this.emit({ t: "busy", busy: true });
    try {
      const proc = (this.proc ??= this.start());
      await new Promise<void>((resolve) => {
        this.turnDone = resolve;
        writeLine(proc, { type: "user", message: { role: "user", content }, parent_tool_use_id: null });
      });
    } catch (e) {
      this.emit({ t: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      this.turnDone = null;
      this.tools.clear();
      this.emit({ t: "busy", busy: false });
      this.emit({ t: "turn_done" });
    }
  }

  /** Claude Code asks about one tool call (the bridge's MCP tool): the panel's card, and the user's answer. */
  permission(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = String(args.tool_name ?? "tool");
    const input = (args.input ?? {}) as Record<string, unknown>;
    const id = String(args.tool_use_id ?? `ask-${name}`);
    if (this.allowAll) return Promise.resolve(allow(input));
    const pending = this.asks.get(id);
    if (pending) return pending.answer;
    const path = extractToolPath(name, input);
    let resolve!: (answer: Record<string, unknown>) => void;
    const answer = new Promise<Record<string, unknown>>((r) => (resolve = r));
    this.asks.set(id, { name, path, input, answer, resolve });
    this.emit({
      t: "tool",
      id,
      name,
      path,
      status: "asking",
      detail: `${name}${path ? ` ${path}` : ""}`,
      call: { tool: name, args: input },
      choices: CHOICES,
    });
    return answer;
  }

  async answer(callId: string, approve: boolean, choice?: string): Promise<boolean> {
    const ask = this.asks.get(callId);
    if (!ask) return false;
    this.asks.delete(callId);
    if (choice == ALLOW_SESSION_CHOICE) this.allowAll = true;
    const granted = choice == ALLOW_SESSION_CHOICE || (approve && choice != "deny");
    ask.resolve(granted ? allow(ask.input) : deny("The user denied this in Erga's agent panel."));
    this.emit({
      t: "tool",
      id: callId,
      name: ask.name,
      path: ask.path,
      status: granted ? "running" : "error",
      ...(granted ? {} : { detail: "Denied" }),
    });
    return true;
  }

  private endAsks(why: string): void {
    for (const [id, ask] of this.asks) {
      ask.resolve(deny(why));
      this.emit({ t: "tool", id, name: ask.name, path: ask.path, status: "error", detail: "Canceled" });
    }
    this.asks.clear();
  }

  async abort(): Promise<void> {
    const proc = this.proc;
    if (!proc || !this.turnDone) return;
    this.aborted = true;
    this.endAsks("The user stopped the turn.");
    // An interrupt ends the process with its turn: the next prompt starts a new one, which resumes the session.
    this.proc = null;
    proc.kill("SIGINT");
    this.turnDone();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.aborted = true;
    this.endAsks("The session closed.");
    if (this.proc) endProcess(this.proc);
    this.onClose();
  }

  private text(delta: string): void {
    if (!delta) return;
    this.emit({ t: "text", delta: this.gap ? `\n\n${delta}` : delta });
    this.gap = false;
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // A subagent's own stream: the panel shows the call that started it.
    if (msg.parent_tool_use_id) return;
    if (msg.type == "system" && msg.subtype == "init") {
      if (typeof msg.model == "string") this._model = msg.model;
      this.resumes = true;
      return;
    }
    if (msg.type == "stream_event") {
      const ev = (msg.event ?? {}) as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
      if (ev.type != "content_block_delta") return;
      if (ev.delta?.type == "text_delta" && ev.delta.text) {
        this.streamed += ev.delta.text;
        this.text(ev.delta.text);
      } else if (ev.delta?.type == "thinking_delta" && ev.delta.thinking) {
        this.emit({ t: "thinking", delta: ev.delta.thinking });
      }
      return;
    }
    if (msg.type == "assistant") {
      for (const b of blocksOf(msg)) {
        if (b.type == "text" && typeof b.text == "string") {
          // A short reply comes whole, with no delta: the panel gets what the deltas did not give.
          if (b.text.startsWith(this.streamed)) this.text(b.text.slice(this.streamed.length));
          this.streamed = "";
          this.gap = true;
        }
        if (b.type != "tool_use" || typeof b.id != "string") continue;
        const name = String(b.name ?? "tool");
        const path = extractToolPath(name, b.input as Record<string, unknown> | undefined);
        this.tools.set(b.id, { name, path });
        this.gap = false;
        this.emit({ t: "tool", id: b.id, name, path, status: "running" });
      }
      return;
    }
    if (msg.type == "user") {
      for (const b of blocksOf(msg)) {
        if (b.type != "tool_result" || typeof b.tool_use_id != "string") continue;
        const tool = this.tools.get(b.tool_use_id);
        if (!tool) continue;
        this.tools.delete(b.tool_use_id);
        const detail = b.is_error ? resultText(b.content).trim().slice(0, 200) || "Failed" : undefined;
        this.emit({ t: "tool", id: b.tool_use_id, ...tool, status: detail ? "error" : "done", ...(detail ? { detail } : {}) });
      }
      return;
    }
    if (msg.type == "result") {
      if (msg.is_error && !this.aborted) {
        this.emit({ t: "error", text: typeof msg.result == "string" && msg.result ? msg.result : `Claude Code: ${String(msg.subtype)}` });
      }
      this.turnDone?.();
    }
  }
}

/** Turns one payload of a Claude Code hook (its stdin JSON) into the bridge's HookPayload. */
export function claudeCodeHook(raw: Record<string, unknown>): HookCall {
  const str = (v: unknown) => (typeof v == "string" && v ? v : undefined);
  const base: HookPayload = { conversationId: str(raw.session_id), cwd: str(raw.cwd), transcriptPath: str(raw.transcript_path) };
  const toolCall = { id: str(raw.tool_use_id), name: str(raw.tool_name), args: (raw.tool_input ?? {}) as Record<string, unknown> };
  const event = raw.hook_event_name;
  // What Claude Code itself puts in a prompt (a background task's notice) is not what the user typed.
  const typed = str(raw.prompt)?.trimStart().startsWith("<") ? undefined : str(raw.prompt);
  const payload: HookPayload =
    event == "UserPromptSubmit"
      ? { ...base, hookEventName: "PreInvocation", invocationNum: 0, ...(typed ? { prompt: typed } : {}) }
      : event == "PreToolUse"
        ? { ...base, hookEventName: "PreToolUse", toolCall }
        : event == "PostToolUse"
          ? { ...base, hookEventName: "PostToolUse", toolCall }
          : event == "PostToolUseFailure"
            ? { ...base, hookEventName: "PostToolUse", toolCall, error: str(raw.error) ?? "Failed" }
            : event == "Stop"
              ? { ...base, hookEventName: "Stop", reply: str(raw.last_assistant_message) }
              : { ...base, hookEventName: str(event) };
  return { payload, reply: () => ({}) };
}

/** Creates the Claude Code AgentDriver (`claude -p`, stream-json). */
export function createClaudeCodeDriver(log?: (line: string) => void): AgentDriver {
  const command = process.env.CLAUDE_BIN || "claude";
  const handles = new Map<string, ClaudeCodeHandle>();
  return {
    id: "claude-code",
    label: "Claude Code",
    sessionEnv: "CLAUDE_CODE_SESSION_ID",
    openHint:
      '- When the user asks to edit an Erga document URL (or create a new Erga doc), run `"${CLAUDE_PLUGIN_ROOT}/bin/erga-agent" open --agent claude-code "<url>"` to mount the live Yjs room in a local folder and connect this session to Erga\'s browser panel.',
    async open(opts: OpenSessionOptions): Promise<AgentHandle> {
      const handle: ClaudeCodeHandle = new ClaudeCodeHandle(command, opts, () => handles.delete(handle.sessionId), log);
      handles.set(handle.sessionId, handle);
      return handle;
    },
    hook: claudeCodeHook,
    permission: async ({ session, args }) =>
      (await handles.get(session)?.permission(args)) ?? deny("Erga's local bridge does not know this session."),
  };
}

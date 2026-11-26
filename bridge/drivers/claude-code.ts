// Claude Code adapter:
//   (1) A prompt from Erga's browser panel runs in a Claude Code session that the
//       bridge starts: `claude -p` with stream-json input and output (Claude
//       Code's headless mode). Each permission prompt of that session goes to
//       the panel through `--permission-prompt-tool`, an MCP tool of the
//       bridge's own server (core/mcp-server.ts: erga_permission).
//   (2) The user's own terminal session reports its turns through the plugin's
//       hooks (plugins/claude-code/hooks/hooks.json), which claudeCodeHook turns
//       into the bridge's HookPayload: the panel shows them.
//   (3) While a terminal session has a document open, a panel prompt runs in
//       that session (PanelPrompts). Claude Code has no call that sends a
//       prompt into a running session, and an organization's policy can turn
//       its channels off. So a hook of the session waits for the prompt
//       (`erga-agent wait`, with asyncRewake): when the hook ends with code 2,
//       Claude Code wakes the session and gives it what the hook wrote.
//       (1) stays for a document that no terminal session has open.
//
// Trap: a hook's output is a decision for Claude Code. `{}` decides nothing.
// Never answer a PreToolUse hook with an allow: it skips the user's own
// permission prompt in their terminal. A PermissionRequest hook gets an allow
// only from the user's own answer on the panel's card.

import {
  BRIDGE_SESSION_ENV,
  extractToolPath,
  type AgentDriver,
  type AgentHandle,
  type HookCall,
  type LiveMessenger,
  type LiveSession,
  type LocalAttachment,
  type ModelOption,
  type OpenSessionOptions,
  type PromptWait,
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
  private _closed = false;

  constructor(
    private readonly command: string,
    private readonly opts: OpenSessionOptions,
    private readonly onEnd: () => void,
    private readonly log?: (line: string) => void
  ) {
    super();
    this._model = opts.model ?? null;
    this.allowAll = Boolean(opts.autoApprove);
  }

  get model(): string | null {
    return this._model;
  }

  get closed(): boolean {
    return this._closed;
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
    if (this._closed) throw new Error("This Claude Code session is closed.");
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
    if (this._closed) return;
    this._closed = true;
    this.aborted = true;
    this.endAsks("The session closed.");
    if (this.proc) endProcess(this.proc);
    this.onEnd();
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

/** One wait of a hook holds this long: less than the time after which the daemon's server ends a quiet request. */
const HOLD_MS = 5_000;
/** A hook that asked this long ago waits no more. */
const WAITER_GONE_MS = HOLD_MS + 3_000;

/** What the session reads before a panel prompt (mcp-server.ts gives it LIVE_HINT, which names these first words). */
const PANEL_PROMPT = `Erga panel prompt. Your user typed this prompt in the agent panel of an Erga document that this session opened. Do it as a prompt that they typed here. The panel shows your last message of the turn as the answer.\n\n`;

const LIVE_HINT = `- After \`erga-agent open\`, a prompt that the user types in the document's agent panel comes to this session as hook feedback that starts with "Erga panel prompt". The user typed it, signed in to Erga: do it as a prompt typed here. The panel shows your last message of the turn as the answer.`;

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Waiting {
  /** Prompts that no hook took yet. */
  queue: string[];
  /** The hook that waits (its process id), its session, and when it last asked. */
  waiter: number;
  session: string;
  asked: number;
  /** Ends the wait that holds now. */
  give: ((prompt: string | null) => void) | null;
}

/**
 * The panel's prompts for the user's terminal sessions: a hook of each session takes them (`erga-agent wait`).
 * They are kept by Claude Code's process: after /clear the process goes on in a new session.
 */
class PanelPrompts implements LiveMessenger {
  private processes = new Map<number, Waiting>();

  private of(session: LiveSession): Waiting {
    const pid = session.pid ?? 0;
    let s = this.processes.get(pid);
    if (!s) this.processes.set(pid, (s = { queue: [], waiter: 0, session: "", asked: 0, give: null }));
    return s;
  }

  /** A prompt goes to the hook that waits. With none (the session works), the session's next hook takes it. */
  async send(session: LiveSession, text: string): Promise<void> {
    if (!alive(session.pid)) throw new Error("its Claude Code process ended");
    const s = this.of(session);
    if (s.give) s.give(text);
    else s.queue.push(text);
  }

  /** Only the Stop hook tells that a turn ended: a session that lives counts as running. */
  async check(session: LiveSession): Promise<"running" | "gone"> {
    return alive(session.pid) ? "running" : "gone";
  }

  wait(session: LiveSession, waiter: number): Promise<PromptWait> {
    const s = this.of(session);
    // One hook waits for each session: Claude Code starts more of them, and each of those ends at once.
    if (s.session == session.conversationId && s.waiter != waiter && Date.now() - s.asked < WAITER_GONE_MS) return Promise.resolve({});
    s.give?.(null);
    s.waiter = waiter;
    s.session = session.conversationId;
    s.asked = Date.now();
    return new Promise((resolve) => {
      const give = (prompt: string | null) => {
        clearTimeout(timer);
        s.give = null;
        // A hook that got a prompt ends: the session's next hook takes its place.
        s.asked = prompt ? 0 : Date.now();
        resolve(prompt ? { prompt: PANEL_PROMPT + prompt } : { pending: true });
      };
      const timer = setTimeout(() => give(null), HOLD_MS);
      timer.unref?.();
      s.give = give;
      const queued = s.queue.shift();
      if (queued) give(queued);
    });
  }
}

/** Turns one payload of a Claude Code hook (its stdin JSON) into the bridge's HookPayload. */
export function claudeCodeHook(raw: Record<string, unknown>): HookCall {
  const str = (v: unknown) => (typeof v == "string" && v ? v : undefined);
  // The hook is a child of Claude Code (hooks.json starts it with no shell): its parent's id names the session's process.
  const base: HookPayload = {
    conversationId: str(raw.session_id),
    cwd: str(raw.cwd),
    transcriptPath: str(raw.transcript_path),
    pid: process.ppid,
  };
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
            : event == "PermissionRequest"
              ? { ...base, hookEventName: "PermissionRequest", toolCall }
              : event == "Stop"
                ? { ...base, hookEventName: "Stop", reply: str(raw.last_assistant_message) }
                : { ...base, hookEventName: str(event) };
  const reply = (answer: Record<string, unknown> | null): Record<string, unknown> => {
    // The user pressed Stop in the panel: the call does not run, and Claude Code ends the turn.
    if (event == "PreToolUse" && answer?.decision == "deny") {
      const why = "The user pressed Stop in Erga's agent panel. End the turn now.";
      return { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: why } };
    }
    // The user's own answer on the panel's card. Without one, the prompt in the terminal decides.
    if (event == "PermissionRequest" && typeof answer?.behavior == "string") {
      const decision = answer.behavior == "allow" ? { behavior: "allow" } : deny("The user denied this in Erga's agent panel.");
      return { hookSpecificOutput: { hookEventName: event, decision } };
    }
    return {};
  };
  return { payload, reply };
}

/** Creates the Claude Code AgentDriver: `claude -p` with stream-json, and the panel's prompts for the terminal sessions. */
export function createClaudeCodeDriver(log?: (line: string) => void): AgentDriver {
  const command = process.env.CLAUDE_BIN || "claude";
  const handles = new Map<string, ClaudeCodeHandle>();
  const prompts = new PanelPrompts();
  return {
    id: "claude-code",
    label: "Claude Code",
    sessionEnv: "CLAUDE_CODE_SESSION_ID",
    openHint:
      '- When the user asks to edit an Erga document URL (or create a new Erga doc), run `"${CLAUDE_PLUGIN_ROOT}/bin/erga-agent" open --agent claude-code "<url>"` to mount the live Yjs room in a local folder and connect this session to Erga\'s browser panel.',
    liveHint: LIVE_HINT,
    live: prompts,
    waitForPrompt: (session, waiter) => prompts.wait(session, waiter),
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

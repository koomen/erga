// An agent's conversation, kept step by step, so a restart (a deploy) loses
// nothing and repeats nothing. Both embedded agents use it: the document
// agent (agents/document/session.ts, its store in the person's own object,
// cloudflare/objects/person-agent.ts) and the admin agent (agents/admin/agent.ts,
// its store in the admin agents' object).
//
// The session saves a checkpoint after each step of a run: each message (the
// person's, each model turn, each tool result), the moment before a tool
// starts, and the end of the run. A checkpoint holds the model's messages
// (pi's), the transcript the panel shows, and the run's state: whether it
// was running, the messages sent while it ran, and the tool calls that began.
//
// After a restart, `resume` goes on from the last checkpoint:
// - a tool call that finished: its result is used, not run again;
// - a tool call that began but did not finish: not run again (it may have
//   changed something); the model hears that it stopped, and checks;
// - a tool call that did not begin: it runs now;
// then the model takes its next turn. Text that streamed after the last
// checkpoint is gone, and the model writes its turn again.

import type { Agent as PiAgent, AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { validateToolArguments, type AssistantMessage, type ToolResultMessage } from "@mariozechner/pi-ai";
import type { Log, LogItem } from "../shared/agent-log";

/** A run's state at its last checkpoint. */
export interface ChatState {
  /** A run was going: after a restart it goes on. */
  running: boolean;
  /** Messages the person sent that the model hasn't had yet (sent while a run was going, or just before it started). */
  queued: AgentMessage[];
  /** The last model turn's tool calls that began, and the results of those that finished, until their results are in the messages. */
  calls: Record<string, { result?: ToolResultMessage }>;
  /** The model the person chose (of MODELS), if any. */
  model: string | null;
  /** The transcript's items before this index were whole at the last checkpoint; text after it streamed since. */
  stable: number;
  /** Who and where, for whoever wakes the run again (the person, the document, the server's origin). */
  meta: Record<string, string>;
  /** When it was saved (ms). */
  at: number;
}

/** What a store holds of one conversation. */
export interface StoredChat { messages: AgentMessage[]; log: LogItem[]; state: ChatState }

/** One checkpoint, as a change: the messages and transcript items from an index on (the rest are as saved), and the state. */
export interface ChatSave {
  messages: { from: number; items: AgentMessage[] };
  log: { from: number; items: LogItem[] };
  state: ChatState;
}

/** Where a conversation is kept. */
export interface ChatStore {
  load(): Promise<StoredChat | null>;
  save(change: ChatSave): Promise<void>;
  clear(): Promise<void>;
}

/** A tool call that began and did not finish before the restart: what the model hears. */
export const STOPPED = "The server restarted while this tool call ran, so it stopped. It was not run again: it may or may not have taken effect. Check before you do it again.";
/** The same, as the panel shows it. */
export const STOPPED_SHOWN = "Stopped: the server restarted while this ran. It was not run again.";
/** A run that could not go on after a restart (the agent is off now). */
export const CUT = "The server restarted before the agent finished, and the agent is off now. What arrived is kept.";

const emptyState = (meta: Record<string, string>): ChatState => ({ running: false, queued: [], calls: {}, model: null, stable: 0, meta, at: 0 });
/** A copy that later changes to the original don't touch (what a save sends). */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The transcript, as a stored conversation shows it: text that streamed after the last checkpoint gone, tools that were running stopped. */
export function restoredLog(stored: StoredChat): Log {
  const { state } = stored;
  const items = stored.log
    .filter((item, i) => !(state.running && i >= state.stable && (item.kind == "assistant" || item.kind == "thinking")))
    .map((item): LogItem => {
      if (item.kind != "tool" || item.status != "running") return item;
      const result = state.calls[item.id]?.result;
      if (result) return { ...item, status: result.isError ? "error" : "done" };
      return { ...item, status: "error", detail: STOPPED_SHOWN };
    });
  return { items, busy: state.running || state.queued.length > 0, undoable: 0 };
}

/**
 * Keeps one session's conversation in its store. The session calls `logged`
 * after each change to its transcript, `queue` for each message it sends,
 * gives pi `beforeToolCall` and subscribes `listener` (after its own
 * listener, so the transcript has each event when the checkpoint is saved).
 */
export class Checkpoints {
  private state: ChatState;
  /** How many messages, and transcript items, the store has. */
  private savedMessages = 0;
  private savedLog = 0;
  /** The first transcript item changed since the last save. */
  private logFrom = Infinity;
  private lastState = "";
  private chain: Promise<void> = Promise.resolve();
  private pending = false;

  constructor(private store: ChatStore | null, private o: {
    log: Log;
    /** The model's messages now. */
    messages: () => AgentMessage[];
    /** Whether a run is going now (its own checkpoints then save the transcript too). */
    busy: () => boolean;
    model: () => string | null;
    meta: Record<string, string>;
    stored?: StoredChat | null;
  }) {
    const s = o.stored;
    this.state = s ? { ...copy(s.state), meta: o.meta } : emptyState(o.meta);
    if (s) { this.savedMessages = s.messages.length; this.savedLog = s.log.length; this.logFrom = 0; }
  }

  /** The state at the last checkpoint (for a test, and for `resume`). */
  get current(): Readonly<ChatState> { return this.state; }

  /** A transcript item changed (its index); saved soon, unless a run is going (its next checkpoint saves it). */
  logged(index: number): void {
    if (index >= 0) this.logFrom = Math.min(this.logFrom, index);
    if (this.o.busy() || this.pending) return;
    this.pending = true;
    queueMicrotask(() => { this.pending = false; void this.save(); });
  }

  /** A message the person sent: kept until the model has it. */
  queue(message: AgentMessage): void {
    this.state.queued.push(message);
    this.state.running = true;
    void this.save();
  }

  /** Before each tool call runs: the store knows it began, so a restart doesn't run it twice. */
  beforeToolCall = async (ctx: { toolCall: { id: string } }) => {
    this.state.calls[ctx.toolCall.id] ??= {};
    this.state.stable = this.o.log.items.length;
    await this.save();
    return undefined;
  };

  /** pi's events: a checkpoint after each message, each tool result, and at the start and end of a run. */
  listener = async (e: AgentEvent) => {
    switch (e.type) {
      case "agent_start": this.state.running = true; break;
      case "message_end": {
        const m = e.message as AgentMessage & { role: string; toolCallId?: string };
        if (m.role == "user") {
          const i = this.state.queued.findIndex((q) => q === m || q.timestamp == m.timestamp);
          if (i >= 0) this.state.queued.splice(i, 1);
        }
        else if (m.role == "toolResult") delete this.state.calls[m.toolCallId!];
        else if (m.role == "assistant") this.state.calls = {};
        break;
      }
      case "tool_execution_end":
        this.state.calls[e.toolCallId] = { result: toolResult(e.toolCallId, e.toolName, e.result, e.isError) };
        break;
      case "agent_end": this.state.running = this.state.queued.length > 0; break;
      default: return;
    }
    // At each of these the transcript is whole: no text is half streamed.
    this.state.stable = this.o.log.items.length;
    await this.save();
  };

  /** Saves what changed since the last save, after any save under way. Never fails: the conversation goes on in memory. */
  save(): Promise<void> {
    if (!this.store) return Promise.resolve();
    const change = this.change();
    if (!change) return this.chain;
    const store = this.store;
    this.chain = this.chain.then(() => store.save(change)).catch((e: unknown) => console.log(`couldn't save the agent's conversation: ${e instanceof Error ? e.message : e}`));
    return this.chain;
  }

  /** What to save now, or null if nothing changed. */
  private change(): ChatSave | null {
    const msgs = this.o.messages(), items = this.o.log.items;
    const mFrom = Math.min(this.savedMessages, msgs.length);
    const lFrom = Math.min(this.logFrom, this.savedLog, items.length);
    this.state.model = this.o.model();
    this.state.stable = this.o.busy() ? this.state.stable : items.length;
    const state = JSON.stringify({ ...this.state, at: 0 });
    if (mFrom == msgs.length && mFrom == this.savedMessages && lFrom == items.length && lFrom == this.savedLog && state == this.lastState) return null;
    this.lastState = state;
    this.savedMessages = msgs.length;
    this.savedLog = items.length;
    this.logFrom = Infinity;
    return copy({ messages: { from: mFrom, items: msgs.slice(mFrom) }, log: { from: lFrom, items: items.slice(lFrom) }, state: { ...this.state, at: Date.now() } });
  }

  /** A new conversation: the store forgets this one. */
  async clear(): Promise<void> {
    this.state = emptyState(this.o.meta);
    this.savedMessages = 0;
    this.savedLog = 0;
    this.logFrom = Infinity;
    this.lastState = "";
    const store = this.store;
    if (!store) return;
    this.chain = this.chain.then(() => store.clear()).catch((e: unknown) => console.log(`couldn't clear the agent's conversation: ${e instanceof Error ? e.message : e}`));
    await this.chain;
  }

  /**
   * Goes on with a run a restart cut off (once, for a session just restored):
   * finishes the last model turn's tool calls (see the top of this file),
   * gives the model the messages it hadn't had, and starts its next turn.
   * `handle`: the session's own handler for pi's events, so the transcript
   * and presence show the tool calls run here. Answers whether a run goes on.
   */
  async resume(agent: PiAgent | null, handle: (e: AgentEvent) => void, failed: (err: unknown) => void): Promise<boolean> {
    if (!this.state.running && !this.state.queued.length) return false;
    if (!agent) {
      this.state.running = false;
      this.state.queued = [];
      this.state.calls = {};
      await this.save();
      return false;
    }
    const msgs = agent.state.messages;
    let at = msgs.length - 1;
    while (at >= 0 && (msgs[at] as { role: string }).role != "assistant") at--;
    const last = at >= 0 ? msgs[at] as AssistantMessage : null;
    const after = msgs.slice(at + 1) as { role: string; toolCallId?: string }[];
    if (last && last.stopReason == "toolUse" && after.every((m) => m.role == "toolResult")) {
      const have = new Set(after.map((m) => m.toolCallId));
      const results: ToolResultMessage[] = [];
      for (const call of last.content.filter((c) => c.type == "toolCall")) {
        if (have.has(call.id)) continue;
        const known = this.state.calls[call.id];
        if (known?.result) results.push(known.result);
        else if (known) {
          results.push(toolResult(call.id, call.name, { content: [{ type: "text", text: STOPPED }], details: {} }, true));
          handle({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: { content: [{ type: "text", text: STOPPED_SHOWN }], details: {} }, isError: true });
        }
        else results.push(await this.runCall(agent.state.tools, call, handle));
      }
      if (results.length) agent.state.messages = [...agent.state.messages, ...results];
      this.state.calls = {};
    }
    // What the person sent that the model hadn't had: it has it now, in order.
    if (this.state.queued.length) {
      agent.state.messages = [...agent.state.messages, ...this.state.queued];
      this.state.queued = [];
    }
    const end = agent.state.messages[agent.state.messages.length - 1] as { role: string } | undefined;
    if (!end || end.role == "assistant") {
      this.state.running = false;
      await this.save();
      return false;
    }
    await this.save();
    agent.continue().catch(failed);
    return true;
  }

  /** Runs a tool call that never began, as pi would: its start, its run (marked as begun first), its result. */
  private async runCall(tools: AgentTool[], call: { id: string; name: string; arguments: Record<string, unknown> }, handle: (e: AgentEvent) => void): Promise<ToolResultMessage> {
    handle({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    let result: { content: ToolResultMessage["content"]; details: unknown }, isError = false;
    const tool = tools.find((t) => t.name == call.name);
    try {
      if (!tool) throw new Error(`Tool ${call.name} not found`);
      const args = validateToolArguments(tool, { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
      await this.beforeToolCall({ toolCall: call });
      result = await tool.execute(call.id, args as never);
    } catch (e) {
      result = { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], details: {} };
      isError = true;
    }
    const r = toolResult(call.id, call.name, result, isError);
    this.state.calls[call.id] = { result: r };
    await this.save();
    handle({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError });
    return r;
  }
}

/**
 * A message sent just as a run ended (after pi last looked for one) waits in
 * pi's queue with nothing to take it: once the run is over, it starts the next.
 */
export function sendLate(agent: PiAgent, failed: (err: unknown) => void): void {
  void agent.waitForIdle().then(() => {
    if (agent.hasQueuedMessages() && !agent.state.isStreaming) agent.continue().catch(failed);
  });
}

/** A tool's result as the model's message, as pi makes it. */
function toolResult(id: string, name: string, result: unknown, isError: boolean): ToolResultMessage {
  const r = (result ?? {}) as { content?: ToolResultMessage["content"]; details?: unknown };
  return { role: "toolResult", toolCallId: id, toolName: name, content: r.content ?? [], details: r.details ?? {}, isError, timestamp: Date.now() };
}

// ---------------------------------------------------------------- big files out of the conversation

/** A picture or a PDF in a message bigger than this (base64 characters) is kept in the blob store, by its hash, not in the conversation. */
const KEEP_OUT = 200_000;
const MARK = "erga-blob:";
/** What the model hears in place of a picture or a PDF the blob store no longer has. */
export const GONE = "[A picture or a PDF from earlier in this conversation: no longer kept.]";

/**
 * A conversation's store with its big pictures and PDFs (read's, view_page's)
 * in the blob store, by their hash: a checkpoint carries the hash, and a load
 * brings the bytes back. So a conversation that read a few PDFs stays small
 * enough to save and load (a value to or from an object is at most 32 MiB).
 */
export function withBlobs(store: ChatStore, blobs: { head(hash: string): Promise<unknown>; put(hash: string, data: Uint8Array, size: number): Promise<void>; bytes(hash: string): Promise<Uint8Array | null> }): ChatStore {
  type Block = { type?: string; data?: string; mimeType?: string };
  const out = async (block: Block): Promise<Block> => {
    if (block?.type != "image" || typeof block.data != "string" || block.data.length <= KEEP_OUT) return block;
    const bytes = Uint8Array.from(atob(block.data), (c) => c.charCodeAt(0));
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!(await blobs.head(hash))) await blobs.put(hash, bytes, bytes.length);
    return { ...block, data: MARK + hash };
  };
  const back = async (block: Block): Promise<Block | { type: "text"; text: string }> => {
    if (block?.type != "image" || typeof block.data != "string" || !block.data.startsWith(MARK)) return block;
    const bytes = await blobs.bytes(block.data.slice(MARK.length)).catch(() => null);
    if (!bytes) return { type: "text", text: GONE };
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { ...block, data: btoa(s) };
  };
  const each = async (messages: AgentMessage[], f: (b: Block) => Promise<unknown>) => Promise.all(messages.map(async (m) => {
    const content = (m as { content?: unknown }).content;
    return Array.isArray(content) ? { ...m, content: await Promise.all(content.map((b) => f(b as Block))) } as AgentMessage : m;
  }));
  return {
    load: async () => {
      const s = await store.load();
      return s && { ...s, messages: await each(s.messages, back), state: { ...s.state, queued: await each(s.state.queued, back) } };
    },
    save: async (change) => store.save({ ...change, messages: { ...change.messages, items: await each(change.messages.items, out) }, state: { ...change.state, queued: await each(change.state.queued, out) } }),
    clear: () => store.clear(),
  };
}

// An agent's conversation, kept step by step, so a restart (a deploy) loses
// nothing and repeats nothing. Each person's agent uses it (agents/person/agent.ts),
// its store in the person's own object (cloudflare/objects/person-agent.ts).
//
// The session saves a checkpoint after each step of a run: each message (the
// person's, each model turn, each tool result), the moment before a tool
// starts, and the end of the run. A checkpoint holds the model's messages
// (Effect AI's prompt messages, as JSON), the transcript the panel shows,
// and the run's state: whether it was running, the messages sent while it
// ran, and the tool calls that began.
//
// After a restart, `resume` goes on from the last checkpoint:
// - a tool call that finished: its result is used, not run again;
// - a tool call that began but did not finish: not run again (it may have
//   changed something); the model hears that it stopped, and checks;
// - a tool call that did not begin: it runs now;
// then the model takes its next turn. Text that streamed after the last
// checkpoint is gone, and the model writes its turn again.

import type { Prompt } from "effect/ai";
import type { Log, LogItem } from "../shared/agent-log";

/** One message of a conversation, as the model has it: Effect AI's prompt message, as JSON. */
export type ChatMessage = Prompt.MessageEncoded;
/** A tool's result, as the model has it: a tool message with one result. */
export type ToolResultMessage = Prompt.ToolMessageEncoded;

/** A run's state at its last checkpoint. */
export interface ChatState {
  /** A run was going: after a restart it goes on. */
  running: boolean;
  /** Messages the person sent that the model hasn't had yet (sent while a run was going, or just before it started). */
  queued: ChatMessage[];
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
export interface StoredChat {
  messages: ChatMessage[];
  log: LogItem[];
  state: ChatState;
}

/** One checkpoint, as a change: the messages and transcript items from an index on (the rest are as saved), and the state. */
export interface ChatSave {
  messages: { from: number; items: ChatMessage[] };
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
/** A call that waited for the person's Approve when the server restarted, as the panel shows it. */
export const ASK_LOST = "Not run: the server restarted before you answered. Ask again.";
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
      // A call that waited for the person's Approve is closed: a restart never leaves a question that nothing answers.
      if (item.kind == "tool" && item.status == "asking") return { ...item, status: "error", detail: ASK_LOST };
      if (item.kind != "tool" || item.status != "running") return item;
      const result = state.calls[item.id]?.result;
      if (result) return { ...item, status: result.content.some((p) => p.type == "tool-result" && p.isFailure) ? "error" : "done" };
      return { ...item, status: "error", detail: STOPPED_SHOWN };
    });
  return { items, busy: state.running || state.queued.length > 0, undoable: 0 };
}

/**
 * Keeps one session's conversation in its store. The loop (agents/run.ts)
 * calls `logged` after each change to its transcript, `queue` for each
 * message it sends, and the step methods (`started`, `took`, `answered`,
 * `beforeToolCall`, `toolEnded`, `ended`) as a run goes, each after the
 * transcript has the step, so a checkpoint has both.
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
    messages: () => ChatMessage[];
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
  queue(message: ChatMessage): void {
    this.state.queued.push(message);
    this.state.running = true;
    void this.save();
  }

  /** A run started. */
  started(): Promise<void> {
    this.state.running = true;
    return this.step();
  }

  /** The model has a message the person sent (it's in the messages now). */
  took(message: ChatMessage): Promise<void> {
    const i = this.state.queued.indexOf(message);
    if (i >= 0) this.state.queued.splice(i, 1);
    return this.step();
  }

  /** The model's turn is in the messages: its tool calls begin from here. */
  answered(): Promise<void> {
    this.state.calls = {};
    return this.step();
  }

  /** Before each tool call runs: the store knows it began, so a restart doesn't run it twice. */
  beforeToolCall(id: string): Promise<void> {
    this.state.calls[id] ??= {};
    return this.step();
  }

  /** A tool call's result: kept, then (once it's in the messages, `inMessages`) no longer needed apart. */
  async toolEnded(id: string, result: ToolResultMessage, inMessages: () => void): Promise<void> {
    this.state.calls[id] = { result };
    await this.step();
    inMessages();
    delete this.state.calls[id];
    await this.step();
  }

  /**
   * Stop (agents/turn.ts): the messages sent before it are no longer waiting (the turn puts them in the messages,
   * unanswered), so a restart doesn't answer them. A run goes on after a restart only for messages sent after Stop.
   */
  unqueue(messages: readonly ChatMessage[]): Promise<void> {
    this.state.queued = this.state.queued.filter((m) => !messages.includes(m));
    this.state.running = this.state.queued.length > 0;
    return this.save();
  }

  /** The run ended (done, stopped or failed): it goes on only for messages still waiting. */
  ended(): Promise<void> {
    this.state.running = this.state.queued.length > 0;
    return this.step();
  }

  /** A checkpoint: the transcript is whole here (no text is half streamed). */
  private step(): Promise<void> {
    this.state.stable = this.o.log.items.length;
    return this.save();
  }

  /** Forgets the run's state: it can't go on (the agent is off now). */
  async drop(): Promise<void> {
    this.state.running = false;
    this.state.queued = [];
    this.state.calls = {};
    await this.save();
  }

  /** Clears the calls of a turn whose results are all in the messages, and the messages `resume` put in the messages (`taken`). */
  async resumed(running: boolean, taken: readonly ChatMessage[]): Promise<void> {
    this.state.calls = {};
    this.state.queued = this.state.queued.filter((m) => !taken.includes(m));
    this.state.running = running || this.state.queued.length > 0;
    await this.save();
  }

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
    // As `change` would see the empty conversation: nothing to save until something changes.
    this.state.model = this.o.model();
    this.lastState = JSON.stringify({ ...this.state, at: 0 });
    const store = this.store;
    if (!store) return;
    this.chain = this.chain.then(() => store.clear()).catch((e: unknown) => console.log(`couldn't clear the agent's conversation: ${e instanceof Error ? e.message : e}`));
    await this.chain;
  }
}

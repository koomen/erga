// An agent's conversation, kept step by step, so a restart (a deploy) loses
// nothing and repeats nothing. Both embedded agents use it: the document
// agent (agents/document/session.ts, its store in the person's own object,
// cloudflare/objects/person-agent.ts) and the admin agent (agents/admin/agent.ts,
// its store in the admin agents' object).
//
// The session saves a checkpoint after each step of a run: each message (the
// person's, each model turn, each tool result), the moment before a tool
// starts, and the end of the run. A checkpoint holds the model's messages
// (Effect AI's prompt messages, as JSON), the transcript the panel shows,
// and the run's state: whether it was running, the messages sent while it
// ran, and the tool calls that began.
//
// Conversations kept before 2026-10-28 hold pi's messages (the agents ran on
// pi then): `fromPi` turns each into Effect AI's when it's loaded.
//
// After a restart, `resume` goes on from the last checkpoint:
// - a tool call that finished: its result is used, not run again;
// - a tool call that began but did not finish: not run again (it may have
//   changed something); the model hears that it stopped, and checks;
// - a tool call that did not begin: it runs now;
// then the model takes its next turn. Text that streamed after the last
// checkpoint is gone, and the model writes its turn again.

import { Base64 } from "effect/encoding";
import * as Result from "effect/Result";
import type { Prompt } from "effect/ai";
import type { Log, LogItem } from "../shared/agent-log";
import { sha256Hex } from "../shared/bytes";

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

  /** Clears the calls of a turn whose results are all in the messages, and the queue (`resume` put it in the messages). */
  async resumed(running: boolean): Promise<void> {
    this.state.calls = {};
    this.state.queued = [];
    this.state.running = running;
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
    this.lastState = "";
    const store = this.store;
    if (!store) return;
    this.chain = this.chain.then(() => store.clear()).catch((e: unknown) => console.log(`couldn't clear the agent's conversation: ${e instanceof Error ? e.message : e}`));
    await this.chain;
  }
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
  // A file part (Effect AI's) or an image block (pi's, in a conversation kept before): base64 in `data`.
  type Block = { type?: string; data?: unknown; modelOutput?: Block[] };
  const big = (b: Block) => (b?.type == "file" || b?.type == "image") && typeof b.data == "string";
  const out = async (block: Block): Promise<Block> => {
    if (block?.type == "tool-result" && Array.isArray(block.modelOutput))
      return { ...block, modelOutput: await Promise.all(block.modelOutput.map(out)) };
    if (!big(block) || (block.data as string).length <= KEEP_OUT) return block;
    const bytes = Result.getOrThrow(Base64.decode(block.data as string));
    const hash = await sha256Hex(bytes);
    if (!(await blobs.head(hash))) await blobs.put(hash, bytes, bytes.length);
    return { ...block, data: MARK + hash };
  };
  const back = async (block: Block): Promise<Block | { type: "text"; text: string }> => {
    if (block?.type == "tool-result" && Array.isArray(block.modelOutput))
      return { ...block, modelOutput: await Promise.all(block.modelOutput.map(back)) };
    if (!big(block) || !(block.data as string).startsWith(MARK)) return block;
    const bytes = await blobs.bytes((block.data as string).slice(MARK.length)).catch(() => null);
    if (!bytes) return { type: "text", text: GONE };
    return { ...block, data: Base64.encode(bytes) };
  };
  const each = async (messages: ChatMessage[], f: (b: Block) => Promise<unknown>) =>
    Promise.all(
      messages.map(async (m) => {
        const content = (m as { content?: unknown }).content;
        return Array.isArray(content) ? ({ ...m, content: await Promise.all(content.map((b) => f(b as Block))) } as ChatMessage) : m;
      })
    );
  const results = async (calls: ChatState["calls"], f: (b: Block) => Promise<unknown>) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(calls).map(
          async ([id, c]) => [id, c.result ? { result: (await each([c.result], f))[0] as ToolResultMessage } : {}] as const
        )
      )
    );
  return {
    load: async () => {
      const s = await store.load();
      return (
        s && {
          ...s,
          messages: await each(s.messages, back),
          state: { ...s.state, queued: await each(s.state.queued, back), calls: await results(s.state.calls, back) },
        }
      );
    },
    save: async (change) =>
      store.save({
        ...change,
        messages: { ...change.messages, items: await each(change.messages.items, out) },
        state: { ...change.state, queued: await each(change.state.queued, out), calls: await results(change.state.calls, out) },
      }),
    clear: () => store.clear(),
  };
}

// ---------------------------------------------------------------- conversations kept by pi

type PiBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  thinking?: string;
  thinkingSignature?: string;
  redacted?: boolean;
  id?: string;
  name?: string;
  arguments?: unknown;
};
type PiMessage = {
  role: string;
  content?: string | PiBlock[];
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

const fromPiBlock = (b: PiBlock): Prompt.TextPartEncoded | Prompt.FilePartEncoded =>
  b.type == "image" ? { type: "file", mediaType: b.mimeType ?? "image/png", data: b.data ?? "" } : { type: "text", text: b.text ?? "" };

/**
 * A conversation's messages as Effect AI has them: each message pi kept
 * (before 2026-10-28) turned into Effect AI's, the others as they are. A turn
 * that failed or was stopped (it never reached the model's history), and a
 * result whose call isn't there, go.
 */
export function fromPi(messages: readonly unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const calls = new Set<string>();
  for (const raw of messages) {
    const m = raw as PiMessage;
    if (m.role == "user" && (typeof m.content == "string" || m.content?.some((b) => b.type == "image"))) {
      out.push({ role: "user", content: typeof m.content == "string" ? [{ type: "text", text: m.content }] : m.content.map(fromPiBlock) });
    } else if (m.role == "assistant" && "stopReason" in m) {
      if (m.stopReason == "error" || m.stopReason == "aborted") continue;
      const content: Prompt.AssistantMessageEncoded["content"] & unknown[] = [];
      for (const b of (m.content as PiBlock[] | undefined) ?? []) {
        if (b.type == "text" && b.text) content.push({ type: "text", text: b.text });
        else if (b.type == "thinking" && b.thinkingSignature)
          content.push({
            type: "reasoning",
            text: b.thinking ?? "",
            options: {
              anthropic: b.redacted
                ? { info: { type: "redacted_thinking", redactedData: b.thinkingSignature } }
                : { info: { type: "thinking", signature: b.thinkingSignature } },
            },
          });
        else if (b.type == "toolCall" && b.id && b.name) {
          calls.add(b.id);
          content.push({ type: "tool-call", id: b.id, name: b.name, params: b.arguments ?? {}, providerExecuted: false });
        }
      }
      if (content.length) out.push({ role: "assistant", content });
    } else if (m.role == "toolResult") {
      if (calls.has(m.toolCallId!)) out.push(fromPiResult(m));
    } else out.push(raw as ChatMessage);
  }
  return out;
}

/** A tool's result pi kept (in a message, or a checkpoint's calls). */
export const fromPiResult = (m: unknown): ToolResultMessage => {
  const r = m as PiMessage;
  if (r.role != "toolResult") return m as ToolResultMessage;
  const blocks = Array.isArray(r.content) ? r.content : [];
  const text = blocks
    .filter((b) => b.type == "text")
    .map((b) => b.text ?? "")
    .join("\n");
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        id: r.toolCallId!,
        name: r.toolName ?? "",
        isFailure: !!r.isError,
        result: text,
        modelOutput: blocks.map(fromPiBlock),
        providerExecuted: false,
      },
    ],
  };
};

/** A conversation as a store kept it, in Effect AI's messages (`fromPi`). */
export function fromPiChat(s: StoredChat): StoredChat {
  const calls = Object.fromEntries(
    Object.entries(s.state.calls ?? {}).map(([id, c]) => [id, c.result ? { result: fromPiResult(c.result) } : {}])
  );
  return { ...s, messages: fromPi(s.messages), state: { ...s.state, queued: fromPi(s.state.queued ?? []), calls } };
}

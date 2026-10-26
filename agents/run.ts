// The agent loop both embedded agents run (the document agent,
// agents/document/session.ts, and the admin agent, agents/admin/agent.ts): the
// model a conversation is on (the one its store kept, else the settings'),
// the transcript and its listeners, the checkpoints that keep each step
// (agents/checkpoint.ts: a restart neither loses nor repeats work), pi's
// agent and the events that become the transcript's (shared/agent-log.ts).
// Each agent adds its own through `LoopHooks`: what a tool call is about,
// and (the document agent) its presence in the room while it works.

import { Agent as PiAgent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import * as Redacted from "effect/Redacted";
import { fileRefs, messageContent, type Attachment } from "../shared/attach";
import { emptyLog, offerOf, reduce, type Log, type LogEvent } from "../shared/agent-log";
import { CUT, Checkpoints, restoredLog, sendLate, type ChatStore, type StoredChat } from "./checkpoint";
import { DEFAULT_MODEL, describeModel, isModelChoice, isScript, patchPayload, resultImage, resultText, scriptModel, type AgentConfig, type ModelChoice } from "./models";

export interface LoopHooks {
  /** What a tool call is about, for the panel: a path, a setting's key, a login. */
  about(name: string, args: unknown): string | null;
  /** A tool call started (`about` its path) or ended. */
  toolStarted?(name: string, about: string | null): void;
  toolEnded?(): void;
  /** A run started, or ended (done, stopped or failed): before the transcript says so. */
  busy?(on: boolean): void;
}

export interface LoopOptions {
  /** The settings now; null while the agent is off (no key). */
  cfg: AgentConfig | null;
  /** The conversation as the store had it, to go on with. */
  stored: StoredChat | null;
  /** Where the conversation is kept, step by step; without it, only in memory. */
  store: ChatStore | null;
  /** What the store keeps beside it, for whoever wakes a run after a restart. */
  meta: Record<string, string>;
  /** The tag a message's context goes in ("<editor>" in a document, "<page>" on the admin pages). */
  tag: string;
  hooks: LoopHooks;
}

export interface AgentLoop {
  readonly log: Log;
  /** pi's agent, once there are settings (`start`); null while the agent is off. */
  readonly agent: PiAgent | null;
  readonly cfg: AgentConfig | null;
  /** The model's name, or null while the agent is off. */
  readonly model: string | null;
  /** The model it's on, of MODELS; null when off or scripted (nothing to switch). */
  readonly modelChoice: ModelChoice | null;
  emit(ev: LogEvent): void;
  subscribe(listener: (ev: LogEvent) => void): () => void;
  /** Makes the model's side, with its first settings, prompt and tools. */
  start(first: AgentConfig, systemPrompt: string, tools: AgentTool[]): PiAgent;
  /** The settings now: the next model call uses them. */
  configure(cfg: AgentConfig | null): void;
  setModel(choice: ModelChoice): boolean;
  /**
   * A message, with any files attached; while a run goes on it steers it.
   * `refresh` runs before a new run starts (the tools and prompt as they are
   * now); a message sent meanwhile steers that run too.
   */
  prompt(text: string, context: string | null, files: Attachment[], refresh?: (agent: PiAgent) => Promise<void>): void;
  abort(): void;
  /** Forgets the conversation; `then` runs before the transcript says so. */
  reset(then?: () => void): Promise<void>;
  /** Goes on with a run that a restart cut off, from its last checkpoint (the first call only). Answers whether a run goes on. */
  resume(): Promise<boolean>;
}

export function startLoop(opts: LoopOptions): AgentLoop {
  const { stored, hooks } = opts;
  let cfg = opts.cfg;
  /** The model the store kept, if it's one of MODELS. */
  const kept = stored && isModelChoice(stored.state.model ?? "") ? (stored.state.model as ModelChoice) : null;
  let choice: ModelChoice | null = cfg == null || cfg.model == "script" ? null : kept ?? cfg.model;
  let agent: PiAgent | null = null;
  /** The model's messages while it has no model side yet (the agent off): the stored ones, until a reset. */
  let offMessages = stored?.messages ?? [];
  /** A new run's tools are being looked up (`refresh`): a message sent now steers it. */
  let starting = false;
  let resumed = false;

  const log = stored ? restoredLog(stored) : emptyLog();
  const listeners = new Set<(ev: LogEvent) => void>();
  // tool_execution_end carries no args; keep each call's path from its start event.
  const paths = new Map<string, string | null>();
  const emit = (ev: LogEvent) => {
    if (ev.t == "tool") {
      if (ev.status == "running") paths.set(ev.id, ev.path);
      else ev = { ...ev, path: paths.get(ev.id) ?? null };
    }
    checkpoints.logged(reduce(log, ev));
    for (const l of listeners) l(ev);
  };
  // Each step of a run, kept in the store; a restart goes on from the last.
  const checkpoints = new Checkpoints(opts.store, {
    log, stored, meta: opts.meta,
    messages: () => agent?.state.messages ?? offMessages,
    busy: () => !!agent?.state.isStreaming,
    model: () => choice,
  });
  /** A run that ended in a failure outside the model's answer (pi threw). */
  const failed = (err: unknown) => {
    starting = false;
    emit({ t: "error", text: err instanceof Error ? err.message : String(err) });
    hooks.busy?.(false);
    emit({ t: "busy", busy: false });
  };
  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case "message_update": {
        const m = e.assistantMessageEvent;
        if (m.type == "text_delta") emit({ t: "text", delta: m.delta });
        else if (m.type == "thinking_delta") emit({ t: "thinking", delta: m.delta });
        break;
      }
      case "message_end": {
        const msg = e.message as { role?: string; stopReason?: string; errorMessage?: string };
        if (msg.role == "assistant" && msg.stopReason == "error") emit({ t: "error", text: msg.errorMessage || "The request failed." });
        break;
      }
      case "tool_execution_start": {
        const path = hooks.about(e.toolName, e.args);
        hooks.toolStarted?.(e.toolName, path);
        emit({ t: "tool", id: e.toolCallId, name: e.toolName, path, status: "running" });
        break;
      }
      case "tool_execution_end":
        hooks.toolEnded?.();
        emit({
          t: "tool", id: e.toolCallId, name: e.toolName, path: null,
          status: e.isError ? "error" : "done",
          detail: e.isError ? resultText(e.result).slice(0, 400) : undefined,
          image: e.isError ? undefined : resultImage(e.result),
          offer: e.isError ? undefined : offerOf(e.result),
        });
        break;
      case "agent_start": hooks.busy?.(true); emit({ t: "busy", busy: true }); break;
      case "agent_end": hooks.busy?.(false); emit({ t: "busy", busy: false }); if (agent) sendLate(agent, failed); break;
    }
  };

  return {
    log,
    get agent() { return agent; },
    get cfg() { return cfg; },
    get model() { return agent?.state.model.name ?? null; },
    get modelChoice() { return choice; },
    emit,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(first, systemPrompt, tools) {
      choice = first.model == "script" ? null : kept ?? first.model;
      const a = new PiAgent({
        initialState: { systemPrompt, model: choice == null ? scriptModel() : describeModel(choice), thinkingLevel: "medium", tools, messages: offMessages },
        getApiKey: () => (cfg ? Redacted.value(cfg.apiKey) : "") || "none",
        onPayload: isScript(first) ? undefined : patchPayload(() => cfg ?? first, () => choice ?? DEFAULT_MODEL),
        beforeToolCall: checkpoints.beforeToolCall,
      });
      // The loop's handler first, so the transcript has each event when its checkpoint is saved.
      a.subscribe(onEvent);
      a.subscribe(checkpoints.listener);
      agent = a;
      return a;
    },
    configure(next) { cfg = next; },
    setModel(next) {
      if (!agent || choice == null || !isModelChoice(next)) return false;
      choice = next;
      agent.state.model = describeModel(next);
      return true;
    },
    prompt(text, context, files, refresh) {
      emit(files.length ? { t: "user", text, files: fileRefs(files) } : { t: "user", text });
      const a = agent;
      if (!a || !cfg) { emit({ t: "error", text: "The agent is off." }); return; }
      const content = messageContent(context ? `<${opts.tag}>\n${context}\n</${opts.tag}>\n\n${text}` : text, files);
      if (isScript(cfg)) scriptModel();
      const message = { role: "user" as const, content, timestamp: Date.now() };
      // Kept until the model has it: a restart before then doesn't lose it.
      checkpoints.queue(message);
      if (a.state.isStreaming || starting) { a.steer(message); return; }
      if (!refresh) { a.prompt(message).catch(failed); return; }
      starting = true;
      refresh(a).then(() => { starting = false; return a.prompt(message); }).catch(failed);
    },
    abort: () => agent?.abort(),
    async reset(then) {
      if (agent) {
        agent.abort();
        await agent.waitForIdle();
        agent.reset();
      }
      paths.clear();
      offMessages = [];
      await checkpoints.clear();
      then?.();
      emit({ t: "reset" });
    },
    async resume() {
      if (resumed) return false;
      resumed = true;
      const was = checkpoints.current.running || checkpoints.current.queued.length > 0;
      const going = await checkpoints.resume(agent, onEvent, failed);
      // A run with nothing left to do, or that can't go on (the agent is off now), ends here.
      if (was && !going) {
        if (!agent) emit({ t: "error", text: CUT });
        emit({ t: "busy", busy: false });
      }
      return going;
    },
  };
}

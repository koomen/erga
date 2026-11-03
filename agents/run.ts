// The agent loop each person's agent runs (agents/person/agent.ts): the
// model a conversation is on (the one its store kept, else the settings'),
// the transcript and its listeners, the checkpoints that keep each step
// (agents/checkpoint.ts: a restart neither loses nor repeats work), and the
// run itself on Effect AI: the model streams its turn (text and thinking go
// to the transcript as they come), the loop runs the turn's tool calls one
// by one, and goes on until the model answers with no calls and no message
// waits. A message sent while a run goes on steers it: the model has it at
// its next turn. The agent adds its own through `LoopHooks`: what a tool call is about.
//
// The sessions are the Promise edge (the person's object calls them: agents/person/sessions.ts); a run is a fiber,
// so `abort` interrupts it.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type AiError, LanguageModel, Prompt, Tool, type Response, type Toolkit } from "effect/ai";
import { fileRefs, messageContent, type Attachment } from "../shared/attach";
import { emptyLog, offerOf, reduce, type Log, type LogEvent } from "../shared/agent-log";
import type { ToolContent } from "../document/agent";
import {
  CUT,
  Checkpoints,
  STOPPED,
  STOPPED_SHOWN,
  fromPiChat,
  restoredLog,
  type ChatMessage,
  type ChatStore,
  type StoredChat,
  type ToolResultMessage,
} from "./checkpoint";
import { fit, isModelChoice, languageModel, messagesFor, modelError, MODELS, usable, type AgentConfig, type ModelChoice } from "./models";
import type { Usable } from "../shared/models";

/** What a tool answers: content for the model (and the panel), and an `offer` (a button for the person) for the panel. */
export interface ToolOutput {
  content: ToolContent[];
  details?: { offer?: unknown };
}

/** A tool, as the embedded agents run it: its arguments as an Effect Schema (the model gets its JSON Schema). */
export interface AgentTool {
  readonly name: string;
  /** For the agent panel. */
  readonly label?: string;
  /** What the agent is doing while it runs ("sharing the document"): the document agent's presence shows it. */
  readonly activity?: string;
  readonly description: string;
  readonly parameters: Schema.Top;
  /** Runs with its arguments decoded; throws (an Error whose message the model reads) when it fails. */
  execute(id: string, params: Record<string, unknown>): Promise<ToolOutput>;
}

export interface LoopHooks {
  /** What a tool call is about, for the panel: a path, a setting's key, a login. */
  about(name: string, args: unknown): string | null;
  /** A tool call started (`about` its path) or ended. */
  toolStarted?(name: string, about: string | null): void;
  toolEnded?(): void;
  /** A run started, or ended (done, stopped or failed): before the transcript says so. */
  busy?(on: boolean): void;
  /** The model changed by itself: the one it was on can't be used now (its key went, or the admin turned it off). */
  modelChanged?(): void;
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

/** The model's side: its prompt and tools, once there are settings (`start`). */
export interface ModelSide {
  systemPrompt: string;
  tools: AgentTool[];
}

export interface AgentLoop {
  readonly log: Log;
  /** The model's side, once there are settings; null while the agent is off. */
  readonly side: ModelSide | null;
  /** The model's messages so far. */
  readonly messages: readonly ChatMessage[];
  readonly cfg: AgentConfig | null;
  /** The model's name, or null while the agent is off. */
  readonly model: string | null;
  /** The model it's on, of MODELS; null when off, or scripted with no keys (nothing to switch). */
  readonly modelChoice: ModelChoice | null;
  /** The models the person can switch between now (none when there's nothing to switch). */
  readonly models: Usable[];
  emit(ev: LogEvent): void;
  subscribe(listener: (ev: LogEvent) => void): () => void;
  /** Makes the model's side, with its first settings, prompt and tools. */
  start(first: AgentConfig, systemPrompt: string, tools: AgentTool[]): ModelSide;
  /** The settings now: the next model call uses them. */
  configure(cfg: AgentConfig | null): void;
  setModel(choice: ModelChoice): boolean;
  /**
   * A message, with any files attached; while a run goes on it steers it.
   * `refresh` runs before a new run starts (the tools and prompt as they are
   * now); a message sent meanwhile steers that run too.
   */
  prompt(text: string, context: string | null, files: Attachment[], refresh?: (side: ModelSide) => Promise<void>): void;
  abort(): void;
  /** Forgets the conversation; `then` runs before the transcript says so. */
  reset(then?: () => void): Promise<void>;
  /** Goes on with a run that a restart cut off, from its last checkpoint (the first call only). Answers whether a run goes on. */
  resume(): Promise<boolean>;
}

/** A tool's result as the model has it: the text as the result, and every part (a picture, a PDF) for the model. */
export function toolMessage(id: string, name: string, out: ToolOutput, isFailure: boolean): ToolResultMessage {
  const text = out.content.flatMap((c) => (c.type == "text" ? [c.text] : [])).join("\n");
  const modelOutput = out.content.map((c) =>
    c.type == "text" ? { type: "text" as const, text: c.text } : { type: "file" as const, mediaType: c.mimeType, data: c.data }
  );
  return { role: "tool", content: [{ type: "tool-result", id, name, isFailure, result: text, modelOutput, providerExecuted: false }] };
}

/** A failure's words as the model reads them. */
const failure = (text: string): ToolOutput => ({ content: [{ type: "text", text }] });

/** A tool result's image (view_page's screenshot), as a data URL for the panel. */
export function resultImage(out: ToolOutput): string | undefined {
  const img = out.content.find((c) => c.type == "image" && c.data && c.mimeType.startsWith("image/"));
  return img && img.type == "image" ? `data:${img.mimeType};base64,${img.data}` : undefined;
}

export const resultText = (out: ToolOutput) =>
  out.content
    .flatMap((c) => (c.type == "text" ? [c.text] : []))
    .join("\n")
    .trim();

/**
 * A tool's arguments as JSON Schema, as every list of tools gives them (the model's, GET /api/tools, MCP's
 * tools/list): always an object's schema, as Anthropic and MCP require. Effect writes an empty Struct (a tool with
 * no arguments) as {"not": {"type": "null"}}: that one is an object with none. What says nothing goes, as each list
 * carries it to the model: an integer's bounds of a safe integer, additionalProperties: true (the default), and the
 * descriptions inside an anyOf that has its own (and an anyOf in one, flattened; a member twice, once).
 */
export function argumentsSchema(parameters: Schema.Top): { type: "object"; properties?: Record<string, unknown>; required?: string[] } {
  const schema = tidy(Tool.getJsonSchemaFromSchema(parameters)) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return schema.type == "object" ? (schema as { type: "object" }) : { type: "object", properties: {} };
}

type Json = { [k: string]: unknown };
function tidy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tidy);
  if (!v || typeof v != "object") return v;
  const out: Json = {};
  for (const [k, x] of Object.entries(v as Json)) {
    if ((k == "minimum" || k == "maximum") && Math.abs(x as number) == Number.MAX_SAFE_INTEGER) continue;
    if (k == "additionalProperties" && x === true) continue;
    out[k] = tidy(x);
  }
  if (Array.isArray(out.anyOf) && out.description) {
    const members = (out.anyOf as Json[]).flatMap(function bare(m): Json[] {
      const { description: _, ...rest } = m;
      return Array.isArray(rest.anyOf) && Object.keys(rest).length == 1 ? (rest.anyOf as Json[]).flatMap(bare) : [rest];
    });
    out.anyOf = [...new Map(members.map((m) => [JSON.stringify(m), m])).values()];
  }
  return out;
}

/** The tools as the model gets them: each one's JSON Schema; the loop runs them, never the model's toolkit. */
function toolkitOf(tools: AgentTool[]): Toolkit.WithHandler<Record<string, Tool.Any>> {
  const byName = Object.fromEntries(
    tools.map((t) => [t.name, Tool.dynamic(t.name, { description: t.description, parameters: argumentsSchema(t.parameters) as never })])
  );
  return { tools: byName as never, handle: () => Effect.die("the loop runs the tools") };
}

const CACHED = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

/** The prompt for a turn, as the model of `choice` takes it: the system prompt, then the messages; both ends marked for the prompt cache. */
function promptOf(side: ModelSide, messages: readonly ChatMessage[], choice: ModelChoice | null): Prompt.RawInput {
  const last = messages.length - 1;
  return [
    { role: "system", content: side.systemPrompt, options: CACHED },
    ...messagesFor(choice, messages).map((m, i) => (i == last ? ({ ...m, options: CACHED } as ChatMessage) : m)),
  ];
}

const encodeMessages = Schema.encodeSync(Prompt.Prompt);

export function startLoop(opts: LoopOptions): AgentLoop {
  const { hooks } = opts;
  const stored = opts.stored && fromPiChat(opts.stored);
  let cfg = opts.cfg;
  /** The model the store kept, if it's one of MODELS. */
  const kept = stored && isModelChoice(stored.state.model ?? "") ? (stored.state.model as ModelChoice) : null;
  /** The model it's on: the one kept, if the person can use it now; null with no model to use (or scripted with no keys). */
  let choice: ModelChoice | null = cfg ? fit(cfg, kept) : null;
  let side: ModelSide | null = null;
  let messages: ChatMessage[] = stored?.messages ?? [];
  /** Messages sent while a run goes on: the model has them at its next turn. */
  const steering: ChatMessage[] = [];
  let run: Fiber.Fiber<void> | null = null;
  /** A new run's tools are being looked up (`refresh`): a message sent now steers it. */
  let starting = false;
  let resumed = false;

  const log = stored ? restoredLog(stored) : emptyLog();
  const listeners = new Set<(ev: LogEvent) => void>();
  // A tool's end carries no args; keep each call's path and name from its start.
  const paths = new Map<string, { path: string | null; name: string }>();
  const emit = (ev: LogEvent) => {
    if (ev.t == "tool") {
      if (ev.status == "running") paths.set(ev.id, { path: ev.path, name: ev.name });
      else ev = { ...ev, path: paths.get(ev.id)?.path ?? null, name: paths.get(ev.id)?.name ?? ev.name };
    }
    checkpoints.logged(reduce(log, ev));
    for (const l of listeners) l(ev);
  };
  // Each step of a run, kept in the store; a restart goes on from the last.
  const checkpoints = new Checkpoints(opts.store, {
    log,
    stored,
    meta: opts.meta,
    messages: () => messages,
    busy: () => run != null,
    model: () => choice,
  });

  /** A call begins: the panel names the operation that a tool of several runs (its `op`). */
  const toolStarted = (id: string, tool: string, args: unknown) => {
    const op = (args as { op?: unknown } | null)?.op;
    const name = typeof op == "string" ? op : tool;
    const path = hooks.about(name, args);
    hooks.toolStarted?.(name, path);
    emit({ t: "tool", id, name, path, status: "running" });
  };
  const toolEnded = (id: string, name: string, out: ToolOutput, isError: boolean) => {
    hooks.toolEnded?.();
    emit({
      t: "tool",
      id,
      name,
      path: null,
      status: isError ? "error" : "done",
      detail: isError ? resultText(out).slice(0, 400) : undefined,
      image: isError ? undefined : resultImage(out),
      offer: isError ? undefined : offerOf(out),
    });
  };

  /** Runs one tool call: marked as begun first, its arguments checked against its schema, its result kept. */
  const runCall = (call: { id: string; name: string; params: unknown }) =>
    Effect.gen(function* () {
      toolStarted(call.id, call.name, call.params);
      const tool = side?.tools.find((t) => t.name == call.name);
      yield* Effect.promise(() => checkpoints.beforeToolCall(call.id));
      const outcome = yield* Effect.gen(function* () {
        if (!tool) return yield* Effect.fail(`Tool ${call.name} not found`);
        const params = yield* Schema.decodeUnknownEffect(tool.parameters as Schema.Codec<unknown>)(call.params, { errors: "all" }).pipe(
          Effect.mapError((e) => `Validation failed for tool "${call.name}":\n${e.message}`)
        );
        return yield* Effect.tryPromise({
          try: () => tool.execute(call.id, params as Record<string, unknown>),
          catch: (e) => (e instanceof Error ? e.message : String(e)),
        });
      }).pipe(Effect.result);
      const [out, isError] = outcome._tag == "Success" ? [outcome.success, false] : [failure(outcome.failure), true];
      const message = toolMessage(call.id, call.name, out, isError);
      yield* Effect.promise(() =>
        checkpoints.toolEnded(call.id, message, () => {
          messages = [...messages, message];
        })
      );
      toolEnded(call.id, call.name, out, isError);
    });

  /** The calls of the last turn that have no result yet. */
  const open = () => {
    let at = messages.length - 1;
    while (at >= 0 && messages[at].role != "assistant") at--;
    if (at < 0) return [];
    const done = new Set(
      messages.slice(at + 1).flatMap((m) => (m.role == "tool" ? m.content.flatMap((p) => (p.type == "tool-result" ? [p.id] : [])) : []))
    );
    const calls = (messages[at] as Prompt.AssistantMessageEncoded).content;
    return (typeof calls == "string" ? [] : calls).flatMap((p) =>
      p.type == "tool-call" && !done.has(p.id) ? [{ id: p.id, name: p.name, params: p.params }] : []
    );
  };

  /** One model turn: streamed into the transcript, then into the messages. Fails with the model's error, in its words. */
  const turn = (s: ModelSide, c: AgentConfig): Effect.Effect<boolean, string> =>
    Effect.gen(function* () {
      const parts: Response.AnyPart[] = [];
      const prompt = promptOf(s, messages, choice);
      const stream = s.tools.length
        ? LanguageModel.streamText({ prompt, toolkit: toolkitOf(s.tools), disableToolCallResolution: true, toolCallValidation: "deferred" })
        : LanguageModel.streamText({ prompt });
      yield* (stream as Stream.Stream<Response.AnyPart, AiError.AiError, LanguageModel.LanguageModel>).pipe(
        Stream.runForEach((part) =>
          Effect.sync(() => {
            parts.push(part);
            if (part.type == "text-delta" && part.delta) emit({ t: "text", delta: part.delta });
            else if (part.type == "reasoning-delta" && part.delta) emit({ t: "thinking", delta: part.delta });
          })
        ),
        Effect.provide(languageModel(c, choice)),
        // A defect too (a bug, a provider's surprise): the person sees what went wrong, and the run ends.
        Effect.catchCause((cause) => Effect.fail(modelError(Cause.squash(cause))))
      );
      const answer = encodeMessages(Prompt.fromResponseParts(parts)).content.filter((m) => m.role == "assistant");
      messages = [...messages, ...answer];
      yield* Effect.promise(() => checkpoints.answered());
      return answer.some((m) => typeof m.content != "string" && m.content.some((p) => p.type == "tool-call"));
    }) as Effect.Effect<boolean, string>;

  /** A run: turns and their tool calls, until the model is done and no message waits. */
  const runLoop = Effect.gen(function* () {
    hooks.busy?.(true);
    emit({ t: "busy", busy: true });
    yield* Effect.promise(() => checkpoints.started());
    while (true) {
      for (const call of open()) yield* runCall(call);
      while (steering.length) {
        const m = steering.shift()!;
        messages = [...messages, m];
        yield* Effect.promise(() => checkpoints.took(m));
      }
      const s = side,
        c = cfg;
      if (!s || !c) return;
      // The model may not be usable now (its key went, the admin turned it off): never run it then.
      refit(c);
      if (choice == null && c.model != "script") return;
      const calls = yield* turn(s, c).pipe(
        Effect.catch((text) =>
          Effect.sync(() => {
            emit({ t: "error", text: text || "The request failed." });
            return null;
          })
        )
      );
      if (calls == null) return;
      if (!calls && !steering.length) return;
    }
  }).pipe(
    // Stopped: each call of the turn that has no result gets one, so the messages stay whole for the next run.
    Effect.onInterrupt(() =>
      Effect.promise(async () => {
        for (const call of open()) {
          const message = toolMessage(call.id, call.name, failure("The person stopped this before it finished."), true);
          messages = [...messages, message];
          toolEnded(call.id, call.name, failure("Stopped."), true);
        }
      })
    ),
    Effect.ensuring(
      Effect.promise(async () => {
        run = null;
        hooks.busy?.(false);
        emit({ t: "busy", busy: false });
        await checkpoints.ended();
      })
    )
  );

  /**
   * Moves to a model the person can use now, if the one it's on isn't: says so in the transcript, and the menus follow.
   * Answers whether it moved.
   */
  const refit = (c: AgentConfig | null): boolean => {
    if (!c || choice == null) return false;
    const next = fit(c, choice);
    if (next == choice) return false;
    const was = MODELS[choice].label;
    choice = next;
    emit({
      t: "error",
      text: next
        ? `${was} can't be used now: its key is gone, or the admin turned it off. The agent goes on with ${MODELS[next].label}.`
        : `${was} can't be used now: no key runs it.`,
    });
    hooks.modelChanged?.();
    return true;
  };

  /** Starts a run unless one goes on. */
  const go = () => {
    if (run) return;
    run = Effect.runFork(runLoop);
  };
  const stop = async () => {
    const r = run;
    if (r) await Effect.runPromise(Fiber.interrupt(r));
  };

  return {
    log,
    get side() {
      return side;
    },
    get messages() {
      return messages;
    },
    get cfg() {
      return cfg;
    },
    get model() {
      if (!side || !cfg) return null;
      return choice == null ? "script (test model)" : MODELS[choice].label;
    },
    get modelChoice() {
      return choice;
    },
    get models() {
      return cfg && choice != null ? usable(cfg) : [];
    },
    emit,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(first, systemPrompt, tools) {
      choice = fit(first, kept);
      side = { systemPrompt, tools };
      return side;
    },
    configure(next) {
      cfg = next;
      if (choice == null && next) choice = fit(next, kept);
      else refit(next);
    },
    setModel(next) {
      if (!side || !cfg || choice == null || !isModelChoice(next) || !usable(cfg).some((u) => u.choice == next)) return false;
      choice = next;
      return true;
    },
    prompt(text, context, files, refresh) {
      emit(files.length ? { t: "user", text, files: fileRefs(files) } : { t: "user", text });
      const s = side;
      if (!s || !cfg) {
        emit({ t: "error", text: "The agent is off." });
        return;
      }
      const message: ChatMessage = {
        role: "user",
        content: messageContent(context ? `<${opts.tag}>\n${context}\n</${opts.tag}>\n\n${text}` : text, files),
      };
      // Kept until the model has it: a restart before then doesn't lose it.
      checkpoints.queue(message);
      steering.push(message);
      if (run || starting) return;
      if (!refresh) return go();
      starting = true;
      refresh(s)
        .catch((e: unknown) => emit({ t: "error", text: e instanceof Error ? e.message : String(e) }))
        .finally(() => {
          starting = false;
          go();
        });
    },
    abort: () => void stop(),
    async reset(then) {
      await stop();
      steering.length = 0;
      paths.clear();
      messages = [];
      await checkpoints.clear();
      then?.();
      emit({ t: "reset" });
    },
    async resume() {
      if (resumed) return false;
      resumed = true;
      const state = checkpoints.current;
      if (!state.running && !state.queued.length) return false;
      if (!side || !cfg) {
        // A run that can't go on (the agent is off now) ends here.
        await checkpoints.drop();
        emit({ t: "error", text: CUT });
        emit({ t: "busy", busy: false });
        return false;
      }
      // The last turn's calls: a result kept is used, a call that began and didn't finish is not run again (the model
      // hears that it stopped, and checks), a call that never began runs with the run.
      for (const call of open()) {
        const known = state.calls[call.id];
        if (known?.result) messages = [...messages, known.result];
        else if (known) {
          messages = [...messages, toolMessage(call.id, call.name, failure(STOPPED), true)];
          toolEnded(call.id, call.name, failure(STOPPED_SHOWN), true);
        }
      }
      // What the person sent that the model hadn't had: it has it now, in order.
      messages = [...messages, ...state.queued];
      const end = messages[messages.length - 1];
      const going = !!end && (end.role != "assistant" || open().length > 0);
      await checkpoints.resumed(going);
      if (!going) {
        emit({ t: "busy", busy: false });
        return false;
      }
      go();
      return true;
    },
  };
}

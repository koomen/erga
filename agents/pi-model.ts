// The models Effect AI has no provider for (OpenAI, Google, OpenRouter), through the Pi router
// (@earendil-works/pi-ai): one Effect AI LanguageModel, so the loop (agents/run.ts), its tools and its stored
// conversations stay in Effect AI's format. A turn's prompt goes to Pi's messages; Pi's events come back as Effect AI's
// stream parts. Pi turns a conversation from one provider into another's (the person switched models): it drops or
// rewrites what only the first provider reads (thinking signatures, tool call ids).
//
// What a provider needs back next turn (a thinking or text signature, Gemini's thought signature on a call) rides in
// each part's metadata as `pi`, which Effect AI keeps in the message's options; with it the provider, its API and the
// model, so Pi knows which messages are its own.
//
// The key is given with each request, and `env` is empty: Pi never reads the Worker's environment. The fetch is the
// one of the moment, so a test's stub answers.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { AiError, LanguageModel, Tool, type Prompt, type Response } from "effect/ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  Message,
  TextContent,
  ThinkingLevel,
} from "@earendil-works/pi-ai";

const pi = createModels();
for (const p of [openaiProvider(), googleProvider(), openrouterProvider()]) pi.setProvider(p);

/** A model in Pi's catalog: its name, and whether it takes images. Undefined: Pi doesn't know it. */
export const piModel = (provider: string, id: string) => pi.getModel(provider, id);

/** What a part carries for its provider, in its options (and its metadata, as it streams). */
interface PiMeta {
  provider: string;
  api: string;
  model: string;
  sig?: string;
}

type Part = Response.StreamPartEncoded;
type Options = Record<string, Record<string, unknown> | undefined> | undefined;

const metaOf = (options: unknown): PiMeta | undefined => (options as Options)?.pi as PiMeta | undefined;

/** A file part's bytes, as base64. */
function base64(data: unknown): string | null {
  if (typeof data == "string") return data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  if (data instanceof Uint8Array) return btoa(Array.from(data, (b) => String.fromCharCode(b)).join(""));
  return null;
}

/** Text and pictures, as Pi takes them; another kind of file is named, not sent (Pi's models take images and text). */
function contentOf(parts: readonly unknown[]): (TextContent | ImageContent)[] {
  return (parts as readonly { type: string; text?: string; mediaType?: string; data?: unknown; fileName?: string }[]).flatMap(
    (p): (TextContent | ImageContent)[] => {
      if (p.type == "text") return [{ type: "text" as const, text: p.text ?? "" }];
      const data = p.type == "file" ? base64(p.data) : null;
      if (p.type == "file" && data && p.mediaType?.startsWith("image/")) return [{ type: "image" as const, data, mimeType: p.mediaType }];
      if (p.type == "file")
        return [{ type: "text" as const, text: `[${p.fileName ?? p.mediaType ?? "a file"}: this model takes only text and pictures]` }];
      return [];
    }
  );
}

/** Effect AI's prompt as Pi's context: the system prompt, the messages, and the tools. */
export function piContext(prompt: Prompt.Prompt, tools: readonly Tool.Any[]): Context {
  const system: string[] = [];
  const messages: Message[] = [];
  for (const m of prompt.content) {
    if (m.role == "system") system.push(m.content);
    else if (m.role == "user") messages.push({ role: "user", content: contentOf(m.content), timestamp: 0 });
    else if (m.role == "assistant") {
      const from = m.content.map((p) => metaOf(p.options)).find(Boolean);
      const anthropic = m.content.some((p) => (p.options as Options)?.anthropic);
      const content: AssistantMessage["content"] = m.content.flatMap((p): AssistantMessage["content"] => {
        const sig = metaOf(p.options)?.sig;
        if (p.type == "text") return [{ type: "text", text: p.text, ...(sig ? { textSignature: sig } : {}) }];
        if (p.type == "reasoning") {
          const theirs = (p.options as Options)?.anthropic?.info as { signature?: string } | undefined;
          const s = sig ?? theirs?.signature;
          return [{ type: "thinking", thinking: p.text, ...(s ? { thinkingSignature: s } : {}) }];
        }
        if (p.type == "tool-call")
          return [
            { type: "toolCall", id: p.id, name: p.name, arguments: (p.params ?? {}) as never, ...(sig ? { thoughtSignature: sig } : {}) },
          ];
        return [];
      });
      messages.push({
        role: "assistant",
        content,
        ...(from
          ? { provider: from.provider, api: from.api, model: from.model }
          : anthropic
            ? { provider: "anthropic", api: "anthropic-messages", model: "claude" }
            : { provider: "erga", api: "erga", model: "erga" }),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: content.some((c) => c.type == "toolCall") ? "toolUse" : "stop",
        timestamp: 0,
      });
    } else
      for (const p of m.content)
        if (p.type == "tool-result")
          messages.push({
            role: "toolResult",
            toolCallId: p.id,
            toolName: p.name,
            content: p.modelOutput?.length
              ? contentOf(p.modelOutput)
              : [{ type: "text", text: typeof p.result == "string" ? p.result : JSON.stringify(p.result) }],
            isError: p.isFailure,
            timestamp: 0,
          } as Message);
  }
  return {
    systemPrompt: system.join("\n\n"),
    messages,
    tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", parameters: Tool.getJsonSchema(t) as never })),
  };
}

/** Pi's events as Effect AI's stream parts; `meta` goes on each part its provider must have back. */
export function partsOf(ev: AssistantMessageEvent, meta: Omit<PiMeta, "sig">): Part[] {
  const id = "contentIndex" in ev ? String(ev.contentIndex) : "";
  const block = "contentIndex" in ev ? ev.partial.content[ev.contentIndex] : undefined;
  const sigOf = () => (block?.type == "text" ? block.textSignature : block?.type == "thinking" ? block.thinkingSignature : undefined);
  const withSig = (sig?: string) => (sig ? { metadata: { pi: { ...meta, sig } } } : { metadata: { pi: meta } });
  switch (ev.type) {
    case "text_start":
      return [{ type: "text-start", id, ...withSig() }];
    case "text_delta":
      return ev.delta ? [{ type: "text-delta", id, delta: ev.delta }] : [];
    case "text_end":
      return [{ type: "text-end", id, ...withSig(sigOf()) }];
    case "thinking_start":
      return [{ type: "reasoning-start", id, ...withSig() }];
    case "thinking_delta":
      return ev.delta ? [{ type: "reasoning-delta", id, delta: ev.delta }] : [];
    case "thinking_end":
      return [{ type: "reasoning-end", id, ...withSig(sigOf()) }];
    case "toolcall_end": {
      const c = ev.toolCall;
      return [{ type: "tool-call", id: c.id, name: c.name, params: c.arguments ?? {}, ...withSig(c.thoughtSignature) }];
    }
    case "done": {
      const u = ev.message.usage;
      return [
        {
          type: "finish",
          reason: ev.reason == "toolUse" ? "tool-calls" : ev.reason == "length" ? "length" : "stop",
          usage: { inputTokens: { total: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite }, outputTokens: { total: u.output } },
        },
      ];
    }
    default:
      return [];
  }
}

/** Erga's effort, as Pi's thinking level (Pi maps it onto each model's own, or leaves thinking off). */
const LEVELS: Record<string, ThinkingLevel> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };

const failed = (method: string, description: string) =>
  AiError.make({ module: "pi", method, reason: new AiError.UnknownError({ description }) });

/** The model `id` of Pi's `provider`, called with `apiKey`, as Effect AI's LanguageModel; effort null: no reasoning. */
export function piLanguageModel(o: {
  provider: string;
  id: string;
  apiKey: Redacted.Redacted<string>;
  effort: string | null;
  maxTokens?: number;
}): Layer.Layer<LanguageModel.LanguageModel> {
  const stream = (options: LanguageModel.ProviderOptions): Stream.Stream<Part, AiError.AiError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const model = pi.getModel(o.provider, o.id);
        if (!model) return Stream.fail(failed("streamText", `${o.provider} has no model ${o.id} in this Erga's list`));
        const ctl = new AbortController();
        yield* Effect.addFinalizer(() => Effect.sync(() => ctl.abort()));
        const events = pi.streamSimple(model, piContext(options.prompt, options.tools), {
          apiKey: Redacted.value(o.apiKey),
          env: {},
          signal: ctl.signal,
          fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch,
          ...(model.reasoning && o.effort ? { reasoning: LEVELS[o.effort] ?? "medium" } : {}),
          ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}),
        });
        const meta = { provider: model.provider, api: model.api, model: model.id };
        return Stream.fromAsyncIterable(events, (e) => failed("streamText", e instanceof Error ? e.message : String(e))).pipe(
          Stream.mapEffect((ev) =>
            ev.type == "error"
              ? Effect.fail(failed("streamText", ev.error.errorMessage || `${model.name} failed`))
              : Effect.succeed(partsOf(ev, meta))
          ),
          Stream.flatMap((parts) => Stream.fromIterable(parts))
        );
      })
    );
  return Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      streamText: stream,
      // What streamText streams, put together: the loop streams, but the interface wants both.
      generateText: (options) =>
        Stream.runCollect(stream(options)).pipe(
          Effect.map((parts) => {
            const out: Response.PartEncoded[] = [],
              text = new Map<string, string>();
            for (const p of parts) {
              if (p.type == "text-delta" || p.type == "reasoning-delta") text.set(p.type + p.id, (text.get(p.type + p.id) ?? "") + p.delta);
              else if (p.type == "text-end") out.push({ type: "text", text: text.get("text-delta" + p.id) ?? "", metadata: p.metadata });
              else if (p.type == "reasoning-end")
                out.push({ type: "reasoning", text: text.get("reasoning-delta" + p.id) ?? "", metadata: p.metadata });
              else if (p.type == "tool-call" || p.type == "finish") out.push(p as Response.PartEncoded);
            }
            return out;
          })
        ),
    })
  );
}

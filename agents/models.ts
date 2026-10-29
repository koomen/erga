// What both agents share of the model runtime: the models a person can
// switch between, the agent's configuration (the key and the model, from
// the Worker's bindings), the model for a turn (Effect AI's Anthropic
// provider), and the free scripted model the test suites run on
// (ERGA_AGENT_MODEL=script).

import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AiError, LanguageModel, type Prompt, type Response } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { CREDENTIALS, type Credentials } from "../server/directory/index.ts";

/** The models a person can switch between, by key. */
export const MODELS = {
  sonnet: { id: "claude-sonnet-5-5", label: "Sonnet 5.5", fast: false },
  "opus-fast": { id: "claude-opus-5-5", label: "Opus 5.5 fast", fast: true },
} as const;
export type ModelChoice = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelChoice = "opus-fast";
export const isModelChoice = (s: string): s is ModelChoice => Object.hasOwn(MODELS, s);

export interface AgentConfig {
  apiKey: Redacted.Redacted<string>;
  /** The model sessions start on, or the scripted test model. */
  model: ModelChoice | "script";
  effort: string;
}

/** The agent's settings, or why it's off (no key). */
export type AgentSettings = AgentConfig | { readonly missing: string };

export const isScript = (cfg: AgentConfig) => cfg.model == "script";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The agent's settings; the key stays redacted, so it can't end up in a log. */
const settings = Config.all({
  apiKey: Config.option(Config.Redacted("ANTHROPIC_API_KEY")),
  model: Config.withDefault(Config.Literals([...Object.keys(MODELS) as ModelChoice[], "script"], "ERGA_AGENT_MODEL"), DEFAULT_MODEL),
  effort: Config.withDefault(Config.Literals(EFFORTS, "ERGA_AGENT_EFFORT"), "medium"),
});

/** Reads the agent's settings from a provider (the Worker's bindings). */
export const agentConfigFrom = (provider: ConfigProvider.ConfigProvider): Effect.Effect<AgentConfig | { missing: string }> => Effect.gen(function* () {
  const read = yield* Effect.result(settings.parse(provider));
  if (read._tag == "Failure") {
    // "ERGA_AGENT_MODEL should be "sonnet" or "opus-fast"", not the schema's own wording.
    const m = /Expected (.+)\n\s*at \["(\w+)"\]/.exec(read.failure.message);
    return { missing: m ? `${m[2]} should be ${m[1].replaceAll(" | ", " or ")}` : read.failure.message };
  }
  const { apiKey, model, effort } = read.success;
  if (model == "script") return { apiKey: Redacted.make(""), model, effort: "medium" } satisfies AgentConfig;
  if (Option.isNone(apiKey) || !Redacted.value(apiKey.value)) return { missing: `ANTHROPIC_API_KEY is not set (an admin pastes the Anthropic API key in the admin agent's panel; locally, export it before bun start, or put it in .dev.vars)` };
  return { apiKey: apiKey.value, model, effort } satisfies AgentConfig;
});

declare module "../server/platform.ts" {
  interface Platform {
    /** The agents' settings as they are now: the Anthropic key an admin stored, else the deploy's; or why there's none. Read at each turn. */
    agentSettings(): Promise<AgentSettings>;
  }
}

/** What the agent pane says when the stored key doesn't open on this server. */
export const UNREADABLE_KEY = "the stored Anthropic API key doesn't open on this server: it was encrypted with another server's FACTORY_KEY. An admin pastes the key again in the admin agent's panel";

/**
 * Both agents' settings, as they are now: the Anthropic key an admin stored on
 * /admin/api-keys, else the Worker secret in `env`. Read at each turn (one row
 * of the database), so a key an admin stores, replaces or clears reaches every
 * agent at its next turn, with no reload. No stored keys: the Worker secret only.
 */
export async function agentSettingsFrom(env: object, credentials: Pick<Credentials, "opened"> | null): Promise<AgentConfig | { missing: string }> {
  const name = CREDENTIALS.anthropic.env;
  const stored = credentials
    ? await credentials.opened("anthropic").catch((e: unknown) => {
      console.log(`couldn't read the stored ${CREDENTIALS.anthropic.label}, so the Worker secret stands: ${e instanceof Error ? e.message : e}`);
      return { key: null, unreadable: false };
    })
    : { key: null, unreadable: false };
  const cfg = await Effect.runPromise(agentConfigFrom(ConfigProvider.fromUnknown(stored.key ? { ...env, [name]: stored.key } : env)));
  // No key to use, but one is stored: say why it can't be used, not only that there's none.
  return "missing" in cfg && stored.unreadable && cfg.missing.startsWith(name) ? { missing: UNREADABLE_KEY } : cfg;
}

/**
 * The model behind a conversation, for one turn: Claude on Effect AI's
 * Anthropic provider, with the key and effort as they are now; or the
 * scripted model. Adaptive thinking with summaries (so the panel can show
 * them), the effort, and fast mode (Opus only: the `fast-mode-2026-02-01`
 * beta and `speed: "fast"`). Tools go as plain JSON Schema, not strict.
 */
export function languageModel(cfg: AgentConfig, choice: ModelChoice | null): Layer.Layer<LanguageModel.LanguageModel> {
  if (isScript(cfg) || choice == null) return scriptModel;
  const m = MODELS[choice];
  const config = {
    max_tokens: 64_000,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: cfg.effort },
    structuredOutputs: false,
    ...(m.fast ? { speed: "fast" } : {}),
  } as unknown as AnthropicConfig;
  return AnthropicLanguageModel.layer({ model: m.id, config }).pipe(
    Layer.provide(AnthropicClient.layer({ apiKey: cfg.apiKey, transformClient: m.fast ? withBeta(FAST_BETA) : undefined })),
    Layer.provide(FetchHttpClient.layer),
    // The fetch of the moment: Effect's default is the first one it saw (a test's stub, say).
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, ((input, init) => globalThis.fetch(input, init)) as typeof fetch))
  );
}

type AnthropicConfig = NonNullable<Parameters<typeof AnthropicLanguageModel.layer>[0]["config"]>;
const FAST_BETA = "fast-mode-2026-02-01";

/** Requests with `beta` added to the betas the provider asks for (a PDF's, say). */
const withBeta = (beta: string) =>
  HttpClient.mapRequest((req) => {
    const had = req.headers["anthropic-beta"];
    return HttpClientRequest.setHeader(req, "anthropic-beta", had ? `${had},${beta}` : beta);
});

/** An error of the model's, as the panel says it: the provider's own words. */
export const modelError = (e: unknown): string => (AiError.isAiError(e) ? e.reason.message : e instanceof Error ? e.message : String(e));

/**
 * The scripted model, for tests. A message containing `@script` followed by
 * a JSON array of steps plays them in order, one per model call:
 *
 *   { "tool": "edit", "args": { ... } }   call a tool
 *   { "text": "Done." }                   reply and end the turn
 *   { "error": "overloaded" }             fail the request
 *   { "inputs": true }                    reply with what the scripted message carried: {"images":["image/png"],"files":["a.csv"]}
 *
 * Any step may add "delay": ms, to wait before answering (so a test can act
 * between two tool calls). Once the steps run out it says "(script done)".
 */
const Step = Schema.Struct({
  tool: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  text: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  delay: Schema.optionalKey(Schema.Finite),
  inputs: Schema.optionalKey(Schema.Boolean),
});
const Steps = Schema.fromJsonString(Schema.Array(Step));
type Part = Response.StreamPartEncoded;

const said = (text: string): Part[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
];

const scriptStep = Effect.fnUntraced(function* (prompt: Prompt.Prompt) {
  const msgs = prompt.content;
  const textOf = (m: Prompt.Message) =>
    typeof m.content == "string" ? m.content : m.content.map((c) => (c.type == "text" ? c.text : "")).join("");
  let at = msgs.length - 1;
  while (at >= 0 && !(msgs[at].role == "user" && textOf(msgs[at]).includes("@script"))) at--;
  if (at < 0) return said("(no script)");
  const text = textOf(msgs[at]);
  // Attached files come after the message: the script ends at the first blank line, then.
  const src = text.slice(text.indexOf("@script") + 7).trim();
  const steps = yield* Schema.decodeEffect(Steps)(src).pipe(
    Effect.catch(() => Schema.decodeEffect(Steps)(src.split("\n\n")[0])),
    Effect.catch((e) => Effect.succeed(`bad script: ${e.message}`))
  );
  if (typeof steps == "string") return said(steps);
  const step = steps[msgs.slice(at + 1).filter((m) => m.role == "assistant").length];
  if (step?.delay) yield* Effect.sleep(step.delay);
  if (!step) return said("(script done)");
  if (step.error)
    return yield* AiError.make({ module: "script", method: "streamText", reason: new AiError.UnknownError({ description: step.error }) });
  if (step.tool)
    return [
      { type: "tool-call", id: `call-${crypto.randomUUID()}`, name: step.tool, params: step.args ?? {} },
      { type: "finish", reason: "tool-calls", usage: { inputTokens: {}, outputTokens: {} } },
    ] satisfies Part[];
  if (step.inputs) {
    const m = msgs[at];
    const parts = typeof m.content == "string" ? [] : m.content;
    return said(
      JSON.stringify({
        images: parts.flatMap((c) => (c.type == "file" && c.mediaType.startsWith("image/") ? [c.mediaType] : [])),
        files: [...text.matchAll(/<file name="([^"]*)">/g)].map((x) => x[1]),
    }));
  }
  return said(step.text ?? "");
});

const scriptModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: (options) => Effect.map(scriptStep(options.prompt), (parts) => parts as Response.PartEncoded[]),
    streamText: (options) => Stream.unwrap(Effect.map(scriptStep(options.prompt), (parts) => Stream.fromIterable(parts))),
}));

/** A tool result's image (view_page's screenshot), as a data URL for the panel. */
export function resultImage(result: unknown): string | undefined {
  const r = result as { content?: { type: string; data?: string; mimeType?: string }[] } | null;
  const img = r?.content?.find((c) => c.type == "image" && c.data && (c.mimeType ?? "image/").startsWith("image/"));
  return img ? `data:${img.mimeType ?? "image/png"};base64,${img.data}` : undefined;
}

export function resultText(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] } | null;
  return (r?.content ?? []).map((c) => c.text ?? "").join("\n").trim();
}

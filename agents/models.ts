// What the agents share of the model runtime: the models a person can switch between (shared/models.ts) and the
// keys that run them, the agent's configuration (from the stored keys, the Worker's bindings and the admin's
// settings), the model for a turn (Claude on Effect AI's Anthropic provider; the others through the Pi router,
// agents/pi-model.ts), and the free scripted model the test suites run on (ERGA_AGENT_MODEL=script).

import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AiError, LanguageModel, type Prompt, type Response } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { AnthropicLanguageModel } from "@effect/ai-anthropic";
import { CREDENTIALS, type Credentials, type PersonKeys } from "../server/directory/index.ts";
import {
  DEFAULT_MODEL,
  fitModel,
  MODELS,
  pageLlmChoices,
  PROVIDERS,
  usableModels,
  type KeySetup,
  type ModelChoice,
  type Provider,
  type Usable,
} from "../shared/models.ts";
import { base64PictureSize, PICTURES, tooLarge } from "../shared/picture.ts";
import type { piLanguageModel } from "./pi-model.ts";

export { DEFAULT_MODEL, isModelChoice, MODELS, type ModelChoice } from "../shared/models.ts";

type Keys = Partial<Record<Provider, Redacted.Redacted<string>>>;

export interface AgentConfig {
  /** The person's own keys, by provider. */
  own: Keys;
  /** The server's keys, by provider (stored on /admin/api-keys, else the deploy's Worker secret). */
  server: Keys;
  /** The agent_keys setting: "own" means the server's keys run nothing. */
  mode: "server" | "own";
  /** The agent_models_off setting: models a server key doesn't run. */
  off: readonly string[];
  /** The model sessions start on, or the scripted test model (every model is scripted then). */
  model: ModelChoice | "script";
  effort: string;
}

/** The agent's settings, or why it's off (no key it can use), with the server's keys (the descriptions of versions use Anthropic's). */
export type AgentSettings = AgentConfig | { readonly missing: string; readonly server?: Keys };

export const isScript = (cfg: AgentConfig) => cfg.model == "script";

const providersOf = (keys: Keys) => PROVIDERS.filter((p) => keys[p] && Redacted.value(keys[p]));
export const keySetup = (cfg: AgentConfig): KeySetup => ({
  own: providersOf(cfg.own),
  server: providersOf(cfg.server),
  mode: cfg.mode,
  off: cfg.off,
});

/** The models the person can use now, with whose key runs each. */
export const usable = (cfg: AgentConfig): Usable[] => usableModels(keySetup(cfg));

/** The model to be on: `wanted` if the person can use it, else the configured one, else the first they can. */
export const fit = (cfg: AgentConfig, wanted: ModelChoice | null): ModelChoice | null =>
  fitModel(keySetup(cfg), wanted ?? (cfg.model == "script" ? DEFAULT_MODEL : cfg.model));

/** The key that runs `choice` for this person now, or null: their own wins; a server key only as the settings allow. */
export function keyFor(cfg: AgentConfig, choice: ModelChoice): Redacted.Redacted<string> | null {
  const u = usable(cfg).find((x) => x.choice == choice);
  return u ? ((u.key == "own" ? cfg.own : cfg.server)[u.provider] ?? null) : null;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The agent's model and effort, from the Worker's bindings. */
const settings = Config.all({
  model: Config.withDefault(Config.Literals([...(Object.keys(MODELS) as ModelChoice[]), "script"], "ERGA_AGENT_MODEL"), DEFAULT_MODEL),
  effort: Config.withDefault(Config.Literals(EFFORTS, "ERGA_AGENT_EFFORT"), "medium"),
});

/** The model and effort from a provider (the Worker's bindings), or what's wrong with them. */
const modelFrom = (
  provider: ConfigProvider.ConfigProvider
): Effect.Effect<{ model: ModelChoice | "script"; effort: string } | { missing: string }> =>
  Effect.gen(function* () {
    const read = yield* Effect.result(settings.parse(provider));
    if (read._tag == "Success") return read.success;
    // "ERGA_AGENT_MODEL should be "opus-fast" or "opus" or ..."", not the schema's own wording.
    const m = /Expected (.+)\n\s*at \["(\w+)"\]/.exec(read.failure.message);
    return { missing: m ? `${m[2]} should be ${m[1].replaceAll(" | ", " or ")}` : read.failure.message };
  });

declare module "../server/platform.ts" {
  interface Platform {
    /**
     * The agents' settings as they are now: the server's keys (stored, else the deploy's), the admin's choices, and
     * `login`'s own keys (none without one); or why there's none. Read at each turn.
     */
    agentSettings(login?: string): Promise<AgentSettings>;
  }
}

/** What the agent pane says when the stored key doesn't open on this server. */
export const UNREADABLE_KEY =
  "the stored Anthropic API key doesn't open on this server: it was encrypted with another server's FACTORY_KEY. An admin pastes the key again on /admin/api-keys, or you add your own in Settings";

/** What the agent pane says when no key runs any model. */
const NO_KEY =
  "no API key is set (add your own in Settings, or an admin sets one on /admin/api-keys; locally, export ANTHROPIC_API_KEY before bun start, or put it in .dev.vars)";
const OWN_KEYS = "the admin asks each person to bring their own API key, and you have none yet. Add one in Settings, Agent";

/** Where the server's keys and the admin's choices are read: the directory's stored keys and its settings. */
export interface KeySource {
  credentials: Pick<Credentials, "opened">;
  personKeys: Pick<PersonKeys, "opened">;
  config: { get(key: "agent_keys" | "agent_models_off"): Promise<unknown> };
}

/**
 * The agents' settings, as they are now: each provider's key an admin stored on /admin/api-keys, else the Worker
 * secret of the same name in `env`; the admin's agent_keys and agent_models_off; and `login`'s own keys. Read at
 * each turn (a few rows of the database), so a key or a setting that changes reaches every agent at its next turn,
 * with no reload. No directory: the Worker secrets only.
 */
export async function agentSettingsFrom(env: object, dir: KeySource | null, login?: string): Promise<AgentSettings> {
  const vars = env as Record<string, unknown>;
  const chosen = await Effect.runPromise(modelFrom(ConfigProvider.fromUnknown(env)));
  if ("missing" in chosen) return chosen;
  // One read at a time would add up each stall of the database; these reads don't depend on each other.
  const none = { key: null, unreadable: false };
  const [stored, theirs, keys, turnedOff] = await Promise.all([
    Promise.all(
      PROVIDERS.map((p) =>
        dir
          ? dir.credentials.opened(p).catch((e: unknown) => {
              console.log(
                `couldn't read the stored ${CREDENTIALS[p].label}, so the Worker secret stands: ${e instanceof Error ? e.message : e}`
              );
              return none;
            })
          : none
      )
    ),
    dir && login
      ? dir.personKeys
          .opened(login)
          .catch((e: unknown) => (console.log(`couldn't read ${login}'s own keys: ${e instanceof Error ? e.message : e}`), {}))
      : {},
    dir?.config.get("agent_keys"),
    dir?.config.get("agent_models_off"),
  ]);
  const server: Keys = {};
  let unreadable = false;
  PROVIDERS.forEach((p, i) => {
    if (p == "anthropic" && stored[i].unreadable) unreadable = true;
    const key = stored[i].key ?? (typeof vars[CREDENTIALS[p].env] == "string" ? (vars[CREDENTIALS[p].env] as string) : "");
    if (key) server[p] = Redacted.make(key);
  });
  const own: Keys = {};
  for (const [p, key] of Object.entries(theirs) as [Provider, string][]) if (key) own[p] = Redacted.make(key);
  const mode = keys == "own" ? "own" : "server",
    off = Array.isArray(turnedOff) ? turnedOff.filter((m): m is string => typeof m == "string") : [];
  const cfg: AgentConfig = { own, server, mode, off, model: chosen.model, effort: chosen.model == "script" ? "medium" : chosen.effort };
  if (isScript(cfg) || usable(cfg).length) return cfg;
  return { missing: mode == "own" ? OWN_KEYS : unreadable ? UNREADABLE_KEY : NO_KEY, server };
}

/** A model that fails at once, with `why`: a turn asked for a model with no key (the loop checks first). */
const failing = (why: string): Layer.Layer<LanguageModel.LanguageModel> => {
  const fail = AiError.make({ module: "erga", method: "streamText", reason: new AiError.UnknownError({ description: why }) });
  return Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({ generateText: () => fail, streamText: () => Stream.fail(fail) }));
};

/**
 * The model behind a conversation, for one turn, with the key and effort as they are now; or the scripted model.
 * Claude runs on Effect AI's Anthropic provider: adaptive thinking with summaries (so the panel can show them), the
 * effort, and fast mode (Opus only: the `fast-mode-2026-02-01` beta and `speed: "fast"`); tools go as plain JSON
 * Schema, not strict. The other providers' models run through the Pi router (agents/pi-model.ts).
 */
export function languageModel(cfg: AgentConfig, choice: ModelChoice | null): Layer.Layer<LanguageModel.LanguageModel> {
  if (isScript(cfg) || choice == null) return scriptModel(choice ? MODELS[choice].label : "script");
  const m: (typeof MODELS)[ModelChoice] & { fast?: boolean } = MODELS[choice];
  const apiKey = keyFor(cfg, choice);
  if (!apiKey) return failing(`${m.label} has no key to run it now`);
  if (m.provider != "anthropic") return pi({ provider: m.provider, id: m.id, apiKey, effort: cfg.effort });
  const config = {
    max_tokens: 64_000,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: cfg.effort },
    structuredOutputs: false,
    ...(m.fast ? { speed: "fast" } : {}),
  } as unknown as AnthropicConfig;
  return anthropic(m.id, config, apiKey, m.fast ? withBeta(FAST_BETA) : undefined);
}

// The providers' code is large (the Anthropic API's schemas, Pi's catalog of models), and only a turn needs it: each
// loads at its first use, in a module of its own, so the Worker starts without it (tests/worker-start.test.ts).

/** Claude on Effect AI's Anthropic provider. */
const anthropic = (
  model: string,
  config: AnthropicConfig,
  apiKey: Redacted.Redacted<string>,
  transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient
): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.unwrap(
    Effect.promise(() => import("@effect/ai-anthropic")).pipe(
      Effect.map(({ AnthropicClient, AnthropicLanguageModel }) =>
        AnthropicLanguageModel.layer({ model, config }).pipe(
          Layer.provide(AnthropicClient.layer({ apiKey, transformClient })),
          Layer.provide(FetchHttpClient.layer),
          // The fetch of the moment: Effect's default is the first one it saw (a test's stub, say).
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, ((input, init) => globalThis.fetch(input, init)) as typeof fetch))
        )
      )
    )
  );

/** Another provider's model, through the Pi router (agents/pi-model.ts). */
const pi = (options: Parameters<typeof piLanguageModel>[0]): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.unwrap(Effect.promise(() => import("./pi-model.ts")).pipe(Effect.map((m) => m.piLanguageModel(options))));

/**
 * The model a document's page calls as its visitor (agents/page-llm.ts), with the server's key, answering at most
 * `maxTokens`, with no thinking and no tools: Claude on Effect AI's Anthropic provider, OpenAI's models through Pi; or the
 * scripted model. Null: the server's keys don't run `choice` for pages now.
 */
export function pageModel(cfg: AgentConfig, choice: ModelChoice, maxTokens: number): Layer.Layer<LanguageModel.LanguageModel> | null {
  if (isScript(cfg)) return scriptModel(MODELS[choice].label);
  const m = MODELS[choice];
  const apiKey = pageLlmChoices({ ...keySetup(cfg), own: [] }).includes(choice) ? cfg.server[m.provider] : undefined;
  if (!apiKey) return null;
  if (m.provider == "openai") return pi({ provider: m.provider, id: m.id, apiKey, effort: null, maxTokens });
  const config = { max_tokens: maxTokens, structuredOutputs: false } as unknown as AnthropicConfig;
  return anthropic(m.id, config, apiKey);
}

/**
 * The messages as the model of `choice` takes them. Anthropic takes a tool call's id only in letters, digits, _ and
 * -; another provider's (OpenAI's "call_…|fc_…") is rewritten the same way in the call and its result. Pi does the
 * same for the providers it calls.
 */
export function messagesFor<M extends { role: string; content: unknown }>(
  choice: ModelChoice | null,
  messages: readonly M[]
): readonly M[] {
  if (!choice || MODELS[choice].provider != "anthropic") return messages;
  const clean = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return messages.map((m) =>
    Array.isArray(m.content) &&
    m.content.some((p: { type?: string; id?: string }) => (p.type == "tool-call" || p.type == "tool-result") && p.id && clean(p.id) != p.id)
      ? {
          ...m,
          content: m.content.map((p: { type?: string; id?: string }) =>
            (p.type == "tool-call" || p.type == "tool-result") && p.id ? { ...p, id: clean(p.id) } : p
          ),
        }
      : m
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

type Piece = { type?: string; mediaType?: string; data?: unknown; modelOutput?: readonly Piece[] };
const isPicture = (p: Piece) => p.type == "file" && typeof p.mediaType == "string" && p.mediaType.startsWith("image/");
/** The pictures of a message: a person's, and those in a tool's result. */
const picturesOf = (m: { content: unknown }): Piece[] =>
  Array.isArray(m.content)
    ? (m.content as Piece[]).flatMap((p) => (isPicture(p) ? [p] : p.type == "tool-result" ? (p.modelOutput ?? []).filter(isPicture) : []))
    : [];

/** Each picture measured one time (every request passes every picture of the conversation): why it's too large, and its base64 length. */
const measured = new WeakMap<Piece, { large: string | null; length: number }>();
function measure(p: Piece) {
  let m = measured.get(p);
  if (!m) {
    const data = typeof p.data == "string" ? p.data : "";
    m = { large: tooLarge(base64PictureSize(data), data.length), length: data.length };
    measured.set(p, m);
  }
  return m;
}

const OLD_PICTURE = "[An old picture was here. It left the conversation, which has many pictures. Take it again if you need it.]";

/**
 * The messages with every picture inside the rule (shared/picture.ts): what each request carries, so the model never
 * refuses one for a picture. A picture too large (one from before the rule: view_page, read and the panel give none
 * now) has words in its place, with its size. Over PICTURES.high together, the oldest have words in their place until
 * PICTURES.low is left. The same messages give the same answer, and more messages only take more pictures away at
 * the next `high`: so the request's start stays as the model's cache has it.
 *
 * A model's thinking holds only with the messages before it as it saw them (Anthropic refuses it otherwise): the
 * turns before the last time pictures left go without their thinking; all of them, with a picture too large.
 */
export function fitPictures<M extends { role: string; content: unknown }>(messages: readonly M[]): readonly M[] {
  const gone = new Map<Piece, string>();
  const kept: { part: Piece; length: number }[] = [];
  let data = 0,
    cut = 0;
  messages.forEach((m, i) => {
    for (const part of picturesOf(m)) {
      const { large, length } = measure(part);
      if (large) {
        gone.set(part, `[A picture was here. It is ${large}. Take it again if you need it: view_page gives a tall page in parts.]`);
        cut = Infinity;
        continue;
      }
      kept.push({ part, length });
      data += length;
      if (data <= PICTURES.high.data && kept.length <= PICTURES.high.count) continue;
      while (data > PICTURES.low.data || kept.length > PICTURES.low.count) {
        const old = kept.shift()!;
        data -= old.length;
        gone.set(old.part, OLD_PICTURE);
      }
      cut = Math.max(cut, i);
    }
  });
  if (!gone.size) return messages;
  const words = (p: Piece): Piece => (gone.has(p) ? ({ type: "text", text: gone.get(p)! } as Piece) : p);
  return messages.flatMap((m, i) => {
    if (!Array.isArray(m.content)) return [m];
    const content = (m.content as Piece[])
      .filter((p) => !(m.role == "assistant" && i < cut && p.type == "reasoning"))
      .map((p) => (p.type == "tool-result" && p.modelOutput ? { ...p, modelOutput: p.modelOutput.map(words) } : words(p)));
    return content.length ? [{ ...m, content }] : [];
  });
}

/** An error that Anthropic sends in the middle of its answer (the stream's "error" event): its type and words. */
const streamed = (e: unknown): { type: string; message: string } | null => {
  const x = e as { type?: unknown; message?: unknown } | null;
  return x && typeof x == "object" && !(e instanceof Error) && typeof x.type == "string"
    ? { type: x.type, message: typeof x.message == "string" ? x.message : x.type }
    : null;
};

/**
 * Whether the same request may pass a moment later: the model's service is overloaded or failed, a rate limit, a lost
 * connection. The loop asks again then (agents/run.ts); every other error ends the turn at once.
 */
export const passing = (e: unknown): boolean =>
  AiError.isAiError(e)
    ? e.isRetryable
    : ["overloaded_error", "api_error", "rate_limit_error", "timeout_error"].includes(streamed(e)?.type ?? "");

/** After an error, how the person goes on: the last words of each error in the panel. */
const GO_ON = 'Say "go on" to try again.';
const NEW = 'Say "go on" to try again. If the same error comes back, start a new conversation (the + above).';

/** An error of the model's, as the panel says it: the provider's own words, then how to go on. `asked`: how many times the loop asked. */
export function modelError(e: unknown, asked = 1): string {
  const words = (AiError.isAiError(e) ? e.reason.message : (streamed(e)?.message ?? (e instanceof Error ? e.message : String(e)))).trim();
  const tag = AiError.isAiError(e) ? e.reason._tag : "";
  const on =
    tag == "AuthenticationError" || tag == "QuotaExhaustedError"
      ? `Check the API key and its account (Settings, Agent), then say "go on".`
      : passing(e)
        ? `${asked > 1 ? `The agent asked ${asked} times. ` : ""}${GO_ON}`
        : tag == "InvalidRequestError"
          ? `The model refused the request. ${NEW}`
          : GO_ON;
  return `${words || "The request failed"}${/[.!?]$/.test(words) ? "" : "."} ${on}`;
}

/** How many times the loop asks the model for one turn, when the error may pass (`passing`). */
export const TRIES = 3;

/**
 * A model's turn that did not end as a whole answer, from its parts: why, in words for the panel, with how to go on;
 * null for a whole turn. An error in the middle of the stream is a part, not a failure, and a connection that closes
 * leaves no "finish": without this, such a turn ends with no word.
 */
export function cutShort(parts: readonly Response.AnyPart[]): string | null {
  const finish = parts.find((p) => p.type == "finish");
  if (!finish) return `The connection to the model closed before its answer ended. ${GO_ON}`;
  if (finish.reason == "length") return `The model's answer reached its length limit, and stops here. Say "go on" to continue.`;
  if (finish.reason == "content-filter")
    return "The model declined to answer this. Ask in another way, or start a new conversation (the + above).";
  if (finish.reason == "error" || finish.reason == "unknown") return `The model's answer ended with no reason given. ${GO_ON}`;
  return null;
}

/**
 * The scripted model, for tests. A message containing `@script` followed by
 * a JSON array of steps plays them in order, one per model call:
 *
 *   { "tool": "edit", "args": { ... } }   call a tool
 *   { "text": "Done." }                   reply and end the turn
 *   { "error": "overloaded" }             fail the request
 *   { "inputs": true }                    reply with what the scripted message carried: {"images":["image/png"],"files":["a.csv"]}
 *   { "model": true }                     reply with the name of the model the person is on
 *   { "text": "Hi", "tokens": 5000 }      ... and say it used that many output tokens (a test of the limits)
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
  model: Schema.optionalKey(Schema.Boolean),
  tokens: Schema.optionalKey(Schema.Finite),
});
const Steps = Schema.fromJsonString(Schema.Array(Step));
type Part = Response.StreamPartEncoded;

const said = (text: string, tokens?: number): Part[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: tokens == null ? {} : { total: tokens } } },
];

const scriptStep = Effect.fnUntraced(function* (prompt: Prompt.Prompt, model: string) {
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
  if (step.model) return said(model);
  if (step.inputs) {
    const m = msgs[at];
    const parts = typeof m.content == "string" ? [] : m.content;
    return said(
      JSON.stringify({
        images: parts.flatMap((c) => (c.type == "file" && c.mediaType.startsWith("image/") ? [c.mediaType] : [])),
        files: [...text.matchAll(/<file name="([^"]*)">/g)].map((x) => x[1]),
    }));
  }
  return said(step.text ?? "", step.tokens);
});

/** The scripted model, standing in for `model` (its name, for the step "model"). */
const scriptModel = (model: string) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) => Effect.map(scriptStep(options.prompt, model), (parts) => parts as Response.PartEncoded[]),
      streamText: (options) => Stream.unwrap(Effect.map(scriptStep(options.prompt, model), (parts) => Stream.fromIterable(parts))),
    })
  );

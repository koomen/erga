// What both agents share of the model runtime: the models a person can
// switch between and their prices, the agent's configuration (the key and
// the model, from the Worker's bindings), pi's model descriptions, and the
// free scripted model the test suites run on (ERGA_AGENT_MODEL=script).

import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider, type Context, type Model } from "@mariozechner/pi-ai";

/** The models a person can switch between, by key; prices per million tokens. */
export const MODELS = {
  sonnet: { id: "claude-sonnet-5-5", label: "Sonnet 5.5", fast: false, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  "opus-fast": { id: "claude-opus-5-5", label: "Opus 5.5 fast", fast: true, cost: { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 } },
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

/**
 * pi's built-in catalogue predates the 5.5 models, so they're described here.
 * Fast mode (Opus only) is the `fast-mode-2026-02-01` beta plus `speed: "fast"`
 * in the request body (added in `patchPayload`).
 */
export function describeModel(choice: ModelChoice): Model<"anthropic-messages"> {
  const m = MODELS[choice];
  return {
    id: m.id,
    name: m.label,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...m.cost },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    headers: m.fast ? { "anthropic-beta": "fast-mode-2026-02-01" } : undefined,
  };
}

/**
 * pi only knows adaptive thinking for the 4.6/4.7 models and would send a
 * budget (or `disabled`), both of which the 5.5 models reject. Rewrite the
 * request: adaptive thinking with summaries (so the panel can show them),
 * explicit effort, and fast mode when the current model has it.
 */
export function patchPayload(settings: () => AgentConfig, current: () => ModelChoice) {
  return (payload: unknown) => {
    const cfg = settings();
    const p = payload as Record<string, unknown>;
    return {
      ...p,
      messages: withDocuments(p.messages),
      max_tokens: 64_000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { ...(p.output_config as object | undefined), effort: cfg.effort },
      ...(MODELS[current()].fast ? { speed: "fast" } : {}),
    };
  };
}

/**
 * A PDF in a tool's result (read: an image's block with the PDF's type, as pi
 * carries it) as the API takes it: a document.
 */
export function withDocuments(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  const fix = (block: unknown): unknown => {
    const b = block as { type?: string; source?: { type?: string; media_type?: string; data?: string }; content?: unknown };
    if (b?.type == "image" && b.source?.media_type == "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: b.source.data } };
    if (b?.type == "tool_result" && Array.isArray(b.content)) return { ...b, content: b.content.map(fix) };
    return block;
  };
  return messages.map((m: { content?: unknown }) => (Array.isArray(m?.content) ? { ...m, content: m.content.map(fix) } : m));
}

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
let script: ReturnType<typeof registerFauxProvider> | null = null;
export function scriptModel(): Model<string> {
  script ??= registerFauxProvider({ provider: "script", models: [{ id: "script", name: "script (test model)", input: ["text", "image"] }] });
  if (script.getPendingResponseCount() < 100) script.appendResponses(Array.from({ length: 1000 }, () => scriptStep));
  return script.getModel();
}

async function scriptStep(context: Context) {
  const msgs = context.messages;
  let at = -1, steps: { tool?: string; args?: Record<string, unknown>; text?: string; error?: string; delay?: number; inputs?: boolean }[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role != "user") continue;
    const text = typeof m.content == "string" ? m.content : m.content.map((c) => (c.type == "text" ? c.text : "")).join("");
    const k = text.indexOf("@script");
    if (k < 0) continue;
    // Attached files come after the message: the script ends at the first blank line, then.
    const src = text.slice(k + 7).trim();
    try { steps = JSON.parse(src); } catch (e) {
      try { steps = JSON.parse(src.split("\n\n")[0]); } catch { return fauxAssistantMessage(`bad script: ${(e as Error).message}`); }
    }
    at = i;
    break;
  }
  if (at < 0) return fauxAssistantMessage("(no script)");
  const step = steps[msgs.slice(at + 1).filter((m) => m.role == "assistant").length];
  if (step?.delay) await new Promise((r) => setTimeout(r, step.delay));
  if (!step) return fauxAssistantMessage("(script done)");
  if (step.error) return fauxAssistantMessage([], { stopReason: "error", errorMessage: step.error });
  if (step.tool) return fauxAssistantMessage([fauxToolCall(step.tool, step.args ?? {})], { stopReason: "toolUse" });
  if (step.inputs) {
    const m = msgs[at] as { content: string | { type: string; text?: string; mimeType?: string }[] };
    const parts = typeof m.content == "string" ? [{ type: "text", text: m.content }] : m.content;
    const text = parts.map((c) => c.text ?? "").join("");
    return fauxAssistantMessage([fauxText(JSON.stringify({ images: parts.filter((c) => c.type == "image").map((c) => c.mimeType), files: [...text.matchAll(/<file name="([^"]*)">/g)].map((x) => x[1]) }))]);
  }
  return fauxAssistantMessage([fauxText(step.text ?? "")]);
}

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

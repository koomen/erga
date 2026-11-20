// The models each person's agent can switch between, and which of them a person can use now. Data and decisions
// only, with no IO: the server's settings check model names against it, the admin's Agents and models page lists it, and
// agents/models.ts runs the models (agents/pi-model.ts for the providers Effect AI has none for).
//
// A model runs with a key for its provider. A person's own key always wins, and opens every model of its provider.
// Without one, a server key opens the models the admin left on, unless the admin requires that each person brings
// their own keys (the agent_keys setting "own"): then server keys open nothing.

/** The providers of models, each with the key a person or the admin gives (server/directory/api-keys.ts's CREDENTIALS). */
export const PROVIDERS = ["anthropic", "openai", "google", "openrouter"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
};

export interface ModelInfo {
  readonly provider: Provider;
  /** The provider's own name for it (Pi's catalog has the same). */
  readonly id: string;
  readonly label: string;
  /** The provider's fast mode, at two times the price: Anthropic's `speed`, OpenAI's `service_tier`. */
  readonly fast?: boolean;
}

/**
 * Our short list, by key: the current models of each provider. Each provider's models go from the smallest to the
 * largest, and every list a person sees has this order (the picker, the Agents and models page, a document's models): the
 * reverse of the order on the provider's own models page (read on 2026-11-19), a model's fast mode after it;
 * OpenRouter's, of three makers, by price. The keys are kept in conversations: don't rename one.
 */
export const MODELS = {
  haiku: { provider: "anthropic", id: "claude-haiku-5-5", label: "Haiku 5.5" },
  sonnet: { provider: "anthropic", id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  opus: { provider: "anthropic", id: "claude-opus-5-5", label: "Opus 5.5" },
  "opus-fast": { provider: "anthropic", id: "claude-opus-5-5", label: "Opus 5.5 fast", fast: true },
  fable: { provider: "anthropic", id: "claude-fable-5-2", label: "Fable 5.2" },
  "fable-fast": { provider: "anthropic", id: "claude-fable-5-2", label: "Fable 5.2 fast", fast: true },
  "gpt-6-luna": { provider: "openai", id: "gpt-6-luna", label: "GPT-6 Luna" },
  "gpt-6-luna-fast": { provider: "openai", id: "gpt-6-luna", label: "GPT-6 Luna fast", fast: true },
  "gpt-6.1-terra": { provider: "openai", id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
  "gpt-6.1-terra-fast": { provider: "openai", id: "gpt-6.1-terra", label: "GPT-6.1 Terra fast", fast: true },
  "gpt-6.2-sol": { provider: "openai", id: "gpt-6.2-sol", label: "GPT-6.2 Sol" },
  "gpt-6.2-sol-fast": { provider: "openai", id: "gpt-6.2-sol", label: "GPT-6.2 Sol fast", fast: true },
  "gpt-6.2-astra": { provider: "openai", id: "gpt-6.2-astra", label: "GPT-6.2 Astra" },
  "gpt-6.2-astra-fast": { provider: "openai", id: "gpt-6.2-astra", label: "GPT-6.2 Astra fast", fast: true },
  "gemini-3.8-flash": { provider: "google", id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  "gemini-4-argon": { provider: "google", id: "gemini-4-argon", label: "Gemini 4 Argon" },
  "gemini-4-hydrogen": { provider: "google", id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
  "gemini-4-neon": { provider: "google", id: "gemini-4-neon", label: "Gemini 4 Neon" },
  "gemini-4-carbon": { provider: "google", id: "gemini-4-carbon", label: "Gemini 4 Carbon" },
  "kimi-k3": { provider: "openrouter", id: "moonshotai/kimi-k3", label: "Kimi K3" },
  "deepseek-v4-pro": { provider: "openrouter", id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  grok: { provider: "openrouter", id: "~x-ai/grok-latest", label: "Grok" },
} as const satisfies Record<string, ModelInfo>;
export type ModelChoice = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelChoice = "opus-fast";
export const isModelChoice = (s: string): s is ModelChoice => Object.hasOwn(MODELS, s);
/**
 * The models that a server key doesn't run until an admin turns them on (the agent_models_off setting's default): the
 * fast modes, at two times the price, but the default model's own.
 */
export const MODELS_OFF_AT_FIRST = (Object.keys(MODELS) as ModelChoice[]).filter(
  (m) => (MODELS[m] as ModelInfo).fast && m != DEFAULT_MODEL
);

/** What decides the models a person can use: the providers with a key (theirs, the server's), and the admin's settings. */
export interface KeySetup {
  /** Providers the person has their own key for. */
  own: readonly Provider[];
  /** Providers the server has a key for. */
  server: readonly Provider[];
  /** "server": server keys work for everyone; "own": each person brings their own. */
  mode: "server" | "own";
  /** Models of the short list the admin turned off for server keys. */
  off: readonly string[];
}

/** A model a person can use, and whose key runs it. */
export interface Usable {
  choice: ModelChoice;
  label: string;
  provider: Provider;
  key: "own" | "server";
}

/** Every model the person can use now, in the short list's order. */
export function usableModels(k: KeySetup): Usable[] {
  return (Object.keys(MODELS) as ModelChoice[]).flatMap((choice) => {
    const m: ModelInfo = MODELS[choice];
    const key = k.own.includes(m.provider)
      ? "own"
      : k.mode == "server" && k.server.includes(m.provider) && !k.off.includes(choice)
        ? "server"
        : null;
    return key ? [{ choice, label: m.label, provider: m.provider, key }] : [];
  });
}

/** The model to be on: the one asked for if the person can use it, else the default, else the first they can; null: none. */
export function fitModel(k: KeySetup, wanted: ModelChoice | null): ModelChoice | null {
  const all = usableModels(k).map((u) => u.choice);
  return wanted && all.includes(wanted) ? wanted : all.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : (all[0] ?? null);
}

/**
 * The Document LLM API's models: the ones a document's script may call as its viewer (window.ergaLLM:
 * agents/page-llm.ts), with the server's keys. Anthropic's and OpenAI's, which take a cap on the tokens they answer.
 * The document's author chooses one (share_document llm_api_model); Haiku at first.
 */
const PAGE_LLM_PROVIDERS: readonly Provider[] = ["anthropic", "openai"];
export const PAGE_LLM_MODELS = (Object.keys(MODELS) as ModelChoice[]).filter((m) => PAGE_LLM_PROVIDERS.includes(MODELS[m].provider));
export const DEFAULT_PAGE_LLM_MODEL: ModelChoice = "haiku";
export const isPageLlmModel = (s: string): s is ModelChoice => (PAGE_LLM_MODELS as string[]).includes(s);

/** The ones the admin's switches have off at first (the document_llm_models_off setting's default): as for the agents. */
export const PAGE_LLM_OFF_AT_FIRST = PAGE_LLM_MODELS.filter((m) => MODELS_OFF_AT_FIRST.includes(m));

/**
 * The models a document's author may choose now, by one rule for every provider: the server provides keys, it has a
 * key for the model's provider, and the admin left the model on (`off`: the document_llm_models_off setting).
 */
export function pageLlmChoices(k: Pick<KeySetup, "server" | "mode">, off: readonly string[]): ModelChoice[] {
  return k.mode == "server" ? PAGE_LLM_MODELS.filter((m) => k.server.includes(MODELS[m].provider) && !off.includes(m)) : [];
}

// The models each person's agent can switch between, and which of them a person can use now. Data and decisions
// only, with no IO: the server's settings check model names against it, the admin's API keys page lists it, and
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
  /** Anthropic's fast mode (Opus only). */
  readonly fast?: boolean;
}

/** Our short list, by key: the current models of each provider. The keys are kept in conversations: don't rename one. */
export const MODELS = {
  "opus-fast": { provider: "anthropic", id: "claude-opus-5-5", label: "Opus 5.5 fast", fast: true },
  opus: { provider: "anthropic", id: "claude-opus-5-5", label: "Opus 5.5" },
  sonnet: { provider: "anthropic", id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  haiku: { provider: "anthropic", id: "claude-haiku-5-5", label: "Haiku 5.5" },
  "gpt-6.1-sol": { provider: "openai", id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  "gpt-6-astra": { provider: "openai", id: "gpt-6-astra", label: "GPT-6 Astra" },
  "gemini-4-argon": { provider: "google", id: "gemini-4-argon", label: "Gemini 4 Argon" },
  "gemini-3.8-flash": { provider: "google", id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  grok: { provider: "openrouter", id: "~x-ai/grok-latest", label: "Grok" },
  "kimi-k3": { provider: "openrouter", id: "moonshotai/kimi-k3", label: "Kimi K3" },
  "deepseek-v4-pro": { provider: "openrouter", id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
} as const satisfies Record<string, ModelInfo>;
export type ModelChoice = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelChoice = "opus-fast";
export const isModelChoice = (s: string): s is ModelChoice => Object.hasOwn(MODELS, s);
export const modelInfo = (choice: ModelChoice): ModelInfo => MODELS[choice];

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
 * The models a document's page may call as its visitor (window.ergaLLM: agents/page-llm.ts), with the server's keys:
 * Anthropic's, which take a cap on the tokens they answer. Its owner chooses one (share_document page_llm); Haiku at first.
 */
export const PAGE_LLM_MODELS = (Object.keys(MODELS) as ModelChoice[]).filter((m) => MODELS[m].provider == "anthropic");
export const DEFAULT_PAGE_LLM_MODEL: ModelChoice = "haiku";
export const isPageLlmModel = (s: string): s is ModelChoice => (PAGE_LLM_MODELS as string[]).includes(s);

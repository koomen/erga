// The model a document's script calls (the Document LLM API: agents/models.ts, pageModel): which models its author may
// choose (the ones a server key runs for the agents, and that the admin left on for documents), and a model of each
// provider Pi calls on the real path, with fetch answering in the provider's place: the request it sends (the model,
// the key, the cap on tokens, the least thinking the model has) and the text.

import { afterAll, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { LanguageModel, Prompt } from "effect/ai";
import { MODELS, MODELS_OFF_AT_FIRST, pageLlmChoices, type ModelChoice, type Provider } from "../shared/models";
import { pageModel, type AgentConfig } from "../agents/models";

const choices = (server: Provider[], o: { agentsOff?: string[]; off?: string[]; mode?: "server" | "own" } = {}): string[] =>
  pageLlmChoices({ server, mode: o.mode ?? "server", off: o.agentsOff ?? [] }, o.off ?? []);
const of = (p: Provider): string[] => (Object.keys(MODELS) as ModelChoice[]).filter((m) => MODELS[m].provider == p);

test("the models a document's author may choose, by one rule for every model: a server key runs it for the agents, and the admin left it on for documents", () => {
  expect(choices([])).toEqual([]);
  // Every provider's models, in the list's own order: no provider is left out.
  expect(choices(["anthropic"])).toEqual(of("anthropic"));
  expect(choices(["openai", "google"])).toEqual([...of("openai"), ...of("google")]);
  expect(choices(["anthropic", "openai", "google", "openrouter"])).toEqual(Object.keys(MODELS));
  // A model off for the agents (the agent_models_off setting) is not one of them; nor one off for documents (the
  // document_llm_models_off setting).
  expect(
    choices(["anthropic", "google"], { agentsOff: ["sonnet", "gemini-4-neon", ...MODELS_OFF_AT_FIRST], off: ["fable", "gemini-4-carbon"] })
  ).toEqual(["haiku", "opus", "opus-fast", "gemini-3.8-flash", "gemini-4-argon", "gemini-4-hydrogen"]);
  // Each person brings their own keys: the server's keys run nothing, for documents too. A person's key never pays for a document.
  expect(choices(["anthropic", "openai"], { mode: "own" })).toEqual([]);
});

const cfg = (o: Partial<AgentConfig>): AgentConfig => ({
  own: {},
  server: {},
  mode: "server",
  off: [],
  model: "opus",
  effort: "high",
  ...o,
});

test("no key of the server's for the model's provider, or the model off for the agents: no model", () => {
  expect(pageModel(cfg({ server: { anthropic: Redacted.make("sk-ant") } }), "gpt-6-luna", 100)).toBeNull();
  expect(pageModel(cfg({ server: { google: Redacted.make("g") }, off: ["gemini-3.8-flash"] }), "gemini-3.8-flash", 100)).toBeNull();
  expect(pageModel(cfg({ own: { google: Redacted.make("g") } }), "gemini-3.8-flash", 100)).toBeNull();
  expect(pageModel(cfg({ server: { google: Redacted.make("g") } }), "gemini-3.8-flash", 100)).not.toBeNull();
});

const real = globalThis.fetch;
const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
/** A streamed answer of OpenAI's Responses API with one text. */
function responses() {
  const ev = (data: object) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`;
  const item = { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] };
  const done = { ...item, status: "completed", content: [{ type: "output_text", text: "Hello from Luna.", annotations: [] }] };
  return [
    ev({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } }),
    ev({ type: "response.output_item.added", output_index: 0, item }),
    ev({
      type: "response.content_part.added",
      output_index: 0,
      item_id: "msg_1",
      content_index: 0,
      part: { type: "output_text", text: "" },
    }),
    ev({ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: "Hello from Luna." }),
    ev({ type: "response.output_item.done", output_index: 0, item: done }),
    ev({
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [done],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 } },
      },
    }),
  ].join("");
}
/** One of Google's Gemini API: a text, with the tokens of its thinking beside the answer's. */
const gemini = () =>
  `data: ${JSON.stringify({
    candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Hello from Gemini." }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 40, totalTokenCount: 55 },
  })}\r\n\r\n`;
/** One of OpenRouter's chat completions. */
function completions() {
  const chunk = (delta: object, finish: string | null, usage?: object) =>
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  return (
    chunk({ role: "assistant", content: "Hello from OpenRouter." }, null) +
    chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 }) +
    "data: [DONE]\n\n"
  );
}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  requests.push({ url: req.url, headers: req.headers, body: (await req.json()) as Record<string, unknown> });
  const body = req.url.includes("googleapis.com") ? gemini() : req.url.includes("openrouter.ai") ? completions() : responses();
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = real;
});

test("an OpenAI model for a page: the server's key, the cap on tokens, no reasoning, and the text", async () => {
  const layer = pageModel(
    cfg({ server: { openai: Redacted.make("sk-proj-server") }, own: { openai: Redacted.make("sk-own") } }),
    "gpt-6-luna",
    300
  );
  expect(layer).not.toBeNull();
  const prompt = Prompt.make([
    { role: "system", content: "Be brief." },
    { role: "user", content: [{ type: "text", text: "Hi" }] },
  ]);
  const parts = await Effect.runPromise(LanguageModel.streamText({ prompt }).pipe(Stream.runCollect, Effect.provide(layer!)));
  const text = Array.from(parts)
    .flatMap((p) => (p.type == "text-delta" ? [p.delta] : []))
    .join("");
  expect(text).toBe("Hello from Luna.");
  const finish = Array.from(parts).find((p) => p.type == "finish");
  expect(finish?.type == "finish" && finish.usage.outputTokens.total).toBe(4);
  expect(requests.length).toBe(1);
  const [r] = requests;
  expect(r.url).toBe("https://api.openai.com/v1/responses");
  expect(r.headers.get("authorization")).toBe("Bearer sk-proj-server");
  expect(r.body).toMatchObject({ model: "gpt-6-luna", max_output_tokens: 300, stream: true, reasoning: { effort: "none" } });
  expect(r.body.service_tier).toBeUndefined();
});

test("an OpenAI model's fast mode for a page: the request has the model's own id and the service tier fast", async () => {
  for (const [choice, id] of [
    ["gpt-6-luna-fast", "gpt-6-luna"],
    ["gpt-6.2-astra-fast", "gpt-6.2-astra"],
  ] as const) {
    requests.length = 0;
    const layer = pageModel(cfg({ server: { openai: Redacted.make("sk-proj-server") } }), choice, 300);
    const prompt = Prompt.make([{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
    await Effect.runPromise(LanguageModel.streamText({ prompt }).pipe(Stream.runCollect, Effect.provide(layer!)));
    expect(requests[0].body).toMatchObject({ model: id, max_output_tokens: 300, stream: true, service_tier: "fast" });
  }
});

test("GPT-6.2 Sol and Astra for a page: the request names no reasoning effort, as OpenAI refuses the effort none for them", async () => {
  for (const choice of ["gpt-6.2-sol", "gpt-6.2-astra"] as const) {
    requests.length = 0;
    const layer = pageModel(cfg({ server: { openai: Redacted.make("sk-proj-server") } }), choice, 300);
    const prompt = Prompt.make([{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
    await Effect.runPromise(LanguageModel.streamText({ prompt }).pipe(Stream.runCollect, Effect.provide(layer!)));
    expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0].body).toMatchObject({ model: choice, max_output_tokens: 300, stream: true });
    expect(requests[0].body.reasoning).toBeUndefined();
  }
});

/** The page's call of `choice` on the server's key for `provider`, with at most 300 tokens: the text and the output tokens. */
async function ask(choice: ModelChoice, provider: Provider) {
  requests.length = 0;
  const layer = pageModel(cfg({ server: { [provider]: Redacted.make("server-key") } }), choice, 300);
  const prompt = Prompt.make([
    { role: "system", content: "Be brief." },
    { role: "user", content: [{ type: "text", text: "Hi" }] },
  ]);
  const parts = Array.from(await Effect.runPromise(LanguageModel.streamText({ prompt }).pipe(Stream.runCollect, Effect.provide(layer!))));
  const finish = parts.find((p) => p.type == "finish");
  return {
    text: parts.flatMap((p) => (p.type == "text-delta" ? [p.delta] : [])).join(""),
    output: finish?.type == "finish" ? finish.usage.outputTokens.total : undefined,
  };
}

test("each Gemini model for a page, by the same rule: the server's key, the cap on tokens, its lowest thinking level, and the text; its thinking counts as output", async () => {
  for (const choice of ["gemini-3.8-flash", "gemini-4-argon", "gemini-4-hydrogen", "gemini-4-neon", "gemini-4-carbon"] as const) {
    expect(await ask(choice, "google")).toEqual({ text: "Hello from Gemini.", output: 45 });
    expect(requests.map((r) => r.url)).toEqual([
      `https://generativelanguage.googleapis.com/v1beta/models/${choice}:streamGenerateContent?alt=sse`,
    ]);
    expect(requests[0].headers.get("x-goog-api-key")).toBe("server-key");
    // (Gemini's thinking has no off: Pi asks for the lowest level.)
    expect(requests[0].body.generationConfig).toMatchObject({ maxOutputTokens: 300, thinkingConfig: { thinkingLevel: "LOW" } });
    expect(requests[0].body.tools).toBeUndefined();
  }
});

test("each OpenRouter model for a page, by the same rule: the server's key, the cap on tokens, no reasoning where the model has an off, and the text", async () => {
  for (const [choice, reasoning] of [
    ["kimi-k3", { effort: "none" }],
    ["deepseek-v4-pro", { effort: "none" }],
    // (Grok's reasoning has no off: the request names none.)
    ["grok", undefined],
  ] as const) {
    expect(await ask(choice, "openrouter")).toEqual({ text: "Hello from OpenRouter.", output: 6 });
    expect(requests.length).toBe(1);
    expect(requests[0].url).toContain("openrouter.ai");
    expect(requests[0].headers.get("authorization")).toBe("Bearer server-key");
    expect(requests[0].body).toMatchObject({ model: MODELS[choice].id, max_completion_tokens: 300, stream: true });
    expect(requests[0].body.reasoning).toEqual(reasoning);
  }
});

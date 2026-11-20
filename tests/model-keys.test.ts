// The models a person can use for each key setup (shared/models.ts), the key that runs each (agents/models.ts), and
// a conversation that goes from a model on the Pi router (OpenRouter's Kimi K3) to Claude, with fetch answering in
// both APIs' place: the request each sends, the key each carries, and the tool call's id that Anthropic takes. Then
// a turn on each Gemini 4 model, with fetch in the place of Google's API.

import { afterAll, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { LanguageModel, Prompt } from "effect/ai";
import {
  fitModel,
  isModelChoice,
  MODELS,
  MODELS_OFF_AT_FIRST,
  usableModels,
  type KeySetup,
  type ModelChoice,
} from "../shared/models";
import { Directory } from "../server/directory/index.ts";
import { memory } from "./helpers/memory-sql";
import { keyFor, pageModel, type AgentConfig } from "../agents/models";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { piModel } from "../agents/pi-model";
import { startLoop, type AgentTool } from "../agents/run";
import type { LogEvent } from "../shared/agent-log";
import { until } from "./helpers/until";

const setup = (k: Partial<KeySetup>): KeySetup => ({ own: [], server: [], mode: "server", off: [], ...k });
const names = (k: Partial<KeySetup>) => usableModels(setup(k)).map((u) => `${u.choice}:${u.key}`);

test("the models a person can use, for each key setup", () => {
  expect(names({})).toEqual([]);
  // A server key opens its provider's models, for everyone.
  expect(names({ server: ["anthropic"] })).toEqual([
    "haiku:server",
    "sonnet:server",
    "opus:server",
    "opus-fast:server",
    "fable:server",
    "fable-fast:server",
  ]);
  // The admin turned one off: a server key doesn't run it.
  expect(names({ server: ["anthropic"], off: ["opus-fast"] })).toEqual([
    "haiku:server",
    "sonnet:server",
    "opus:server",
    "fable:server",
    "fable-fast:server",
  ]);
  // The person's own key wins, and runs every model of its provider, the ones turned off too.
  expect(names({ server: ["anthropic"], own: ["anthropic"], off: ["opus-fast"] })).toEqual([
    "haiku:own",
    "sonnet:own",
    "opus:own",
    "opus-fast:own",
    "fable:own",
    "fable-fast:own",
  ]);
  // Own keys only: the server's keys run nothing.
  expect(names({ server: ["anthropic", "openai"], mode: "own" })).toEqual([]);
  expect(names({ server: ["anthropic"], own: ["openrouter"], mode: "own" })).toEqual(["kimi-k3:own", "deepseek-v4-pro:own", "grok:own"]);
  // Both, side by side, in the short list's order: each provider's models from the smallest to the largest, a model's
  // fast mode after it.
  expect(names({ server: ["google"], own: ["openai"] })).toEqual([
    "gpt-6-luna:own",
    "gpt-6-luna-fast:own",
    "gpt-6.1-terra:own",
    "gpt-6.1-terra-fast:own",
    "gpt-6.2-sol:own",
    "gpt-6.2-sol-fast:own",
    "gpt-6.2-astra:own",
    "gpt-6.2-astra-fast:own",
    "gemini-3.8-flash:server",
    "gemini-4-argon:server",
    "gemini-4-hydrogen:server",
    "gemini-4-neon:server",
    "gemini-4-carbon:server",
  ]);
});

test("the fast modes start off for a server key, but the default model's; an admin turns one on, and a person's own key runs them all", async () => {
  const fast = ["fable-fast", "gpt-6-luna-fast", "gpt-6.1-terra-fast", "gpt-6.2-sol-fast", "gpt-6.2-astra-fast"];
  expect<string[]>(MODELS_OFF_AT_FIRST).toEqual(fast);
  const dir = new Directory(memory(), { admins: ["ada"] });
  const off = await dir.config.get("agent_models_off");
  expect(off).toEqual(fast);
  expect(names({ server: ["anthropic", "openai"], off })).toEqual([
    "haiku:server",
    "sonnet:server",
    "opus:server",
    "opus-fast:server",
    "fable:server",
    "gpt-6-luna:server",
    "gpt-6.1-terra:server",
    "gpt-6.2-sol:server",
    "gpt-6.2-astra:server",
  ]);
  expect(names({ server: ["anthropic"], own: ["openai"], off }).filter((n) => n.includes("-fast"))).toEqual([
    "opus-fast:server",
    ...fast.slice(1).map((m) => `${m}:own`),
  ]);
  // The admin ticks one on the Agents and models page: the list without it.
  await dir.config.set({ login: "ada", admin: true }, "agent_models_off", fast.slice(1));
  expect(names({ server: ["anthropic"], off: await dir.config.get("agent_models_off") })).toContain("fable-fast:server");
});

test("the model to be on: the one asked for if it can be used, else the default, else the first", () => {
  expect(fitModel(setup({ server: ["anthropic"] }), "sonnet")).toBe("sonnet");
  expect(fitModel(setup({ server: ["anthropic"] }), "gpt-6.2-sol")).toBe("opus-fast");
  expect(fitModel(setup({ server: ["google"] }), "sonnet")).toBe("gemini-3.8-flash");
  expect(fitModel(setup({ server: ["anthropic"], mode: "own" }), "sonnet")).toBeNull();
});

test("a model that left the short list (GPT-6 Astra): the setting takes its name no more, and what was stored gives way to the default", async () => {
  const sql = memory();
  const dir = new Directory(sql, { admins: ["ada"] });
  const ada = { login: "ada", admin: true };
  await expect(dir.config.set(ada, "agent_models_off", ["gpt-6-astra"])).rejects.toThrow(/isn't one of the models/);
  // A list stored before, with its name: the default stands, until an admin sets the list again.
  await dir.config.set(ada, "agent_models_off", ["gpt-6.2-astra"]);
  expect(await dir.config.get("agent_models_off")).toEqual(["gpt-6.2-astra"]);
  sql.db.run(`UPDATE server_config SET value = '["gpt-6-astra","gpt-6.2-astra"]' WHERE key = 'agent_models_off'`);
  expect(await new Directory(sql, { admins: ["ada"] }).config.get("agent_models_off")).toEqual(MODELS_OFF_AT_FIRST);
  // A conversation's stored choice of it, and a page's: not a model, so the default.
  expect([isModelChoice("gpt-6-astra"), isModelChoice("gpt-6.1-sol")]).toEqual([false, false]);
  expect(fitModel(setup({ server: ["anthropic", "openai"] }), null)).toBe("opus-fast");
});

const cfg = (o: Partial<AgentConfig>): AgentConfig => ({
  own: {},
  server: {},
  mode: "server",
  off: [],
  model: "opus-fast",
  effort: "medium",
  ...o,
});

test("the key that runs a model: the person's own wins; a server key only as the settings allow", () => {
  const server = { anthropic: Redacted.make("sk-ant-server") },
    own = { anthropic: Redacted.make("sk-ant-own") };
  expect(Redacted.value(keyFor(cfg({ server }), "sonnet")!)).toBe("sk-ant-server");
  expect(Redacted.value(keyFor(cfg({ server, own }), "sonnet")!)).toBe("sk-ant-own");
  expect(keyFor(cfg({ server, mode: "own" }), "sonnet")).toBeNull();
  expect(keyFor(cfg({ server, off: ["sonnet"] }), "sonnet")).toBeNull();
  expect(keyFor(cfg({ server }), "kimi-k3")).toBeNull();
});

test("every model of the short list that Pi runs is in Pi's catalog", () => {
  for (const [choice, m] of Object.entries(MODELS) as [ModelChoice, (typeof MODELS)[ModelChoice]][])
    if (m.provider != "anthropic") expect(piModel(m.provider, m.id)?.id, choice).toBe(m.id);
});

test("Pi's own catalog lacks five models of the short list: when it has one, delete Erga's record of it (agents/pi-model.ts)", () => {
  const theirs = [...googleProvider().getModels(), ...openaiProvider().getModels()].map((m) => m.id);
  expect(theirs.filter((id) => id.startsWith("gemini-4-"))).toEqual(["gemini-4-argon"]);
  expect(theirs.filter((id) => id.startsWith("gpt-6.2-"))).toEqual([]);
});

// -- a conversation from OpenRouter (through Pi) to Anthropic, with fetch answering for both

const real = globalThis.fetch;
const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
const answers: Response[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  requests.push({ url: req.url, headers: req.headers, body: (await req.json()) as Record<string, unknown> });
  return answers.shift() ?? new Response("no answer set", { status: 500 });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = real;
});

/** A streamed answer of the Chat Completions API (OpenRouter's): text, or a tool call, then the stop. */
function completions(delta: object, finish: string) {
  const chunk = (d: object, f: string | null, usage?: object) =>
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 0, model: "moonshotai/kimi-k3", choices: [{ index: 0, delta: d, finish_reason: f }], ...(usage ? { usage } : {}) })}\n\n`;
  const body =
    chunk({ role: "assistant", ...delta }, null) +
    chunk({}, finish, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }) +
    "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** A streamed answer of Anthropic's Messages API with one text block. */
function messages(text: string) {
  const ev = (data: object) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`;
  const body =
    ev({
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }) +
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    ev({ type: "content_block_stop", index: 0 }) +
    ev({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }) +
    ev({ type: "message_stop" });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

test("a turn on Kimi K3 through Pi, with a tool call; then Sonnet goes on with the same conversation", async () => {
  const read: AgentTool = {
    name: "read",
    description: "Reads a file.",
    parameters: Schema.Struct({ path: Schema.String }),
    execute: async (_id, p) => ({ content: [{ type: "text", text: `${p.path}: hello` }] }),
  };
  const keys = cfg({
    own: { openrouter: Redacted.make("sk-or-own-key") },
    server: { anthropic: Redacted.make("sk-ant-server-key") },
    model: "kimi-k3",
  });
  const events: LogEvent[] = [];
  const loop = startLoop({ cfg: keys, stored: null, store: null, meta: {}, tag: "page", hooks: { about: () => null } });
  loop.start(keys, "You are a test.", [read]);
  loop.subscribe((e) => events.push(e));
  expect(loop.modelChoice).toBe("kimi-k3");
  expect(loop.models.map((u) => `${u.choice}:${u.key}`)).toContain("kimi-k3:own");

  answers.push(
    completions(
      { tool_calls: [{ index: 0, id: "call|1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }] },
      "tool_calls"
    ),
    completions({ content: "It says hello." }, "stop")
  );
  loop.prompt("What's in a.txt?", null, []);
  await until(() => events.some((e) => e.t == "busy" && !e.busy));
  expect(events.filter((e) => e.t == "error")).toEqual([]);
  // OpenRouter got the person's own key, the model's id, the tool, and then the tool's result.
  expect(requests[0].url).toContain("openrouter.ai");
  expect(requests[0].headers.get("authorization")).toBe("Bearer sk-or-own-key");
  expect(requests[0].body.model).toBe("moonshotai/kimi-k3");
  expect(JSON.stringify(requests[0].body.tools)).toContain('"read"');
  expect(JSON.stringify(requests[1].body.messages)).toContain("a.txt: hello");
  expect(
    events
      .filter((e) => e.t == "text")
      .map((e) => (e as { delta: string }).delta)
      .join("")
  ).toBe("It says hello.");

  // The switch: Sonnet, on the server's key, has the whole conversation, and the call's id as Anthropic takes it.
  expect(loop.setModel("sonnet")).toBe(true);
  expect(loop.setModel("gpt-6.2-sol")).toBe(false);
  events.length = 0;
  answers.push(messages("Yes, hello."));
  loop.prompt("Sure?", null, []);
  await until(() => events.some((e) => e.t == "busy" && !e.busy));
  expect(events.filter((e) => e.t == "error")).toEqual([]);
  const claude = requests[2];
  expect(claude.url).toContain("api.anthropic.com");
  expect(claude.headers.get("x-api-key")).toBe("sk-ant-server-key");
  const sent = JSON.stringify(claude.body.messages);
  expect(sent).toContain('"call_1"');
  expect(sent).not.toContain("call|1");
  expect(sent).toContain("It says hello.");

  // The person's key goes (the settings at the next turn): Kimi can't be chosen, and the conversation stays.
  loop.configure(cfg({ server: { anthropic: Redacted.make("sk-ant-server-key") }, model: "kimi-k3" }));
  expect(loop.setModel("kimi-k3")).toBe(false);
  expect(loop.messages.length).toBeGreaterThan(4);
});

/** A streamed answer of Google's Gemini API: one part (text, or a function call), then the stop. */
function gemini(part: object) {
  const chunk = {
    candidates: [{ index: 0, content: { role: "model", parts: [part] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\r\n\r\n`, { headers: { "content-type": "text/event-stream" } });
}

test("a turn on each Gemini 4 model through Pi, with a tool call: Google gets the key, the model, the tool and its result", async () => {
  const read: AgentTool = {
    name: "read",
    description: "Reads a file.",
    parameters: Schema.Struct({ path: Schema.String }),
    execute: async (_id, p) => ({ content: [{ type: "text", text: `${p.path}: hello` }] }),
  };
  for (const choice of ["gemini-4-argon", "gemini-4-hydrogen", "gemini-4-neon", "gemini-4-carbon"] as const) {
    // The highest effort: Pi sends each model's highest level that it knows.
    const keys = cfg({ own: { google: Redacted.make("AIza-own-key") }, model: choice, effort: "max" });
    const events: LogEvent[] = [];
    const loop = startLoop({ cfg: keys, stored: null, store: null, meta: {}, tag: "page", hooks: { about: () => null } });
    loop.start(keys, "You are a test.", [read]);
    loop.subscribe((e) => events.push(e));
    expect(loop.modelChoice).toBe(choice);
    requests.length = 0;
    answers.push(
      gemini({ functionCall: { name: "read", args: { path: "a.txt" } }, thoughtSignature: "c2lnbmF0dXJl" }),
      gemini({ text: "It says hello." })
    );
    loop.prompt("What's in a.txt?", null, []);
    await until(() => events.some((e) => e.t == "busy" && !e.busy));
    expect(events.filter((e) => e.t == "error")).toEqual([]);
    expect(requests.map((r) => r.url)).toEqual(
      Array(2).fill(`https://generativelanguage.googleapis.com/v1beta/models/${choice}:streamGenerateContent?alt=sse`)
    );
    expect(requests[0].headers.get("x-goog-api-key")).toBe("AIza-own-key");
    expect(JSON.stringify(requests[0].body.tools)).toContain('"read"');
    expect(requests[0].body.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: "HIGH" } });
    // The second request has the call with the signature Google gave it, and the tool's result.
    const sent = JSON.stringify(requests[1].body.contents);
    expect(sent).toContain('"thoughtSignature":"c2lnbmF0dXJl"');
    expect(sent).toContain("a.txt: hello");
    expect(
      events
        .filter((e) => e.t == "text")
        .map((e) => (e as { delta: string }).delta)
        .join("")
    ).toBe("It says hello.");
  }
});

test("a turn on Fable 5.2, and in its fast mode: Anthropic gets its id, adaptive thinking, the effort and the speed, and nothing that Fable refuses", async () => {
  const read: AgentTool = {
    name: "read",
    description: "Reads a file.",
    parameters: Schema.Struct({ path: Schema.String }),
    execute: async () => ({ content: [{ type: "text", text: "hello" }] }),
  };
  for (const choice of ["fable", "fable-fast"] as const) {
    const keys = cfg({ server: { anthropic: Redacted.make("sk-ant-server-key") }, model: choice });
    const events: LogEvent[] = [];
    const loop = startLoop({ cfg: keys, stored: null, store: null, meta: {}, tag: "page", hooks: { about: () => null } });
    loop.start(keys, "You are a test.", [read]);
    loop.subscribe((e) => events.push(e));
    expect(loop.modelChoice).toBe(choice);
    requests.length = 0;
    answers.push(messages("Hi."));
    loop.prompt("Hello", null, []);
    await until(() => events.some((e) => e.t == "busy" && !e.busy));
    expect(events.filter((e) => e.t == "error")).toEqual([]);
    // Fable refuses a forced tool call, and a temperature, top_p or top_k (its page of Anthropic's documentation).
    const { system: _s, messages: _m, tools: _t, ...sent } = requests[0].body;
    expect(sent).toEqual({
      model: "claude-fable-5-2",
      max_tokens: 64000,
      thinking: { type: "adaptive", display: "summarized" },
      tool_choice: { type: "auto" },
      output_config: { effort: "medium" },
      stream: true,
      ...(choice == "fable-fast" ? { speed: "fast" } : {}),
    });
    // Fast mode needs no beta header on Fable 5.2 (nor on Opus 5.5).
    expect(requests[0].headers.get("anthropic-beta") ?? "").not.toContain("fast-mode");
  }
});

/** A streamed answer of OpenAI's Responses API with one text. */
function responses(text: string) {
  const ev = (data: object) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`;
  const item = { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] };
  const done = { ...item, status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const body =
    ev({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } }) +
    ev({ type: "response.output_item.added", output_index: 0, item }) +
    ev({
      type: "response.content_part.added",
      output_index: 0,
      item_id: "msg_1",
      content_index: 0,
      part: { type: "output_text", text: "" },
    }) +
    ev({ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: text }) +
    ev({ type: "response.output_item.done", output_index: 0, item: done }) +
    ev({
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        service_tier: "fast",
        output: [done],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 } },
      },
    });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

test("a turn on each GPT model in its fast mode through Pi: OpenAI gets the model's own id and the service tier fast; the model alone gets no tier", async () => {
  for (const [choice, id, tier] of [
    ["gpt-6-luna-fast", "gpt-6-luna", "fast"],
    ["gpt-6.1-terra-fast", "gpt-6.1-terra", "fast"],
    ["gpt-6.2-sol-fast", "gpt-6.2-sol", "fast"],
    ["gpt-6.2-astra-fast", "gpt-6.2-astra", "fast"],
    ["gpt-6.2-sol", "gpt-6.2-sol", undefined],
  ] as const) {
    const keys = cfg({ own: { openai: Redacted.make("sk-proj-own-key") }, model: choice });
    const events: LogEvent[] = [];
    const loop = startLoop({ cfg: keys, stored: null, store: null, meta: {}, tag: "page", hooks: { about: () => null } });
    loop.start(keys, "You are a test.", []);
    loop.subscribe((e) => events.push(e));
    expect(loop.modelChoice).toBe(choice);
    requests.length = 0;
    answers.push(responses("Hi."));
    loop.prompt("Hello", null, []);
    await until(() => events.some((e) => e.t == "busy" && !e.busy));
    expect(events.filter((e) => e.t == "error")).toEqual([]);
    expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0].headers.get("authorization")).toBe("Bearer sk-proj-own-key");
    expect(requests[0].body).toMatchObject({ model: id, stream: true, reasoning: { effort: "medium" } });
    expect(requests[0].body.service_tier).toBe(tier);
    expect(
      events
        .filter((e) => e.t == "text")
        .map((e) => (e as { delta: string }).delta)
        .join("")
    ).toBe("Hi.");
  }
});

test("Claude's fast modes for a page: the request has the speed; the model alone has none", async () => {
  for (const [choice, id, speed] of [
    ["opus-fast", "claude-opus-5-5", "fast"],
    ["fable-fast", "claude-fable-5-2", "fast"],
    ["opus", "claude-opus-5-5", undefined],
  ] as const) {
    requests.length = 0;
    answers.push(messages("Hi."));
    const layer = pageModel(cfg({ server: { anthropic: Redacted.make("sk-ant-server-key") } }), choice, 300);
    const prompt = Prompt.make([{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
    await Effect.runPromise(LanguageModel.streamText({ prompt }).pipe(Stream.runCollect, Effect.provide(layer!)));
    expect(requests[0].body).toMatchObject({ model: id, max_tokens: 300, stream: true });
    expect(requests[0].body.speed).toBe(speed);
    expect(requests[0].headers.get("anthropic-beta") ?? "").not.toContain("fast-mode");
  }
});

test("a key that Google refuses: the panel has Google's words, not its JSON", async () => {
  const keys = cfg({ own: { google: Redacted.make("AIza-wrong-key") }, model: "gemini-4-neon" });
  const events: LogEvent[] = [];
  const loop = startLoop({ cfg: keys, stored: null, store: null, meta: {}, tag: "page", hooks: { about: () => null } });
  loop.start(keys, "You are a test.", []);
  loop.subscribe((e) => events.push(e));
  // As Google answers (2026-11-19).
  const refusal = { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } };
  answers.push(new Response(JSON.stringify(refusal, null, 2), { status: 400, headers: { "content-type": "application/json" } }));
  loop.prompt("Hello", null, []);
  await until(() => events.some((e) => e.t == "busy" && !e.busy));
  expect(events.filter((e) => e.t == "error").map((e) => (e as { text: string }).text)).toEqual([
    'API key not valid. Please pass a valid API key. Say "go on" to try again.',
  ]);
});

test("on a model whose key went: the next turn never runs it, says so, and goes on with one that can be used", async () => {
  const both = cfg({
    own: { openrouter: Redacted.make("sk-or-own-key") },
    server: { anthropic: Redacted.make("sk-ant-server-key") },
    model: "kimi-k3",
  });
  const events: LogEvent[] = [];
  const loop = startLoop({ cfg: both, stored: null, store: null, meta: {}, tag: "page", hooks: { about: () => null } });
  loop.start(both, "You are a test.", []);
  loop.subscribe((e) => events.push(e));
  requests.length = 0;
  // The key is removed between the choice and the message.
  loop.configure(cfg({ server: { anthropic: Redacted.make("sk-ant-server-key") }, model: "kimi-k3" }));
  answers.push(messages("Hi."));
  loop.prompt("Hello", null, []);
  await until(() => events.some((e) => e.t == "busy" && !e.busy));
  expect(loop.modelChoice).toBe("opus-fast");
  expect(requests.map((r) => new URL(r.url).host)).toEqual(["api.anthropic.com"]);
  expect(events.find((e) => e.t == "error")).toMatchObject({ text: expect.stringContaining("Kimi K3 can't be used now") });
});

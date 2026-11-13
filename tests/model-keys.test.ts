// The models a person can use for each key setup (shared/models.ts), the key that runs each (agents/models.ts), and
// a conversation that goes from a model on the Pi router (OpenRouter's Kimi K3) to Claude, with fetch answering in
// both APIs' place: the request each sends, the key each carries, and the tool call's id that Anthropic takes.

import { afterAll, expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { fitModel, MODELS, usableModels, type KeySetup, type ModelChoice } from "../shared/models";
import { keyFor, type AgentConfig } from "../agents/models";
import { piModel } from "../agents/pi-model";
import { startLoop, type AgentTool } from "../agents/run";
import type { LogEvent } from "../shared/agent-log";
import { until } from "./helpers/until";

const setup = (k: Partial<KeySetup>): KeySetup => ({ own: [], server: [], mode: "server", off: [], ...k });
const names = (k: Partial<KeySetup>) => usableModels(setup(k)).map((u) => `${u.choice}:${u.key}`);

test("the models a person can use, for each key setup", () => {
  expect(names({})).toEqual([]);
  // A server key opens its provider's models, for everyone.
  expect(names({ server: ["anthropic"] })).toEqual(["opus-fast:server", "opus:server", "sonnet:server", "haiku:server"]);
  // The admin turned one off: a server key doesn't run it.
  expect(names({ server: ["anthropic"], off: ["opus-fast"] })).toEqual(["opus:server", "sonnet:server", "haiku:server"]);
  // The person's own key wins, and runs every model of its provider, the ones turned off too.
  expect(names({ server: ["anthropic"], own: ["anthropic"], off: ["opus-fast"] })).toEqual([
    "opus-fast:own",
    "opus:own",
    "sonnet:own",
    "haiku:own",
  ]);
  // Own keys only: the server's keys run nothing.
  expect(names({ server: ["anthropic", "openai"], mode: "own" })).toEqual([]);
  expect(names({ server: ["anthropic"], own: ["openrouter"], mode: "own" })).toEqual(["grok:own", "kimi-k3:own", "deepseek-v4-pro:own"]);
  // Both, side by side, in the short list's order.
  expect(names({ server: ["google"], own: ["openai"] })).toEqual([
    "gpt-6.1-sol:own",
    "gpt-6-astra:own",
    "gpt-6.1-terra:own",
    "gpt-6-luna:own",
    "gemini-4-argon:server",
    "gemini-3.8-flash:server",
  ]);
});

test("the model to be on: the one asked for if it can be used, else the default, else the first", () => {
  expect(fitModel(setup({ server: ["anthropic"] }), "sonnet")).toBe("sonnet");
  expect(fitModel(setup({ server: ["anthropic"] }), "gpt-6.1-sol")).toBe("opus-fast");
  expect(fitModel(setup({ server: ["google"] }), "sonnet")).toBe("gemini-4-argon");
  expect(fitModel(setup({ server: ["anthropic"], mode: "own" }), "sonnet")).toBeNull();
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
  expect(loop.setModel("gpt-6.1-sol")).toBe(false);
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

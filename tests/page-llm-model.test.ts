// The model a document's page calls (agents/models.ts, pageModel): which models its owner may choose (Claude's, and
// OpenAI's where the server has an OpenAI key), and an OpenAI model on the real path, through Pi, with fetch answering
// in the Responses API's place: the request it sends (the model, the key, the cap on tokens, no reasoning) and the text.

import { afterAll, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { LanguageModel, Prompt } from "effect/ai";
import { pageLlmChoices, type KeySetup } from "../shared/models";
import { pageModel, type AgentConfig } from "../agents/models";

const setup = (k: Partial<KeySetup>): KeySetup => ({ own: [], server: [], mode: "server", off: [], ...k });
const choices = (k: Partial<KeySetup>): string[] => pageLlmChoices(setup(k));
const claude: string[] = ["opus-fast", "opus", "sonnet", "haiku"];

test("the page models an owner may choose: Claude's, and OpenAI's where the server's keys run them", () => {
  expect(choices({ server: ["anthropic"] })).toEqual(claude);
  expect(choices({ server: ["anthropic", "openai", "google"] })).toEqual([
    ...claude,
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6.1-terra",
    "gpt-6-luna",
  ]);
  // The admin turned one off, or each person brings their own keys: the server's key doesn't run it for pages.
  expect(choices({ server: ["openai"], off: ["gpt-6-astra"] })).toEqual([...claude, "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]);
  expect(choices({ server: ["openai"], mode: "own" })).toEqual(claude);
  // A person's own key never pays for a page.
  expect(choices({ own: ["openai"] })).toEqual(claude);
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

test("no OpenAI key on the server, or a provider pages don't use: no model", () => {
  expect(pageModel(cfg({ server: { anthropic: Redacted.make("sk-ant") } }), "gpt-6-luna", 100)).toBeNull();
  expect(pageModel(cfg({ server: { google: Redacted.make("g") } }), "gemini-3.8-flash", 100)).toBeNull();
});

const real = globalThis.fetch;
const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  requests.push({ url: req.url, headers: req.headers, body: (await req.json()) as Record<string, unknown> });
  const ev = (data: object) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`;
  const item = { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] };
  const done = { ...item, status: "completed", content: [{ type: "output_text", text: "Hello from Luna.", annotations: [] }] };
  const body = [
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
});

// The agent loop on the real model's path (agents/run.ts, agents/models.ts: Effect AI's Anthropic provider), with
// fetch answering in the API's place: what the request carries (fast mode's beta and speed, adaptive thinking, the
// effort, the tools' JSON Schema, a PDF in a tool's result as a document, the prompt cache's marks), and the
// streamed answer in the transcript and the messages.

import { afterAll, expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { startLoop, type AgentTool } from "../agents/run";
import type { LogEvent } from "../shared/agent-log";

// One stub for the file: Effect's fetch client keeps the fetch it first sees, so each test sets `answer`.
const real = globalThis.fetch;
const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
let answer: () => Response = () => {
  throw new Error("no answer set");
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  requests.push({ headers: req.headers, body: (await req.json()) as Record<string, unknown> });
  return answer();
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = real;
});

/** An SSE answer of the Messages API: `blocks` in order, then the stop. */
function sse(
  blocks: (
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: object }
    | { type: "thinking"; thinking: string; signature: string }
  )[],
  stop: string
) {
  const ev = (data: object) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`;
  let body = ev({
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  blocks.forEach((b, index) => {
    if (b.type == "text") {
      body += ev({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      body += ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else if (b.type == "thinking") {
      body += ev({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      body += ev({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } });
      body += ev({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
    } else {
      body += ev({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      body += ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    body += ev({ type: "content_block_stop", index });
  });
  body += ev({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  body += ev({ type: "message_stop" });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

test("a turn on Opus in fast mode: the request, the streamed text and thinking, a tool call with a PDF, and the reply", async () => {
  requests.length = 0;
  const answers = [
    sse(
      [
        { type: "thinking", thinking: "Read it.", signature: "sig-1" },
        { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.pdf" } },
      ],
      "tool_use"
    ),
    sse([{ type: "text", text: "It says hello." }], "end_turn"),
  ];
  answer = () => answers.shift()!;

  const read: AgentTool = {
    name: "read",
    description: "Reads a file.",
    parameters: Schema.Struct({ path: Schema.String.annotate({ description: "The file" }) }),
    execute: async (_id, p) => ({
      content: [
        { type: "text", text: `${p.path}: 1 page` },
        { type: "image", data: "JVBERi0=", mimeType: "application/pdf" },
      ],
    }),
  };
  const events: LogEvent[] = [];
  const loop = startLoop({
    cfg: { own: {}, server: { anthropic: Redacted.make("sk-test") }, mode: "server", off: [], model: "opus-fast", effort: "high" },
    stored: null,
    store: null,
    meta: {},
    tag: "editor",
    hooks: { about: (_n, a) => (a as { path?: string }).path ?? null },
  });
  const whoami: AgentTool = {
    name: "whoami",
    description: "Who you are.",
    parameters: Schema.Struct({}),
    execute: async () => ({ content: [{ type: "text", text: "Ada" }] }),
  };
  loop.start(loop.cfg!, "You edit documents.", [read, whoami]);
  const done = new Promise<void>((resolve) =>
    loop.subscribe((ev) => {
      events.push(ev);
      if (ev.t == "busy" && !ev.busy) resolve();
    })
  );
  loop.prompt("What does a.pdf say?", null, []);
  await done;

  expect(requests.length).toBe(2);
  const [first, second] = requests;
  expect(first.headers.get("x-api-key")).toBe("sk-test");
  expect(first.headers.get("anthropic-beta")).toContain("fast-mode-2026-02-01");
  expect(first.body).toMatchObject({
    model: "claude-opus-5-5",
    max_tokens: 64_000,
    stream: true,
    speed: "fast",
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
  });
  expect(first.body.system).toEqual([{ type: "text", text: "You edit documents.", cache_control: { type: "ephemeral" } }]);
  const tools = first.body.tools as { name: string; input_schema: unknown }[];
  expect(tools[0]).toMatchObject({
    name: "read",
    description: "Reads a file.",
    input_schema: { type: "object", properties: { path: { type: "string", description: "The file" } }, required: ["path"] },
  });
  // A tool with no arguments: an object with none (the API refuses any other schema).
  expect(tools[1]).toMatchObject({ name: "whoami", input_schema: { type: "object", properties: {} } });
  // The second turn: the thinking with its signature, the call, and its result with the PDF as a document.
  const msgs = second.body.messages as { role: string; content: Record<string, unknown>[] }[];
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(msgs[1].content).toEqual([
    { type: "thinking", thinking: "Read it.", signature: "sig-1" },
    { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.pdf" } },
  ]);
  expect(msgs[2].content[0]).toMatchObject({
    type: "tool_result",
    tool_use_id: "toolu_1",
    is_error: false,
    content: [
      { type: "text", text: "a.pdf: 1 page" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
    ],
    cache_control: { type: "ephemeral" },
  });
  // What the panel saw, as it streamed.
  expect(events.filter((e) => e.t != "busy").map((e) => e.t)).toEqual(["user", "thinking", "tool", "tool", "text"]);
  expect(events.find((e) => e.t == "tool" && e.status == "done")).toMatchObject({ name: "read", path: "a.pdf" });
  expect(loop.log.items.at(-1)).toEqual({ kind: "assistant", text: "It says hello." });
  expect(loop.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  expect(loop.model).toBe("Opus 5.5 fast");
});

test("Opus 5.5 at normal speed has no fast mode; an API error shows in the transcript in the API's words, and the run ends", async () => {
  requests.length = 0;
  answer = () => Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 });
  const events: LogEvent[] = [];
  const loop = startLoop({
    cfg: { own: {}, server: { anthropic: Redacted.make("sk-test") }, mode: "server", off: [], model: "opus", effort: "medium" },
    stored: null,
    store: null,
    meta: {},
    tag: "page",
    hooks: { about: () => null },
  });
  loop.start(loop.cfg!, "You help admins.", []);
  const done = new Promise<void>((resolve) =>
    loop.subscribe((ev) => {
      events.push(ev);
      if (ev.t == "busy" && !ev.busy) resolve();
    })
  );
  loop.prompt("Hi", null, []);
  await done;
  expect(requests[0].body.model).toBe("claude-opus-5-5");
  expect(requests[0].body.speed).toBeUndefined();
  expect(requests[0].headers.get("anthropic-beta") ?? "").not.toContain("fast-mode");
  const error = events.find((e) => e.t == "error") as { text: string } | undefined;
  expect(error?.text).toContain("Overloaded");
  expect(loop.log.busy).toBe(false);
});

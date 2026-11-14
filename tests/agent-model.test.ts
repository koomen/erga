// The agent loop on the real model's path (agents/run.ts, agents/models.ts: Effect AI's Anthropic provider), with
// fetch answering in the API's place: what the request carries (fast mode's beta and speed, adaptive thinking, the
// effort, the tools' JSON Schema, a PDF in a tool's result as a document, the prompt cache's marks), and the
// streamed answer in the transcript and the messages.

import { afterAll, expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { ChatMessage, StoredChat } from "../agents/checkpoint";
import { startLoop, toolMessage, type AgentTool } from "../agents/run";
import type { LogEvent } from "../shared/agent-log";
import { fromBase64 } from "../shared/bytes";
import { pictureSize } from "../shared/picture";
import { pngOf } from "./helpers/png";
import { until } from "./helpers/until";

// One stub for the file: Effect's fetch client keeps the fetch it first sees, so each test sets `answer`.
const real = globalThis.fetch;
const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
let answer: () => Response | Promise<Response> = () => {
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
  // An overload may pass: the loop asked three times, then the run ended, and the panel says how to go on.
  expect(requests.length).toBe(3);
  expect(error?.text).toBe('Internal provider error: Overloaded. The agent asked 3 times. Say "go on" to try again.');
  expect(loop.log.busy).toBe(false);
});

/** A loop on Opus with the server's key, and its events; `turn` sends a message and waits for the run's end. */
function opus(stored: StoredChat | null = null) {
  requests.length = 0;
  const events: LogEvent[] = [];
  const loop = startLoop({
    cfg: { own: {}, server: { anthropic: Redacted.make("sk-test") }, mode: "server", off: [], model: "opus", effort: "medium" },
    stored,
    store: null,
    meta: {},
    tag: "page",
    hooks: { about: () => null },
  });
  loop.start(loop.cfg!, "You help.", []);
  loop.subscribe((ev) => void events.push(ev));
  const turn = async (text: string) => {
    const from = events.length;
    loop.prompt(text, null, []);
    await until(() => events.slice(from).some((e) => e.t == "busy" && !e.busy));
    return events.slice(from);
  };
  const errors = (evs: LogEvent[]) => evs.flatMap((e) => (e.t == "error" ? [e.text] : []));
  return { loop, turn, errors };
}

type Block = { type: string; source?: { data: string }; content?: Block[] | string };
/**
 * The API's own rule for pictures (its Vision guide, and the error of production): 8000 px a side, and 3000 px in a
 * request with more than 20 pictures, a tool's too. The refusal, in the API's words, or null.
 */
function refusedPicture(body: Record<string, unknown>): Response | null {
  const found: { at: string; side: number }[] = [];
  const see = (b: Block, at: string) => {
    const size = b.type == "image" ? pictureSize(fromBase64(b.source!.data)) : null;
    if (size) found.push({ at, side: Math.max(size.width, size.height) });
    if (b.type == "tool_result" && Array.isArray(b.content)) b.content.forEach((c, k) => see(c, `${at}.content.${k}`));
  };
  (body.messages as { content: Block[] | string }[]).forEach((m, i) => {
    if (Array.isArray(m.content)) m.content.forEach((b, j) => see(b, `messages.${i}.content.${j}`));
  });
  const many = found.length > 20;
  const bad = found.find((f) => f.side > (many ? 3000 : 8000));
  if (!bad) return null;
  const message = `${bad.at}.image.source.base64.data: At least one of the image dimensions exceed max allowed size${many ? " for many-image requests: 3000 pixels" : ": 8000 pixels"}`;
  return Response.json(
    { type: "error", error: { type: "invalid_request_error", message } },
    { status: 400, headers: { "request-id": "req_test" } }
  );
}

/** A conversation as the store kept it: a message, then `pictures` view_page calls, each with its picture. */
function looked(pictures: string[]): StoredChat {
  const messages: ChatMessage[] = [{ role: "user", content: "Look at the page." }];
  pictures.forEach((data, i) => {
    messages.push({
      role: "assistant",
      content: [{ type: "tool-call", id: `toolu_${i}`, name: "page", params: {}, providerExecuted: false }],
    });
    messages.push(toolMessage(`toolu_${i}`, "page", { content: [{ type: "image", data, mimeType: "image/png" }] }, false));
  });
  messages.push({ role: "assistant", content: [{ type: "text", text: "I looked." }] });
  return { messages, log: [], state: { running: false, queued: [], calls: {}, model: "opus", stable: 0, meta: {}, at: 0 } };
}

test("a long conversation with a whole page's picture from before the rule: the request stays inside the API's limits", async () => {
  // 21 pictures, one of them 1280×4200 px: the request that production refused (the report).
  const { loop, turn, errors } = opus(looked([...Array.from({ length: 20 }, () => pngOf(1280, 800)), pngOf(1280, 4200)]));
  answer = () => refusedPicture(requests.at(-1)!.body) ?? sse([{ type: "text", text: "On it." }], "end_turn");
  expect(errors(await turn("Go on."))).toEqual([]);
  expect(loop.log.items.at(-1)).toEqual({ kind: "assistant", text: "On it." });
  // The tall picture has words in its place, with its size; the others went as they are.
  const sent = JSON.stringify(requests[0].body.messages);
  expect(sent.split('"type":"image"').length - 1).toBe(20);
  expect(sent).toContain("[A picture was here. It is 1280×4200 px: more than the 3000 px a side that the model takes.");
});

test("a request that the API refuses ends the turn with the API's words and how to go on, and the next message is taken", async () => {
  const { loop, turn, errors } = opus();
  const refusal = { type: "invalid_request_error", message: "messages.0.content: something the API does not take" };
  answer = () => Response.json({ type: "error", error: refusal }, { status: 400 });
  const said = errors(await turn("Hi"));
  // A refused request does not pass a moment later: asked one time.
  expect(requests.length).toBe(1);
  expect(said.length).toBe(1);
  expect(said[0]).toContain("messages.0.content: something the API does not take");
  expect(said[0]).toEndWith(
    'The model refused the request. Say "go on" to try again. If the same error comes back, start a new conversation (the + above).'
  );
  expect(loop.log.busy).toBe(false);
  // The person goes on: the agent takes the message, and answers.
  answer = () => sse([{ type: "text", text: "Here." }], "end_turn");
  expect(errors(await turn("go on"))).toEqual([]);
  expect(loop.log.items.at(-1)).toEqual({ kind: "assistant", text: "Here." });
  expect(loop.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
});

/** An SSE answer cut after its start: `text` streamed (or none), then `end` (an error event), or nothing: the connection closed. */
function cut(text: string | null, end?: object) {
  const whole = sse(text == null ? [] : [{ type: "text", text }], "end_turn");
  return whole.text().then((body) => {
    const kept = body.slice(0, body.indexOf(text == null ? "event: message_delta" : "event: content_block_stop"));
    return new Response(kept + (end ? `event: error\ndata: ${JSON.stringify(end)}\n\n` : ""), {
      headers: { "content-type": "text/event-stream" },
  });
  });
}
const OVERLOADED = { type: "error", error: { type: "overloaded_error", message: "Overloaded" }, request_id: "req_1" };

test("an overload that passes: the loop asks again, and the turn goes on with no error", async () => {
  const { loop, turn, errors } = opus();
  // First the HTTP answer 529; then an error at the start of the stream, before any text; then the answer.
  const answers: (() => Response | Promise<Response>)[] = [
    () => Response.json(OVERLOADED, { status: 529 }),
    () => cut(null, OVERLOADED),
    () => sse([{ type: "text", text: "Here." }], "end_turn"),
  ];
  answer = () => answers.shift()!() as Response;
  expect(errors(await turn("Hi"))).toEqual([]);
  expect(requests.length).toBe(3);
  expect(loop.log.items.at(-1)).toEqual({ kind: "assistant", text: "Here." });
});

test("an answer that stops in the middle ends the turn with a reason, never in silence", async () => {
  const { loop, turn, errors } = opus();
  // An error after text: the text shows already, so the loop does not ask again.
  answer = () => cut("Half an ans", OVERLOADED) as unknown as Response;
  expect(errors(await turn("Hi"))).toEqual(['Overloaded. Say "go on" to try again.']);
  expect(requests.length).toBe(1);
  // The connection closes with no end.
  answer = () => cut("Half an ans") as unknown as Response;
  expect(errors(await turn("go on"))).toEqual(['The connection to the model closed before its answer ended. Say "go on" to try again.']);
  // The model's answer reaches its length limit: what came stays, and the panel says why it stops.
  answer = () => sse([{ type: "text", text: "A long ans" }], "max_tokens");
  expect(errors(await turn("go on"))).toEqual(['The model\'s answer reached its length limit, and stops here. Say "go on" to continue.']);
  expect(loop.messages.at(-1)).toMatchObject({ role: "assistant" });
  // The model declines.
  answer = () => sse([], "refusal");
  expect(errors(await turn("go on"))).toEqual([
    "The model declined to answer this. Ask in another way, or start a new conversation (the + above).",
  ]);
  expect(loop.log.busy).toBe(false);
});

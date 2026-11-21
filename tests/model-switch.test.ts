// A person switches models in the middle of a conversation (agents/models.ts, messagesFor; agents/pi-model.ts): a
// conversation made with each provider (Anthropic, Google, OpenAI) on the real path, with fetch answering in each API's
// place, goes on with each of the three. Each answer has what only its own provider reads back: thinking with a
// signature, an empty text (Claude's before a tool call, Gemini's with a thought signature), a turn of thinking alone,
// a tool's result with no text. The stub refuses a request as the API would, and no request is refused.

import { afterAll, expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { AgentConfig } from "../agents/models";
import { startLoop, type AgentTool } from "../agents/run";
import type { LogEvent } from "../shared/agent-log";
import { MODELS, type ModelChoice } from "../shared/models";
import { until } from "./helpers/until";

type Json = Record<string, any>;
type Api = "anthropic" | "google" | "openai";

const real = globalThis.fetch;
const requests: { api: Api; body: Json }[] = [];
/** The answers of the conversation's first turns, in order; with none left, the API answers the request by its rules. */
const answers: Response[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const api: Api = req.url.includes("anthropic") ? "anthropic" : req.url.includes("googleapis") ? "google" : "openai";
  const body = (await req.json()) as Json;
  requests.push({ api, body });
  const scripted = answers.shift();
  if (scripted) return scripted;
  const refusal = REFUSES[api](body);
  return refusal ? Response.json(refusal, { status: 400 }) : SAYS[api]("On it.");
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = real;
});

const sse = (events: object[], named = true) =>
  new Response(events.map((e) => `${named ? `event: ${(e as { type: string }).type}\n` : ""}data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

/** A streamed answer of Anthropic's Messages API: `blocks` in order (a text block may be empty, as Claude's are at times). */
function claude(blocks: Json[], stop = "end_turn") {
  const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null };
  return sse([
    { type: "message_start", message: { ...message, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    ...blocks.flatMap((b, index) => [
      {
        type: "content_block_start",
        index,
        content_block:
          b.type == "text"
            ? { type: "text", text: "" }
            : b.type == "thinking"
              ? { type: "thinking", thinking: "", signature: "" }
              : { ...b, input: {} },
      },
      ...(b.type == "text" && b.text ? [{ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } }] : []),
      ...(b.type == "thinking"
        ? [
            { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } },
            { type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } },
          ]
        : []),
      ...(b.type == "tool_use"
        ? [{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }]
        : []),
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);
}

/** A streamed answer of Google's Gemini API: its parts, then the stop. */
const gemini = (parts: Json[]) =>
  sse(
    [
      {
        candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
      },
    ],
    false
  );

/** A streamed answer of OpenAI's Responses API: its output items (reasoning, a function call, a message). */
function gpt(items: Json[]) {
  const done: Json[] = items.map((item) => ({ ...item, status: "completed" }));
  return sse([
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    ...done.flatMap((item, output_index) => [
      {
        type: "response.output_item.added",
        output_index,
        item: { ...item, status: "in_progress", ...(item.type == "function_call" ? { arguments: "" } : {}) },
      },
      ...(item.type == "message"
        ? [{ type: "response.output_text.delta", output_index, item_id: item.id, content_index: 0, delta: item.content[0].text }]
        : []),
      { type: "response.output_item.done", output_index, item },
    ]),
    {
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: done, usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } },
    },
  ]);
}
const said = (text: string) => ({
  type: "message",
  id: "msg_1",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});

const SAYS: Record<Api, (text: string) => Response> = {
  anthropic: (text) => claude([{ type: "text", text }]),
  google: (text) => gemini([{ text }]),
  openai: (text) => gpt([said(text)]),
};

// What each provider gave with its answer, and takes back from no other: a request with another's is refused.
const CLAUDE_SIGNATURE = "claude-signature-1";
const GEMINI_SIGNATURES = ["Z2VtaW5pLWNhbGw=", "Z2VtaW5pLXRleHQ=", "Z2VtaW5pLXRob3VnaHQ="];
const GPT_REASONING = "gpt-encrypted-1";

const blank = (text: unknown) => typeof text != "string" || !text.trim();

// Each API's rules for a conversation: null if it takes the request, else its error. In the API's own words where its
// errors of production or its documentation have them.
const REFUSES: Record<Api, (body: Json) => Json | null> = {
  anthropic(body) {
    const no = (message: string) => ({ type: "error", error: { type: "invalid_request_error", message } });
    const messages = body.messages as { role: string; content: Json[] }[];
    for (const [i, m] of messages.entries()) {
      if (!m.content.length)
        return no(`messages.${i}: all messages must have non-empty content except for the optional final assistant message`);
      const texts = m.content.flatMap((b) =>
        b.type == "text" ? [b] : b.type == "tool_result" && Array.isArray(b.content) ? b.content.filter((c: Json) => c.type == "text") : []
      );
      if (texts.some((b) => b.text === "")) return no("messages: text content blocks must be non-empty");
      if (texts.some((b) => blank(b.text))) return no("messages: text content blocks must contain non-whitespace text");
      if (m.role == "assistant" && m.content.at(-1)!.type == "thinking")
        return no(`messages.${i}: The final block in an assistant message cannot be \`thinking\`.`);
      for (const [j, b] of m.content.entries()) {
        if (b.type == "thinking" && b.signature != CLAUDE_SIGNATURE)
          return no(`messages.${i}.content.${j}: Invalid \`signature\` in \`thinking\` block`);
        if (b.type == "tool_use" && !/^[a-zA-Z0-9_-]{1,64}$/.test(b.id))
          return no(`messages.${i}.content.${j}.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'`);
      }
      const ids = (role: string, type: string, at: number): string[] =>
        messages[at]?.role == role ? messages[at].content.flatMap((b) => (b.type == type ? [b.id ?? b.tool_use_id] : [])) : [];
      const open = ids("assistant", "tool_use", i).filter((id) => !ids("user", "tool_result", i + 1).includes(id));
      if (open.length)
        return no(`messages.${i}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${open.join(", ")}`);
      const lost = ids("user", "tool_result", i).filter((id) => !ids("assistant", "tool_use", i - 1).includes(id));
      if (lost.length) return no(`messages.${i}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${lost.join(", ")}`);
    }
    return null;
  },
  google(body) {
    const no = (message: string) => ({ error: { code: 400, message, status: "INVALID_ARGUMENT" } });
    const contents = body.contents as { role: string; parts?: Json[] }[];
    for (const [i, c] of contents.entries()) {
      if (!c.parts?.length) return no(`contents[${i}].parts: contents.parts must not be empty`);
      for (const p of c.parts) {
        if ("text" in p && blank(p.text) && !p.thoughtSignature)
          return no("Unable to submit request because it has an empty text parameter. Add a value to the parameter and try again.");
        if (p.thoughtSignature && !GEMINI_SIGNATURES.includes(p.thoughtSignature)) return no("Corrupted thought signature.");
      }
      const calls = c.parts.filter((p) => p.functionCall).length;
      if (calls != (c.role == "model" ? (contents[i + 1]?.parts ?? []).filter((p) => p.functionResponse).length : 0))
        return no(
          "Please ensure that the number of function response parts is equal to the number of function call parts of the function call turn."
        );
    }
    return null;
  },
  openai(body) {
    const no = (message: string) => ({ error: { message, type: "invalid_request_error" } });
    const input = body.input as Json[];
    for (const [i, item] of input.entries()) {
      // (Erga's own rule: no empty text goes to any model.)
      if (Array.isArray(item.content) && item.content.some((c: Json) => "text" in c && blank(c.text)))
        return no(`Invalid 'input[${i}].content': an empty text.`);
      if (item.type == "reasoning") {
        if (item.encrypted_content != GPT_REASONING) return no(`The encrypted content for item ${item.id} could not be verified.`);
        if (!["message", "function_call"].includes(input[i + 1]?.type))
          return no(`Item '${item.id}' of type 'reasoning' was provided without its required following item.`);
      }
      if (item.type == "function_call") {
        if (item.id != null && !/^fc_[a-zA-Z0-9_-]{1,61}$/.test(item.id))
          return no(`Invalid 'input[${i}].id': '${item.id}'. Expected an ID that begins with 'fc'.`);
        if (!input.some((x) => x.type == "function_call_output" && x.call_id == item.call_id))
          return no(`No tool output found for function call ${item.call_id}.`);
      }
      if (item.type == "function_call_output" && !input.some((x) => x.type == "function_call" && x.call_id == item.call_id))
        return no(`No tool call found for function call output with call_id ${item.call_id}.`);
    }
    return null;
  },
};

/** One file has text, the other is empty: a tool's result with an empty text. */
const read: AgentTool = {
  name: "read",
  description: "Reads a file.",
  parameters: Schema.Struct({ path: Schema.String }),
  execute: async (_id, p) => ({ content: [{ type: "text", text: p.path == "a.txt" ? "a.txt: hello" : "" }] }),
};

// A conversation with each provider: the model thinks and reads two files in one turn, answers, and then (Gemini, GPT)
// has a turn of thinking alone. The model's choice, then each message's answers.
const MADE: Record<Api, { choice: ModelChoice; turns: (() => Response[])[] }> = {
  anthropic: {
    choice: "opus",
    turns: [
      () => [
        claude(
          [
            { type: "thinking", thinking: "Claude thinks.", signature: CLAUDE_SIGNATURE },
            { type: "text", text: "" },
            { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.txt" } },
            { type: "tool_use", id: "toolu_2", name: "read", input: { path: "b.txt" } },
          ],
          "tool_use"
        ),
        claude([{ type: "text", text: "It says hello." }]),
      ],
    ],
  },
  google: {
    choice: "gemini-4-hydrogen",
    turns: [
      () => [
        gemini([
          { thought: true, text: "Gemini thinks." },
          { functionCall: { name: "read", args: { path: "a.txt" } }, thoughtSignature: GEMINI_SIGNATURES[0] },
          { functionCall: { name: "read", args: { path: "b.txt" } } },
          { text: "", thoughtSignature: GEMINI_SIGNATURES[1] },
        ]),
        gemini([{ text: "It says hello." }]),
      ],
      () => [gemini([{ thought: true, text: "Nothing more.", thoughtSignature: GEMINI_SIGNATURES[2] }])],
    ],
  },
  openai: {
    choice: "gpt-6.2-sol",
    turns: [
      () => [
        gpt([
          { type: "reasoning", id: "rs_1", summary: [], encrypted_content: GPT_REASONING },
          {
            type: "function_call",
            id: `fc_${"1".repeat(48)}`,
            call_id: `call_${"1".repeat(24)}`,
            name: "read",
            arguments: '{"path":"a.txt"}',
          },
          {
            type: "function_call",
            id: `fc_${"2".repeat(48)}`,
            call_id: `call_${"2".repeat(24)}`,
            name: "read",
            arguments: '{"path":"b.txt"}',
          },
        ]),
        gpt([said("It says hello.")]),
      ],
      () => [gpt([{ type: "reasoning", id: "rs_2", summary: [], encrypted_content: GPT_REASONING }])],
    ],
  },
};

const keys = (model: ModelChoice): AgentConfig => ({
  own: { anthropic: Redacted.make("sk-ant"), google: Redacted.make("AIza"), openai: Redacted.make("sk-proj") },
  server: {},
  mode: "server",
  off: [],
  model,
  effort: "medium",
});

/** The conversation made with `from`'s model, then one more message on `to`'s: the errors of the panel, and the last request. */
async function switched(from: Api, to: Api) {
  const cfg = keys(MADE[from].choice);
  const events: LogEvent[] = [];
  const loop = startLoop({ cfg, stored: null, store: null, meta: {}, tag: "page", hooks: { about: () => null } });
  loop.start(cfg, "You are a test.", [read]);
  loop.subscribe((e) => void events.push(e));
  const turn = async (text: string) => {
    const at = events.length;
    loop.prompt(text, null, []);
    await until(() => events.slice(at).some((e) => e.t == "busy" && !e.busy));
  };
  for (const turnAnswers of MADE[from].turns) {
    answers.push(...turnAnswers());
    await turn("What do a.txt and b.txt say?");
  }
  expect(answers).toEqual([]);
  expect(loop.setModel(MADE[to].choice)).toBe(true);
  requests.length = 0;
  await turn("try again? can you see the errors?");
  return {
    errors: events.flatMap((e) => (e.t == "error" ? [e.text] : [])),
    last: loop.log.items.at(-1),
    sent: requests.map((r) => r.api),
    body: JSON.stringify(requests.at(-1)?.body),
  };
}

const APIS: Api[] = ["anthropic", "google", "openai"];
/** What a request to an API has of that API's own earlier answer: its thinking and signatures. */
const OWN: Record<Api, string[]> = {
  anthropic: [CLAUDE_SIGNATURE, "Claude thinks."],
  google: [...GEMINI_SIGNATURES.slice(0, 2), "Gemini thinks."],
  openai: [GPT_REASONING, "rs_1"],
};

for (const from of APIS)
  for (const to of APIS)
    test(`a conversation made with ${MODELS[MADE[from].choice].label} goes on with ${MODELS[MADE[to].choice].label}: the API takes the request`, async () => {
      const { errors, last, sent, body } = await switched(from, to);
      expect(errors).toEqual([]);
      expect(sent).toEqual([to]);
      expect(last).toEqual({ kind: "assistant", text: "On it." });
      // The conversation is whole: the calls, the file's text, the answer, the new message.
      for (const text of ["a.txt", "b.txt", "a.txt: hello", "It says hello.", "try again? can you see the errors?"])
        expect(body).toContain(text);
      // The same model has its own thinking and signatures back; another model has none of them.
      for (const api of APIS) for (const own of OWN[api]) expect(body.includes(own)).toBe(api == from && api == to);
    });

// A scripted AG-UI 1.0 agent with an address, for the journeys (connected.e2e.ts): an HTTP server that takes a
// RunAgentInput and answers with a stream of events (HTTP + SSE), as a hosted agent does. No model is in the loop: the
// person's message has the script, after `@agui`, a list of steps:
//
//   { say: "text" }                        the agent's text, in two parts
//   { call: "name", args: {…}, result? }   a tool call of the agent's own, and its result (none: the call stays open)
//   { ask: "message", after: [steps] }     the run stops to ask about the last call; the run that approves it gets the
//                                          call's result ("done") and plays `after`
//   { hold: true }                         the stream stays open until the page closes it
//
// It permits the page that calls it (CORS, with credentials). With `signIn`, a run needs the cookie that the agent's
// own page (GET /) sets: without it the answer is 401.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunAgentInput } from "../../shared/agui-schema";

type Step = { say?: string; call?: string; args?: object; result?: string; ask?: string; after?: Step[]; hold?: boolean };

export interface ScriptedAgent {
  /** Its AG-UI endpoint, and its site. */
  url: string;
  origin: string;
  /** Each run's input, as the page sent it. */
  inputs: RunAgentInput[];
  /** How many streams the page closed before their end. */
  cut(): number;
  stop(): Promise<void>;
}

export async function scriptedAgent(opts: { signIn?: boolean } = {}): Promise<ScriptedAgent> {
  const inputs: RunAgentInput[] = [];
  /** Each thread's call that waits for an answer: its id, and the steps after it. */
  const waits = new Map<string, { call: string; after: Step[] }>();
  let cut = 0,
    n = 0;
  const server = createServer((req, res) => {
    const cors = { "Access-Control-Allow-Origin": req.headers.origin ?? "*", "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
    if (req.method == "OPTIONS")
      return void res
        .writeHead(204, { ...cors, "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST" })
        .end();
    if (req.method == "GET")
      return void res
        .writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "agui=1; Path=/; SameSite=Lax" })
        .end("<h1>Signed in</h1>");
    if (opts.signIn && !/\bagui=1\b/.test(req.headers.cookie ?? "")) return void res.writeHead(401, cors).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const input = JSON.parse(body) as RunAgentInput;
      inputs.push(input);
      const { threadId, runId } = input;
      res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      const send = (ev: object) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      const end = (outcome?: object) => {
        send({ type: "RUN_FINISHED", threadId, runId, ...(outcome ? { outcome } : {}) });
        res.end();
      };
      send({ type: "RUN_STARTED", threadId, runId });
      let steps: Step[];
      const waited = waits.get(threadId);
      if (input.resume?.length && waited) {
        waits.delete(threadId);
        const approved = (input.resume[0].payload as { approved?: boolean } | undefined)?.approved === true;
        send({
          type: "TOOL_CALL_RESULT",
          messageId: `m${++n}`,
          toolCallId: waited.call,
          content: approved ? "done" : "The person denied it.",
        });
        steps = approved ? waited.after : [{ say: "Not done." }];
      } else {
        const last = input.messages.filter((m) => m.role == "user").at(-1);
        const text = typeof last?.content == "string" ? last.content : "";
        steps = text.includes("@agui ") ? (JSON.parse(text.slice(text.indexOf("@agui ") + 6)) as Step[]) : [{ say: "No script." }];
      }
      let call = "";
      for (const s of steps) {
        if (s.say != null) {
          const messageId = `m${++n}`,
            half = Math.ceil(s.say.length / 2);
          send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
          send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: s.say.slice(0, half) });
          if (s.say.length > half) send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: s.say.slice(half) });
          send({ type: "TEXT_MESSAGE_END", messageId });
        } else if (s.call) {
          call = `c${++n}`;
          send({ type: "TOOL_CALL_START", toolCallId: call, toolCallName: s.call });
          send({ type: "TOOL_CALL_ARGS", toolCallId: call, delta: JSON.stringify(s.args ?? {}) });
          send({ type: "TOOL_CALL_END", toolCallId: call });
          if (s.result != null) send({ type: "TOOL_CALL_RESULT", messageId: `m${++n}`, toolCallId: call, content: s.result });
        } else if (s.ask != null) {
          waits.set(threadId, { call, after: s.after ?? [] });
          return end({ type: "interrupt", interrupts: [{ id: `i${++n}`, reason: "approval", message: s.ask, toolCallId: call }] });
        } else if (s.hold) {
          res.on("close", () => cut++);
          return;
        }
      }
      end({ type: "success" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/agui`,
    origin,
    inputs,
    cut: () => cut,
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A scripted helper of an attached session (agents/link.ts): the link's far end, which a journey plays by hand. */
export interface ScriptedHelper {
  /** Each frame that came down the link. */
  got: Record<string, unknown>[];
  /** Sends one frame up. */
  say(frame: object): void;
  /** Whether the server closed the link. */
  closed(): boolean;
  leave(): void;
}

/** Opens the link at `root` with the agent token `token`, and says who the session is. */
export async function scriptedHelper(root: string, token: string, hello: Record<string, string>): Promise<ScriptedHelper> {
  const options = { headers: { Authorization: `Bearer ${token}` } };
  // (The runtime's WebSocket takes the headers; the browser's type has no such argument.)
  const ws = new WebSocket(`${root.replace(/^http/, "ws")}/api/agent/link`, options as unknown as string[]);
  const got: Record<string, unknown>[] = [];
  let closed = false;
  ws.addEventListener("message", (e) => got.push(JSON.parse(String(e.data))));
  ws.addEventListener("close", () => (closed = true));
  await new Promise<void>((ok, no) => {
    ws.addEventListener("open", () => ok());
    ws.addEventListener("error", () => no(new Error("the link did not open")));
  });
  const say = (frame: object) => ws.send(JSON.stringify(frame));
  say({ type: "CUSTOM", name: "hello", value: hello });
  return { got, say, closed: () => closed, leave: () => ws.close() };
}

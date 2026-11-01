// What the admin agents' object keeps of each admin's agent conversation, and
// the agent going on with it (agents/person/agent.ts, `stored`): the transcript and the
// model's messages, kept step by step (agents/checkpoint.ts); and the panel's prefs.
// A run cut off in the middle and resumed: tests/agent-resume.test.ts.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import { panelPrefs } from "../agents/person/panel";
import { startAgent } from "../agents/person/agent";
import { ChatTables, tableStore } from "../agents/chat-store";
import { restoredLog, STOPPED, STOPPED_SHOWN, type ChatStore, type StoredChat } from "../agents/checkpoint";
import * as Schema from "effect/Schema";
import type { AgentTool } from "../agents/run";

const script = { apiKey: Redacted.make(""), model: "script" as const, effort: "medium" as const };

/** Runs one message to the end of its turn. */
function turn(agent: ReturnType<typeof startAgent>, text: string) {
  return new Promise<void>((resolve) => {
    const off = agent.subscribe((ev) => { if (ev.t == "busy" && !ev.busy) { off(); resolve(); } });
    agent.prompt(text, null);
  });
}

function tables() {
  const db = new Database(":memory:", { strict: true });
  return new ChatTables({ exec: <T>(q: string, ...p: (string | number | null)[]) => db.query(q).all(...p) as T[], transaction: (f) => db.transaction(f)() });
}

test("a conversation stored and restored goes on where it was: the transcript and what the model remembers", async () => {
  const t = tables(), store = tableStore(t, "admin:root");
  const a = startAgent({ cfg: script, owner: "root", admin: true, tools: [], store });
  await turn(a, `@script [{"text":"Hello, root."}]`);
  await new Promise((r) => setTimeout(r, 10));

  const b = startAgent({ cfg: script, owner: "root", admin: true, tools: [], store, stored: t.load("admin:root") });
  expect(b.log().items).toEqual([{ kind: "user", text: `@script [{"text":"Hello, root."}]` }, { kind: "assistant", text: "Hello, root." }]);
  expect(b.messages().map((m) => (m as { role: string }).role)).toEqual(["user", "assistant"]);
  expect(await b.resume()).toBe(false);
  await turn(b, `@script [{"text":"Again."}]`);
  expect(b.log().items.map((i) => i.kind)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(b.messages().length).toBe(4);
  await new Promise((r) => setTimeout(r, 10));
  expect(t.load("admin:root")!.messages.length).toBe(4);
  await b.reset();
  expect(t.load("admin:root")).toBeNull();
});

test("the admin agent, killed while a tool call ran, goes on after the restart without running it again", async () => {
  const t = tables(),
    runs = { n: 0 };
  const count: AgentTool = {
    name: "count",
    label: "Count",
    description: "Counts its runs.",
    parameters: Schema.Struct({}),
    execute: async () => {
      runs.n++;
      return { content: [{ type: "text", text: `run ${runs.n}` }], details: {} };
    },
  };
  // The object dies once the tool call began: that save lands, no later one returns.
  let dead = false;
  const dying: ChatStore = {
    load: async () => t.load("admin:root"),
    save: async (c) => { if (dead) return new Promise<void>(() => {}); t.save("admin:root", c); if (Object.values(c.state.calls).some((x) => !x.result)) dead = true; },
    clear: async () => t.clear("admin:root"),
  };
  const a = startAgent({ cfg: script, owner: "root", admin: true, tools: [count], store: dying });
  a.prompt(`@script [{"tool":"count","args":{}},{"text":"Done."}]`, null);
  for (let i = 0; i < 200 && !(dead && runs.n == 1); i++) await new Promise((r) => setTimeout(r, 10));
  expect(runs.n).toBe(1);

  const b = startAgent({
    cfg: script,
    owner: "root",
    admin: true,
    tools: [count],
    store: tableStore(t, "admin:root"),
    stored: t.load("admin:root"),
  });
  const done = new Promise<void>((resolve) =>
    b.subscribe((ev) => {
      if (ev.t == "busy" && !ev.busy) resolve();
    })
  );
  expect(await b.resume()).toBe(true);
  await done;
  expect(runs.n).toBe(1);
  expect(b.log().items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
  expect(b.log().items[1]).toMatchObject({ status: "error", detail: STOPPED_SHOWN });
  const result = b.messages().find((m) => m.role == "tool") as unknown as { content: { result: string }[] };
  expect(result.content[0].result).toBe(STOPPED);
});

test("a stored transcript shows text that streamed after the last checkpoint as gone, and a running tool as stopped", () => {
  const stored: StoredChat = {
    messages: [],
    log: [
      { kind: "user", text: "Read the board" },
      { kind: "tool", id: "t1", name: "list_tasks", path: null, status: "running" },
      { kind: "assistant", text: "I'll look at" },
    ],
    state: { running: true, queued: [], calls: { t1: {} }, model: null, stable: 2, meta: {}, at: 1 },
  };
  const back = restoredLog(stored);
  expect(back.busy).toBe(true);
  expect(back.items.length).toBe(2);
  expect(back.items[1]).toMatchObject({ kind: "tool", status: "error", detail: STOPPED_SHOWN });
});

test("the panel's prefs keep only what's valid", () => {
  expect(panelPrefs({ open: false, side: "right", width: 512.4 })).toEqual({ open: false, side: "right", width: 512 });
  expect(panelPrefs({ open: "yes", side: "up", width: "wide" })).toEqual({});
  expect(panelPrefs(null)).toEqual({});
  expect(panelPrefs({ width: 1e9 }).width).toBe(4000);
});

test("a conversation pi kept (before the agents ran on Effect AI) loads in Effect AI's messages, and goes on", async () => {
  const t = tables();
  const pi = [
    { role: "user", content: "Read a.pdf", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Read it.", thinkingSignature: "sig" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.pdf" } },
      ],
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [
        { type: "text", text: "a.pdf: 1 page" },
        { type: "image", data: "JVBERi0=", mimeType: "application/pdf" },
      ],
      isError: false,
      timestamp: 3,
    },
    { role: "assistant", content: [{ type: "text", text: "It says hi." }], stopReason: "stop", timestamp: 4 },
    { role: "user", content: [{ type: "text", text: "Again" }], timestamp: 5 },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "Overloaded", timestamp: 6 },
  ];
  const state = { running: false, queued: [], calls: {}, model: null, stable: 0, meta: {}, at: 1 };
  t.save("admin:root", {
    messages: { from: 0, items: pi as never[] },
    log: {
      from: 0,
      items: [
        { kind: "user", text: "Read a.pdf" },
        { kind: "assistant", text: "It says hi." },
      ],
    },
    state,
  });

  const b = startAgent({
    cfg: script,
    owner: "root",
    admin: true,
    tools: [],
    store: tableStore(t, "admin:root"),
    stored: t.load("admin:root"),
  });
  expect(b.messages()).toEqual([
    { role: "user", content: [{ type: "text", text: "Read a.pdf" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "Read it.", options: { anthropic: { info: { type: "thinking", signature: "sig" } } } },
        { type: "tool-call", id: "c1", name: "read", params: { path: "a.pdf" }, providerExecuted: false },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "read",
          isFailure: false,
          result: "a.pdf: 1 page",
          modelOutput: [
            { type: "text", text: "a.pdf: 1 page" },
            { type: "file", mediaType: "application/pdf", data: "JVBERi0=" },
          ],
          providerExecuted: false,
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "It says hi." }] },
    { role: "user", content: [{ type: "text", text: "Again" }], timestamp: 5 } as never,
  ]);
  await turn(b, `@script [{"text":"Still here."}]`);
  expect(b.log().items.at(-1)).toEqual({ kind: "assistant", text: "Still here." });
  expect(b.messages().map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user", "user", "assistant"]);
});

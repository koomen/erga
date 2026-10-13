// What the admin agents' object keeps of each admin's agent conversation, and
// the agent going on with it (agents/admin.ts, `stored`): the transcript and the
// model's messages, kept step by step (agents/checkpoint.ts); and the panel's prefs.
// A run cut off in the middle and resumed: tests/agent-resume.test.ts.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import { panelPrefs } from "../agents/admin-chats";
import { startAdminAgent } from "../agents/admin";
import { ChatTables, tableStore } from "../agents/chat-store";
import { restoredLog, STOPPED, STOPPED_SHOWN, type ChatStore, type StoredChat } from "../agents/checkpoint";
import { Type } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const script = { apiKey: Redacted.make(""), model: "script" as const, effort: "medium" as const };

/** Runs one message to the end of its turn. */
function turn(agent: ReturnType<typeof startAdminAgent>, text: string) {
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
  const a = startAdminAgent({ cfg: script, owner: "root", tools: [], store });
  await turn(a, `@script [{"text":"Hello, root."}]`);
  await new Promise((r) => setTimeout(r, 10));

  const b = startAdminAgent({ cfg: script, owner: "root", tools: [], store, stored: t.load("admin:root") });
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
  const t = tables(), runs = { n: 0 };
  const count: AgentTool = { name: "count", label: "Count", description: "Counts its runs.", parameters: Type.Object({}), execute: async () => { runs.n++; return { content: [{ type: "text", text: `run ${runs.n}` }], details: {} }; } };
  // The object dies once the tool call began: that save lands, no later one returns.
  let dead = false;
  const dying: ChatStore = {
    load: async () => t.load("admin:root"),
    save: async (c) => { if (dead) return new Promise<void>(() => {}); t.save("admin:root", c); if (Object.values(c.state.calls).some((x) => !x.result)) dead = true; },
    clear: async () => t.clear("admin:root"),
  };
  const a = startAdminAgent({ cfg: script, owner: "root", tools: [count], store: dying });
  a.prompt(`@script [{"tool":"count","args":{}},{"text":"Done."}]`, null);
  for (let i = 0; i < 200 && !(dead && runs.n == 1); i++) await new Promise((r) => setTimeout(r, 10));
  expect(runs.n).toBe(1);

  const b = startAdminAgent({ cfg: script, owner: "root", tools: [count], store: tableStore(t, "admin:root"), stored: t.load("admin:root") });
  const done = new Promise<void>((resolve) => b.subscribe((ev) => { if (ev.t == "busy" && !ev.busy) resolve(); }));
  expect(await b.resume()).toBe(true);
  await done;
  expect(runs.n).toBe(1);
  expect(b.log().items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
  expect(b.log().items[1]).toMatchObject({ status: "error", detail: STOPPED_SHOWN });
  const result = b.messages().find((m) => (m as { role: string }).role == "toolResult") as unknown as { content: { text: string }[] };
  expect(result.content[0].text).toBe(STOPPED);
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

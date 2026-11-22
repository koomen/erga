// A person's agent has a thread for each document, and one for the rest of Erga (agents/person/sessions.ts): a
// message, its answer and its events stay in their thread, a new conversation clears one thread only, and a run that a
// restart cut off goes on in its own thread.

import { expect, test } from "bun:test";
import { ChatTables } from "../agents/chat-store";
import { PersonAgents } from "../agents/person/sessions";
import type { Platform } from "../server/platform";
import { objectSql } from "./helpers/memory-sql";
import { until } from "./helpers/until";

const script = { own: {}, server: {}, mode: "server" as const, off: [], model: "script" as const, effort: "medium" as const };
const platform = {
  agentSettings: async () => script,
  directory: { users: { isAdmin: async () => false, actsAsAdmin: async () => false }, config: { get: async () => true } },
} as unknown as Platform;

/** What a thread shows: each item's kind and text. */
const shown = async (a: PersonAgents, doc: string | null) =>
  (await a.conversation("ada", doc)).items.map((i) => (i.kind == "user" || i.kind == "assistant" ? `${i.kind}: ${i.text}` : i.kind));
/** The thread's turn has ended with an answer. */
const answered = (a: PersonAgents, doc: string | null) =>
  until(async () => {
    const log = await a.conversation("ada", doc);
    return !log.busy && log.items.at(-1)?.kind == "assistant";
  });

test("a message, its answer and its events stay in the thread of their document; a new conversation clears that thread only", async () => {
  const a = new PersonAgents({ sql: objectSql(), platform });
  const heard: Record<string, number> = { app: 0, a: 0, b: 0 };
  const panel = (key: string, doc: string | null) =>
    a.join(new Request(`http://x/api/agent/events${doc ? `?doc=${doc}` : ""}`, { headers: { "x-erga-login": "ada" } }), () => heard[key]++);
  const leave = [panel("app", null), panel("a", "doc-a"), panel("b", "doc-b")];

  // A turn in document A's thread, which is slow: a turn in the app's thread runs beside it, and ends first.
  await a.agentPrompt("ada", "http://x", `In A @script [{"text":"Answer in A.","delay":40}]`, null, undefined, "doc-a", "Ada");
  await a.agentPrompt("ada", "http://x", `In the app @script [{"text":"Answer in the app."}]`, null, undefined, null, "Ada");
  await answered(a, null);
  await answered(a, "doc-a");
  expect(await shown(a, "doc-a")).toEqual([`user: In A @script [{"text":"Answer in A.","delay":40}]`, "assistant: Answer in A."]);
  expect(await shown(a, null)).toEqual([`user: In the app @script [{"text":"Answer in the app."}]`, "assistant: Answer in the app."]);
  expect(await shown(a, "doc-b")).toEqual([]);
  expect(heard.a).toBeGreaterThan(0);
  expect(heard.app).toBeGreaterThan(0);
  expect(heard.b).toBe(0);

  const app = heard.app;
  await a.clearConversation("ada", "doc-a");
  expect(await shown(a, "doc-a")).toEqual([]);
  expect((await shown(a, null)).length).toBe(2);
  expect(heard.app).toBe(app);
  for (const l of leave) l();
});

test("a run that a restart cut off goes on in its own thread", async () => {
  const sql = objectSql();
  new ChatTables(sql).save("thread:doc-a:ada", {
    messages: { from: 0, items: [{ role: "user", content: `Hi @script [{"text":"Woke."}]` }] },
    log: { from: 0, items: [{ kind: "user", text: "Hi" }] },
    state: {
      running: true,
      queued: [],
      calls: {},
      model: null,
      bound: null,
      stable: 1,
      meta: { origin: "http://x" },
      at: Date.now() - 21_000,
    },
  });
  const a = new PersonAgents({ sql, platform });
  await a.wake();
  await answered(a, "doc-a");
  expect(await shown(a, "doc-a")).toEqual(["user: Hi", "assistant: Woke."]);
  expect(await shown(a, null)).toEqual([]);
});

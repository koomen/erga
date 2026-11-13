// A message from the panel carries the tab's id for it (agents/person/sessions.ts, agentPrompt): the transcript's copy
// has the id, even when the server cuts a long message, and a second message with the same id (Try again, after the
// first got there late) is not sent again. The panel matches its dimmed message by that id (client/agent/sends.ts).

import { expect, test } from "bun:test";
import { PersonAgents } from "../agents/person/sessions";
import type { Platform } from "../server/platform";
import { objectSql } from "./helpers/memory-sql";

const script = { own: {}, server: {}, mode: "server" as const, off: [], model: "script" as const, effort: "medium" as const };

function agents() {
  const platform = {
    agentSettings: async () => script,
    directory: { users: { isAdmin: async () => false, actsAsAdmin: async () => false } },
  };
  return new PersonAgents({ sql: objectSql(), platform: platform as unknown as Platform });
}

const users = async (a: PersonAgents) =>
  (await a.conversation("ada")).items.flatMap((i) => (i.kind == "user" ? [{ length: i.text.length, id: i.id }] : []));

test("a message longer than the server keeps: its copy in the transcript has the tab's id", async () => {
  const a = agents();
  expect(await a.agentPrompt("ada", "http://x", "x".repeat(20_001), null, undefined, null, "Ada", "m-1")).toEqual({ ok: true });
  expect(await users(a)).toEqual([{ length: 20_000, id: "m-1" }]);
});

test("the same message sent again (Try again after a late answer) goes once", async () => {
  const a = agents();
  expect(await a.agentPrompt("ada", "http://x", "hello", null, undefined, null, "Ada", "m-2")).toEqual({ ok: true });
  expect(await a.agentPrompt("ada", "http://x", "hello", null, undefined, null, "Ada", "m-2")).toEqual({ ok: true });
  // Another tab's message with the same words has its own id: it goes too.
  expect(await a.agentPrompt("ada", "http://x", "hello", null, undefined, null, "Ada", "m-3")).toEqual({ ok: true });
  expect(await users(a)).toEqual([
    { length: 5, id: "m-2" },
    { length: 5, id: "m-3" },
  ]);
});

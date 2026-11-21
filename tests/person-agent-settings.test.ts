// The agent settings in a person's agent object (agents/person/sessions.ts): the panel's state, asked every few
// seconds, reads them from the database at most once in 5 s; a turn, and the panel after a key changed, read them
// again, so a key or a setting that changes reaches the next turn.

import { afterEach, expect, setSystemTime, test } from "bun:test";
import { PersonAgents } from "../agents/person/sessions";
import type { Platform } from "../server/platform";
import { objectSql } from "./helpers/memory-sql";

afterEach(() => setSystemTime());

/** The hosted agents that the server has (the setting agents). */
const HOSTED = [{ name: "Helper", url: "https://agent.example.com/agui" }];
function agents(read: () => Promise<{ missing: string }>) {
  const directory = { config: { get: async () => HOSTED } };
  return new PersonAgents({ sql: objectSql(), platform: { agentSettings: read, directory } as unknown as Platform });
}

test("the panel's state reads the settings once in 5 s; a turn reads them at once", async () => {
  let reads = 0,
    now = "no key yet";
  const a = agents(async () => (reads++, { missing: now }));
  setSystemTime(new Date("2026-11-04T12:00:00Z"));
  expect(await a.agentState("ada", null, "http://x")).toEqual({
    enabled: false,
    reason: "no key yet",
    agents: HOSTED,
    sessions: [],
    agent: null,
  });
  await Promise.all([a.agentState("ada", null, "http://x"), a.agentState("ada", null, "http://x")]);
  expect(reads).toBe(1);

  // An admin changes a setting: the next turn reads it, and the state after it shows it.
  now = "the admin asks for your own key";
  expect(await a.agentPrompt("ada", "http://x", "hi", null)).toEqual({
    ok: false,
    reason: "the agent is off: the admin asks for your own key",
  });
  expect(reads).toBe(2);
  expect(await a.agentState("ada", null, "http://x")).toMatchObject({ reason: "the admin asks for your own key" });
  expect(reads).toBe(2);

  // Each person has their own; after 5 s the state reads again.
  await a.agentState("bob", null, "http://x");
  expect(reads).toBe(3);
  now = "later";
  setSystemTime(new Date("2026-11-04T12:00:06Z"));
  expect(await a.agentState("ada", null, "http://x")).toMatchObject({ reason: "later" });
  expect(reads).toBe(4);

  // The panel after the person's own key changed asks with fresh: read now.
  now = "fresh";
  expect(await a.agentState("ada", null, "http://x", undefined, true)).toMatchObject({ reason: "fresh" });
  expect(reads).toBe(5);
});

test("a failed read of the settings isn't kept", async () => {
  let reads = 0;
  const a = agents(async () => {
    if (reads++ == 0) throw new Error("D1 stalled");
    return { missing: "no key yet" };
  });
  expect(await a.agentState("ada", null, "http://x")).toMatchObject({ reason: expect.stringContaining("couldn't be read (D1 stalled)") });
  expect(await a.agentState("ada", null, "http://x")).toMatchObject({ reason: "no key yet" });
  expect(reads).toBe(2);
});

test("a person picks who their panel shows: a hosted agent of the server's, or Erga's own; each person has their own choice", async () => {
  const a = agents(async () => ({ missing: "no key" }));
  expect(await a.setAgent("ada", "Other")).toEqual({ ok: false, reason: "this server has no agent by that name" });
  expect(await a.setAgent("ada", "Helper")).toEqual({ ok: true });
  expect(await a.agentState("ada", null, "http://x")).toMatchObject({ agent: "Helper", agents: HOSTED });
  expect(await a.agentState("bob", null, "http://x")).toMatchObject({ agent: null });
  // Her other tabs hear it.
  const heard: string[] = [];
  a.join(new Request("http://x/api/agent/events", { headers: { "x-erga-login": "ada" } }), (text) => heard.push(text));
  expect(await a.setAgent("ada", null)).toEqual({ ok: true });
  expect(heard.map((t) => JSON.parse(t))).toEqual([{ type: "who", agent: null, agents: HOSTED, sessions: [] }]);
  expect(await a.agentState("ada", null, "http://x")).toMatchObject({ agent: null });
});

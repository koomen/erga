// The agent settings in a person's agent object (agents/person/sessions.ts): the panel's state, asked every few
// seconds, reads them from the database at most once in 5 s; a turn, and the panel after a key changed, read them
// again, so a key or a setting that changes reaches the next turn.

import { afterEach, expect, setSystemTime, test } from "bun:test";
import { PersonAgents } from "../agents/person/sessions";
import type { Platform } from "../server/platform";
import { objectSql } from "./helpers/memory-sql";

afterEach(() => setSystemTime());

function agents(read: () => Promise<{ missing: string }>) {
  return new PersonAgents({ sql: objectSql(), platform: { agentSettings: read } as unknown as Platform });
}

test("the panel's state reads the settings once in 5 s; a turn reads them at once", async () => {
  let reads = 0,
    now = "no key yet";
  const a = agents(async () => (reads++, { missing: now }));
  setSystemTime(new Date("2026-11-04T12:00:00Z"));
  expect(await a.agentState("ada", "http://x")).toEqual({ enabled: false, reason: "no key yet" });
  await Promise.all([a.agentState("ada", "http://x"), a.agentState("ada", "http://x")]);
  expect(reads).toBe(1);

  // An admin changes a setting: the next turn reads it, and the state after it shows it.
  now = "the admin asks for your own key";
  expect(await a.agentPrompt("ada", "http://x", "hi", null)).toEqual({
    ok: false,
    reason: "the agent is off: the admin asks for your own key",
  });
  expect(reads).toBe(2);
  expect(await a.agentState("ada", "http://x")).toMatchObject({ reason: "the admin asks for your own key" });
  expect(reads).toBe(2);

  // Each person has their own; after 5 s the state reads again.
  await a.agentState("bob", "http://x");
  expect(reads).toBe(3);
  now = "later";
  setSystemTime(new Date("2026-11-04T12:00:06Z"));
  expect(await a.agentState("ada", "http://x")).toMatchObject({ reason: "later" });
  expect(reads).toBe(4);

  // The panel after the person's own key changed asks with fresh: read now.
  now = "fresh";
  expect(await a.agentState("ada", "http://x", undefined, true)).toMatchObject({ reason: "fresh" });
  expect(reads).toBe(5);
});

test("a failed read of the settings isn't kept", async () => {
  let reads = 0;
  const a = agents(async () => {
    if (reads++ == 0) throw new Error("D1 stalled");
    return { missing: "no key yet" };
  });
  expect(await a.agentState("ada", "http://x")).toMatchObject({ reason: expect.stringContaining("couldn't be read (D1 stalled)") });
  expect(await a.agentState("ada", "http://x")).toMatchObject({ reason: "no key yet" });
  expect(reads).toBe(2);
});

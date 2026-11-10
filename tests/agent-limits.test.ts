// The limits of a person's agent on the server's keys (agents/run.ts, agents/person/sessions.ts): a run ends after
// MAX_STEPS model turns, and a person's day ends at the setting agent_daily_tokens. A person's own key has neither.

import { expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { startAgent } from "../agents/person/agent";
import { dailyLimit } from "../agents/person/sessions";
import { MAX_STEPS, type AgentTool } from "../agents/run";
import type { AgentConfig } from "../agents/models";
import { Directory } from "../server/directory/index.ts";
import { memory } from "./helpers/memory-sql";

const onServer: AgentConfig = { own: {}, server: {}, mode: "server", off: [], model: "script", effort: "medium" };
const onOwn: AgentConfig = { ...onServer, own: { anthropic: Redacted.make("sk-own") } };

/** A tool that counts its calls. */
function counter(): AgentTool & { calls: number } {
  const t = {
    name: "tick",
    description: "Counts.",
    parameters: Schema.Struct({}),
    calls: 0,
    execute: async () => {
      t.calls++;
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  };
  return t;
}

/** Sends `text` and waits for the run's end: the transcript's errors. */
async function run(a: ReturnType<typeof startAgent>, text: string): Promise<string[]> {
  const done = new Promise<void>((resolve) => a.subscribe((ev) => ev.t == "busy" && !ev.busy && resolve()));
  a.prompt(text, null);
  await done;
  return a.log().items.flatMap((i) => (i.kind == "error" ? [i.text] : []));
}

const loop = (n: number) => `@script ${JSON.stringify(Array.from({ length: n }, () => ({ tool: "tick" })))}`;

test("on the server's keys, a run ends after MAX_STEPS model turns, and says why; the next message starts a new run", async () => {
  const tick = counter();
  const a = startAgent({ cfg: onServer, owner: "ada", admin: false, tools: [tick] });
  const errors = await run(a, loop(MAX_STEPS + 20));
  expect(tick.calls).toBe(MAX_STEPS);
  expect(errors).toEqual([
    `The agent stopped after ${MAX_STEPS} steps, the most for one run on the server's keys. Say "go on" to continue.`,
  ]);
  // A new run has its own count.
  await run(a, `@script [{"tool":"tick"},{"text":"Done."}]`);
  expect(tick.calls).toBe(MAX_STEPS + 1);
  expect(a.log().items.at(-1)).toEqual({ kind: "assistant", text: "Done." });
});

test("on the person's own key, a run has no step limit", async () => {
  const tick = counter();
  const a = startAgent({ cfg: onOwn, owner: "ada", admin: false, tools: [tick], limit: async () => "never asked" });
  expect(await run(a, loop(MAX_STEPS + 5))).toEqual([]);
  expect(tick.calls).toBe(MAX_STEPS + 5);
});

test("on the server's keys, the day's limit stops the run before the model's next turn, and says why", async () => {
  const tick = counter();
  let over: string | null = null;
  const a = startAgent({ cfg: onServer, owner: "ada", admin: false, tools: [tick], limit: async () => over });
  expect(await run(a, `@script [{"tool":"tick"},{"text":"Done."}]`)).toEqual([]);
  over = "The day's limit.";
  expect(await run(a, `@script [{"tool":"tick"},{"text":"Done."}]`)).toEqual(["The day's limit."]);
  expect(tick.calls).toBe(1);
  // A limit that can't be read stops nothing.
  const b = startAgent({ cfg: onServer, owner: "ada", admin: false, tools: [], limit: () => Promise.reject(new Error("no database")) });
  expect(await run(b, `@script [{"text":"Hi."}]`)).toEqual([]);
});

test("the day's limit: a person's tokens on the server's keys today (UTC), against the setting", async () => {
  const dir = new Directory(memory(), { admins: ["root"] });
  const root = { login: "root", admin: true };
  const NOW = Date.UTC(2026, 10, 9, 12);
  expect(await dir.config.get("agent_daily_tokens")).toBe(30_000_000);
  await dir.config.set(root, "agent_daily_tokens", 1000);
  await dir.activity.add("ada", { "in:server": 700, "out:server": 200 }, NOW);
  // Their own key's tokens, another person's and yesterday's don't count.
  await dir.activity.add("ada", { "in:own": 5000, "out:own": 5000 }, NOW);
  await dir.activity.add("bo", { "in:server": 5000 }, NOW);
  await dir.activity.add("ada", { "in:server": 5000 }, NOW - 86_400_000);
  expect(await dailyLimit(dir, "ada", NOW)).toBeNull();
  await dir.activity.add("ada", { "out:server": 100 }, NOW);
  expect(await dailyLimit(dir, "ada", NOW)).toBe(
    "Your agent used 1,000 tokens on the server's keys today, and the limit for one day is 1,000. It works again after midnight UTC, or now with your own API key (Settings, Agent)."
  );
  expect(await dailyLimit(dir, "bo", NOW)).not.toBeNull();
  expect(await dailyLimit(dir, "ada", NOW + 86_400_000)).toBeNull();
});

// The agent's turn (agents/turn.ts, run by agents/run.ts): Stop clears the queue, a tool call ends before "stopped",
// a resume never says "not busy" over a run that a new message started, and a Stop with no live agent ends the run kept.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { startAgent } from "../agents/person/agent";
import { PersonAgents } from "../agents/person/sessions";
import { ChatTables, tableStore } from "../agents/chat-store";
import type { StoredChat } from "../agents/checkpoint";
import type { AgentTool } from "../agents/run";
import type { Platform } from "../server/platform";
import { IDLE, next, type Turn, type TurnEvent } from "../agents/turn";

const script = { own: {}, server: {}, mode: "server" as const, off: [], model: "script" as const, effort: "medium" as const };

function db() {
  const d = new Database(":memory:", { strict: true });
  return {
    exec: <T>(q: string, ...p: (string | number | null)[]) => d.query(q).all(...p) as T[],
    transaction: <T>(f: () => T) => d.transaction(f)(),
  };
}

/** The busy events an agent says, as they come. */
function busyOf(agent: ReturnType<typeof startAgent>) {
  const seen: boolean[] = [];
  agent.subscribe((ev) => {
    if (ev.t == "busy") seen.push(ev.busy);
  });
  return seen;
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
};

test("Stop clears the queue: a message sent during the run is never answered, after a restart too", async () => {
  const t = new ChatTables(db()),
    store = tableStore(t, "you:ada");
  const a = startAgent({ cfg: script, owner: "ada", admin: false, tools: [], store });
  const busy = busyOf(a);
  a.prompt(`@script [{"text":"Slow.","delay":300}]`, null);
  await until(() => busy.length == 1);
  a.prompt("And this too.", null);
  a.abort();
  await until(() => busy.length == 2);
  await new Promise((r) => setTimeout(r, 20));
  expect(busy).toEqual([true, false]);
  // The message stays in the conversation, as the transcript shows it, and nothing waits.
  expect(a.messages().map((m) => m.role)).toEqual(["user", "user"]);
  expect(t.load("you:ada")!.state).toMatchObject({ running: false, queued: [] });
  expect(t.running()).toEqual([]);

  // The object restarts: the new agent has no run to go on with.
  const b = startAgent({ cfg: script, owner: "ada", admin: false, tools: [], store, stored: t.load("you:ada") });
  expect(await b.resume()).toBe(false);
  expect(b.log().busy).toBe(false);
});

test("Stop waits for the tool call that runs: its edit lands before the run says it stopped", async () => {
  const order: string[] = [];
  const edit: AgentTool = {
    name: "edit",
    description: "Edits, slowly.",
    parameters: Schema.Struct({}),
    execute: async () => {
      await new Promise((r) => setTimeout(r, 150));
      order.push("edited");
      return { content: [{ type: "text", text: "edited" }] };
    },
  };
  const a = startAgent({ cfg: script, owner: "ada", admin: false, tools: [edit] });
  let started = false;
  a.subscribe((ev) => {
    if (ev.t == "tool" && ev.status == "running") started = true;
    if (ev.t == "busy" && !ev.busy) order.push("stopped");
  });
  a.prompt(`@script [{"tool":"edit"},{"text":"Done."}]`, null);
  await until(() => started);
  a.abort();
  await until(() => order.includes("stopped"));
  await new Promise((r) => setTimeout(r, 200));
  expect(order).toEqual(["edited", "stopped"]);
  // The model hears what the call did, not that it stopped.
  const result = a.messages().find((m) => m.role == "tool") as unknown as { content: { result: string; isFailure: boolean }[] };
  expect(result.content[0]).toMatchObject({ result: "edited", isFailure: false });
  expect(a.log().items.map((i) => i.kind)).toEqual(["user", "tool"]);
});

test("a message sent while the agent resumes runs, and the resume never says the agent is idle meanwhile", async () => {
  const t = new ChatTables(db());
  // A run that a restart cut off just after its last turn: nothing is left to do.
  const stored: StoredChat = {
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello." },
    ],
    log: [
      { kind: "user", text: "Hi" },
      { kind: "assistant", text: "Hello." },
    ],
    state: { running: true, queued: [], calls: {}, model: null, stable: 2, meta: {}, at: 1 },
  };
  const a = startAgent({ cfg: script, owner: "ada", admin: false, tools: [], store: tableStore(t, "you:ada"), stored });
  const busy = busyOf(a);
  const resumed = a.resume();
  a.prompt(`@script [{"text":"Again.","delay":50}]`, null);
  expect(await resumed).toBe(true);
  await until(() => busy.at(-1) == false);
  expect(busy).toEqual([true, false]);
  expect(a.log().items.at(-1)).toEqual({ kind: "assistant", text: "Again." });
});

test("Stop with no live agent (the object restarted) ends the run kept: the alarm wakes nothing", async () => {
  const sql = db(),
    t = new ChatTables(sql);
  t.save("you:ada", {
    messages: { from: 0, items: [{ role: "user", content: "Hi" }] },
    log: {
      from: 0,
      items: [
        { kind: "user", text: "Hi" },
        { kind: "user", text: "And this." },
      ],
    },
    state: {
      running: true,
      queued: [{ role: "user", content: "And this." }],
      calls: {},
      model: null,
      stable: 2,
      meta: { origin: "http://x" },
      at: 1,
    },
  });
  const agents = new PersonAgents({ sql, platform: { agentSettings: async () => ({ missing: "off" }) } as unknown as Platform });
  await agents.agentControl("ada", "abort");
  expect(t.running()).toEqual([]);
  // The queued message stays in the conversation, unanswered.
  expect(t.load("you:ada")!.messages.map((m) => m.content)).toEqual(["Hi", "And this."]);
});

/** The states and effects a list of events goes through, from `from`. */
function walk(from: Turn, events: TurnEvent[]) {
  let t = from;
  return events.map((ev) => {
    const [n, fx] = next(t, ev);
    t = n;
    return [n.at, ...fx].join(" ");
  });
}

const ended = (o: { steered?: boolean; held?: boolean } = {}): TurnEvent => ({ e: "ended", steered: !!o.steered, held: !!o.held });
const resumed = (o: { going?: boolean; steered?: boolean; held?: boolean } = {}): TurnEvent => ({
  e: "resumed",
  going: !!o.going,
  steered: !!o.steered,
  held: !!o.held,
});

test("the turn: a message starts a run, steers it, and a message that came as it ended starts the next", () => {
  expect(walk(IDLE, [{ e: "prompt" }, { e: "prompt" }, ended({ steered: true }), ended()])).toEqual([
    "running steer start",
    "running steer",
    "running start",
    "idle",
  ]);
});

test("the turn: Stop unqueues what was sent before it; what is sent after it waits, then runs", () => {
  expect(walk(IDLE, [{ e: "prompt" }, { e: "prompt" }, { e: "stop" }, { e: "stop" }, { e: "prompt" }, ended({ held: true })])).toEqual([
    "running steer start",
    "running steer",
    "stopping unqueue interrupt",
    "stopping",
    "stopping hold",
    "running settle release start",
  ]);
  expect(walk(IDLE, [{ e: "prompt" }, { e: "stop" }, ended()])).toEqual([
    "running steer start",
    "stopping unqueue interrupt",
    "idle settle",
  ]);
  expect(walk(IDLE, [{ e: "stop" }])).toEqual(["idle"]);
});

test("the turn: a new conversation waits for the run to end, then drops all that waits", () => {
  expect(walk(IDLE, [{ e: "reset" }])).toEqual(["idle clear"]);
  expect(walk(IDLE, [{ e: "prompt" }, { e: "reset" }, { e: "prompt" }, ended({ held: true })])).toEqual([
    "running steer start",
    "stopping unqueue interrupt",
    "stopping hold",
    "idle clear",
  ]);
  expect(walk(IDLE, [{ e: "prompt" }, { e: "stop" }, { e: "reset" }, ended()]).at(-1)).toBe("idle clear");
});

test("the turn: a resume goes on, or not; a message meanwhile steers the run; Stop waits for it to end", () => {
  expect(walk(IDLE, [{ e: "resume" }, resumed({ going: true })])).toEqual(["resuming", "running start"]);
  expect(walk(IDLE, [{ e: "resume" }, resumed()])).toEqual(["resuming", "idle"]);
  expect(walk(IDLE, [{ e: "resume" }, { e: "prompt" }, resumed({ steered: true })])).toEqual([
    "resuming",
    "resuming steer",
    "running start",
  ]);
  expect(
    walk(IDLE, [{ e: "resume" }, { e: "prompt" }, { e: "stop" }, { e: "prompt" }, resumed({ going: true, steered: true, held: true })])
  ).toEqual(["resuming", "resuming steer", "resuming unqueue", "resuming hold", "running settle release start"]);
  expect(walk(IDLE, [{ e: "resume" }, { e: "stop" }, resumed({ going: true })]).at(-1)).toBe("idle settle");
  expect(walk(IDLE, [{ e: "resume" }, { e: "reset" }, resumed({ going: true })]).at(-1)).toBe("idle clear");
  // Only an idle agent resumes.
  expect(walk({ at: "running" }, [{ e: "resume" }])).toEqual(["running"]);
});

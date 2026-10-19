// A deploy restarts the document's object in the middle of an agent's run:
// the run goes on from its last checkpoint (agents/checkpoint.ts), kept in the
// person's store (agents/chat-store.ts's tables, on bun:sqlite here). The
// object "dies" at a checkpoint: that save lands, every later one never
// returns, so the old run stops there. A second host on the same files and
// store then goes on with it. The scripted model calls a tool that counts
// its runs: work is neither lost (the tool runs, the reply ends) nor done
// twice (the tool runs once).

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { Type } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { ChatTables } from "../agents/chat-store.ts";
import { STOPPED, STOPPED_SHOWN, type ChatSave, type ChatStore } from "../agents/checkpoint.ts";
import { makeHost } from "../document/host.ts";
import { FileStore, Room, StateStore } from "../document/room.ts";
import type { Log } from "../shared/agent-log.ts";

const SCRIPT = `@script [{"tool":"count","args":{}},{"text":"Done."}]`;

function tables() {
  const db = new Database(":memory:", { strict: true });
  return new ChatTables({
    exec: <T>(q: string, ...params: (string | number | null)[]) => db.query(q).all(...params) as T[],
    transaction: (f) => db.transaction(f)(),
  });
}

/** The store, until the object dies: the save that `dies` picks lands, and no later one ever returns. */
function dying(t: ChatTables, dies: (c: ChatSave, n: number) => boolean): ChatStore & { dead: () => boolean } {
  let dead = false, n = 0;
  return {
    load: async () => t.load("doc:d1"),
    save: async (c) => {
      if (dead) return new Promise<void>(() => {});
      t.save("doc:d1", c);
      if (dies(c, n++)) dead = true;
    },
    clear: async () => t.clear("doc:d1"),
    dead: () => dead,
  };
}

/** A document's host on these files, its agent's conversation in `store`; the counting tool counts in `runs`. */
async function openDocument(data: Map<string, Uint8Array>, store: ChatStore, runs: { n: number }) {
  const files = FileStore.of({
    list: Effect.sync(() => [...data.keys()]),
    read: (p) => Effect.sync(() => data.get(p) ?? null),
    write: (p, text) => Effect.sync(() => { data.set(p, new TextEncoder().encode(text)); }),
  });
  const scope = Effect.runSync(Scope.make());
  const room = await Effect.runPromise(Room.make({}).pipe(Effect.provide(StateStore.none.pipe(Layer.provideMerge(Layer.succeed(FileStore, files)))), Scope.provide(scope)));
  const count: AgentTool = {
    name: "count", label: "Count", description: "Counts its runs.", parameters: Type.Object({}),
    execute: async () => { runs.n++; return { content: [{ type: "text", text: `run ${runs.n}` }], details: {} }; },
  };
  const host = makeHost({
    room, files, agent: { apiKey: Redacted.make(""), model: "script", effort: "medium" },
    doc: { name: "index.html", path: "index.html", kind: "html", dir: "ada" },
    personOf: () => ({ id: "ada", name: "Ada" }),
    agentOf: () => null,
    baseUrl: () => "",
    serverTools: async () => [count],
    chats: () => store,
    chatMeta: { doc: "d1" },
  });
  const call = async (method: "GET" | "POST", body?: unknown) =>
    (await host.handler(new Request("http://doc.test/api/agent", { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }))).json() as Promise<{ log: Log }>;
  return { prompt: (text: string) => call("POST", { text }), state: () => call("GET"), close: () => Effect.runPromise(Scope.close(scope, Effect.void)) };
}

async function until(f: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 500; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${what}`);
}

const roles = (t: ChatTables) => t.load("doc:d1")!.messages.map((m) => (m as { role: string }).role);
const results = (t: ChatTables) => t.load("doc:d1")!.messages.filter((m) => (m as { role: string }).role == "toolResult")
  .map((m) => (m as { content: { text: string }[] }).content[0].text);

/** Runs the script, kills the object where `dies` says, opens the document again, and waits for the reply to end. */
async function killAndResume(dies: (c: ChatSave, n: number) => boolean) {
  const t = tables(), runs = { n: 0 };
  const data = new Map([["index.html", new TextEncoder().encode("<p>Hello</p>")]]);
  const store = dying(t, dies);
  const first = await openDocument(data, store, runs);
  await first.prompt(SCRIPT);
  await until(() => store.dead(), "the object to die");
  const before = runs.n;
  // The restart: a new host (a new object) on the same files and the same person's store.
  const second = await openDocument(data, { load: async () => t.load("doc:d1"), save: async (c) => t.save("doc:d1", c), clear: async () => t.clear("doc:d1") }, runs);
  let log: Log = (await second.state()).log;
  await until(async () => { log = (await second.state()).log; return !log.busy && log.items.some((i) => i.kind == "assistant" && i.text == "Done."); }, "the reply to end");
  await first.close();
  await second.close();
  return { t, runs, before, log };
}

test("killed after the model's turn, before its tool call began: the tool runs once, after the restart", async () => {
  const { t, runs, before, log } = await killAndResume((c) => c.messages.items.some((m) => (m as { role: string }).role == "assistant") && !Object.keys(c.state.calls).length);
  expect(before).toBe(0);
  expect(runs.n).toBe(1);
  expect(roles(t)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  expect(results(t)).toEqual(["run 1"]);
  expect(log.items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
  expect(log.items[1]).toMatchObject({ name: "count", status: "done" });
  expect(t.load("doc:d1")!.state.running).toBe(false);
});

test("killed while the tool call ran: it isn't run again, and the model hears that it stopped", async () => {
  const { t, runs, before, log } = await killAndResume((c) => Object.values(c.state.calls).some((x) => !x.result));
  expect(before).toBe(1);
  expect(runs.n).toBe(1);
  expect(roles(t)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  expect(results(t)).toEqual([STOPPED]);
  expect(log.items[1]).toMatchObject({ name: "count", status: "error", detail: STOPPED_SHOWN });
  expect(log.items.filter((i) => i.kind == "assistant")).toEqual([{ kind: "assistant", text: "Done." }]);
});

test("killed after the tool's result, before the model's next turn: the result is used, not run again", async () => {
  const { t, runs, before, log } = await killAndResume((c) => Object.values(c.state.calls).some((x) => x.result));
  expect(before).toBe(1);
  expect(runs.n).toBe(1);
  expect(roles(t)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  expect(results(t)).toEqual(["run 1"]);
  expect(log.items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
  expect(log.items[1]).toMatchObject({ status: "done" });
});

test("killed right after the message was sent: the model gets it after the restart", async () => {
  const { t, runs, log } = await killAndResume((_c, n) => n == 0);
  expect(runs.n).toBe(1);
  expect(roles(t)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  expect(log.items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
});

test("a long value goes in parts, and a later checkpoint replaces what changed", () => {
  const t = tables();
  const big = "x".repeat(1_300_000);
  const state = { running: false, queued: [], calls: {}, model: null, stable: 0, meta: {}, at: 1 };
  t.save("s", { messages: { from: 0, items: [{ role: "user", content: big, timestamp: 1 }] }, log: { from: 0, items: [{ kind: "user", text: "a" }, { kind: "assistant", text: "b" }] }, state });
  expect((t.load("s")!.messages[0] as { content: string }).content.length).toBe(big.length);
  t.save("s", { messages: { from: 1, items: [] }, log: { from: 1, items: [{ kind: "assistant", text: "c" }] }, state });
  expect(t.load("s")!.log).toEqual([{ kind: "user", text: "a" }, { kind: "assistant", text: "c" }]);
  t.clear("s");
  expect(t.load("s")).toBeNull();
});

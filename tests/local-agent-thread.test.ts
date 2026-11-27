// Unit tests for local agent per-session thread isolation:
// - bridgeStep per-doc and per-session threadId isolation, reconnect preservation, and reset rotation
// - PersonAgents thread tagging, fresh empty threads on new local sessions, and panelSeq ordering

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ChatSql } from "../agents/chat-store.ts";
import { activeBridge, bridgeStep, EMPTY_BRIDGES, localScopeOf, threadKeyFor } from "../agents/person/bridge.ts";
import { PersonAgents } from "../agents/person/sessions.ts";
import type { Platform } from "../server/platform.ts";

function sqliteChat(): ChatSql {
  const db = new Database(":memory:");
  return {
    exec: <T>(query: string, ...params: (string | number | null)[]) => db.query(query).all(...params) as T[],
    transaction: <R>(f: () => R) => db.transaction(f)(),
  };
}

async function until(fn: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (; Date.now() < deadline && !fn(); ) await new Promise((r) => setTimeout(r, 15));
  if (!fn()) throw new Error("Timed out waiting for condition");
}

test("bridgeStep isolates per-session and per-doc threads while preserving threadId on reconnect", () => {
  let st = bridgeStep(EMPTY_BRIDGES, {
    on: "connect",
    fallbackThreadId: "conn-1",
    bridge: {
      id: "antigravity-local",
      agent: "antigravity",
      label: "Antigravity",
      grantId: "g1",
      onlyDoc: null,
      sessionId: null,
      cwd: null,
      connectedAt: 1,
    },
  }).state;
  st = bridgeStep(st, { on: "bind", id: "antigravity-local", doc: "doc1", sessionId: "conv-1", fallbackThreadId: "fb-1" }).state;
  st = bridgeStep(st, { on: "bind", id: "antigravity-local", doc: "doc2", sessionId: "conv-2", fallbackThreadId: "fb-2" }).state;
  expect(threadKeyFor(activeBridge(st, "doc1"), "doc1")).toBe("local:antigravity-local:conv-1");
  expect(threadKeyFor(activeBridge(st, "doc2"), "doc2")).toBe("local:antigravity-local:conv-2");

  // Reconnect with the same threadId preserves doc1's thread.
  st = bridgeStep(st, {
    on: "bind",
    id: "antigravity-local",
    doc: "doc1",
    sessionId: "conv-1",
    fallbackThreadId: "fb-3",
    reconnect: true,
  }).state;
  expect(threadKeyFor(activeBridge(st, "doc1"), "doc1")).toBe("local:antigravity-local:conv-1");

  // A new local session binding doc1 gets its own fresh threadId without affecting doc2.
  st = bridgeStep(st, { on: "bind", id: "antigravity-local", doc: "doc1", sessionId: "conv-3", fallbackThreadId: "fb-4" }).state;
  expect(threadKeyFor(activeBridge(st, "doc1"), "doc1")).toBe("local:antigravity-local:conv-3");
  expect(threadKeyFor(activeBridge(st, "doc2"), "doc2")).toBe("local:antigravity-local:conv-2");

  // Reset rotates only the reset document's thread.
  st = bridgeStep(st, { on: "reset", id: "antigravity-local", doc: "doc1", nextThreadId: "reset-1" }).state;
  expect(threadKeyFor(activeBridge(st, "doc1"), "doc1")).toBe("local:antigravity-local:reset-1");
  expect(threadKeyFor(activeBridge(st, "doc2"), "doc2")).toBe("local:antigravity-local:conv-2");
});

test("PersonAgents gives each connecting local agent session its own clean thread and tags WS events", async () => {
  const fakePlatform = {
    agentSettings: async () => ({ missing: "no API keys" }),
    directory: {
      route: async (id: string) => ({ id, owner: "pete", test: false }),
      users: { isAdmin: async () => false },
    },
  } as unknown as Platform;

  const agents = new PersonAgents({ sql: sqliteChat(), platform: fakePlatform });
  const tabMsgs: Record<string, unknown>[] = [];
  const leave = agents.join(
    new Request("http://localhost:4400/api/agent/events?doc=doc1", { headers: { "x-erga-login": "pete" } }),
    (text) => tabMsgs.push(JSON.parse(text) as Record<string, unknown>)
  );

  const b1 = agents.joinBridge(
    { login: "pete", grantId: "g1", label: "Antigravity", onlyDoc: null, origin: "http://localhost:4400" },
    () => {},
    () => {}
  );
  b1.message(JSON.stringify({ type: "hello", id: "agy-local", agent: "antigravity", label: "Antigravity" }));
  b1.message(JSON.stringify({ type: "bind", doc: "doc1", label: "Antigravity (repo)", sessionId: "conv-1" }));
  await until(() => tabMsgs.some((m) => m.type == "model" && m.thread == "local:agy-local:conv-1"));

  b1.message(JSON.stringify({ type: "event", doc: "doc1", ev: { t: "text", delta: "First session reply." } }));
  expect(tabMsgs.some((m) => m.type == "agent" && m.thread == "local:agy-local:conv-1")).toBe(true);
  expect((await agents.conversation("pete", "doc1")).items).toEqual([{ kind: "assistant", text: "First session reply." }]);
  expect(localScopeOf("pete", "doc1", "agy-local", "conv-1")).toBe("local:agy-local:conv-1:doc1:pete");

  // A new local session on the same machine/bridgeId gets its own empty thread instead of appending to conv-1.
  b1.message(JSON.stringify({ type: "bind", doc: "doc1", label: "Antigravity (repo)", sessionId: "conv-2" }));
  await until(() => tabMsgs.some((m) => m.type == "model" && m.thread == "local:agy-local:conv-2"));
  expect((await agents.conversation("pete", "doc1")).items).toEqual([]);

  b1.message(JSON.stringify({ type: "event", doc: "doc1", ev: { t: "text", delta: "Second session reply." } }));
  expect((await agents.conversation("pete", "doc1")).items).toEqual([{ kind: "assistant", text: "Second session reply." }]);

  // Headless disconnect + fresh reconnect without sessionId also gets a brand-new thread.
  b1.close();
  const b2 = agents.joinBridge(
    { login: "pete", grantId: "g1", label: "Antigravity", onlyDoc: null, origin: "http://localhost:4400" },
    () => {},
    () => {}
  );
  b2.message(JSON.stringify({ type: "hello", id: "agy-local", agent: "antigravity", label: "Antigravity", doc: "doc1" }));
  await until(() => {
    const last = [...tabMsgs].reverse().find((m) => m.type == "model" && m.enabled == true);
    return typeof last?.thread == "string" && last.thread != "local:agy-local:conv-2";
  });
  expect((await agents.conversation("pete", "doc1")).items).toEqual([]);

  b2.close();
  leave();
});

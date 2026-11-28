// WebSocket hibernation for PersonAgent (cloudflare/objects/person-agent.ts, agents/person/sessions.ts):
// panel and bridge WebSockets stay open across DO hibernation, bridge sessions and explicit picks rehydrate
// from SQLite reconciled against live sockets, stale rows from hard restarts are pruned, and SSE keeps working.

import { expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import {
  PersonAgents,
  type AgentSockets,
  type BridgeInfo,
  type BridgeSocketEntry,
  type PanelSocketEntry,
} from "../agents/person/sessions.ts";
import type { Platform } from "../server/platform.ts";
import { localChoice } from "../shared/bridge-protocol.ts";
import { PING, PONG } from "../shared/room-socket.ts";
import { objectSql } from "./helpers/memory-sql.ts";
import { until } from "./helpers/until.ts";

const script = {
  own: {},
  server: { anthropic: Redacted.make("sk-ant-test") },
  mode: "server" as const,
  off: [],
  model: "script" as const,
  effort: "medium" as const,
};

function makePlatform(opts: { enabled?: boolean; docCalls?: string[] } = {}): Platform {
  return {
    agentSettings: async () => (opts.enabled === false ? { missing: "no key" } : script),
    directory: {
      route: async (id: string) => ({ id, owner: "ada", test: false }),
      openAs: async (_who: unknown, _owner: string, id: string) => ({ doc: { id, owner: "ada", test: false }, role: "editor" }),
      users: { isAdmin: async () => false, actsAsAdmin: async () => false },
      config: { get: async () => null },
      activity: { serverTokens: async () => 0, add: async () => {} },
    },
    docs: {
      fetch: async (doc: { id: string }, req: Request) => {
        opts.docCalls?.push(`${doc.id}:${new URL(req.url).pathname}`);
        return new Response("ok");
      },
    },
  } as unknown as Platform;
}

/** Simulated DO hibernatable WebSocket pool shared across PersonAgents instances (sleep -> wake). */
function socketPool() {
  const panels = new Set<PanelSocketEntry>();
  const bridges = new Map<string, BridgeSocketEntry>();
  const sockets: AgentSockets = {
    panels: () => [...panels],
    bridges: () => [...bridges.values()],
  };
  return {
    sockets,
    addPanel(agents: PersonAgents, url: string, login = "ada") {
      const received: Record<string, unknown>[] = [];
      const att = agents.panelAttachment(new Request(url, { headers: { "x-erga-login": login } }));
      const entry: PanelSocketEntry = { ...att, send: (text) => received.push(JSON.parse(text) as Record<string, unknown>) };
      panels.add(entry);
      return { entry, received, close: () => panels.delete(entry) };
    },
    addBridge(info: BridgeInfo) {
      const sockId = crypto.randomUUID();
      const sent: string[] = [];
      let closed = false;
      const entry: BridgeSocketEntry = {
        sockId,
        info,
        send: (text) => {
          if (closed) throw new Error("socket closed");
          sent.push(text);
        },
        close: () => {
          closed = true;
          bridges.delete(sockId);
        },
      };
      bridges.set(sockId, entry);
      return {
        entry,
        sent,
        json: () => sent.filter((s) => s.startsWith("{")).map((s) => JSON.parse(s) as Record<string, unknown>),
        isClosed: () => closed,
        drop: () => bridges.delete(sockId),
      };
    },
    clearBridges: () => bridges.clear(),
  };
}

test("hibernated panel WebSocket receives embedded agent events after DO wake without reconnecting", async () => {
  const sql = objectSql();
  const pool = socketPool();
  const platform = makePlatform({ enabled: true });

  // Instance 1 accepts the panel socket, then hibernates (instance discarded).
  const beforeSleep = new PersonAgents({ sql, platform, sockets: pool.sockets });
  const panel = pool.addPanel(beforeSleep, "https://erga.example/api/agent/events?doc=doc1", "ada");

  // Instance 2 wakes on agentPrompt with only SQLite + hibernated sockets.
  const afterWake = new PersonAgents({ sql, platform, sockets: pool.sockets });
  expect(await afterWake.agentPrompt("ada", "https://erga.example", `@script [{"text":"Woke cleanly."}]`, null, [], "doc1", "Ada")).toEqual(
    {
      ok: true,
    }
  );

  await until(() => panel.received.some((m) => m.type == "agent" && (m.ev as { t?: string; delta?: string })?.delta == "Woke cleanly."));
  await until(async () => !(await afterWake.conversation("ada", "doc1")).busy);
  panel.close();
});

test("bridge sessions, explicit picks, prompt/event relay, approval, model switch, and close survive hibernation", async () => {
  const sql = objectSql();
  const pool = socketPool();
  const docCalls: string[] = [];
  const platform = makePlatform({ enabled: true, docCalls });
  const info: BridgeInfo = { login: "ada", grantId: "g1", label: "Erga Bridge", onlyDoc: null, origin: "https://erga.example" };

  // Instance 1: connect panel sockets + bridge socket, bind doc1 & doc2, switch doc2 to embedded model.
  const inst1 = new PersonAgents({ sql, platform, sockets: pool.sockets });
  const panel1 = pool.addPanel(inst1, "https://erga.example/api/agent/events?doc=doc1", "ada");
  const panel2 = pool.addPanel(inst1, "https://erga.example/api/agent/events?doc=doc2", "ada");
  const br = pool.addBridge(info);

  await inst1.bridgeMessage(
    br.entry,
    JSON.stringify({ type: "hello", id: "agy-1", agent: "antigravity", label: "Antigravity", version: "dev" })
  );
  await inst1.bridgeMessage(br.entry, JSON.stringify({ type: "bind", doc: "doc1", label: "Agy (doc1)", sessionId: "sess-1" }));
  await inst1.bridgeMessage(br.entry, JSON.stringify({ type: "bind", doc: "doc2", label: "Agy (doc2)", sessionId: "sess-2" }));
  // Switch doc2 back to embedded (persisted in bridge_picks).
  await inst1.agentState("ada", "doc2", "https://erga.example", "Ada");
  const sw = await inst1.agentControl("ada", "doc2", "model", "sonnet");
  expect(sw.ok).toBe(true);

  panel1.received.length = 0;
  panel2.received.length = 0;
  br.sent.length = 0;

  // Simulate DO hibernation: drop inst1 completely, create inst2 with same SQLite + same live hibernated sockets.
  const inst2 = new PersonAgents({ sql, platform, sockets: pool.sockets });

  // Defensive PING/PONG still works on wake if a frame reaches bridgeMessage.
  await inst2.bridgeMessage(br.entry, PING);
  expect(br.sent.at(-1)).toBe(PONG);

  // doc1 still sees local bridge; doc2 preserves explicit embedded pick.
  const st1 = await inst2.agentState("ada", "doc1", "https://erga.example", "Ada");
  expect(st1.enabled).toBe(true);
  if (st1.enabled) {
    expect(st1.choice).toBe(localChoice("agy-1"));
    expect(st1.thread).toBe("local:agy-1:sess-1");
  }
  const st2 = await inst2.agentState("ada", "doc2", "https://erga.example", "Ada");
  expect(st2.enabled).toBe(true);
  if (st2.enabled) {
    expect(st2.thread).toBe("embedded");
    expect(st2.models.some((m) => m.id == localChoice("agy-1"))).toBe(true);
  }

  // Prompt & approval route straight down the hibernated bridge socket; streamed events reach the hibernated panel.
  expect(await inst2.agentPrompt("ada", "https://erga.example", "Hello after sleep", null, [], "doc1", "Ada", "m-wake")).toEqual({
    ok: true,
  });
  expect(br.json().some((m) => m.type == "prompt" && m.doc == "doc1" && m.text == "Hello after sleep")).toBe(true);

  await inst2.bridgeMessage(br.entry, JSON.stringify({ type: "event", doc: "doc1", ev: { t: "text", delta: "Still alive!" } }));
  expect(panel1.received.some((m) => m.type == "agent" && m.thread == "local:agy-1:sess-1")).toBe(true);

  expect(await inst2.agentControl("ada", "doc1", "approve", "call-wake", "allow")).toEqual({ ok: true });
  expect(br.json().some((m) => m.type == "answer" && m.id == "call-wake" && m.approve == true && m.choice == "allow")).toBe(true);

  await inst2.bridgeMessage(br.entry, JSON.stringify({ type: "turn_done", doc: "doc1" }));
  expect(docCalls).toEqual(["doc1:/api/turn-done"]);

  // Switching to an embedded model on a freshly woken instance lazily initializes the session.
  const inst3 = new PersonAgents({ sql, platform, sockets: pool.sockets });
  const switched = await inst3.agentControl("ada", "doc1", "model", "sonnet");
  expect(switched.ok).toBe(true);
  expect(switched).toMatchObject({ thread: "embedded" });

  // Closing the hibernated bridge socket wakes & notifies panels cleanly using the stored origin.
  panel1.received.length = 0;
  br.drop();
  await inst3.bridgeClosed(br.entry.sockId);
  expect(panel1.received.some((m) => m.type == "model" && m.thread == "embedded")).toBe(true);
  const afterClose = await inst3.agentState("ada", "doc1", "https://erga.example", "Ada");
  expect(afterClose.enabled).toBe(true);
  if (afterClose.enabled) expect(afterClose.models.some((m) => m.id == localChoice("agy-1"))).toBe(false);
});

test("hard restart with no live sockets prunes stale SQLite rows, retains disconnected state, and restores thread on reconnect", async () => {
  const sql = objectSql();
  const pool = socketPool();
  const platform = makePlatform({ enabled: true });
  const info: BridgeInfo = { login: "ada", grantId: "g1", label: "Erga Bridge", onlyDoc: null, origin: "https://erga.example" };

  const inst1 = new PersonAgents({ sql, platform, sockets: pool.sockets });
  const br = pool.addBridge(info);
  await inst1.bridgeMessage(
    br.entry,
    JSON.stringify({ type: "hello", id: "agy-stale", agent: "antigravity", label: "Antigravity", doc: "doc1" })
  );
  await inst1.bridgeMessage(br.entry, JSON.stringify({ type: "bind", doc: "doc2", label: "Antigravity (doc2)" }));
  // Explicitly switch doc2 to embedded before restart.
  expect((await inst1.agentControl("ada", "doc2", "model", "sonnet")).ok).toBe(true);
  const before = await inst1.agentState("ada", "doc1", "https://erga.example", "Ada");
  expect(before.enabled).toBe(true);
  const originalThread = before.enabled ? before.thread : "";
  expect(sql.exec<{ sock_id: string }>("SELECT sock_id FROM bridge_sessions").length).toBe(1);

  // Deploy drops all live WebSockets without invoking webSocketClose.
  pool.clearBridges();

  // Instance 2 wakes: stale socket row is pruned, doc1 retains disconnected state without auto-switching, doc2 stays embedded.
  const inst2 = new PersonAgents({ sql, platform, sockets: pool.sockets });
  const st1 = await inst2.agentState("ada", "doc1", "https://erga.example", "Ada");
  expect(st1.enabled).toBe(true);
  if (st1.enabled) {
    expect(st1.choice).toBe(localChoice("agy-stale"));
    expect(st1.thread).toBe(originalThread);
    expect("disconnected" in st1 && st1.disconnected).toBe(true);
  }
  const st2 = await inst2.agentState("ada", "doc2", "https://erga.example", "Ada");
  expect(st2.enabled).toBe(true);
  if (st2.enabled) {
    expect(st2.thread).toBe("embedded");
    expect("disconnected" in st2 && st2.disconnected).toBeFalsy();
  }
  expect(sql.exec<{ sock_id: string }>("SELECT sock_id FROM bridge_sessions")).toEqual([]);

  // Disconnected state survives another hibernation, and reconnecting restores the exact thread.
  const inst3 = new PersonAgents({ sql, platform, sockets: pool.sockets });
  const stillDisc = await inst3.agentState("ada", "doc1", "https://erga.example", "Ada");
  expect(stillDisc.enabled && "disconnected" in stillDisc && stillDisc.disconnected).toBe(true);
  const reBr = pool.addBridge(info);
  await inst3.bridgeMessage(
    reBr.entry,
    JSON.stringify({ type: "hello", id: "agy-stale", agent: "antigravity", label: "Antigravity", doc: "doc1", reconnect: true })
  );
  const resumed = await inst3.agentState("ada", "doc1", "https://erga.example", "Ada");
  expect(resumed.enabled).toBe(true);
  if (resumed.enabled) {
    expect(resumed.thread).toBe(originalThread);
    expect("disconnected" in resumed && resumed.disconnected).toBeFalsy();
  }
});

test("replacement bridge socket across hibernation closes the old socket without dropping the new one", async () => {
  const sql = objectSql();
  const pool = socketPool();
  const platform = makePlatform({ enabled: false });
  const info: BridgeInfo = { login: "ada", grantId: "g1", label: "Erga Bridge", onlyDoc: null, origin: "https://erga.example" };

  const inst1 = new PersonAgents({ sql, platform, sockets: pool.sockets });
  const oldBr = pool.addBridge(info);
  await inst1.bridgeMessage(
    oldBr.entry,
    JSON.stringify({ type: "hello", id: "agy-1", agent: "antigravity", label: "Antigravity", doc: "doc1" })
  );

  // Wake in inst2, a fresh socket connects with the same bridge id before oldBr closes.
  const inst2 = new PersonAgents({ sql, platform, sockets: pool.sockets });
  const newBr = pool.addBridge(info);
  await inst2.bridgeMessage(
    newBr.entry,
    JSON.stringify({ type: "hello", id: "agy-1", agent: "antigravity", label: "Antigravity", doc: "doc1", reconnect: true })
  );
  expect(oldBr.isClosed()).toBe(true);

  // Late webSocketClose for oldBr must NOT disconnect newBr.
  await inst2.bridgeClosed(oldBr.entry.sockId);
  expect(await inst2.agentPrompt("ada", "https://erga.example", "Still connected", null, [], "doc1", "Ada")).toEqual({ ok: true });
  expect(newBr.json().some((m) => m.type == "prompt" && m.text == "Still connected")).toBe(true);
});

test("SSE fallback stream still connects and delivers events without WebSocket upgrade", async () => {
  const sql = objectSql();
  const platform = makePlatform({ enabled: true });
  const agents = new PersonAgents({ sql, platform });
  const res = await agents.fetch(new Request("https://erga.example/api/agent/events?doc=doc1", { headers: { "x-erga-login": "ada" } }));
  expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const first = await reader.read();
  expect(dec.decode(first.value)).toContain(": connected");

  await agents.agentPrompt("ada", "https://erga.example", `@script [{"text":"SSE works"}]`, null, [], "doc1", "Ada");
  let chunk = "";
  await until(async () => {
    const next = await reader.read();
    if (next.value) chunk += dec.decode(next.value);
    return chunk.includes("SSE works");
  });
  await reader.cancel();
});

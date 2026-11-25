// Unit tests for the local agent bridge:
// - Pure bridge registry state machine (agents/person/bridge.ts)
// - PersonAgents bridge routing, own thread scopes, and approval forwarding
// - Yjs room `via` attribution ("Pete’s Antigravity") on agent WebSockets
// - Generic ACP stdio driver streaming, approvals, and abort (mock ACP server)
// - Antigravity transcript.jsonl mirroring and deduplication
// - YjsDiskSync bidirectional CRDT <-> filesystem sync

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Y from "yjs";
import { activeBridge, bridgeStep, EMPTY_BRIDGES, localScopeOf, panelOptions } from "../agents/person/bridge.ts";
import { PersonAgents } from "../agents/person/sessions.ts";
import type { ChatSql } from "../agents/chat-store.ts";
import { createAcpDriver } from "../bridge/drivers/acp.ts";
import { AntigravityTranscriptMirror, parseTranscriptStep, unwrapUserRequest } from "../bridge/drivers/antigravity.ts";
import type { DriverEvent } from "../bridge/core/driver.ts";
import { copyIntoManaged, ErgaDaemon } from "../bridge/core/daemon.ts";
import { saveToken } from "../bridge/core/auth.ts";
import { YjsDiskSync } from "../bridge/core/yjs-sync.ts";
import { authors, files, roomInfo } from "../document/model/content.ts";
import { Participants, type Tab, type TabSocket } from "../document/room/participants.ts";
import { Room } from "../document/room/room.ts";
import { FileStore, StateStore, StoreError } from "../document/store/storage.ts";
import type { Platform } from "../server/platform.ts";
import { agentLabel, VIA } from "../shared/attribution.ts";
import { localChoice } from "../shared/bridge-protocol.ts";
import { encodeStart } from "../shared/room-socket.ts";
import { Decoder, Encoder, readSyncMessage, writeSyncStep1, writeUpdate } from "../shared/yjs-protocol.ts";

/** Polls until `fn` returns true (no fixed pauses). */
async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (; Date.now() < deadline && !(await fn()); ) await new Promise((r) => setTimeout(r, 15));
  if (!(await fn())) throw new Error("Timed out waiting for condition");
}

function sqliteChat(): ChatSql {
  const db = new Database(":memory:");
  return {
    exec: <T>(query: string, ...params: (string | number | null)[]) => db.query(query).all(...params) as T[],
    transaction: <R>(f: () => R) => db.transaction(f)(),
  };
}

// ---------------------------------------------------------------- 1. Bridge state machine

test("bridge state machine orders connected agents above built-in models and defaults to them", () => {
  const embedded = [{ id: "sonnet", label: "Claude Sonnet", key: "server" as const }];
  let st = EMPTY_BRIDGES;
  expect(activeBridge(st, "doc1")).toBeNull();
  expect(panelOptions(st, "doc1", embedded)).toEqual([{ id: "sonnet", label: "Claude Sonnet", key: "server" }]);

  // Connecting a global agent makes it default and puts it in the "local" group first.
  const c1 = bridgeStep(st, {
    on: "connect",
    bridge: {
      id: "antigravity-mac",
      agent: "antigravity",
      label: "Antigravity",
      grantId: "g1",
      onlyDoc: null,
      sessionId: null,
      cwd: "/repo",
      connectedAt: 100,
    },
  });
  st = c1.state;
  expect(c1.notify).toEqual(["*"]);
  expect(activeBridge(st, "doc1")?.id).toBe("antigravity-mac");
  expect(panelOptions(st, "doc1", embedded)).toEqual([
    { id: "local:antigravity-mac", label: "Antigravity", group: "local", agent: "antigravity" },
    { id: "sonnet", label: "Claude Sonnet", key: "server", group: "embedded" },
  ]);

  // Explicitly choosing an embedded model pins that doc to embedded.
  st = bridgeStep(st, { on: "select", doc: "doc1", choice: "sonnet" }).state;
  expect(activeBridge(st, "doc1")).toBeNull();
  expect(activeBridge(st, "doc2")?.id).toBe("antigravity-mac");

  // Binding a document to the local agent switches that doc back to the local agent.
  const b1 = bridgeStep(st, { on: "bind", id: "antigravity-mac", doc: "doc1", label: "Antigravity (repo)" });
  st = b1.state;
  expect(b1.notify).toEqual(["doc1"]);
  expect(activeBridge(st, "doc1")?.id).toBe("antigravity-mac");
  expect(panelOptions(st, "doc1", embedded)[0].label).toBe("Antigravity (repo)");

  // Disconnecting cleans up and falls back to embedded.
  const d1 = bridgeStep(st, { on: "disconnect", id: "antigravity-mac" });
  st = d1.state;
  expect(activeBridge(st, "doc1")).toBeNull();
  expect(panelOptions(st, "doc1", embedded)).toEqual([{ id: "sonnet", label: "Claude Sonnet", key: "server" }]);
});

test("bridge enforces document-scoped grant onlyDoc", () => {
  let st = EMPTY_BRIDGES;
  st = bridgeStep(st, {
    on: "connect",
    bridge: {
      id: "scoped",
      agent: "antigravity",
      label: "Antigravity",
      grantId: "g2",
      onlyDoc: "docA",
      sessionId: null,
      cwd: null,
      connectedAt: 10,
    },
  }).state;
  expect(activeBridge(st, "docA")?.id).toBe("scoped");
  expect(activeBridge(st, "docB")).toBeNull();
  const badBind = bridgeStep(st, { on: "bind", id: "scoped", doc: "docB" });
  expect(badBind.ok).toBe(false);
  expect(activeBridge(badBind.state, "docB")).toBeNull();
});

// ---------------------------------------------------------------- 2. PersonAgents bridge routing & own scope

test("PersonAgents enables panel with no API keys when a local bridge connects, streams events and approvals in its own scope", async () => {
  const fakePlatform = {
    agentSettings: async () => ({ missing: "no API keys configured" }),
    directory: {
      route: async (id: string) => ({ id, owner: "pete", test: false }),
      users: { isAdmin: async () => false },
    },
  } as unknown as Platform;

  const agents = new PersonAgents({ sql: sqliteChat(), platform: fakePlatform });

  // Without a bridge and without API keys, the panel is off.
  const before = await agents.agentState("pete", "doc1", "http://localhost:4400", "Pete");
  expect(before.enabled).toBe(false);

  // Browser tab subscribes to /api/agent/events for doc1.
  const tabMsgs: Record<string, unknown>[] = [];
  const leaveTab = agents.join(
    new Request("http://localhost:4400/api/agent/events?doc=doc1", { headers: { "x-erga-login": "pete" } }),
    (text) => tabMsgs.push(JSON.parse(text) as Record<string, unknown>)
  );

  // Local bridge connects and sends hello.
  const toBridge: Record<string, unknown>[] = [];
  const bridge = agents.joinBridge(
    { login: "pete", grantId: "g1", label: "Antigravity", onlyDoc: null, origin: "http://localhost:4400" },
    (text) => toBridge.push(JSON.parse(text) as Record<string, unknown>),
    () => {}
  );
  bridge.message(JSON.stringify({ type: "hello", id: "agy-1", agent: "antigravity", label: "Antigravity", doc: "doc1" }));

  // Panel immediately switches on and selects Antigravity.
  await until(() => tabMsgs.some((m) => m.type == "model" && m.enabled == true));
  const state = await agents.agentState("pete", "doc1", "http://localhost:4400", "Pete");
  expect(state.enabled).toBe(true);
  if (state.enabled) {
    expect(state.choice).toBe(localChoice("agy-1"));
    expect(state.models[0]).toEqual({ id: "local:agy-1", label: "Antigravity", group: "local", agent: "antigravity" });
  }

  // Browser sends prompt -> forwarded to bridge; bridge streams permission ask -> browser approves -> forwarded back!
  const sent = await agents.agentPrompt("pete", "http://localhost:4400", "Update heading", "Open: /pete/doc1", [], "doc1", "Pete", "m1");
  expect(sent.ok).toBe(true);
  expect(toBridge.length).toBe(1);
  expect(toBridge[0].type).toBe("prompt");
  expect(toBridge[0].text).toBe("Update heading");

  bridge.message(
    JSON.stringify({
      type: "event",
      doc: "doc1",
      ev: {
        t: "tool",
        id: "call-1",
        name: "run_command",
        path: "echo hi",
        status: "asking",
        detail: "echo hi",
        call: { tool: "run_command", args: { CommandLine: "echo hi" } },
      },
    })
  );
  const ans = await agents.agentControl("pete", "doc1", "approve", "call-1");
  expect(ans.ok).toBe(true);
  expect(toBridge[1]).toEqual({ type: "answer", doc: "doc1", id: "call-1", approve: true });

  bridge.message(JSON.stringify({ type: "event", doc: "doc1", ev: { t: "text", delta: "Updated!" } }));
  bridge.message(JSON.stringify({ type: "event", doc: "doc1", ev: { t: "busy", busy: false } }));

  // Local agent thread has its own conversation log.
  const conv = await agents.conversation("pete", "doc1");
  expect(conv.items.some((i) => i.kind == "user" && i.text == "Update heading")).toBe(true);
  expect(conv.items.some((i) => i.kind == "assistant" && i.text == "Updated!")).toBe(true);
  expect(localScopeOf("pete", "doc1", "agy-1")).toBe("local:agy-1:doc1:pete");

  // Disconnecting bridge turns panel back off (since no API keys are set).
  bridge.close();
  const after = await agents.agentState("pete", "doc1", "http://localhost:4400", "Pete");
  expect(after.enabled).toBe(false);
  leaveTab();
});

// ---------------------------------------------------------------- 3. Yjs room `via` attribution

test("Yjs room WebSocket preserves via attribution for local agent edits (Pete’s Antigravity)", async () => {
  const storeFiles = new Map<string, Uint8Array>([["index.html", new TextEncoder().encode("<p>Hello</p>")]]);
  const fileStore = FileStore.of({
    list: Effect.sync(() => [...storeFiles.keys()]),
    read: (p) => Effect.sync(() => storeFiles.get(p) ?? null),
    write: (p, b) => Effect.sync(() => void storeFiles.set(p, typeof b == "string" ? new TextEncoder().encode(b) : b)),
    remove: (p) => Effect.sync(() => storeFiles.delete(p)),
    folders: Effect.sync(() => []),
    mkdir: () => Effect.void,
    rmdir: () => Effect.void,
  });
  const stateStore = StateStore.of({
    lazyFiles: false,
    load: Effect.succeed(null),
    commit: () => Effect.void,
    compact: () => Effect.succeed(false),
  });

  const scope = Effect.runSync(Scope.make());
  const room = await Effect.runPromise(
    Room.make({ writeDelay: 50 }).pipe(
      Effect.provideService(FileStore, fileStore),
      Effect.provideService(StateStore, stateStore),
      Effect.provideService(Scope.Scope, scope)
    )
  );

  const tabs = new Map<TabSocket, Tab>();
  const participants = new Participants(
    {
      all: () => [...tabs.keys()],
      tabOf: (s) => tabs.get(s) ?? null,
      keep: (s, t) => tabs.set(s, t),
    },
    {
      isOpen: () => true,
      reopen: () => Effect.succeed(true),
      activity: () => {},
      viewed: () => Effect.succeed("v1"),
      greet: () => {},
      avatarOf: () => undefined,
      hello: async () => ({}),
      joined: () => {},
      left: () => {},
      cutVersion: async () => null,
      setTitle: async () => true,
    }
  );
  participants.opened(room, null);

  const sentToAgent: (string | Uint8Array)[] = [];
  const agentSocket: TabSocket = { send: (m) => sentToAgent.push(m), close: () => {} };
  const via = VIA.token("Antigravity");
  const agentTab: Tab = {
    id: "t-agent",
    readOnly: false,
    epoch: null,
    person: { id: "pete", name: "Pete" },
    via,
    events: false,
  };
  tabs.set(agentSocket, agentTab);
  expect(participants.join(agentSocket, agentTab)).toBe(true);
  // Agent sockets are not counted as browser editor tabs.
  expect(participants.tabsOf("pete")).toEqual([]);

  // Simulate local Yjs peer syncing and applying an edit.
  const localDoc = new Y.Doc();
  Y.applyUpdate(localDoc, Y.encodeStateAsUpdate(room.doc));
  let updateBytes: Uint8Array | null = null;
  localDoc.on("update", (u: Uint8Array) => {
    updateBytes = u;
  });
  localDoc.transact(() => {
    files(localDoc).get("index.html")!.insert(3, "Antigravity ");
  });

  const enc = new Encoder();
  enc.writeUint(0); // MSG_SYNC
  writeUpdate(enc, updateBytes!);
  await Effect.runPromise(participants.message(agentSocket, enc.toBytes()));

  expect(room.text("index.html")).toBe("<p>Antigravity Hello</p>");
  const author = authors(room.doc).get(String(localDoc.clientID));
  expect(author?.kind).toBe("agent");
  expect(author?.via).toBe("a shared agent (Antigravity)");
  expect(agentLabel(author!, null, true).label).toBe("Pete’s Antigravity");
  expect(agentLabel(author!, "editing", false).label).toBe("Antigravity · editing");

  localDoc.destroy();
  await Effect.runPromise(Scope.close(scope, Effect.runSyncExit(Effect.void)));
});

// ---------------------------------------------------------------- 4. ACP stdio driver

test("AcpDriver streams thoughts, text, tool calls, interactive permissions, and abort over stdio JSON-RPC", async () => {
  const dir = mkdtempSync(join(tmpdir(), "erga-acp-unit-"));
  const mockScript = join(dir, "mock-acp.ts");
  writeFileSync(
    mockScript,
    `
const out = (m: object) => process.stdout.write(JSON.stringify(m) + "\\n");
const reader = Bun.stdin.stream().getReader();
const dec = new TextDecoder();
let buf = "";
let pendingPromptId: number | null = null;

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") {
      out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (m.method === "session/new") {
      out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s-1", models: { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "Mock Model" }] } } });
    } else if (m.method === "session/prompt") {
      pendingPromptId = m.id;
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning..." } } } });
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "tool_call", toolCallId: "tc-1", name: "run_command", args: { CommandLine: "echo ok" }, status: "in_progress" } } });
      out({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: { sessionId: "s-1", toolCall: { toolCallId: "tc-1", name: "run_command", title: "echo ok", args: { CommandLine: "echo ok" } }, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] } });
    } else if (m.id === "perm-1" && m.result) {
      const picked = m.result.outcome?.optionId;
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", name: "run_command", status: picked === "allow" ? "completed" : "failed" } } });
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Decision: " + picked } } } });
      out({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "end_turn" } });
    } else if (m.method === "session/close") {
      out({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  }
}
`
  );

  try {
    const driver = createAcpDriver({ id: "mock-acp", label: "Mock ACP", command: process.execPath, args: [mockScript] });
    const handle = await driver.open({ cwd: dir });
    expect(handle.sessionId).toBe("s-1");
    expect(handle.models).toEqual([{ id: "m1", label: "Mock Model" }]);

    const events: DriverEvent[] = [];
    handle.onEvent((ev) => {
      events.push(ev);
      if (ev.t == "tool" && ev.status == "asking") void handle.answer(ev.id, true);
    });

    await handle.prompt({ text: "Run it" });
    await handle.close();

    expect(events.some((e) => e.t == "thinking" && e.delta == "Planning...")).toBe(true);
    expect(events.some((e) => e.t == "tool" && e.id == "tc-1" && e.status == "asking")).toBe(true);
    expect(events.some((e) => e.t == "tool" && e.id == "tc-1" && e.status == "done")).toBe(true);
    expect(events.some((e) => e.t == "text" && e.delta == "Decision: allow")).toBe(true);
    expect(events.at(-1)).toEqual({ t: "turn_done" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 5. Antigravity transcript mirror

test("Antigravity transcript parser and mirror emit local steps and suppress during ACP turns", () => {
  expect(unwrapUserRequest("<USER_REQUEST>\nHello world\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>")).toBe(
    "Hello world"
  );

  const parsed = parseTranscriptStep({
    step_index: 2,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    thinking: "Checking file",
    tool_calls: [{ name: "edit_file", args: { Path: "index.html" } }],
    content: "All set.",
  });
  expect(parsed).toEqual([
    { t: "thinking", delta: "Checking file" },
    { t: "tool", id: "local-2-0", name: "edit_file", path: "index.html", status: "done" },
    { t: "text", delta: "All set." },
  ]);

  const dir = mkdtempSync(join(tmpdir(), "erga-transcript-"));
  const file = join(dir, "transcript.jsonl");
  try {
    writeFileSync(
      file,
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "old" }) + "\n"
    );
    const seen: DriverEvent[] = [];
    const mirror = new AntigravityTranscriptMirror(file, (evs) => seen.push(...evs));
    mirror.start(false);
    expect(seen).toEqual([]); // skipped pre-existing

    // While suppressed (ACP turn active), appended steps are ignored and skipped on unsuppress.
    mirror.setSuppressed(true);
    writeFileSync(
      file,
      readFileSync(file, "utf8") + JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "from acp" }) + "\n"
    );
    mirror.poke();
    expect(seen).toEqual([]);
    mirror.setSuppressed(false);

    // Local terminal turn appended after unsuppress IS mirrored immediately.
    writeFileSync(
      file,
      readFileSync(file, "utf8") +
        JSON.stringify({
          step_index: 2,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "<USER_REQUEST>Answered locally</USER_REQUEST>",
        }) +
        "\n"
    );
    mirror.poke();
    expect(seen).toEqual([{ t: "user", text: "Answered locally" }]);
    mirror.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 6. YjsDiskSync bidirectional CRDT <-> disk

test("YjsDiskSync mirrors remote Yjs files to disk, rebases local disk edits back, and uploads binary assets", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.transact(() => {
    roomInfo(serverDoc).set("epoch", "ep-1");
    const t = new Y.Text();
    t.insert(0, "<h1>Hello world</h1>\n<p>Keep me</p>");
    files(serverDoc).set("index.html", t);
  });

  const uploaded = new Map<string, Uint8Array>();
  const sockets = new Set<Bun.ServerWebSocket<unknown>>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname == "/d/doc1/api/start") {
        const payload = encodeStart({ type: "hello", epoch: "ep-1" }, Y.encodeStateAsUpdate(serverDoc));
        return new Response(new Uint8Array(payload));
      }
      if (url.pathname == "/d/doc1/api/room") {
        if (srv.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (req.method == "PUT" && url.pathname.startsWith("/d/doc1/api/files/")) {
        const rel = decodeURIComponent(url.pathname.slice("/d/doc1/api/files/".length));
        uploaded.set(rel, new Uint8Array(await req.arrayBuffer()));
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        const e = new Encoder();
        e.writeUint(0);
        writeSyncStep1(e, serverDoc);
        ws.send(e.toBytes());
      },
      message(ws, data) {
        if (typeof data == "string") return;
        const d = new Decoder(new Uint8Array(data));
        const type = d.readUint();
        if (type == 0) {
          const reply = new Encoder();
          reply.writeUint(0);
          readSyncMessage(d, reply, serverDoc, ws);
          if (reply.length > 1) ws.send(reply.toBytes());
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  serverDoc.on("update", (u: Uint8Array, origin: unknown) => {
    const e = new Encoder();
    e.writeUint(0);
    writeUpdate(e, u);
    const bytes = e.toBytes();
    for (const s of sockets) if (s !== origin) s.send(bytes);
  });

  const dir = mkdtempSync(join(tmpdir(), "erga-yjs-disk-"));
  const sync = new YjsDiskSync({
    origin: `http://127.0.0.1:${server.port}`,
    docId: "doc1",
    dir,
    token: async () => "test-token",
  });

  try {
    await sync.start();
    // 1. Remote file materialized on disk.
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("<h1>Hello world</h1>\n<p>Keep me</p>");

    // 2. Local edit on disk merges cleanly into remote server Y.Doc.
    writeFileSync(join(dir, "index.html"), "<h1>Hello Erga</h1>\n<p>Keep me</p>");
    await sync.flush();
    await until(() => files(serverDoc).get("index.html")?.toString() == "<h1>Hello Erga</h1>\n<p>Keep me</p>");

    // 3. Remote edit in browser propagates back to disk.
    serverDoc.transact(() => {
      const t = files(serverDoc).get("index.html")!;
      t.insert(t.length, "\n<p>From browser</p>");
    }, "browser");
    await until(() => readFileSync(join(dir, "index.html"), "utf8").includes("From browser"));

    // 4. Ignored files never sync; binary files upload over HTTP.
    writeFileSync(join(dir, ".DS_Store"), "junk");
    writeFileSync(join(dir, "logo.png"), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    await sync.flush();
    await until(() => uploaded.has("logo.png"));
    expect(files(serverDoc).has(".DS_Store")).toBe(false);
    expect(uploaded.get("logo.png")?.length).toBe(8);
  } finally {
    await sync.stop();
    server.stop(true);
    serverDoc.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 7. copyIntoManaged

test("copyIntoManaged copies project files into managed dir, skips ignored dirs, and leaves source untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "erga-copy-managed-"));
  const src = join(root, "project");
  const dst = join(root, "managed");
  mkdirSync(join(src, "styles"), { recursive: true });
  mkdirSync(join(src, ".git"), { recursive: true });
  mkdirSync(join(src, "node_modules/pkg"), { recursive: true });
  mkdirSync(dst, { recursive: true });

  writeFileSync(join(src, "index.html"), "<h1>From Local Project</h1>");
  writeFileSync(join(src, "styles/main.css"), "body { color: navy; }");
  writeFileSync(join(src, ".DS_Store"), "junk");
  writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main");
  writeFileSync(join(src, "node_modules/pkg/index.js"), "module.exports = 1;");

  try {
    await copyIntoManaged(src, dst);
    expect(readFileSync(join(dst, "index.html"), "utf8")).toBe("<h1>From Local Project</h1>");
    expect(readFileSync(join(dst, "styles/main.css"), "utf8")).toBe("body { color: navy; }");
    expect(existsSync(join(dst, ".DS_Store"))).toBe(false);
    expect(existsSync(join(dst, ".git"))).toBe(false);
    expect(existsSync(join(dst, "node_modules"))).toBe(false);

    // Editing the managed copy never mutates the original project folder.
    writeFileSync(join(dst, "index.html"), "<h1>Changed In Managed</h1>");
    expect(readFileSync(join(src, "index.html"), "utf8")).toBe("<h1>From Local Project</h1>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 8. Edge-case regressions

test("YjsDiskSync.start rejects cleanly with no unhandled rejection when start fails", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("server error", { status: 500 }),
  });
  const dir = mkdtempSync(join(tmpdir(), "erga-yjs-fail-"));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const sync = new YjsDiskSync({
      origin: `http://127.0.0.1:${server.port}`,
      docId: "doc1",
      dir,
      token: async () => "test-token",
    });
    await expect(sync.start()).rejects.toThrow("500");
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PersonAgents.joinBridge records bridge origin and notifies tabs that subscribed before agentState", async () => {
  const fakePlatform = {
    agentSettings: async () => ({ missing: "no API keys configured" }),
    directory: {
      route: async (id: string) => ({ id, owner: "pete", test: false }),
      users: { isAdmin: async () => false },
    },
  } as unknown as Platform;

  const agents = new PersonAgents({ sql: sqliteChat(), platform: fakePlatform });
  const tabMsgs: Record<string, unknown>[] = [];
  const leaveTab = agents.join(
    new Request("https://erga.example/api/agent/events?doc=doc1", { headers: { "x-erga-login": "pete" } }),
    (text) => tabMsgs.push(JSON.parse(text) as Record<string, unknown>)
  );

  const bridge = agents.joinBridge(
    { login: "pete", grantId: "g1", label: "Antigravity", onlyDoc: null, origin: "https://erga.example" },
    () => {},
    () => {}
  );
  bridge.message(JSON.stringify({ type: "hello", id: "agy-origin", agent: "antigravity", label: "Antigravity", doc: "doc1" }));

  await until(() => tabMsgs.some((m) => m.type == "model" && m.enabled == true));
  const last = tabMsgs.filter((m) => m.type == "model").at(-1);
  expect(last?.choice).toBe(localChoice("agy-origin"));
  bridge.close();
  leaveTab();
});

test("ErgaDaemon.openDocument copies fromDir into an already-mounted document", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.transact(() => {
    roomInfo(serverDoc).set("epoch", "ep-1");
    const t = new Y.Text();
    t.insert(0, "<h1>Initial</h1>");
    files(serverDoc).set("index.html", t);
  });

  const server = Bun.serve<{ path: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname == "/d/doc1/api/doc") {
        return new Response(JSON.stringify({ docName: { id: "doc1", owner: "pete", slug: "demo", title: "Demo" } }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname == "/d/doc1/api/start") {
        return new Response(new Uint8Array(encodeStart({ type: "hello", epoch: "ep-1" }, Y.encodeStateAsUpdate(serverDoc))));
      }
      if (url.pathname == "/d/doc1/api/room" || url.pathname == "/api/agent/bridge") {
        if (srv.upgrade(req, { data: { path: url.pathname } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.path == "/d/doc1/api/room") {
          const e = new Encoder();
          e.writeUint(0);
          writeSyncStep1(e, serverDoc);
          ws.send(e.toBytes());
        }
      },
      message(ws, data) {
        if (ws.data.path != "/d/doc1/api/room" || typeof data == "string") return;
        const d = new Decoder(new Uint8Array(data));
        if (d.readUint() == 0) {
          const reply = new Encoder();
          reply.writeUint(0);
          readSyncMessage(d, reply, serverDoc, ws);
          if (reply.length > 1) ws.send(reply.toBytes());
        }
      },
    },
  });

  const root = mkdtempSync(join(tmpdir(), "erga-daemon-fromdir-"));
  const home = join(root, "home");
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "notes.html"), "<p>Copied later</p>");

  const prevHome = process.env.ERGA_HOME;
  const prevToken = process.env.ERGA_TOKEN;
  process.env.ERGA_HOME = home;
  delete process.env.ERGA_TOKEN;

  const origin = `http://127.0.0.1:${server.port}`;
  saveToken({ origin, clientName: "Mock", clientId: "c1", accessToken: "tok", expiresAt: Date.now() + 60_000 });

  const daemon = new ErgaDaemon({
    id: "mock",
    label: "Mock",
    open: async () => {
      throw new Error("not used");
    },
  });

  try {
    const first = await daemon.openDocument({ origin, document: "/d/doc1" });
    expect(first.files).toEqual(["index.html"]);

    const second = await daemon.openDocument({ origin, document: "/d/doc1", fromDir: src });
    expect(second.copiedFrom).toBe(src);
    await until(() => files(serverDoc).get("notes.html")?.toString() == "<p>Copied later</p>");
  } finally {
    await daemon.stop();
    if (prevHome === undefined) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = prevHome;
    if (prevToken === undefined) delete process.env.ERGA_TOKEN;
    else process.env.ERGA_TOKEN = prevToken;
    server.stop(true);
    serverDoc.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

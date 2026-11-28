// Unit tests for the chat-native Erga bridge:
// - Pure bridge registry state machine (agents/person/bridge.ts): per-session threadId isolation, reset, reconnect
// - PersonAgents chat-native streaming, permission answers, thread tagging, update push, and edit access on turn_done
// - Yjs room `via` attribution on agent WebSockets
// - YjsDiskSync bidirectional CRDT <-> filesystem sync & copyIntoManaged
// - ErgaDaemon end-to-end: connectAgent (fake ACP driver), openDocument, bindings.json restore, turn-safe update deferral, device-code auth

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Y from "yjs";
import {
  activeBridge,
  bridgeStep,
  disconnectedBridge,
  EMPTY_BRIDGES,
  isLocalSelected,
  localScopeOf,
  panelOptions,
  selectedThreadKey,
  threadKeyFor,
} from "../agents/person/bridge.ts";
import { PersonAgents } from "../agents/person/sessions.ts";
import type { ChatSql } from "../agents/chat-store.ts";
import { cachedToken, saveToken } from "../bridge/core/auth.ts";
import { ErgaDaemon } from "../bridge/core/daemon.ts";
import { copyIntoManaged } from "../bridge/core/daemon-io.ts";
import { sha256Hex, writePinnedOrigin } from "../bridge/core/updater.ts";
import { YjsDiskSync } from "../bridge/core/yjs-sync.ts";
import { DriverEvents, type AgentDriver, type AgentHandle, type OpenSessionOptions } from "../bridge/drivers/stdio.ts";
import { authors, files, roomInfo } from "../document/model/content.ts";
import { Participants, type Tab, type TabSocket } from "../document/room/participants.ts";
import { Room } from "../document/room/room.ts";
import { FileStore, StateStore } from "../document/store/storage.ts";
import { useAssets } from "../server/pages/index.ts";
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

class FakeAcpHandle extends DriverEvents implements AgentHandle {
  readonly models = [{ id: "m1", label: "Model 1" }];
  model: string | null = "m1";
  closed = false;
  prompts: string[] = [];
  answers: Array<{ id: string; approve: boolean; choice?: string }> = [];
  private closeFns = new Set<() => void>();
  private pendingFinish: (() => void) | null = null;

  constructor(
    readonly sessionId: string,
    readonly opts: OpenSessionOptions
  ) {
    super();
  }

  async prompt(input: { text: string }): Promise<void> {
    this.prompts.push(input.text);
    this.emit({ t: "busy", busy: true });
    if (input.text.includes("HOLD")) {
      await new Promise<void>((r) => {
        this.pendingFinish = r;
      });
    }
    this.emit({ t: "text", delta: `Reply: ${input.text}` });
    this.emit({ t: "busy", busy: false });
    this.emit({ t: "turn_done" });
  }

  releaseHeldTurn(): void {
    const fn = this.pendingFinish;
    this.pendingFinish = null;
    fn?.();
  }

  async abort(): Promise<void> {
    this.releaseHeldTurn();
  }

  async answer(id: string, approve: boolean, choice?: string): Promise<boolean> {
    this.answers.push({ id, approve, choice });
    return true;
  }

  onClose(fn: () => void): () => void {
    this.closeFns.add(fn);
    return () => this.closeFns.delete(fn);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.releaseHeldTurn();
    for (const fn of [...this.closeFns]) fn();
  }
}

// ---------------------------------------------------------------- 1. Bridge state machine & per-session thread isolation

test("bridgeStep isolates per-session and per-doc threads, handles embedded fallback, and preserves threadId on reconnect", () => {
  const embedded = [{ id: "sonnet", label: "Claude Sonnet", key: "server" as const }];
  let st = EMPTY_BRIDGES;
  expect(activeBridge(st, "doc1")).toBeNull();
  expect(panelOptions(st, "doc1", embedded)).toEqual([{ id: "sonnet", label: "Claude Sonnet", key: "server" }]);

  const c1 = bridgeStep(st, {
    on: "connect",
    fallbackThreadId: "conn-1",
    bridge: {
      id: "agy-local",
      agent: "antigravity",
      label: "Antigravity",
      version: "abc123",
      grantId: "g1",
      onlyDoc: null,
      sessionId: null,
      cwd: null,
      connectedAt: 100,
    },
  });
  st = c1.state;
  expect(c1.notify).toEqual(["*"]);
  expect(activeBridge(st, "doc1")?.id).toBe("agy-local");
  expect(panelOptions(st, "doc1", embedded)).toEqual([
    { id: "local:agy-local", label: "Antigravity", group: "local", agent: "antigravity" },
    { id: "sonnet", label: "Claude Sonnet", key: "server", group: "embedded" },
  ]);

  st = bridgeStep(st, { on: "select", doc: "doc1", choice: "sonnet" }).state;
  expect(activeBridge(st, "doc1")).toBeNull();
  expect(activeBridge(st, "doc2")?.id).toBe("agy-local");

  st = bridgeStep(st, { on: "bind", id: "agy-local", doc: "doc1", sessionId: "conv-1", fallbackThreadId: "fb-1" }).state;
  st = bridgeStep(st, { on: "bind", id: "agy-local", doc: "doc2", sessionId: "conv-2", fallbackThreadId: "fb-2" }).state;
  expect(threadKeyFor(activeBridge(st, "doc1"), "doc1")).toBe("local:agy-local:conv-1");
  expect(threadKeyFor(activeBridge(st, "doc2"), "doc2")).toBe("local:agy-local:conv-2");

  // Reconnect with same session keeps doc1's thread.
  st = bridgeStep(st, { on: "bind", id: "agy-local", doc: "doc1", sessionId: "conv-1", fallbackThreadId: "fb-3", reconnect: true }).state;
  expect(threadKeyFor(activeBridge(st, "doc1"), "doc1")).toBe("local:agy-local:conv-1");

  // New local session binding doc1 gets a fresh thread without affecting doc2.
  st = bridgeStep(st, { on: "bind", id: "agy-local", doc: "doc1", sessionId: "conv-3", fallbackThreadId: "fb-4" }).state;
  expect(threadKeyFor(activeBridge(st, "doc1"), "doc1")).toBe("local:agy-local:conv-3");
  expect(threadKeyFor(activeBridge(st, "doc2"), "doc2")).toBe("local:agy-local:conv-2");

  // Reset rotates only doc1's thread.
  st = bridgeStep(st, { on: "reset", id: "agy-local", doc: "doc1", nextThreadId: "reset-1" }).state;
  expect(threadKeyFor(activeBridge(st, "doc1"), "doc1")).toBe("local:agy-local:reset-1");
  expect(threadKeyFor(activeBridge(st, "doc2"), "doc2")).toBe("local:agy-local:conv-2");

  // Disconnect keeps doc1 and doc2 pinned on the disconnected local agent (never auto-switching).
  st = bridgeStep(st, { on: "disconnect", id: "agy-local", now: 500 }).state;
  expect(activeBridge(st, "doc1")).toBeNull();
  expect(disconnectedBridge(st, "doc1")).toEqual({
    id: "agy-local",
    agent: "antigravity",
    label: "Antigravity",
    threadId: "reset-1",
    disconnectedAt: 500,
  });
  expect(isLocalSelected(st, "doc1")).toBe(true);
  expect(selectedThreadKey(st, "doc1")).toBe("local:agy-local:reset-1");
  expect(panelOptions(st, "doc1", embedded)).toEqual([
    { id: "local:agy-local", label: "Antigravity", group: "local", agent: "antigravity", disconnected: true },
    { id: "sonnet", label: "Claude Sonnet", key: "server", group: "embedded" },
  ]);

  // Reconnecting with reconnect: true restores the exact same threadId and clears disconnected state.
  st = bridgeStep(st, {
    on: "connect",
    fallbackThreadId: "fb-re",
    reconnect: true,
    bridge: {
      id: "agy-local",
      agent: "antigravity",
      label: "Antigravity",
      version: "abc123",
      grantId: "g1",
      onlyDoc: null,
      doc: "doc1",
      sessionId: null,
      cwd: null,
      connectedAt: 600,
    },
  }).state;
  expect(disconnectedBridge(st, "doc1")).toBeNull();
  expect(threadKeyFor(activeBridge(st, "doc1"), "doc1")).toBe("local:agy-local:reset-1");

  // Unbind keeps doc1 pinned as disconnected until user manually switches to an embedded model.
  st = bridgeStep(st, { on: "unbind", id: "agy-local", doc: "doc1", now: 700 }).state;
  expect(activeBridge(st, "doc1")).toBeNull();
  expect(disconnectedBridge(st, "doc1")?.threadId).toBe("reset-1");
  st = bridgeStep(st, { on: "select", doc: "doc1", choice: "sonnet" }).state;
  expect(disconnectedBridge(st, "doc1")).toBeNull();
  expect(isLocalSelected(st, "doc1")).toBe(false);
  expect(selectedThreadKey(st, "doc1")).toBe("embedded");
});

test("bridge enforces document-scoped grant onlyDoc", () => {
  const st = bridgeStep(EMPTY_BRIDGES, {
    on: "connect",
    fallbackThreadId: "t1",
    bridge: {
      id: "scoped",
      agent: "claude-code",
      label: "Claude Code",
      version: "v1",
      grantId: "g2",
      onlyDoc: "docA",
      sessionId: "s1",
      cwd: null,
      connectedAt: 10,
    },
  }).state;
  expect(activeBridge(st, "docA")?.id).toBe("scoped");
  expect(activeBridge(st, "docB")).toBeNull();
  const badBind = bridgeStep(st, { on: "bind", id: "scoped", doc: "docB", fallbackThreadId: "t2" });
  expect(badBind.ok).toBe(false);
});

// ---------------------------------------------------------------- 2. PersonAgents chat-native streaming, thread isolation & update push

test("PersonAgents streams native chat events, isolates local threads, relays permission answers, and pushes updates", async () => {
  useAssets({
    files: {},
    deps: {},
    frame: [],
    integrity: {},
    fonts: { css: "", preload: "", page: "" },
    bridge: { file: "/_erga/bridge-new999.js", version: "new999", sha256: "deadbeef", size: 1234 },
  });

  const fakePlatform = {
    agentSettings: async () => ({ missing: "no API keys configured" }),
    directory: {
      route: async (id: string) => ({ id, owner: "ada", test: false }),
      users: { isAdmin: async () => false },
    },
  } as unknown as Platform;

  const agents = new PersonAgents({ sql: sqliteChat(), platform: fakePlatform });
  const tabMsgs: Record<string, unknown>[] = [];
  const leave = agents.join(
    new Request("http://localhost:4400/api/agent/events?doc=doc1", { headers: { "x-erga-login": "ada" } }),
    (text) => tabMsgs.push(JSON.parse(text) as Record<string, unknown>)
  );

  const toBridge: Record<string, unknown>[] = [];
  const bridge = agents.joinBridge(
    { login: "ada", grantId: "g1", label: "Erga Bridge", onlyDoc: null, origin: "http://localhost:4400" },
    (text) => toBridge.push(JSON.parse(text) as Record<string, unknown>),
    () => {}
  );

  try {
    // Outdated bridge hello triggers an immediate update push.
    bridge.message(
      JSON.stringify({ type: "hello", id: "agy-1", agent: "antigravity", label: "Antigravity", version: "old111", doc: "doc1" })
    );
    expect(toBridge[0]).toEqual({ type: "update", version: "new999", sha256: "deadbeef", url: "/plugin/bridge.js" });

    bridge.message(JSON.stringify({ type: "bind", doc: "doc1", label: "Antigravity (repo)", sessionId: "conv-1" }));
    await until(() => tabMsgs.some((m) => m.type == "model" && m.thread == "local:agy-1:conv-1"));

    const st = await agents.agentState("ada", "doc1", "http://localhost:4400", "Ada");
    expect(st.enabled).toBe(true);
    if (st.enabled) {
      expect(st.choice).toBe(localChoice("agy-1"));
      expect(st.thread).toBe("local:agy-1:conv-1");
    }

    // Prompt forwarded to bridge, streamed events persisted under isolated thread scope.
    expect(await agents.agentPrompt("ada", "http://localhost:4400", "Fix intro", "Open: /ada/demo", [], "doc1", "Ada", "m1")).toEqual({
      ok: true,
    });
    expect(toBridge[1]).toMatchObject({ type: "prompt", doc: "doc1", text: "Fix intro", id: "m1" });

    bridge.message(JSON.stringify({ type: "event", doc: "doc1", ev: { t: "text", delta: "Done." } }));
    expect(tabMsgs.some((m) => m.type == "agent" && m.thread == "local:agy-1:conv-1")).toBe(true);
    expect(localScopeOf("ada", "doc1", "agy-1", "conv-1")).toBe("local:agy-1:conv-1:doc1:ada");

    // Permission answer forwarded with choice.
    expect(await agents.agentControl("ada", "doc1", "approve", "call-1", "__erga_allow_session__")).toEqual({ ok: true });
    expect(toBridge[2]).toEqual({ type: "answer", doc: "doc1", id: "call-1", approve: true, choice: "__erga_allow_session__" });

    // A new local session on the same bridgeId gets a clean empty thread.
    bridge.message(JSON.stringify({ type: "bind", doc: "doc1", label: "Antigravity (repo)", sessionId: "conv-2" }));
    await until(() => tabMsgs.some((m) => m.type == "model" && m.thread == "local:agy-1:conv-2"));
    expect((await agents.conversation("ada", "doc1")).items).toEqual([]);

    // Start a turn so busy=true, then disconnect: must stay selected (never auto-switch), clear stale busy, and reject prompts.
    expect(await agents.agentPrompt("ada", "http://localhost:4400", "Working...", null, [], "doc1", "Ada", "m2")).toEqual({ ok: true });
    expect((await agents.conversation("ada", "doc1")).busy).toBe(true);
    bridge.close();
    await until(() => tabMsgs.some((m) => m.type == "model" && m.disconnected === true));
    const after = await agents.agentState("ada", "doc1", "http://localhost:4400", "Ada");
    expect(after.enabled).toBe(true);
    if (after.enabled) {
      expect(after.choice).toBe(localChoice("agy-1"));
      expect(after.thread).toBe("local:agy-1:conv-2");
      expect("disconnected" in after && after.disconnected).toBe(true);
      expect(after.log.busy).toBe(false);
      expect(after.log.items.some((i) => i.kind == "user" && i.text == "Working...")).toBe(true);
    }
    expect(await agents.agentPrompt("ada", "http://localhost:4400", "Still there?", null, [], "doc1", "Ada", "m3")).toEqual({
      ok: false,
      reason: "Antigravity (repo) is disconnected",
    });
    expect(await agents.agentControl("ada", "doc1", "approve", "call-2")).toEqual({
      ok: false,
      reason: "Antigravity (repo) is disconnected",
    });
    leave();
  } finally {
    useAssets(null);
  }
});

// ---------------------------------------------------------------- 3. Yjs room `via` attribution

test("Yjs room WebSocket preserves via attribution for local agent edits", async () => {
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

  const agentSocket: TabSocket = { send: () => {}, close: () => {} };
  const via = VIA.token("Erga Bridge");
  const agentTab: Tab = { id: "t-agent", readOnly: false, epoch: null, person: { id: "ada", name: "Ada" }, via, events: false };
  tabs.set(agentSocket, agentTab);
  expect(participants.join(agentSocket, agentTab)).toBe(true);
  expect(participants.tabsOf("ada")).toEqual([]);

  const localDoc = new Y.Doc();
  Y.applyUpdate(localDoc, Y.encodeStateAsUpdate(room.doc));
  let updateBytes: Uint8Array | null = null;
  localDoc.on("update", (u: Uint8Array) => (updateBytes = u));
  localDoc.transact(() => files(localDoc).get("index.html")!.insert(3, "Bridge "));

  const enc = new Encoder();
  enc.writeUint(0);
  writeUpdate(enc, updateBytes!);
  await Effect.runPromise(participants.message(agentSocket, enc.toBytes()));

  expect(room.text("index.html")).toBe("<p>Bridge Hello</p>");
  const author = authors(room.doc).get(String(localDoc.clientID));
  expect(author?.kind).toBe("agent");
  expect(agentLabel(author!, null, true).label).toBe("Ada’s Erga Bridge");

  localDoc.destroy();
  await Effect.runPromise(Scope.close(scope, Effect.runSyncExit(Effect.void)));
});

// ---------------------------------------------------------------- 4. YjsDiskSync & copyIntoManaged

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
      if (url.pathname == "/d/doc1/api/start")
        return new Response(new Uint8Array(encodeStart({ type: "hello", epoch: "ep-1" }, Y.encodeStateAsUpdate(serverDoc))));
      if (url.pathname == "/d/doc1/api/room" && srv.upgrade(req)) return undefined;
      if (req.method == "PUT" && url.pathname.startsWith("/d/doc1/api/files/")) {
        uploaded.set(decodeURIComponent(url.pathname.slice("/d/doc1/api/files/".length)), new Uint8Array(await req.arrayBuffer()));
        return Response.json({ ok: true });
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
        if (d.readUint() != 0) return;
        const reply = new Encoder();
        reply.writeUint(0);
        readSyncMessage(d, reply, serverDoc, ws);
        if (reply.length > 1) ws.send(reply.toBytes());
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
  const sync = new YjsDiskSync({ origin: `http://127.0.0.1:${server.port}`, docId: "doc1", dir, token: async () => "test-token" });
  try {
    await sync.start();
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("<h1>Hello world</h1>\n<p>Keep me</p>");

    writeFileSync(join(dir, "index.html"), "<h1>Hello Erga</h1>\n<p>Keep me</p>");
    await sync.flush();
    await until(() => files(serverDoc).get("index.html")?.toString() == "<h1>Hello Erga</h1>\n<p>Keep me</p>");

    serverDoc.transact(() => {
      const t = files(serverDoc).get("index.html")!;
      t.insert(t.length, "\n<p>From browser</p>");
    }, "browser");
    await until(() => readFileSync(join(dir, "index.html"), "utf8").includes("From browser"));

    writeFileSync(join(dir, ".DS_Store"), "junk");
    writeFileSync(join(dir, "logo.png"), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    await sync.flush();
    await until(() => uploaded.has("logo.png"));
    expect(files(serverDoc).has(".DS_Store")).toBe(false);
  } finally {
    await sync.stop();
    server.stop(true);
    serverDoc.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("copyIntoManaged copies project files into managed dir, skips ignored dirs, and leaves source untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "erga-copy-managed-"));
  const src = join(root, "project");
  const dst = join(root, "managed");
  mkdirSync(join(src, "styles"), { recursive: true });
  mkdirSync(join(src, ".git"), { recursive: true });
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(src, "index.html"), "<h1>From Local Project</h1>");
  writeFileSync(join(src, "styles/main.css"), "body { color: navy; }");
  writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main");
  try {
    await copyIntoManaged(src, dst);
    expect(readFileSync(join(dst, "index.html"), "utf8")).toBe("<h1>From Local Project</h1>");
    expect(readFileSync(join(dst, "styles/main.css"), "utf8")).toBe("body { color: navy; }");
    expect(existsSync(join(dst, ".git"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 5. ErgaDaemon end-to-end: ACP connect, turn-safe update, bindings.json restore

test("ErgaDaemon connects ACP agents, defers updates during active turns, and restores sessions from bindings.json", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.transact(() => {
    roomInfo(serverDoc).set("epoch", "ep-1");
    const t = new Y.Text();
    t.insert(0, "<h1>Initial</h1>");
    files(serverDoc).set("index.html", t);
  });

  const v2Bytes = new TextEncoder().encode("console.log('bridge-v2');\n");
  const v2Sha = sha256Hex(v2Bytes);
  const fromBridge: Record<string, unknown>[] = [];
  let bridgeWs: Bun.ServerWebSocket<{ path: string }> | null = null;
  const server = Bun.serve<{ path: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname == "/d/doc1/api/doc") return Response.json({ docName: { id: "doc1", owner: "ada", slug: "demo", title: "Demo" } });
      if (url.pathname == "/d/doc1/api/start") {
        return new Response(new Uint8Array(encodeStart({ type: "hello", epoch: "ep-1" }, Y.encodeStateAsUpdate(serverDoc))));
      }
      if (url.pathname == "/plugin/bridge.js") return new Response(new Uint8Array(v2Bytes));
      if (url.pathname == "/d/doc1/api/room" || url.pathname == "/api/agent/bridge") {
        if (srv.upgrade(req, { data: { path: url.pathname } })) return undefined;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.path == "/api/agent/bridge") return void (bridgeWs = ws);
        const e = new Encoder();
        e.writeUint(0);
        writeSyncStep1(e, serverDoc);
        ws.send(e.toBytes());
      },
      message(ws, data) {
        if (typeof data == "string") {
          if (ws.data.path == "/api/agent/bridge" && data.startsWith("{")) fromBridge.push(JSON.parse(data) as Record<string, unknown>);
          return;
        }
        const d = new Decoder(new Uint8Array(data));
        if (d.readUint() != 0) return;
        const reply = new Encoder();
        reply.writeUint(0);
        readSyncMessage(d, reply, serverDoc, ws);
        if (reply.length > 1) ws.send(reply.toBytes());
      },
    },
  });

  const root = mkdtempSync("/tmp/erga-daemon-e2e-");
  const home = join(root, "home");
  const prevHome = process.env.ERGA_HOME;
  const prevToken = process.env.ERGA_TOKEN;
  process.env.ERGA_HOME = home;
  delete process.env.ERGA_TOKEN;

  const origin = `http://127.0.0.1:${server.port}`;
  saveToken({ origin, clientName: "Erga Bridge", clientId: "c1", accessToken: "tok", expiresAt: Date.now() + 60_000 });
  writePinnedOrigin(origin, home);

  const openedHandles: FakeAcpHandle[] = [];
  const driverFactory = (): AgentDriver => ({
    id: "antigravity",
    label: "Antigravity",
    async open(opts) {
      const h = new FakeAcpHandle(opts.resumeId ?? `sess-${openedHandles.length + 1}`, opts);
      openedHandles.push(h);
      return h;
    },
  });

  const restarts: string[] = [];
  const daemon = new ErgaDaemon({
    version: "v1",
    home,
    defaultOrigin: origin,
    selfCmd: { command: "bun", prefix: ["bridge.js"] },
    driverFactory,
    onRestart: (v) => restarts.push(v),
  });

  try {
    await daemon.start();
    const connected = await daemon.connectAgent({ origin, document: "/d/doc1", agent: "antigravity" });
    expect(connected.ok).toBe(true);
    expect(openedHandles[0].opts.mcpServers?.[0]?.name).toBe("erga");
    await until(() => bridgeWs != null && fromBridge.some((m) => m.type == "bind" && m.doc == "doc1"));

    // Start a held turn, then send a server update offer mid-turn: must defer until turn_done!
    bridgeWs!.send(JSON.stringify({ type: "prompt", doc: "doc1", text: "HOLD please", context: null }));
    await until(() => daemon.status().activeTurns == 1);

    bridgeWs!.send(JSON.stringify({ type: "update", version: "v2", sha256: v2Sha, url: "/plugin/bridge.js" }));
    await until(() => daemon.status().updateState.at == "pending_restart");
    expect(restarts).toEqual([]);

    // Finish the turn -> turn_done fires and triggers deferred restart!
    openedHandles[0].releaseHeldTurn();
    await until(() => restarts.length == 1 && fromBridge.some((m) => m.type == "turn_done" && m.doc == "doc1"));
    expect(restarts).toEqual(["v2"]);

    // Restarting daemon restores mounts and resumes ACP session via resumeId with reconnect: true!
    await daemon.stop();
    fromBridge.length = 0;
    const daemon2 = new ErgaDaemon({ version: "v2", home, defaultOrigin: origin, driverFactory });
    try {
      await daemon2.start();
      expect(daemon2.status().mounts.map((m) => m.docId)).toEqual(["doc1"]);
      expect(daemon2.status().connections.length).toBe(1);
      expect(openedHandles[1].opts.resumeId).toBe("sess-1");
      await until(() => fromBridge.some((m) => m.type == "hello" && m.reconnect == true));
    } finally {
      await daemon2.stop();
    }
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

test("ErgaDaemon.openDocument with nonBlockingAuth returns device-code URL and saves token in background when approved", async () => {
  let approved = false;
  let deviceCalls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname == "/.well-known/oauth-authorization-server") {
        return Response.json({
          authorization_endpoint: `${url.origin}/oauth/authorize`,
          device_authorization_endpoint: `${url.origin}/oauth/device_authorization`,
          token_endpoint: `${url.origin}/oauth/token`,
          registration_endpoint: `${url.origin}/oauth/register`,
        });
      }
      if (url.pathname == "/oauth/device_authorization") {
        deviceCalls++;
        return Response.json({
          device_code: "dev-secret-1",
          user_code: "BCDF-GHJK",
          verification_uri: `${url.origin}/oauth/device`,
          verification_uri_complete: `${url.origin}/oauth/device?user_code=BCDF-GHJK`,
          expires_in: 600,
          interval: 1,
        });
      }
      if (url.pathname == "/oauth/device_authorization/poll") {
        if (!approved) return Response.json({ error: "authorization_pending" }, { status: 400 });
        return Response.json({ code: "signed-code-1", redirect_uri: `${url.origin}/oauth/device/done` });
      }
      if (url.pathname == "/oauth/token") {
        const body = new URLSearchParams(await req.text());
        if (body.get("code") == "signed-code-1" && body.get("code_verifier")) {
          return Response.json({ access_token: "tok-from-device", refresh_token: "ref-1", expires_in: 3600 });
        }
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const root = mkdtempSync(join(tmpdir(), "erga-daemon-device-"));
  const prevHome = process.env.ERGA_HOME;
  const prevToken = process.env.ERGA_TOKEN;
  process.env.ERGA_HOME = root;
  delete process.env.ERGA_TOKEN;

  const origin = `http://127.0.0.1:${server.port}`;
  const daemon = new ErgaDaemon({ home: root });

  try {
    const first = await daemon.openDocument({ origin, document: "/d/doc1", nonBlockingAuth: true });
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.needsAuth).toBe(true);
      expect(first.userCode).toBe("BCDF-GHJK");
    }
    await daemon.openDocument({ origin, document: "/d/doc1", nonBlockingAuth: true });
    expect(deviceCalls).toBe(1);

    approved = true;
    await until(() => cachedToken(origin, "Erga Bridge")?.accessToken == "tok-from-device");
  } finally {
    await daemon.stop();
    if (prevHome === undefined) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = prevHome;
    if (prevToken === undefined) delete process.env.ERGA_TOKEN;
    else process.env.ERGA_TOKEN = prevToken;
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

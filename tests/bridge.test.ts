// Unit tests for the local terminal-first Erga bridge:
// - Pure bridge registry state machine (agents/person/bridge.ts): single terminal & whole space
// - PersonAgents terminal relay, space terminal switching, OSC 7501 updates, update push, and edit access on turn_done
// - Yjs room `via` attribution on agent WebSockets
// - YjsDiskSync bidirectional CRDT <-> filesystem sync
// - copyIntoManaged + ErgaDaemon open/space/PTY relay/persistence/device-code auth

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Y from "yjs";
import { activeBridge, bridgeStep, EMPTY_BRIDGES, localBridgeView, panelOptions } from "../agents/person/bridge.ts";
import { PersonAgents } from "../agents/person/sessions.ts";
import type { ChatSql } from "../agents/chat-store.ts";
import { cachedToken, saveToken } from "../bridge/core/auth.ts";
import type { BackendEvent, PtyAttachment, TerminalBackend } from "../bridge/core/backend.ts";
import { ErgaDaemon } from "../bridge/core/daemon.ts";
import { copyIntoManaged } from "../bridge/core/daemon-io.ts";
import { YjsDiskSync } from "../bridge/core/yjs-sync.ts";
import { authors, files, roomInfo } from "../document/model/content.ts";
import { Participants, type Tab, type TabSocket } from "../document/room/participants.ts";
import { Room } from "../document/room/room.ts";
import { FileStore, StateStore } from "../document/store/storage.ts";
import { useAssets } from "../server/pages/index.ts";
import type { Platform } from "../server/platform.ts";
import { agentLabel, VIA } from "../shared/attribution.ts";
import { localChoice, type TerminalSummary } from "../shared/bridge-protocol.ts";
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

function createMockBackend(initial: TerminalSummary[] = []): TerminalBackend & {
  emit(ev: BackendEvent): void;
  setTerminals(list: TerminalSummary[]): void;
  inputs: Array<{ terminal: string; text: string }>;
  resizes: Array<{ terminal: string; cols: number; rows: number }>;
  sent: Array<{ terminal: string; text: string }>;
  interrupted: string[];
  stateStore: Map<string, unknown>;
} {
  let list: TerminalSummary[] = initial.length
    ? [...initial]
    : [
        { id: "t1", label: "agy · t1", app: "antigravity", state: "live", status: { state: "idle", app: "antigravity" }, turn: 0 },
        { id: "t2", label: "claude · t2", app: "claude", state: "live", status: { state: "done", app: "claude" }, turn: 1, parent: "t1" },
      ];
  const listeners = new Set<(ev: BackendEvent) => void>();
  const inputs: Array<{ terminal: string; text: string }> = [];
  const resizes: Array<{ terminal: string; cols: number; rows: number }> = [];
  const sent: Array<{ terminal: string; text: string }> = [];
  const interrupted: string[] = [];
  const stateStore = new Map<string, unknown>();

  return {
    id: "herdr-core",
    label: "herdr-core",
    inputs,
    resizes,
    sent,
    interrupted,
    stateStore,
    emit(ev) {
      for (const fn of listeners) fn(ev);
    },
    setTerminals(next) {
      list = [...next];
    },
    connect: async () => ({ version: "0.1.22" }),
    close: async () => {},
    listTerminals: async () => [...list],
    listSpaces: async () => [{ id: "sp1", name: "Erga Space", folder: "/repo", terminals: [...list] }],
    resolveTarget: async (opts) => {
      if (opts.terminal) {
        const hit = list.find((t) => t.id == opts.terminal) ?? list[0];
        return { scope: "single", spaceId: null, spaceName: null, terminals: hit ? [hit] : [], activeTerminal: hit?.id ?? null };
      }
      if (opts.space) {
        return { scope: "space", spaceId: "sp1", spaceName: "Erga Space", terminals: [...list], activeTerminal: list[0]?.id ?? null };
      }
      return { scope: "single", spaceId: null, spaceName: null, terminals: list[0] ? [list[0]] : [], activeTerminal: list[0]?.id ?? null };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async attach(terminalId, _size, onData): Promise<PtyAttachment> {
      onData(new TextEncoder().encode(`ATTACHED:${terminalId}\r\n`));
      return {
        terminalId,
        write: (bytes) => {
          const text = new TextDecoder().decode(bytes);
          inputs.push({ terminal: terminalId, text });
          onData(new TextEncoder().encode(`ECHO:${text}`));
        },
        resize: (cols, rows) => resizes.push({ terminal: terminalId, cols, rows }),
        close: () => {},
      };
    },
    send: async (terminal, text) => void sent.push({ terminal, text }),
    interrupt: async (terminal) => void interrupted.push(terminal),
    spawn: async () => list[0],
    getState: async <T>(key: string) => (stateStore.get(key) as T | undefined) ?? null,
    setState: async <T>(key: string, val: T) => void stateStore.set(key, val),
  };
}

// ---------------------------------------------------------------- 1. Bridge state machine

test("bridge state machine manages single terminal and whole-space bindings, terminal swaps, and embedded fallback", () => {
  const embedded = [{ id: "sonnet", label: "Claude Sonnet", key: "server" as const }];
  let st = EMPTY_BRIDGES;
  expect(activeBridge(st, "doc1")).toBeNull();
  expect(localBridgeView(st, "doc1")).toBeNull();
  expect(panelOptions(st, "doc1", embedded)).toEqual([{ id: "sonnet", label: "Claude Sonnet", key: "server" }]);

  const c1 = bridgeStep(st, {
    on: "connect",
    bridge: {
      id: "hc-mac",
      backend: "herdr-core",
      label: "herdr-core",
      version: "abc123",
      grantId: "g1",
      onlyDoc: null,
      connectedAt: 100,
    },
  });
  st = c1.state;
  expect(c1.notify).toEqual(["*"]);
  expect(activeBridge(st, "doc1")?.id).toBe("hc-mac");
  expect(panelOptions(st, "doc1", embedded)).toEqual([
    { id: "local:hc-mac", label: "herdr-core", group: "local", agent: "herdr-core" },
    { id: "sonnet", label: "Claude Sonnet", key: "server", group: "embedded" },
  ]);

  // Explicit switch to embedded pins doc1 to embedded while doc2 stays on the global bridge.
  st = bridgeStep(st, { on: "select", doc: "doc1", choice: "sonnet" }).state;
  expect(activeBridge(st, "doc1")).toBeNull();
  expect(activeBridge(st, "doc2")?.id).toBe("hc-mac");

  const terms: TerminalSummary[] = [
    { id: "t1", label: "agy · t1", app: "antigravity", state: "live", status: { state: "idle" }, turn: 0 },
    { id: "t2", label: "claude · t2", app: "claude", state: "live", status: { state: "working" }, turn: 1 },
  ];
  const b1 = bridgeStep(st, {
    on: "bind",
    id: "hc-mac",
    doc: "doc1",
    label: "Erga Space",
    scope: "space",
    spaceId: "sp1",
    spaceName: "Erga Space",
    terminals: terms,
    activeTerminal: "t1",
  });
  st = b1.state;
  expect(b1.notify).toEqual(["doc1"]);
  expect(localBridgeView(st, "doc1")).toEqual({
    bridgeId: "hc-mac",
    backend: "herdr-core",
    label: "Erga Space",
    scope: "space",
    spaceId: "sp1",
    spaceName: "Erga Space",
    terminals: terms,
    activeTerminal: "t1",
  });

  // Switch active terminal inside the bound space.
  st = bridgeStep(st, { on: "select_terminal", id: "hc-mac", doc: "doc1", terminal: "t2" }).state;
  expect(localBridgeView(st, "doc1")?.activeTerminal).toBe("t2");

  // Disconnect cleans up.
  st = bridgeStep(st, { on: "disconnect", id: "hc-mac" }).state;
  expect(activeBridge(st, "doc1")).toBeNull();
});

test("bridge enforces document-scoped grant onlyDoc", () => {
  let st = bridgeStep(EMPTY_BRIDGES, {
    on: "connect",
    bridge: {
      id: "scoped",
      backend: "herdr-core",
      label: "herdr-core",
      version: "v1",
      grantId: "g2",
      onlyDoc: "docA",
      connectedAt: 10,
    },
  }).state;
  expect(activeBridge(st, "docA")?.id).toBe("scoped");
  expect(activeBridge(st, "docB")).toBeNull();
  const badBind = bridgeStep(st, { on: "bind", id: "scoped", doc: "docB", scope: "single", terminals: [] });
  expect(badBind.ok).toBe(false);
});

// ---------------------------------------------------------------- 2. PersonAgents terminal relay & auto-update push

test("PersonAgents relays PTY attach/input/resize/select, OSC 7501 updates, and pushes update offer on outdated hello", async () => {
  useAssets({
    files: {},
    deps: {},
    frame: [],
    integrity: {},
    fonts: { css: "", preload: "", page: "" },
    bridge: { file: "/_erga/bridge-new999.js", version: "new999", sha256: "deadbeef", size: 1234, minHcVersion: "0.1.20" },
  });

  const fakePlatform = {
    agentSettings: async () => ({ missing: "no API keys configured" }),
    directory: {
      route: async (id: string) => ({ id, owner: "pete", test: false }),
      users: { isAdmin: async () => false },
    },
  } as unknown as Platform;

  const agents = new PersonAgents({ sql: sqliteChat(), platform: fakePlatform });
  const tabMsgs: Record<string, unknown>[] = [];
  const tab = agents.join(new Request("http://localhost:4400/api/agent/events?doc=doc1", { headers: { "x-erga-login": "pete" } }), (text) =>
    tabMsgs.push(JSON.parse(text) as Record<string, unknown>)
  );

  const toBridge: Record<string, unknown>[] = [];
  const bridge = agents.joinBridge(
    { login: "pete", grantId: "g1", label: "Erga Bridge", onlyDoc: null, origin: "http://localhost:4400" },
    (text) => toBridge.push(JSON.parse(text) as Record<string, unknown>),
    () => {}
  );

  try {
    // Outdated bridge hello triggers an immediate update push.
    bridge.message(
      JSON.stringify({ type: "hello", id: "hc-1", backend: "herdr-core", label: "herdr-core", version: "old111", doc: "doc1" })
    );
    expect(toBridge[0]).toEqual({
      type: "update",
      version: "new999",
      sha256: "deadbeef",
      url: "/plugin/bridge.js",
      minHcVersion: "0.1.20",
    });

    const terms: TerminalSummary[] = [
      { id: "t1", label: "agy · t1", app: "antigravity", state: "live", status: { state: "idle" }, turn: 0 },
      { id: "t2", label: "claude · t2", app: "claude", state: "live", status: { state: "working" }, turn: 1 },
    ];
    bridge.message(
      JSON.stringify({
        type: "bind",
        doc: "doc1",
        label: "Erga Space",
        scope: "space",
        spaceId: "sp1",
        spaceName: "Erga Space",
        terminals: terms,
        activeTerminal: "t1",
      })
    );

    await until(() => tabMsgs.some((m) => m.type == "model" && m.enabled == true));
    const st = await agents.agentState("pete", "doc1", "http://localhost:4400", "Pete");
    expect(st.enabled).toBe(true);
    if (st.enabled) {
      expect(st.choice).toBe(localChoice("hc-1"));
      expect(st.local?.scope).toBe("space");
      expect(st.local?.terminals.length).toBe(2);
    }

    // Browser attaches, types, resizes, switches terminal -> forwarded straight to bridge.
    tab.message(JSON.stringify({ type: "pty_attach", terminal: "t1", cols: 80, rows: 24 }));
    tab.message(JSON.stringify({ type: "pty_input", terminal: "t1", data: Buffer.from("hi\r").toString("base64") }));
    tab.message(JSON.stringify({ type: "pty_resize", terminal: "t1", cols: 100, rows: 30 }));
    tab.message(JSON.stringify({ type: "pty_attach", terminal: "t2", cols: 100, rows: 30 }));

    expect(toBridge.slice(1)).toEqual([
      { type: "pty_attach", doc: "doc1", terminal: "t1", cols: 80, rows: 24 },
      { type: "pty_input", doc: "doc1", terminal: "t1", data: Buffer.from("hi\r").toString("base64") },
      { type: "pty_resize", doc: "doc1", terminal: "t1", cols: 100, rows: 30 },
      { type: "pty_detach", doc: "doc1", terminal: "t1" },
      { type: "pty_attach", doc: "doc1", terminal: "t2", cols: 100, rows: 30 },
    ]);

    // Bridge streams PTY bytes and OSC 7501 status updates back to browser tab.
    bridge.message(JSON.stringify({ type: "pty_data", doc: "doc1", terminal: "t2", data: Buffer.from("OUTPUT").toString("base64") }));
    expect(tabMsgs.some((m) => m.type == "pty_data" && m.terminal == "t2")).toBe(true);

    bridge.message(
      JSON.stringify({
        type: "terminals",
        doc: "doc1",
        terminals: [terms[0], { ...terms[1], status: { state: "blocked", kind: "permission", msg: "Allow?" } }],
      })
    );
    expect(tabMsgs.some((m) => m.type == "bridge_state")).toBe(true);

    // Closing browser tab sends pty_detach for the watched terminal.
    tab.close();
    expect(toBridge.at(-1)).toEqual({ type: "pty_detach", doc: "doc1", terminal: "t2" });

    bridge.close();
    const after = await agents.agentState("pete", "doc1", "http://localhost:4400", "Pete");
    expect(after.enabled).toBe(false);
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
  const agentTab: Tab = { id: "t-agent", readOnly: false, epoch: null, person: { id: "pete", name: "Pete" }, via, events: false };
  tabs.set(agentSocket, agentTab);
  expect(participants.join(agentSocket, agentTab)).toBe(true);
  expect(participants.tabsOf("pete")).toEqual([]);

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
  expect(agentLabel(author!, null, true).label).toBe("Pete’s Erga Bridge");

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

// ---------------------------------------------------------------- 5. ErgaDaemon end-to-end with TerminalBackend

test("ErgaDaemon binds whole space, relays PTY + OSC 7501 turn_done, copies fromDir, and restores bindings on restart", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.transact(() => {
    roomInfo(serverDoc).set("epoch", "ep-1");
    const t = new Y.Text();
    t.insert(0, "<h1>Initial</h1>");
    files(serverDoc).set("index.html", t);
  });

  const fromBridge: Record<string, unknown>[] = [];
  let bridgeWs: Bun.ServerWebSocket<{ path: string }> | null = null;
  const server = Bun.serve<{ path: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname == "/d/doc1/api/doc") return Response.json({ docName: { id: "doc1", owner: "pete", slug: "demo", title: "Demo" } });
      if (url.pathname == "/d/doc1/api/start") {
        return new Response(new Uint8Array(encodeStart({ type: "hello", epoch: "ep-1" }, Y.encodeStateAsUpdate(serverDoc))));
      }
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
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "notes.html"), "<p>Copied later</p>");

  const prevHome = process.env.ERGA_HOME;
  const prevToken = process.env.ERGA_TOKEN;
  process.env.ERGA_HOME = home;
  delete process.env.ERGA_TOKEN;

  const origin = `http://127.0.0.1:${server.port}`;
  saveToken({ origin, clientName: "Erga Bridge", clientId: "c1", accessToken: "tok", expiresAt: Date.now() + 60_000 });
  const backend = createMockBackend();
  const daemon = new ErgaDaemon(backend, { defaultOrigin: origin });

  try {
    await daemon.start();
    const opened = await daemon.openDocument({ origin, document: "/d/doc1", space: true, fromDir: src });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.scope).toBe("space");
      expect(opened.terminals.map((t) => t.id)).toEqual(["t1", "t2"]);
      expect(opened.copiedFrom).toBe(src);
    }
    await until(() => files(serverDoc).get("notes.html")?.toString() == "<p>Copied later</p>");
    await until(() => bridgeWs != null && fromBridge.some((m) => m.type == "bind"));

    // PTY attach + input + resize round-trip.
    bridgeWs!.send(JSON.stringify({ type: "pty_attach", doc: "doc1", terminal: "t2", cols: 80, rows: 24 }));
    await until(() => fromBridge.some((m) => m.type == "pty_data" && m.terminal == "t2"));
    bridgeWs!.send(JSON.stringify({ type: "pty_input", doc: "doc1", terminal: "t2", data: Buffer.from("y\r").toString("base64") }));
    bridgeWs!.send(JSON.stringify({ type: "pty_resize", doc: "doc1", terminal: "t2", cols: 110, rows: 32 }));
    await until(() => backend.inputs.some((i) => i.terminal == "t2" && i.text == "y\r") && backend.resizes.some((r) => r.cols == 110));

    // OSC 7501 status update & turn_done propagate from backend -> Erga.
    backend.emit({
      type: "terminal_changed",
      terminal: { id: "t2", label: "claude · t2", app: "claude", state: "live", status: { state: "blocked", kind: "permission" }, turn: 1 },
    });
    backend.emit({ type: "turn_done", terminalId: "t2", turn: 2 });
    await until(() => fromBridge.some((m) => m.type == "terminals") && fromBridge.some((m) => m.type == "turn_done" && m.doc == "doc1"));

    // Restarting daemon restores persisted bindings automatically from backend state!
    await daemon.stop();
    fromBridge.length = 0;
    const daemon2 = new ErgaDaemon(backend, { defaultOrigin: origin });
    try {
      await daemon2.start();
      expect(daemon2.status().mounts.map((m) => [m.docId, m.scope])).toEqual([["doc1", "space"]]);
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
  const daemon = new ErgaDaemon(createMockBackend());

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

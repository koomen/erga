import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { ChatSql } from "../agents/chat-store.ts";
import { activeBridge, bridgeStep, EMPTY_BRIDGES, panelOptions } from "../agents/person/bridge.ts";
import { PersonAgents } from "../agents/person/sessions.ts";
import { defaultOrigin, login, saveToken } from "../bridge/core/auth.ts";
import { ErgaBridgeClient } from "../bridge/core/bridge-client.ts";
import { ErgaDaemon } from "../bridge/core/daemon.ts";
import { daemonSocketPath } from "../bridge/core/daemon-io.ts";
import type { AgentDriver, AgentHandle, DriverEvent } from "../bridge/core/driver.ts";
import { findSession, recordSession } from "../bridge/core/sessions.ts";
import { YjsDiskSync } from "../bridge/core/yjs-sync.ts";
import { createAcpDriver } from "../bridge/drivers/acp.ts";
import { checkLiveAntigravityState, type LiveAntigravitySession } from "../bridge/drivers/antigravity.ts";
import { assets, files, roomInfo } from "../document/model/content.ts";
import { digest } from "../document/room/room.ts";
import type { Platform } from "../server/platform.ts";
import { encodeStart } from "../shared/room-socket.ts";
import { Decoder, Encoder, readSyncMessage, writeSyncStep1, writeUpdate } from "../shared/yjs-protocol.ts";

async function until(fn: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (; Date.now() < deadline && !fn(); ) await new Promise((r) => setTimeout(r, 15));
  if (!fn()) throw new Error("Timed out waiting for condition");
}

function sqliteChat(): ChatSql {
  const db = new Database(":memory:");
  return {
    exec: <T>(query: string, ...params: (string | number | null)[]) => db.query(query).all(...params) as T[],
    transaction: <R>(f: () => R) => db.transaction(f)(),
  };
}

// ---------------------------------------------------------------- 1 & 2 & 11. YjsDiskSync

test("YjsDiskSync matches Erga's 16-char SHA-1 asset digest without upload/download loops", async () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const localBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
  const stored = new Map<string, Uint8Array>([["logo.png", pngBytes]]);
  const gets: string[] = [];
  const puts: string[] = [];

  const serverDoc = new Y.Doc();
  serverDoc.transact(() => {
    roomInfo(serverDoc).set("epoch", "ep-1");
    const t = new Y.Text();
    t.insert(0, "<p>ok</p>");
    files(serverDoc).set("index.html", t);
    assets(serverDoc).set("logo.png", digest(pngBytes));
  });

  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  serverDoc.on("update", (u, origin) => {
    const e = new Encoder();
    e.writeUint(0);
    writeUpdate(e, u);
    const frame = e.toBytes();
    for (const s of sockets) if (s !== origin) s.send(frame);
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname == "/d/doc1/api/start") {
        return new Response(new Uint8Array(encodeStart({ type: "hello", epoch: "ep-1" }, Y.encodeStateAsUpdate(serverDoc))));
      }
      if (url.pathname == "/d/doc1/api/room") {
        if (srv.upgrade(req, { data: undefined })) return undefined;
      }
      if (url.pathname.startsWith("/d/doc1/doc/") && req.method == "GET") {
        const p = decodeURIComponent(url.pathname.slice("/d/doc1/doc/".length));
        gets.push(p);
        const b = stored.get(p);
        return b ? new Response(new Uint8Array(b)) : new Response("missing", { status: 404 });
      }
      if (url.pathname.startsWith("/d/doc1/api/files/") && req.method == "PUT") {
        const p = decodeURIComponent(url.pathname.slice("/d/doc1/api/files/".length));
        const b = new Uint8Array(await req.arrayBuffer());
        puts.push(p);
        stored.set(p, b);
        serverDoc.transact(() => assets(serverDoc).set(p, digest(b)));
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
      close(ws) {
        sockets.delete(ws);
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
    },
  });

  const dir = mkdtempSync(join(tmpdir(), "erga-asset-sync-"));
  const sync = new YjsDiskSync({
    origin: `http://127.0.0.1:${server.port}`,
    docId: "doc1",
    dir,
    token: async () => "tok",
  });
  try {
    await sync.start();
    expect(new Uint8Array(readFileSync(join(dir, "logo.png")))).toEqual(pngBytes);
    expect(gets).toEqual(["logo.png"]);

    // Flushing after downloading a remote asset must NOT re-upload it.
    await sync.flush();
    expect(puts).toEqual([]);

    // Uploading a new local binary asset must upload once and NOT re-download when server sets assets(doc).
    writeFileSync(join(dir, "banner.png"), localBytes);
    await sync.flush();
    await until(() => assets(sync.doc).get("banner.png") == digest(localBytes));
    await sync.flush();
    expect(puts).toEqual(["banner.png"]);
    expect(gets).toEqual(["logo.png"]);
  } finally {
    await sync.stop();
    server.stop(true);
    serverDoc.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("YjsDiskSync writes merged text back to disk after concurrent remote and local edits, and preserves new local files across epoch reset", async () => {
  let epoch = "ep-1";
  let serverDoc = new Y.Doc();
  serverDoc.transact(() => {
    roomInfo(serverDoc).set("epoch", epoch);
    const t = new Y.Text();
    t.insert(0, "alpha\nbeta\ngamma\n");
    files(serverDoc).set("index.html", t);
  });

  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname == "/d/doc1/api/start") {
        return new Response(new Uint8Array(encodeStart({ type: "hello", epoch }, Y.encodeStateAsUpdate(serverDoc))));
      }
      if (url.pathname == "/d/doc1/api/room") {
        if (srv.upgrade(req, { data: undefined })) return undefined;
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
      close(ws) {
        sockets.delete(ws);
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
    },
  });

  const dir = mkdtempSync(join(tmpdir(), "erga-merge-epoch-"));
  const sync = new YjsDiskSync({
    origin: `http://127.0.0.1:${server.port}`,
    docId: "doc1",
    dir,
    token: async () => "tok",
  });
  try {
    await sync.start();

    // Concurrent edit: disk edits line 3 while Yjs concurrently received a remote edit on line 1 before diskBase updates.
    writeFileSync(join(dir, "index.html"), "alpha\nbeta\nGAMMA\n");
    const flushDone = sync.flush();
    sync.doc.transact(() => {
      const t = files(sync.doc).get("index.html")!;
      t.delete(0, 5);
      t.insert(0, "ALPHA");
    }, "concurrent-remote");
    await flushDone;

    // Immediately after applyDiskChanges completes, both Yjs AND disk must hold the merged result.
    expect(files(sync.doc).get("index.html")?.toString()).toBe("ALPHA\nbeta\nGAMMA\n");
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("ALPHA\nbeta\nGAMMA\n");

    // Epoch reset (4409): a newly created local file not present in the fresh epoch must survive on disk and sync to the new room.
    writeFileSync(join(dir, "draft.md"), "# Keep me\n");
    await sync.flush();
    expect(files(sync.doc).get("draft.md")?.toString()).toBe("# Keep me\n");

    const oldServerDoc = serverDoc;
    epoch = "ep-2";
    serverDoc = new Y.Doc();
    serverDoc.transact(() => {
      roomInfo(serverDoc).set("epoch", epoch);
      const t = new Y.Text();
      t.insert(0, "ALPHA\nbeta\nGAMMA\n");
      files(serverDoc).set("index.html", t);
    });
    for (const s of [...sockets]) s.close(4409, "stale epoch");
    oldServerDoc.destroy();

    await until(() => files(serverDoc).get("draft.md")?.toString() == "# Keep me\n");
    expect(readFileSync(join(dir, "draft.md"), "utf8")).toBe("# Keep me\n");
  } finally {
    await sync.stop();
    server.stop(true);
    serverDoc.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 3, 5 & 10. PersonAgents & Bridge reconnect

test("PersonAgents removes dead bridges on send failure and enforces edit access on turn_done", async () => {
  const docCalls: Array<{ id: string; url: string }> = [];
  const roles = new Map<string, "owner" | "editor" | "viewer" | null>([
    ["doc-edit", "editor"],
    ["doc-view", "viewer"],
    ["doc-none", null],
  ]);

  const fakePlatform = {
    agentSettings: async () => ({ missing: "no API keys" }),
    directory: {
      route: async (id: string) => ({ id, owner: "pete", test: false }),
      openAs: async (_who: unknown, _owner: string, id: string) =>
        roles.has(id) ? { doc: { id, owner: "pete", test: false }, role: roles.get(id)! } : null,
      users: { isAdmin: async () => false },
    },
    docs: {
      fetch: async (doc: { id: string }, req: Request) => {
        docCalls.push({ id: doc.id, url: new URL(req.url).pathname });
        return new Response("ok");
      },
    },
  } as unknown as Platform;

  const agents = new PersonAgents({ sql: sqliteChat(), platform: fakePlatform });
  const tabMsgs: Record<string, unknown>[] = [];
  const leave = agents.join(
    new Request("http://localhost:4400/api/agent/events?doc=doc-edit", { headers: { "x-erga-login": "pete" } }),
    (text) => tabMsgs.push(JSON.parse(text) as Record<string, unknown>)
  );

  let failSend = false;
  let closed = false;
  const bridge = agents.joinBridge(
    { login: "pete", grantId: "g1", label: "Antigravity", onlyDoc: null, origin: "http://localhost:4400" },
    () => {
      if (failSend) throw new Error("socket closed");
    },
    () => {
      closed = true;
    }
  );

  try {
    bridge.message(JSON.stringify({ type: "hello", id: "agy-1", agent: "antigravity", label: "Antigravity" }));
    await until(() => tabMsgs.some((m) => m.type == "model" && m.enabled == true));

    // turn_done must only fire /api/turn-done for documents where info.login has edit access.
    bridge.message(JSON.stringify({ type: "turn_done", doc: "doc-view" }));
    bridge.message(JSON.stringify({ type: "turn_done", doc: "doc-none" }));
    bridge.message(JSON.stringify({ type: "turn_done", doc: "doc-edit" }));
    await until(() => docCalls.length == 1);
    expect(docCalls).toEqual([{ id: "doc-edit", url: "/api/turn-done" }]);

    // Send error on a dead socket must disconnect the bridge, clear it from dropdown state, and notify panels.
    tabMsgs.length = 0;
    failSend = true;
    const res = await agents.agentPrompt("pete", "http://localhost:4400", "Hi", null, [], "doc-edit", "Pete", "m1");
    expect(res.ok).toBe(false);
    expect(closed).toBe(true);
    await until(() => tabMsgs.some((m) => m.type == "model" && m.enabled == false));
    const after = await agents.agentState("pete", "doc-edit", "http://localhost:4400", "Pete");
    expect(after.enabled).toBe(false);
  } finally {
    leave();
  }
});

test("bridge reconnect preserves explicit switch to an embedded model", async () => {
  let st = bridgeStep(EMPTY_BRIDGES, {
    on: "connect",
    bridge: {
      id: "agy-1",
      agent: "antigravity",
      label: "Antigravity",
      grantId: "g1",
      onlyDoc: null,
      sessionId: null,
      cwd: null,
      connectedAt: 1,
    },
  }).state;
  st = bridgeStep(st, { on: "bind", id: "agy-1", doc: "doc1" }).state;
  expect(activeBridge(st, "doc1")?.id).toBe("agy-1");

  // User explicitly picks an embedded model on doc1.
  st = bridgeStep(st, { on: "select", doc: "doc1", choice: "sonnet" }).state;
  expect(activeBridge(st, "doc1")).toBeNull();

  // Transient disconnect + reconnect (hello + replayed bind with reconnect: true) must NOT override embedded pick.
  st = bridgeStep(st, { on: "disconnect", id: "agy-1" }).state;
  st = bridgeStep(st, {
    on: "connect",
    reconnect: true,
    bridge: {
      id: "agy-1",
      agent: "antigravity",
      label: "Antigravity",
      grantId: "g1",
      onlyDoc: null,
      sessionId: null,
      cwd: null,
      connectedAt: 2,
    },
  }).state;
  st = bridgeStep(st, { on: "bind", id: "agy-1", doc: "doc1", reconnect: true }).state;
  expect(activeBridge(st, "doc1")).toBeNull();
  expect(panelOptions(st, "doc1", [{ id: "sonnet", label: "Sonnet" }]).map((o) => o.id)).toEqual(["local:agy-1", "sonnet"]);

  // Explicit new bind (without reconnect) switches back to the local bridge.
  st = bridgeStep(st, { on: "bind", id: "agy-1", doc: "doc1" }).state;
  expect(activeBridge(st, "doc1")?.id).toBe("agy-1");

  // Verify ErgaBridgeClient sets reconnect: true only on subsequent opens.
  const received: Record<string, unknown>[] = [];
  let opens = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname == "/api/agent/bridge" && srv.upgrade(req, { data: undefined })) return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open() {
        opens++;
      },
      message(ws, data) {
        const s = String(data);
        if (!s.startsWith("{")) return;
        const parsed = JSON.parse(s) as Record<string, unknown>;
        received.push(parsed);
        if (opens == 1 && parsed.type == "bind") ws.close(1011, "drop");
      },
    },
  });
  const client = new ErgaBridgeClient({
    origin: `http://127.0.0.1:${server.port}`,
    id: "agy-1",
    agent: "antigravity",
    label: "Antigravity",
    token: async () => "tok",
    onMessage: () => {},
  });
  try {
    await client.start();
    client.bind("doc1", { label: "Antigravity (repo)" });
    await until(() => received.filter((m) => m.type == "bind").length >= 2);
    const hellos = received.filter((m) => m.type == "hello");
    const binds = received.filter((m) => m.type == "bind");
    expect(hellos[0].reconnect).toBeUndefined();
    expect(hellos[1].reconnect).toBe(true);
    expect(binds[0].reconnect).toBeUndefined();
    expect(binds[1].reconnect).toBe(true);
  } finally {
    client.stop();
    server.stop(true);
  }
});

// ---------------------------------------------------------------- 4 & 13. AcpDriver exit, meta, and init timeout

test("AcpDriver uses configurable sessionMeta, enforces initTimeoutMs, and marks handle closed on crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "erga-acp-review-"));
  const metaFile = join(dir, "meta.json");
  const script = join(dir, "mock-acp.ts");
  writeFileSync(
    script,
    `
import { writeFileSync, writeSync } from "node:fs";
const mode = process.argv[2] || "crash";
const dec = new TextDecoder();
let buf = "";
const send = (m: unknown) => writeSync(1, JSON.stringify(m) + "\\n");
const reader = Bun.stdin.stream().getReader();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method == "initialize") {
      if (mode == "hang") continue;
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    } else if (msg.method == "session/new") {
      writeFileSync(${JSON.stringify(metaFile)}, JSON.stringify(msg.params?._meta ?? null));
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-1" } });
    } else if (msg.method == "session/prompt") {
      send({
        jsonrpc: "2.0",
        id: "perm-1",
        method: "session/request_permission",
        params: { toolCall: { toolCallId: "tc-1", name: "Bash" }, options: [{ optionId: "allow", kind: "allow_once" }] },
      });
      process.exit(1);
    }
  }
}
`
  );

  try {
    // 1. Generic ACP driver sends no hardcoded antigravity _meta; custom sessionMeta is forwarded.
    const driver = createAcpDriver({
      id: "generic",
      label: "Generic",
      command: process.execPath,
      args: [script],
      sessionMeta: (o) => (o.systemPromptAppend ? { custom: o.systemPromptAppend } : undefined),
    });
    const handle = await driver.open({ cwd: dir, systemPromptAppend: "Be brief" });
    expect(JSON.parse(readFileSync(metaFile, "utf8"))).toEqual({ custom: "Be brief" });

    const evs: DriverEvent[] = [];
    let closedFired = false;
    handle.onEvent((e) => evs.push(e));
    handle.onClose?.(() => (closedFired = true));

    await handle.prompt({ text: "boom" });
    await until(() => closedFired);
    expect(handle.closed).toBe(true);
    expect(evs.some((e) => e.t == "tool" && e.id == "tc-1" && e.status == "error")).toBe(true);
    expect(await handle.answer("tc-1", true)).toBe(false);

    // 2. Startup timeout rejects promptly on a hung initialize.
    const hung = createAcpDriver({ id: "hung", label: "Hung", command: process.execPath, args: [script, "hang"], initTimeoutMs: 120 });
    await expect(hung.open({ cwd: dir })).rejects.toThrow(/timed out/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 4, 6 & 9. Daemon concurrency, eviction & socket perms

test("ErgaDaemon deduplicates mounts/threads, serializes prompts, evicts closed handles, and restricts socket permissions", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.transact(() => {
    roomInfo(serverDoc).set("epoch", "ep-1");
    const t = new Y.Text();
    t.insert(0, "<p>hi</p>");
    files(serverDoc).set("index.html", t);
  });

  let panel: Bun.ServerWebSocket<{ path: string }> | null = null;
  const fromBridge: Record<string, unknown>[] = [];
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
        if (ws.data.path == "/api/agent/bridge") return void (panel = ws);
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

  let opens = 0;
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((r) => (releaseFirst = r));
  let crashFirstHandle!: () => void;

  const mockDriver: AgentDriver = {
    id: "mock-conc",
    label: "Mock",
    async open(): Promise<AgentHandle> {
      const idx = ++opens;
      let closed = false;
      const listeners = new Set<(ev: DriverEvent) => void>();
      const closeListeners = new Set<() => void>();
      const emit = (ev: DriverEvent) => {
        for (const fn of listeners) fn(ev);
      };
      const markClosed = () => {
        if (closed) return;
        closed = true;
        for (const fn of [...closeListeners]) fn();
        closeListeners.clear();
      };
      if (idx == 1) crashFirstHandle = markClosed;
      return {
        sessionId: `s-${idx}`,
        models: [],
        model: null,
        get closed() {
          return closed;
        },
        async prompt(input) {
          const tag = input.text.includes("first") ? "first" : input.text.includes("second") ? "second" : "third";
          order.push(`start:${idx}:${tag}`);
          if (tag == "first") await firstGate;
          emit({ t: "text", delta: `reply:${idx}:${tag}` });
          emit({ t: "busy", busy: false });
          emit({ t: "turn_done" });
          order.push(`end:${idx}:${tag}`);
        },
        async abort() {},
        async answer() {
          return false;
        },
        onEvent(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        onClose(fn) {
          closeListeners.add(fn);
          return () => closeListeners.delete(fn);
        },
        async close() {
          markClosed();
        },
      };
    },
  };

  const root = mkdtempSync(join(tmpdir(), "erga-daemon-conc-"));
  const home = join(root, "home");
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const prevHome = process.env.ERGA_HOME;
  const prevTok = process.env.ERGA_TOKEN;
  process.env.ERGA_HOME = home;
  delete process.env.ERGA_TOKEN;
  const origin = `http://127.0.0.1:${server.port}`;
  saveToken({ origin, clientName: "Mock", clientId: "c1", accessToken: "tok", expiresAt: Date.now() + 60_000 });
  const daemon = new ErgaDaemon(mockDriver, { defaultOrigin: origin, defaultCwd: work });

  try {
    daemon.startSocket();
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(daemonSocketPath("mock-conc")).mode & 0o777).toBe(0o600);

    // Concurrent openDocument calls must deduplicate into one mount.
    const [a, b] = await Promise.all([
      daemon.openDocument({ origin, document: "/d/doc1", cwd: work }),
      daemon.openDocument({ origin, document: "/d/doc1", cwd: work }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(daemon.status().mounts.length).toBe(1);
    await until(() => panel != null);

    // Concurrent browser prompts must open only ONE handle and execute strictly sequentially.
    panel!.send(JSON.stringify({ type: "prompt", doc: "doc1", text: "first", context: null }));
    panel!.send(JSON.stringify({ type: "prompt", doc: "doc1", text: "second", context: null }));
    await until(() => order.includes("start:1:first"));
    expect(order).toEqual(["start:1:first"]);
    releaseFirst();
    await until(() => order.includes("end:1:second"));
    expect(opens).toBe(1);
    expect(order).toEqual(["start:1:first", "end:1:first", "start:1:second", "end:1:second"]);

    // Unexpected handle close must evict the thread so the next prompt opens handle #2.
    crashFirstHandle();
    panel!.send(JSON.stringify({ type: "prompt", doc: "doc1", text: "third", context: null }));
    await until(() => order.includes("end:2:third"));
    expect(opens).toBe(2);
  } finally {
    await daemon.stop();
    if (prevHome === undefined) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = prevHome;
    if (prevTok !== undefined) process.env.ERGA_TOKEN = prevTok;
    server.stop(true);
    serverDoc.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 7, 12 & 14. Auth callback, dynamic defaultOrigin & findSession

test("loopback OAuth login ignores stray bad-state callbacks and defaultOrigin reads auth dynamically", async () => {
  let authorizeUrl = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname == "/.well-known/oauth-authorization-server") {
        const origin = url.origin;
        return Response.json({
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          registration_endpoint: `${origin}/oauth/register`,
        });
      }
      if (url.pathname == "/oauth/register") return Response.json({ client_id: "cid-1" });
      if (url.pathname == "/oauth/token") return Response.json({ access_token: "tok-ok", expires_in: 3600 });
      return new Response("not found", { status: 404 });
    },
  });

  const home = mkdtempSync(join(tmpdir(), "erga-auth-review-"));
  const prevHome = process.env.ERGA_HOME;
  const prevServer = process.env.ERGA_SERVER;
  process.env.ERGA_HOME = home;
  delete process.env.ERGA_SERVER;
  const origin = `http://127.0.0.1:${server.port}`;

  try {
    expect(defaultOrigin()).toBe("http://localhost:4400");

    const loginPromise = login(origin, "Antigravity", {
      mode: "local",
      open: false,
      timeoutMs: 5_000,
      log: (line) => {
        const m = /https?:\/\/\S+/.exec(line);
        if (m) authorizeUrl = m[0];
      },
    });
    await until(() => !!authorizeUrl);
    const parsed = new URL(authorizeUrl);
    const redirectUri = parsed.searchParams.get("redirect_uri")!;
    const state = parsed.searchParams.get("state")!;

    // Stray bad-state callbacks must return 400 and NOT abort the pending login.
    const bad1 = await fetch(`${redirectUri}?code=fake&state=wrong`);
    expect(bad1.status).toBe(400);
    const bad2 = await fetch(`${redirectUri}?error=access_denied&state=wrong`);
    expect(bad2.status).toBe(400);

    // Valid callback still succeeds and defaultOrigin() immediately reflects the new token.
    const good = await fetch(`${redirectUri}?code=real-code&state=${encodeURIComponent(state)}`);
    expect(good.status).toBe(200);
    const token = await loginPromise;
    expect(token.accessToken).toBe("tok-ok");
    expect(defaultOrigin()).toBe(origin);
  } finally {
    if (prevHome === undefined) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = prevHome;
    if (prevServer === undefined) delete process.env.ERGA_SERVER;
    else process.env.ERGA_SERVER = prevServer;
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

test("findSession matches only the requested conversationId or exact cwd without cross-repo fallback", () => {
  const home = mkdtempSync(join(tmpdir(), "erga-sessions-review-"));
  const prevHome = process.env.ERGA_HOME;
  process.env.ERGA_HOME = home;
  try {
    recordSession("antigravity", { conversationId: "conv-a", cwd: "/repo/a", transcriptPath: "/tmp/a.jsonl" });
    expect(findSession("antigravity", { conversationId: "conv-a" })?.transcriptPath).toBe("/tmp/a.jsonl");
    expect(findSession("antigravity", { cwd: "/repo/a" })?.conversationId).toBe("conv-a");
    expect(findSession("antigravity", { cwd: "/repo/b" })).toBeNull();
    expect(findSession("antigravity", { conversationId: "conv-b", cwd: "/repo/a" })).toBeNull();
  } finally {
    if (prevHome === undefined) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 15. Antigravity live-attach lifecycle

test("checkLiveAntigravityState keeps slow or unimplemented LS checks non-fatal and detects dead sessions", async () => {
  let mode: "running" | "idle" | "unimplemented" | "server_error" | "slow" | "unauthenticated" | "not_found" = "running";
  const slowResolvers: (() => void)[] = [];
  const ls = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      if (mode == "running") return Response.json({ state: { runState: "RUN_STATE_RUNNING" } });
      if (mode == "idle") return Response.json({ state: { runState: "RUN_STATE_IDLE" } });
      if (mode == "unimplemented") return new Response("404 page not found\n", { status: 404 });
      if (mode == "server_error") return new Response("unavailable", { status: 503 });
      if (mode == "unauthenticated") return Response.json({ code: "unauthenticated" }, { status: 401 });
      if (mode == "not_found") return Response.json({ code: "not_found" }, { status: 404 });
      await new Promise<void>((r) => slowResolvers.push(r));
      return Response.json({ state: { runState: "RUN_STATE_RUNNING" } });
    },
  });
  const baseSession = (lsAddress = `127.0.0.1:${ls.port}`): LiveAntigravitySession => ({
    conversationId: "conv-check-1",
    lsAddress,
    csrfToken: "csrf-1",
    cwd: "/tmp",
  });
  try {
    expect(await checkLiveAntigravityState(baseSession())).toBe("running");
    expect(await checkLiveAntigravityState(baseSession(`http://127.0.0.1:${ls.port}`))).toBe("running");

    mode = "idle";
    expect(await checkLiveAntigravityState(baseSession())).toBe("idle");

    mode = "unimplemented";
    expect(await checkLiveAntigravityState(baseSession())).toBe("unknown");

    mode = "server_error";
    expect(await checkLiveAntigravityState(baseSession())).toBe("unknown");

    mode = "slow";
    expect(await checkLiveAntigravityState(baseSession(), { timeoutMs: 80 })).toBe("unknown");
    for (const r of slowResolvers.splice(0)) r();

    mode = "unauthenticated";
    expect(await checkLiveAntigravityState(baseSession())).toBe("gone");

    mode = "not_found";
    expect(await checkLiveAntigravityState(baseSession())).toBe("gone");

    const deadPort = ls.port;
    await ls.stop(true);
    expect(await checkLiveAntigravityState(baseSession(`127.0.0.1:${deadPort}`))).toBe("gone");
  } finally {
    for (const r of slowResolvers.splice(0)) r();
    ls.stop(true);
  }
});

test("ErgaDaemon keeps Antigravity liveAttached across multiple browser prompts when state check is unimplemented or slow", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.transact(() => {
    roomInfo(serverDoc).set("epoch", "ep-live-2");
    const t = new Y.Text();
    t.insert(0, "<h1>Live Multi</h1>");
    files(serverDoc).set("index.html", t);
  });

  const fromBridge: Record<string, unknown>[] = [];
  let panel: Bun.ServerWebSocket<{ path: string }> | null = null;
  const server = Bun.serve<{ path: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname == "/d/doc1/api/doc")
        return Response.json({ docName: { id: "doc1", owner: "pete", slug: "multi", title: "Multi" } });
      if (url.pathname == "/d/doc1/api/start") {
        return new Response(new Uint8Array(encodeStart({ type: "hello", epoch: "ep-live-2" }, Y.encodeStateAsUpdate(serverDoc))));
      }
      if (url.pathname == "/d/doc1/api/room" || url.pathname == "/api/agent/bridge") {
        if (srv.upgrade(req, { data: { path: url.pathname } })) return undefined;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.path == "/api/agent/bridge") return void (panel = ws);
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

  // Mock LS that handles send-message fine, but does not implement GetConversation (404 plain text).
  const ls = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("404 page not found\n", { status: 404 }),
  });

  const root = mkdtempSync(join(tmpdir(), "erga-live-multi-"));
  const transcript = join(root, "transcript_full.jsonl");
  writeFileSync(transcript, "");
  const prevHome = process.env.ERGA_HOME;
  const prevTok = process.env.ERGA_TOKEN;
  process.env.ERGA_HOME = root;
  delete process.env.ERGA_TOKEN;

  const origin = `http://127.0.0.1:${server.port}`;
  saveToken({ origin, clientName: "Antigravity", clientId: "c1", accessToken: "tok", expiresAt: Date.now() + 60_000 });

  const sent: string[] = [];
  let checks = 0;
  let acpSpawned = 0;
  const daemon = new ErgaDaemon(
    {
      id: "antigravity",
      label: "Antigravity",
      open: async () => {
        acpSpawned++;
        throw new Error("ACP must not be spawned");
      },
    },
    {
      livePollMs: 25,
      liveMessenger: {
        send: async (_session, text) => {
          sent.push(text);
        },
        check: async (session) => {
          checks++;
          return checkLiveAntigravityState(session as LiveAntigravitySession);
        },
      },
    }
  );

  try {
    const opened = await daemon.openDocument({
      origin,
      document: "/d/doc1",
      cwd: root,
      conversationId: "conv-multi-1",
      lsAddress: `127.0.0.1:${ls.port}`,
      csrfToken: "csrf-live-secret",
      transcriptPath: transcript,
    });
    expect(opened.ok && opened.liveAttached).toBe(true);
    await until(() => panel != null);

    // Prompt 1: safety poll fires while turn is active, then Stop hook finishes turn 1.
    panel!.send(JSON.stringify({ type: "prompt", doc: "doc1", text: "First prompt", context: null }));
    await until(() => sent.length == 1);
    await until(() => checks >= 2);
    await daemon.handleHook({ hookEventName: "Stop", conversationId: "conv-multi-1", cwd: root, fullyIdle: true });
    await until(() => fromBridge.some((m) => m.type == "turn_done"));

    // liveAttached must STILL be true after turn 1 so prompt 2 routes live!
    expect(daemon.status().mounts[0].conversationId).toBe("conv-multi-1");
    expect(daemon.status().mounts[0].liveAttached).toBe(true);

    // Prompt 2: must succeed without "live prompt routing is not attached yet" error.
    fromBridge.length = 0;
    panel!.send(JSON.stringify({ type: "prompt", doc: "doc1", text: "Second prompt", context: null }));
    await until(() => sent.length == 2);
    expect(sent[1]).toContain("Second prompt");
    expect(fromBridge.some((m) => m.type == "event" && (m.ev as { t?: string }).t == "error")).toBe(false);
    await daemon.handleHook({ hookEventName: "Stop", conversationId: "conv-multi-1", cwd: root, fullyIdle: true });
    await until(() => fromBridge.some((m) => m.type == "turn_done"));
    expect(daemon.status().mounts[0].liveAttached).toBe(true);

    // Prompt 3 while LS actually dies (ConnectionRefused) -> consecutive gone polls detach cleanly.
    fromBridge.length = 0;
    ls.stop(true);
    panel!.send(JSON.stringify({ type: "prompt", doc: "doc1", text: "Third prompt", context: null }));
    await until(() => sent.length == 3);
    await until(() => fromBridge.some((m) => m.type == "turn_done"));
    expect(daemon.status().mounts[0].liveAttached).toBe(false);

    // A subsequent hook carrying live credentials restores liveAttached in RAM only (never persisted or exposed).
    await daemon.handleHook(
      { hookEventName: "PreInvocation", conversationId: "conv-multi-1", cwd: root, transcriptPath: transcript },
      { lsAddress: "127.0.0.1:59999", csrfToken: "csrf-refreshed-secret" }
    );
    expect(daemon.status().mounts[0].liveAttached).toBe(true);
    expect(JSON.stringify(daemon.status())).not.toContain("csrf-refreshed-secret");
    expect(readFileSync(join(root, "antigravity-sessions.json"), "utf8")).not.toContain("csrf-refreshed-secret");
    expect(acpSpawned).toBe(0);
  } finally {
    await daemon.stop();
    if (prevHome === undefined) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = prevHome;
    if (prevTok !== undefined) process.env.ERGA_TOKEN = prevTok;
    ls.stop(true);
    server.stop(true);
    serverDoc.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

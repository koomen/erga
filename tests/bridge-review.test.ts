// Regression tests for YjsDiskSync, PersonAgents dead-socket cleanup & edit access,
// ErgaBridgeClient reconnect semantics, daemon mount deduplication & socket perms,
// and OAuth loopback bad-state handling.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
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
import { YjsDiskSync } from "../bridge/core/yjs-sync.ts";
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
      if (url.pathname == "/d/doc1/api/start")
        return new Response(new Uint8Array(encodeStart({ type: "hello", epoch: "ep-1" }, Y.encodeStateAsUpdate(serverDoc))));
      if (url.pathname == "/d/doc1/api/room" && srv.upgrade(req, { data: undefined })) return undefined;
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
  const sync = new YjsDiskSync({ origin: `http://127.0.0.1:${server.port}`, docId: "doc1", dir, token: async () => "tok" });
  try {
    await sync.start();
    expect(new Uint8Array(readFileSync(join(dir, "logo.png")))).toEqual(pngBytes);
    expect(gets).toEqual(["logo.png"]);
    await sync.flush();
    expect(puts).toEqual([]);

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

test("YjsDiskSync writes merged text back to disk after concurrent edits and preserves new local files across epoch reset", async () => {
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
      if (url.pathname == "/d/doc1/api/start")
        return new Response(new Uint8Array(encodeStart({ type: "hello", epoch }, Y.encodeStateAsUpdate(serverDoc))));
      if (url.pathname == "/d/doc1/api/room" && srv.upgrade(req, { data: undefined })) return undefined;
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
  const sync = new YjsDiskSync({ origin: `http://127.0.0.1:${server.port}`, docId: "doc1", dir, token: async () => "tok" });
  try {
    await sync.start();
    writeFileSync(join(dir, "index.html"), "alpha\nbeta\nGAMMA\n");
    const flushDone = sync.flush();
    sync.doc.transact(() => {
      const t = files(sync.doc).get("index.html")!;
      t.delete(0, 5);
      t.insert(0, "ALPHA");
    }, "concurrent-remote");
    await flushDone;
    expect(files(sync.doc).get("index.html")?.toString()).toBe("ALPHA\nbeta\nGAMMA\n");
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("ALPHA\nbeta\nGAMMA\n");

    writeFileSync(join(dir, "draft.md"), "# Keep me\n");
    await sync.flush();
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
  } finally {
    await sync.stop();
    server.stop(true);
    serverDoc.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    { login: "pete", grantId: "g1", label: "Erga Bridge", onlyDoc: null, origin: "http://localhost:4400" },
    () => {
      if (failSend) throw new Error("socket closed");
    },
    () => {
      closed = true;
    }
  );

  try {
    bridge.message(JSON.stringify({ type: "hello", id: "agy-1", agent: "antigravity", label: "Antigravity", version: "dev" }));
    await until(() => tabMsgs.some((m) => m.type == "model" && m.enabled == true));

    bridge.message(JSON.stringify({ type: "turn_done", doc: "doc-view" }));
    bridge.message(JSON.stringify({ type: "turn_done", doc: "doc-none" }));
    bridge.message(JSON.stringify({ type: "turn_done", doc: "doc-edit" }));
    await until(() => docCalls.length == 1);
    expect(docCalls).toEqual([{ id: "doc-edit", url: "/api/turn-done" }]);

    tabMsgs.length = 0;
    failSend = true;
    const res = await agents.agentPrompt("pete", "http://localhost:4400", "Hi", null, [], "doc-edit", "Pete", "m1");
    expect(res.ok).toBe(false);
    expect(closed).toBe(true);
    await until(() => tabMsgs.some((m) => m.type == "model" && m.enabled == false));
  } finally {
    leave();
  }
});

test("bridge reconnect preserves explicit switch to an embedded model and sets reconnect flag on retry", async () => {
  let st = bridgeStep(EMPTY_BRIDGES, {
    on: "connect",
    fallbackThreadId: "t1",
    bridge: {
      id: "agy-1",
      agent: "antigravity",
      label: "Antigravity",
      version: "dev",
      grantId: "g1",
      onlyDoc: null,
      sessionId: "s1",
      cwd: null,
      connectedAt: 1,
    },
  }).state;
  st = bridgeStep(st, { on: "bind", id: "agy-1", doc: "doc1", sessionId: "s1", fallbackThreadId: "t1" }).state;
  st = bridgeStep(st, { on: "select", doc: "doc1", choice: "sonnet" }).state;
  expect(activeBridge(st, "doc1")).toBeNull();

  st = bridgeStep(st, { on: "disconnect", id: "agy-1" }).state;
  st = bridgeStep(st, {
    on: "connect",
    fallbackThreadId: "t2",
    reconnect: true,
    bridge: {
      id: "agy-1",
      agent: "antigravity",
      label: "Antigravity",
      version: "dev",
      grantId: "g1",
      onlyDoc: null,
      sessionId: "s1",
      cwd: null,
      connectedAt: 2,
    },
  }).state;
  st = bridgeStep(st, { on: "bind", id: "agy-1", doc: "doc1", sessionId: "s1", fallbackThreadId: "t2", reconnect: true }).state;
  expect(activeBridge(st, "doc1")).toBeNull();
  expect(panelOptions(st, "doc1", [{ id: "sonnet", label: "Sonnet" }]).map((o) => o.id)).toEqual(["local:agy-1", "sonnet"]);

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
    version: "dev",
    token: async () => "tok",
    onMessage: () => {},
  });
  try {
    await client.start();
    client.bind("doc1", { label: "Antigravity", sessionId: "s1" });
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

test("ErgaDaemon deduplicates concurrent mounts and restricts bridge.sock permissions to 0600", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.transact(() => {
    roomInfo(serverDoc).set("epoch", "ep-1");
    const t = new Y.Text();
    t.insert(0, "<p>hi</p>");
    files(serverDoc).set("index.html", t);
  });

  const server = Bun.serve<{ path: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname == "/d/doc1/api/doc") return Response.json({ docName: { id: "doc1", owner: "pete", slug: "demo", title: "Demo" } });
      if (url.pathname == "/d/doc1/api/start")
        return new Response(new Uint8Array(encodeStart({ type: "hello", epoch: "ep-1" }, Y.encodeStateAsUpdate(serverDoc))));
      if ((url.pathname == "/d/doc1/api/room" || url.pathname == "/api/agent/bridge") && srv.upgrade(req, { data: { path: url.pathname } }))
        return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.path != "/d/doc1/api/room") return;
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
    },
  });

  const root = mkdtempSync("/tmp/erga-daemon-perm-");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const prevHome = process.env.ERGA_HOME;
  const prevTok = process.env.ERGA_TOKEN;
  process.env.ERGA_HOME = home;
  delete process.env.ERGA_TOKEN;
  const origin = `http://127.0.0.1:${server.port}`;
  saveToken({ origin, clientName: "Erga Bridge", clientId: "c1", accessToken: "tok", expiresAt: Date.now() + 60_000 });
  const daemon = new ErgaDaemon({ home, defaultOrigin: origin });

  try {
    await daemon.start();
    daemon.startSocket();
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(daemonSocketPath(home)).mode & 0o777).toBe(0o600);

    const [a, b] = await Promise.all([
      daemon.openDocument({ origin, document: "/d/doc1" }),
      daemon.openDocument({ origin, document: "/d/doc1" }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(daemon.status().mounts.length).toBe(1);
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

test("loopback OAuth login ignores stray bad-state callbacks and defaultOrigin reads auth dynamically", async () => {
  let authorizeUrl = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname == "/.well-known/oauth-authorization-server") {
        return Response.json({
          authorization_endpoint: `${url.origin}/oauth/authorize`,
          token_endpoint: `${url.origin}/oauth/token`,
          registration_endpoint: `${url.origin}/oauth/register`,
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
    const loginPromise = login(origin, "Erga Bridge", {
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

    expect((await fetch(`${redirectUri}?code=fake&state=wrong`)).status).toBe(400);
    expect((await fetch(`${redirectUri}?error=access_denied&state=wrong`)).status).toBe(400);
    expect((await fetch(`${redirectUri}?code=real-code&state=${encodeURIComponent(state)}`)).status).toBe(200);
    expect((await loginPromise).accessToken).toBe("tok-ok");
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

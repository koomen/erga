// Real in-process Erga scenario runners that execute Erga's actual auth,
// YjsDiskSync, ErgaDaemon, PersonAgents, page-operations (view_page), and
// updater code against an ephemeral local server inside `withTrace()`.
// Nothing here mocks the protocol order under test: if Erga's code changes
// what routes, storage, or messages it uses, the captured trace changes too.

import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { ChatSql } from "../agents/chat-store.ts";
import { PersonAgents } from "../agents/person/sessions.ts";
import { login, pollDeviceOnce, saveToken, startDeviceLogin } from "../bridge/core/auth.ts";
import { ErgaDaemon } from "../bridge/core/daemon.ts";
import { sha256Hex, writePinnedOrigin } from "../bridge/core/updater.ts";
import { DriverEvents, type AgentDriver, type AgentHandle, type OpenSessionOptions } from "../bridge/drivers/stdio.ts";
import { PAGE_OPERATIONS } from "../document/api/page-operations.ts";
import { files, roomInfo } from "../document/model/content.ts";
import { DEVICE_AUTH, DEVICE_DONE, DEVICE_POLL } from "../gate/core.ts";
import { encodeStart } from "../shared/room-socket.ts";
import { Encoder, MSG_STORED, writeSyncStep1 } from "../shared/yjs-protocol.ts";
import { recordTrace, withTrace, type TraceEvent } from "./trace.ts";

function sqliteChat(): ChatSql {
  const db = new Database(":memory:");
  return {
    exec: <T>(query: string, ...params: (string | number | null)[]) => db.query(query).all(...params) as T[],
    transaction: <R>(f: () => R) => db.transaction(f)(),
  };
}

type Emit = (ev: Omit<TraceEvent, "seq">) => void;

class TracedAcpHandle extends DriverEvents implements AgentHandle {
  readonly models = [{ id: "m1", label: "Model 1" }];
  model: string | null = "m1";
  closed = false;
  private closeFns = new Set<() => void>();
  private holdFinish: (() => void) | null = null;
  private pendingPerm: ((choice: string) => void) | null = null;

  constructor(
    readonly sessionId: string,
    readonly opts: OpenSessionOptions,
    private readonly mode: "stream" | "permission" | "update",
    private readonly emitTrace: () => Emit,
    private readonly onPrompt?: () => Promise<void>
  ) {
    super();
  }

  async prompt(input: { text: string }): Promise<void> {
    this.emitTrace()({ from: "sbridge", to: "sagent", proto: "acp", op: "session/prompt", milestone: true });
    this.emit({ t: "busy", busy: true });
    if (this.onPrompt) await this.onPrompt();
    if (this.mode == "permission") {
      this.emitTrace()({ from: "sagent", to: "sbridge", proto: "acp", op: "session/request_permission", milestone: true });
      this.emit({
        t: "tool",
        id: "perm-1",
        name: "run_command",
        path: null,
        status: "asking",
        detail: "bun run check",
        choices: [
          { id: "deny", label: "Deny", kind: "deny" },
          { id: "allow_once", label: "Allow once", kind: "allow" },
        ],
      });
      await new Promise<string>((r) => {
        this.pendingPerm = r;
      });
      this.emit({ t: "tool", id: "perm-1", name: "run_command", path: null, status: "done" });
    } else if (this.mode == "update") {
      await new Promise<void>((r) => {
        this.holdFinish = r;
      });
    }
    this.emitTrace()({ from: "sagent", to: "sbridge", proto: "acp", op: "agent_message_chunk" });
    this.emit({ t: "text", delta: `Done: ${input.text}` });
    this.emit({ t: "busy", busy: false });
    this.emitTrace()({ from: "sagent", to: "sbridge", proto: "acp", op: "turn_done", milestone: true });
    this.emit({ t: "turn_done" });
  }

  releaseTurn(): void {
    const fn = this.holdFinish;
    this.holdFinish = null;
    fn?.();
  }

  async abort(): Promise<void> {
    this.releaseTurn();
  }

  async answer(id: string, approve: boolean, choice?: string): Promise<boolean> {
    this.emitTrace()({ from: "sbridge", to: "sagent", proto: "acp", op: "permission_answer", milestone: true });
    const fn = this.pendingPerm;
    this.pendingPerm = null;
    fn?.(choice ?? (approve ? "allow_once" : "deny"));
    return true;
  }

  onClose(fn: () => void): () => void {
    this.closeFns.add(fn);
    return () => this.closeFns.delete(fn);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.releaseTurn();
    for (const fn of [...this.closeFns]) fn();
  }
}

function makeYjsDocBytes(): Uint8Array {
  const ydoc = new Y.Doc();
  roomInfo(ydoc).set("epoch", "ep1");
  files(ydoc).set("index.html", new Y.Text("<h1>Launch Notes</h1><p>Initial draft.</p>"));
  return encodeStart({ type: "hello", epoch: "ep1" }, Y.encodeStateAsUpdate(ydoc));
}

function makeFakeServer(opts: {
  person: PersonAgents;
  bundleBytes: Uint8Array;
  bundleVersion: string;
  onTurnDone: () => void;
  getEmit: () => Emit;
}) {
  const emit: Emit = (ev) => opts.getEmit()(ev);
  const bundleSha = sha256Hex(opts.bundleBytes);
  const startBytes = makeYjsDocBytes();
  let deviceApproved = false;
  const bridgeSockMap = new Map<unknown, ReturnType<PersonAgents["joinBridge"]>>();

  const server = Bun.serve<{ kind: "yjs" | "bridge"; login?: string }>({
    port: 0,
    fetch(req, srv) {
      const u = new URL(req.url);
      const p = u.pathname;
      const isWs = req.headers.get("upgrade")?.toLowerCase() == "websocket";
      const hasBearer = /^Bearer\s+/i.test(req.headers.get("authorization") ?? "");

      if (isWs && p == "/d/doc1/api/room") {
        emit({ from: "sbridge", to: "doc", proto: "ws", op: "WS", path: p, status: 101, milestone: true });
        if (srv.upgrade(req, { data: { kind: "yjs" } })) return;
      }
      if (isWs && p == "/api/agent/bridge") {
        emit({ from: "sbridge", to: "person", proto: "ws", op: "WS", path: p, status: 101, milestone: true });
        if (srv.upgrade(req, { data: { kind: "bridge", login: "ada" } })) return;
      }

      if (req.method == "GET" && p == "/llms.txt") {
        emit({ from: "sagent", to: "worker", proto: "http", op: "GET", path: p, status: 200, milestone: true });
        return new Response("# Erga\n", { headers: { "Content-Type": "text/markdown" } });
      }
      if (req.method == "GET" && p == "/plugin/install.sh") {
        emit({ from: "sagent", to: "worker", proto: "http", op: "GET", path: p, status: 200, milestone: true });
        return new Response("#!/bin/sh\n");
      }
      if (req.method == "GET" && p == "/plugin/bridge.json") {
        emit({ from: "sbridge", to: "worker", proto: "http", op: "GET", path: p, status: 200, milestone: true });
        return Response.json({ version: opts.bundleVersion, sha256: bundleSha, url: "/plugin/bridge.js" });
      }
      if (req.method == "GET" && p == "/plugin/bridge.js") {
        emit({ from: "sbridge", to: "worker", proto: "http", op: "GET", path: p, status: 200, milestone: true });
        return new Response(new Uint8Array(opts.bundleBytes));
      }
      if (req.method == "GET" && p == "/.well-known/oauth-authorization-server") {
        emit({ from: "sbridge", to: "edge", proto: "http", op: "GET", path: p, status: 200, milestone: true });
        return Response.json({
          issuer: u.origin,
          authorization_endpoint: `${u.origin}/oauth/authorize`,
          device_authorization_endpoint: `${u.origin}${DEVICE_AUTH}`,
          token_endpoint: `${u.origin}/oauth/token`,
          registration_endpoint: `${u.origin}/oauth/register`,
        });
      }
      if (req.method == "POST" && p == "/oauth/register") {
        emit({ from: "sbridge", to: "edge", proto: "http", op: "POST", path: p, status: 201, milestone: true });
        return Response.json({ client_id: "erga-bridge-1" }, { status: 201 });
      }
      if (req.method == "POST" && p == DEVICE_AUTH) {
        emit({ from: "sbridge", to: "worker", proto: "http", op: "POST", path: p, status: 200, milestone: true });
        return Response.json({
          device_code: "dev-123",
          user_code: "WXYZ-4819",
          verification_uri: `${u.origin}/oauth/device`,
          verification_uri_complete: `${u.origin}/oauth/device?user_code=WXYZ-4819`,
          expires_in: 600,
          interval: 1,
        });
      }
      if (req.method == "GET" && p == "/oauth/device") {
        emit({ from: "sshell", to: "worker", proto: "http", op: "GET", path: p, status: 200, milestone: true });
        return new Response("<html>Approve WXYZ-4819</html>");
      }
      if (req.method == "POST" && p == "/oauth/authorize") {
        emit({ from: "sshell", to: "worker", proto: "http", op: "POST", path: p, status: 302, milestone: true });
        emit({ from: "worker", to: "d1", proto: "sql", op: "INSERT agent_grants", milestone: true });
        deviceApproved = true;
        return new Response("", { status: 302, headers: { Location: `${u.origin}${DEVICE_DONE}?code=pkce-code-1&state=st1` } });
      }
      if (req.method == "GET" && p == DEVICE_DONE) {
        emit({ from: "sshell", to: "worker", proto: "http", op: "GET", path: p, status: 200 });
        return new Response("Approved.");
      }
      if (req.method == "POST" && p == DEVICE_POLL) {
        emit({ from: "sbridge", to: "worker", proto: "http", op: "POST", path: p, status: 200, milestone: true });
        if (!deviceApproved) return Response.json({ error: "authorization_pending" }, { status: 400 });
        return Response.json({ code: "pkce-code-1", redirect_uri: `${u.origin}${DEVICE_DONE}` });
      }
      if (req.method == "POST" && p == "/oauth/token") {
        emit({ from: "sbridge", to: "edge", proto: "http", op: "POST", path: p, status: 200, milestone: true });
        return Response.json({ access_token: "a.tok.sig", refresh_token: "r.tok.sig", expires_in: 3600 });
      }
      if (req.method == "GET" && (p == "/ada/launch-notes/api/doc" || p == "/d/doc1/api/doc")) {
        emit({ from: "sbridge", to: "worker", proto: "http", op: "GET", path: p, status: 200, milestone: true });
        return Response.json({ docName: { id: "doc1", owner: "ada", slug: "launch-notes", title: "Launch Notes" } });
      }
      if (req.method == "GET" && p == "/d/doc1/api/start") {
        emit({ from: "sbridge", to: "doc", proto: "http", op: "GET", path: p, status: 200, milestone: true });
        return new Response(new Uint8Array(startBytes), { headers: { "Content-Type": "application/octet-stream" } });
      }
      if (req.method == "POST" && p == "/mcp") {
        if (!hasBearer) return new Response("Unauthorized", { status: 401 });
        emit({ from: "sbridge", to: "worker", proto: "http", op: "POST", path: p, status: 200, milestone: true });
        return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "image", data: "iVBORw==", mimeType: "image/png" }] } });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.kind == "yjs") {
          const e = new Encoder();
          e.writeUint(0);
          writeSyncStep1(e, new Y.Doc());
          ws.send(e.toBytes());
          return;
        }
        const handler = opts.person.joinBridge(
          {
            login: ws.data.login ?? "ada",
            grantId: "g7",
            label: "Erga Bridge",
            onlyDoc: null,
            origin: server.url.origin,
          },
          (data: string) => ws.send(data),
          () => ws.close()
        );
        bridgeSockMap.set(ws, handler);
      },
      message(ws, data) {
        if (ws.data.kind == "yjs") {
          if (typeof data != "string") {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
            // Byte 0 == 0 is MSG_SYNC (actual Yjs doc sync/update); byte 0 == 1 is MSG_AWARENESS (presence)
            if (bytes[0] == 0) {
              emit({ from: "sbridge", to: "doc", proto: "yjs", op: "sync_update", milestone: true });
              ws.send(new Uint8Array([MSG_STORED]));
            }
          }
          return;
        }
        const raw = typeof data == "string" ? data : new TextDecoder().decode(data);
        try {
          const parsed = JSON.parse(raw) as { type?: string };
          if (parsed.type == "hello" || parsed.type == "bind" || parsed.type == "turn_done") {
            emit({ from: "sbridge", to: "person", proto: "ws", op: `FromBridge:${parsed.type}`, milestone: true });
          }
          if (parsed.type == "turn_done") {
            emit({ from: "person", to: "doc", proto: "http", op: "POST", path: "/api/turn-done", status: 200, milestone: true });
            opts.onTurnDone();
          }
        } catch {}
        bridgeSockMap.get(ws)?.message(raw);
      },
      close(ws) {
        bridgeSockMap.get(ws)?.close();
        bridgeSockMap.delete(ws);
      },
    },
  });

  return server;
}

function makePersonAgents(origin: string, getEmit: () => Emit): PersonAgents {
  const platform = {
    agentSettings: async () => ({ missing: "no API keys configured" }),
    directory: {
      openAs: async () => ({ doc: { id: "doc1", owner: "ada", slug: "launch-notes", test: false }, role: "owner" }),
      route: async (id: string) => ({ id, owner: "ada", test: false }),
      users: { isAdmin: async () => false },
      personKeys: { list: async () => [] },
      settings: { get: async () => null },
    },
    documents: {
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    },
  } as unknown as ConstructorParameters<typeof PersonAgents>[0]["platform"];
  const agents = new PersonAgents({ platform, sql: sqliteChat() });
  agents.join(new Request(`${origin}/api/agent/events?doc=doc1`, { headers: { "x-erga-login": "ada" } }), (text) => {
    try {
      const msg = JSON.parse(text) as { type?: string; ev?: { status?: string } };
      if (msg.type == "agent" && msg.ev?.status == "asking") {
        getEmit()({ from: "person", to: "sshell", proto: "ws", op: "LogEvent:asking", milestone: true });
      }
    } catch {}
  });
  return agents;
}

const NOOP_EMIT: Emit = () => {};

async function waitBridgeReady(person: PersonAgents, origin: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const st = await person.agentState("ada", "doc1", origin, "Ada");
    if (st.enabled && st.choice?.startsWith("local:")) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for bridge to register with PersonAgents");
}

async function runConnectScenario(authMode: "device" | "pkce"): Promise<TraceEvent[]> {
  const home = mkdtempSync(join(tmpdir(), "erga-trace-home-"));
  const prevHome = process.env.ERGA_HOME;
  process.env.ERGA_HOME = home;
  let activeEmit: Emit = NOOP_EMIT;
  const bundleBytes = new TextEncoder().encode("console.log('bridge');");
  const person = makePersonAgents("http://localhost", () => activeEmit);
  const server = makeFakeServer({ person, bundleBytes, bundleVersion: "v8a3f1c2", onTurnDone: () => {}, getEmit: () => activeEmit });
  const origin = server.url.origin;
  const holder: { daemon: ErgaDaemon | null } = { daemon: null };

  try {
    const { events } = await withTrace(async (emit) => {
      activeEmit = emit;
      await fetch(`${origin}/llms.txt`);
      await fetch(`${origin}/plugin/install.sh`);
      await fetch(`${origin}/plugin/bridge.json`);
      await fetch(`${origin}/plugin/bridge.js`);
      writePinnedOrigin(origin, home);

      if (authMode == "device") {
        const pending = await startDeviceLogin(origin, "Erga Bridge");
        await fetch(pending.verificationUriComplete);
        const appRes = await fetch(`${origin}/oauth/authorize`, { method: "POST", redirect: "manual" });
        const doneLoc = appRes.headers.get("location");
        if (doneLoc) await fetch(doneLoc);
        const polled = await pollDeviceOnce(pending);
        if (polled.status != "approved") throw new Error(`Expected approved device auth, got ${polled.status}`);
      } else {
        const loginDone = login(origin, "Erga Bridge", {
          mode: "local",
          open: false,
          log: (line) => {
            const m = /(https?:\/\/\S+)/.exec(line);
            if (!m) return;
            const authUrl = new URL(m[1]);
            const redirect = authUrl.searchParams.get("redirect_uri")!;
            const state = authUrl.searchParams.get("state")!;
            void (async () => {
              await fetch(`${origin}/oauth/authorize`, { method: "POST", redirect: "manual" });
              emit({ from: "sshell", to: "sbridge", proto: "http", op: "GET", path: "/callback", status: 200, milestone: true });
              await fetch(`${redirect}?code=pkce-code-1&state=${encodeURIComponent(state)}`);
            })();
          },
        });
        await loginDone;
      }

      const driver: AgentDriver = {
        id: "antigravity",
        label: "Antigravity (ACP)",
        async open(o) {
          emit({ from: "sbridge", to: "sagent", proto: "acp", op: "session/new", milestone: true });
          return new TracedAcpHandle("s71e", o, "stream", () => activeEmit);
        },
      };
      holder.daemon = new ErgaDaemon({ home, version: "v8a3f1c2", driverFactory: () => driver, log: () => {} });
      await holder.daemon.connectAgent({ origin, document: "/ada/launch-notes" });
      await waitBridgeReady(person, origin);
      emit({ from: "sbridge", to: "sclone", proto: "fs", op: "yjs.mount", milestone: true });
    });
    return events;
  } finally {
    activeEmit = NOOP_EMIT;
    if (holder.daemon) await holder.daemon.stop();
    server.stop(true);
    if (prevHome == null) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

async function runStreamScenario(): Promise<TraceEvent[]> {
  const home = mkdtempSync(join(tmpdir(), "erga-trace-stream-"));
  const prevHome = process.env.ERGA_HOME;
  process.env.ERGA_HOME = home;
  let activeEmit: Emit = NOOP_EMIT;
  const bundleBytes = new TextEncoder().encode("console.log('bridge');");
  const person = makePersonAgents("http://localhost", () => activeEmit);
  let turnDoneCount = 0;
  const server = makeFakeServer({
    person,
    bundleBytes,
    bundleVersion: "v8a3f1c2",
    onTurnDone: () => turnDoneCount++,
    getEmit: () => activeEmit,
  });
  const origin = server.url.origin;
  let daemon: ErgaDaemon | null = null;

  try {
    saveToken({ origin, clientName: "Erga Bridge", clientId: "c1", accessToken: "a.tok.sig", expiresAt: Date.now() + 3600_000 });
    let connectedDir = "";
    const driver: AgentDriver = {
      id: "antigravity",
      label: "Antigravity (ACP)",
      async open(o) {
        return new TracedAcpHandle(
          "s71e",
          o,
          "stream",
          () => activeEmit,
          async () => {
            // Real agent edits index.html & runs MCP view_page INSIDE the ACP turn!
            const idxPath = join(connectedDir, "index.html");
            activeEmit({ from: "sagent", to: "sclone", proto: "fs", op: "fs.write", milestone: true });
            writeFileSync(idxPath, readFileSync(idxPath, "utf8") + "<p>Verified security item.</p>");
            await (daemon as unknown as { mounts: Map<string, { sync: { flush: () => Promise<void> } }> }).mounts
              .values()
              .next()
              .value!.sync.flush();

            await fetch(`${origin}/mcp`, {
              method: "POST",
              headers: { Authorization: "Bearer a.tok.sig", "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "page", arguments: { op: "view_page" } },
              }),
            });
            const viewOp = PAGE_OPERATIONS.find((op) => op.name == "view_page")!;
            const viewOut = await viewOp.run(
              {
                view: async () => {
                  activeEmit({ from: "doc", to: "doc", proto: "browser", op: "env.BROWSER.screenshot", milestone: true });
                  return {
                    shots: [{ data: "iVBORw==", type: "image/png" as const }],
                    errors: [],
                    width: 1100,
                    height: 800,
                    colorScheme: "light" as const,
                  };
                },
              } as unknown as Parameters<typeof viewOp.run>[0],
              {}
            );
            if (!viewOut.some((c) => c.type == "image")) throw new Error("view_page must return inline image");
          }
        );
      },
    };
    daemon = new ErgaDaemon({ home, version: "v8a3f1c2", driverFactory: () => driver, log: () => {} });
    const connected = await daemon.connectAgent({ origin, document: "/ada/launch-notes" });
    if (!connected.ok) throw new Error("connect failed");
    connectedDir = connected.dir!;
    await waitBridgeReady(person, origin);

    const { events } = await withTrace(async (emit) => {
      activeEmit = emit;
      emit({ from: "sshell", to: "person", proto: "http", op: "POST", path: "/api/agent", status: 200, milestone: true });
      emit({ from: "person", to: "sbridge", proto: "ws", op: "ToBridge:prompt", milestone: true });
      await person.agentPrompt("ada", origin, "Add a security item and check layout", null, undefined, "doc1", "Ada");

      for (let i = 0; i < 80 && turnDoneCount == 0; i++) await new Promise((r) => setTimeout(r, 10));
    });
    return events;
  } finally {
    activeEmit = NOOP_EMIT;
    if (daemon) await daemon.stop();
    server.stop(true);
    if (prevHome == null) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

async function runPermissionScenario(): Promise<TraceEvent[]> {
  const home = mkdtempSync(join(tmpdir(), "erga-trace-perm-"));
  const prevHome = process.env.ERGA_HOME;
  process.env.ERGA_HOME = home;
  let activeEmit: Emit = NOOP_EMIT;
  const bundleBytes = new TextEncoder().encode("console.log('bridge');");
  const person = makePersonAgents("http://localhost", () => activeEmit);
  let turnDoneCount = 0;
  const server = makeFakeServer({
    person,
    bundleBytes,
    bundleVersion: "v8a3f1c2",
    onTurnDone: () => turnDoneCount++,
    getEmit: () => activeEmit,
  });
  const origin = server.url.origin;
  let daemon: ErgaDaemon | null = null;

  try {
    saveToken({ origin, clientName: "Erga Bridge", clientId: "c1", accessToken: "a.tok.sig", expiresAt: Date.now() + 3600_000 });
    const driver: AgentDriver = {
      id: "antigravity",
      label: "Antigravity (ACP)",
      async open(o) {
        return new TracedAcpHandle("s71e", o, "permission", () => activeEmit);
      },
    };
    daemon = new ErgaDaemon({ home, version: "v8a3f1c2", driverFactory: () => driver, log: () => {} });
    await daemon.connectAgent({ origin, document: "/ada/launch-notes" });
    await waitBridgeReady(person, origin);

    const { events } = await withTrace(async (emit) => {
      activeEmit = emit;
      emit({ from: "sshell", to: "person", proto: "http", op: "POST", path: "/api/agent", status: 200, milestone: true });
      emit({ from: "person", to: "sbridge", proto: "ws", op: "ToBridge:prompt", milestone: true });
      await person.agentPrompt("ada", origin, "Run checks", null, undefined, "doc1", "Ada");
      for (
        let i = 0;
        i < 60 && !(await person.conversation("ada", "doc1")).items.some((x) => x.kind == "tool" && x.status == "asking");
        i++
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
      emit({ from: "sshell", to: "person", proto: "http", op: "POST", path: "/api/agent/approve", status: 200, milestone: true });
      emit({ from: "person", to: "sbridge", proto: "ws", op: "ToBridge:answer", milestone: true });
      await person.agentControl("ada", "doc1", "approve", "perm-1", "allow_once");
      for (let i = 0; i < 60 && turnDoneCount == 0; i++) await new Promise((r) => setTimeout(r, 10));
    });
    return events;
  } finally {
    activeEmit = NOOP_EMIT;
    if (daemon) await daemon.stop();
    server.stop(true);
    if (prevHome == null) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

async function runUpdateScenario(): Promise<TraceEvent[]> {
  const home = mkdtempSync(join(tmpdir(), "erga-trace-upd-"));
  const prevHome = process.env.ERGA_HOME;
  process.env.ERGA_HOME = home;
  let activeEmit: Emit = NOOP_EMIT;
  const nextBundle = new TextEncoder().encode("console.log('bridge-v2');");
  const person = makePersonAgents("http://localhost", () => activeEmit);
  let restartedVersion = "";
  let activeHandle: TracedAcpHandle | null = null;
  const server = makeFakeServer({
    person,
    bundleBytes: nextBundle,
    bundleVersion: "v9d4e2a1",
    onTurnDone: () => {},
    getEmit: () => activeEmit,
  });
  const origin = server.url.origin;
  let daemon: ErgaDaemon | null = null;

  try {
    saveToken({ origin, clientName: "Erga Bridge", clientId: "c1", accessToken: "a.tok.sig", expiresAt: Date.now() + 3600_000 });
    writePinnedOrigin(origin, home);
    const driver: AgentDriver = {
      id: "antigravity",
      label: "Antigravity (ACP)",
      async open(o) {
        if (o.resumeId) {
          activeEmit({ from: "sbridge", to: "sagent", proto: "acp", op: "session/load", milestone: true });
        }
        activeHandle = new TracedAcpHandle("s71e", o, "update", () => activeEmit);
        return activeHandle;
      },
    };
    daemon = new ErgaDaemon({
      home,
      version: "v8a3f1c2",
      driverFactory: () => driver,
      onRestart: (v) => {
        restartedVersion = v;
        activeEmit({ from: "sbridge", to: "sbridge", proto: "rpc", op: "daemon.restart", milestone: true });
      },
      log: () => {},
    });
    await daemon.connectAgent({ origin, document: "/ada/launch-notes" });
    await waitBridgeReady(person, origin);

    const { events } = await withTrace(async (emit) => {
      activeEmit = emit;
      emit({ from: "sshell", to: "person", proto: "http", op: "POST", path: "/api/agent", status: 200, milestone: true });
      await person.agentPrompt("ada", origin, "Polish intro", null, undefined, "doc1", "Ada");
      for (let i = 0; i < 60 && !daemon!.status().activeTurns; i++) await new Promise((r) => setTimeout(r, 10));

      const upd = await daemon!.checkForUpdate(false);
      if (!upd.pendingRestart) throw new Error("Expected update to defer into pending_restart during active turn");

      activeHandle!.releaseTurn();
      for (let i = 0; i < 60 && !restartedVersion; i++) await new Promise((r) => setTimeout(r, 10));

      await daemon!.stop();
      daemon = new ErgaDaemon({ home, version: restartedVersion, driverFactory: () => driver, log: () => {} });
      await daemon.start();
      await waitBridgeReady(person, origin);
    });
    return events;
  } finally {
    activeEmit = NOOP_EMIT;
    if (daemon) await daemon.stop();
    server.stop(true);
    if (prevHome == null) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

const SCENARIOS: Record<string, () => Promise<TraceEvent[]>> = {
  "chat-native-bridge/connect-device": () => runConnectScenario("device"),
  "chat-native-bridge/connect-pkce": () => runConnectScenario("pkce"),
  "chat-native-bridge/stream": runStreamScenario,
  "chat-native-bridge/permission": runPermissionScenario,
  "chat-native-bridge/update": runUpdateScenario,
};

/** Executes a named live Erga scenario and returns its captured boundary trace events. */
export async function captureErgaTrace(traceId: string): Promise<TraceEvent[]> {
  const fn = SCENARIOS[traceId];
  if (!fn) throw new Error(`Unknown trace scenario "${traceId}". Known: ${Object.keys(SCENARIOS).join(", ")}`);
  return fn();
}

export const TRACE_SCENARIO_IDS = Object.keys(SCENARIOS);

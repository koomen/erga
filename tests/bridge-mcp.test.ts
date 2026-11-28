// Tests for the MCP proxy (`erga-agent mcp`) and CLI unmount (`erga-agent unmount`).

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { saveToken } from "../bridge/core/auth.ts";
import { ErgaDaemon } from "../bridge/core/daemon.ts";
import { files, roomInfo } from "../document/model/content.ts";
import { encodeStart } from "../shared/room-socket.ts";
import { Decoder, Encoder, readSyncMessage, writeSyncStep1 } from "../shared/yjs-protocol.ts";

const CLI = join(import.meta.dir, "..", "bridge", "core", "cli.ts");

function makeMcpClient(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let nextId = 1;

  const readMsg = async (): Promise<Record<string, unknown>> => {
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl != -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) return JSON.parse(line) as Record<string, unknown>;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("MCP server closed stdout unexpectedly");
      buf += dec.decode(value, { stream: true });
    }
  };

  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await proc.stdin.flush();
    while (true) {
      const msg = await readMsg();
      if (msg.id === id) return msg;
    }
  };

  const close = async () => {
    proc.stdin.end();
    await proc.exited;
  };

  return {
    rpc,
    sendRaw: (msg: object) => {
      proc.stdin.write(JSON.stringify(msg) + "\n");
      void proc.stdin.flush();
    },
    readMsg,
    close,
  };
}

test("erga-agent mcp proxies remote Erga tools without duplicate local tools or permission hacks", async () => {
  const remoteTools = [
    { name: "documents", description: "Manage documents", inputSchema: { type: "object", properties: {} } },
    { name: "page", description: "Inspect live page", inputSchema: { type: "object", properties: {} } },
  ];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname != "/mcp" || req.method != "POST") return new Response("not found", { status: 404 });
      if (req.headers.get("authorization") != "Bearer tok-mcp") return new Response("unauthorized", { status: 401 });
      const body = (await req.json()) as { id: number; method: string; params?: Record<string, unknown> };
      calls.push({ method: body.method, params: body.params ?? {} });
      if (body.method == "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { instructions: "Remote Erga manual." } });
      }
      if (body.method == "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: remoteTools } });
      }
      if (body.method == "tools/call") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: `called:${String(body.params?.name ?? "")}` }] },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } });
    },
  });

  const home = mkdtempSync(join(tmpdir(), "erga-mcp-proxy-"));
  const origin = `http://127.0.0.1:${server.port}`;
  const env = { ERGA_HOME: home, ERGA_TOKEN: "", ERGA_SERVER: "" };
  const client = makeMcpClient(["mcp"], env);

  try {
    const init = (await client.rpc("initialize", { protocolVersion: "2025-06-18" })) as {
      result?: { instructions?: string };
    };
    expect(init.result?.instructions).toContain("erga-agent open");

    const beforeAuth = (await client.rpc("tools/list")) as { result?: { tools?: Array<{ name: string }> } };
    expect((beforeAuth.result?.tools ?? []).map((t) => t.name)).toEqual(["erga_api"]);

    const prevHome = process.env.ERGA_HOME;
    process.env.ERGA_HOME = home;
    try {
      saveToken({ origin, clientName: "Erga Bridge", clientId: "c1", accessToken: "tok-mcp", expiresAt: Date.now() + 60_000 });
    } finally {
      if (prevHome === undefined) delete process.env.ERGA_HOME;
      else process.env.ERGA_HOME = prevHome;
    }

    const afterAuth = (await client.rpc("tools/list")) as { result?: { tools?: Array<{ name: string }> } };
    expect((afterAuth.result?.tools ?? []).map((t) => t.name)).toEqual(["documents", "page"]);

    const callRes = (await client.rpc("tools/call", { name: "documents", arguments: { op: "list" } })) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(callRes.result?.content?.[0]?.text).toBe("called:documents");
    expect(calls.some((c) => c.method == "tools/call" && c.params.name == "documents")).toBe(true);
  } finally {
    await client.close();
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

test("erga-agent mcp dispatches stdio requests concurrently so a slow tool call does not block ping", async () => {
  let releaseTool!: () => void;
  const toolGate = new Promise<void>((r) => (releaseTool = r));
  let toolStarted!: () => void;
  const started = new Promise<void>((r) => (toolStarted = r));

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string };
      if (body.method == "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
      if (body.method == "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "page", description: "Page", inputSchema: { type: "object", properties: {} } }] },
        });
      }
      if (body.method == "tools/call") {
        toolStarted();
        await toolGate;
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "slow-done" }] } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } });
    },
  });

  const home = mkdtempSync(join(tmpdir(), "erga-mcp-conc-"));
  const origin = `http://127.0.0.1:${server.port}`;
  const prevHome = process.env.ERGA_HOME;
  process.env.ERGA_HOME = home;
  try {
    saveToken({ origin, clientName: "Erga Bridge", clientId: "c1", accessToken: "tok", expiresAt: Date.now() + 60_000 });
  } finally {
    if (prevHome === undefined) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = prevHome;
  }

  const client = makeMcpClient(["mcp", "--server", origin], { ERGA_HOME: home, ERGA_TOKEN: "" });
  try {
    await client.rpc("initialize", { protocolVersion: "2025-06-18" });
    client.sendRaw({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "page", arguments: { op: "view_page" } } });
    await started;
    client.sendRaw({ jsonrpc: "2.0", id: 11, method: "ping", params: {} });
    const first = await client.readMsg();
    expect(first.id).toBe(11);
    releaseTool();
    const second = await client.readMsg();
    expect(second.id).toBe(10);
    expect((second.result as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe("slow-done");
  } finally {
    await client.close();
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

test("erga-agent unmount closes a mounted document over bridge.sock without requiring --server", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.transact(() => {
    roomInfo(serverDoc).set("epoch", "ep-1");
    const t = new Y.Text();
    t.insert(0, "<h1>Hi</h1>");
    files(serverDoc).set("index.html", t);
  });

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

  const root = mkdtempSync("/tmp/erga-cli-unm-");
  const home = join(root, "home");
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
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
    const opened = await daemon.openDocument({ origin, document: "/d/doc1", cwd: work });
    expect(opened.ok).toBe(true);
    expect(daemon.status().mounts.map((m) => m.docId)).toEqual(["doc1"]);

    const proc = Bun.spawn([process.execPath, CLI, "unmount", "doc1"], {
      env: { ...process.env, ERGA_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out)).toEqual({ ok: true });
    expect(daemon.status().mounts).toEqual([]);
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

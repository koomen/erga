// Unit tests for the Claude Code side of the local agent bridge (tests/bridge.test.ts has the rest):
// - The Claude Code driver's stream (bridge/drivers/claude-code.ts), against a mock `claude`
// - A panel prompt's permission card, through the bridge's own MCP tool and the daemon
// - The terminal session's plugin hooks: the panel's events, the session's record, the hook's output

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Y from "yjs";
import { saveToken } from "../bridge/core/auth.ts";
import { ErgaDaemon } from "../bridge/core/daemon.ts";
import { BRIDGE_SESSION_ENV, type DriverEvent } from "../bridge/core/driver.ts";
import { findSession } from "../bridge/core/sessions.ts";
import { ALLOW_SESSION_CHOICE } from "../bridge/drivers/acp.ts";
import { claudeCodeHook, createClaudeCodeDriver } from "../bridge/drivers/claude-code.ts";
import { files, roomInfo } from "../document/model/content.ts";
import { encodeStart } from "../shared/room-socket.ts";
import { Decoder, Encoder, readSyncMessage, writeSyncStep1 } from "../shared/yjs-protocol.ts";

const CLI = resolve(import.meta.dir, "../bridge/core/cli.ts");

/** Polls until `fn` returns true (no fixed pauses). */
async function until(fn: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (; Date.now() < deadline && !fn(); ) await new Promise((r) => setTimeout(r, 15));
  if (!fn()) throw new Error(`Timed out waiting for ${what}`);
}

/**
 * A mock `claude -p` with stream-json input and output. It answers each user message with a thought, two
 * texts, a Bash call and a last text. With `--permission-prompt-tool` it asks that MCP tool about the
 * call first, as Claude Code does. "wait" starts a turn that never ends; "exit" ends the process.
 */
const MOCK = `
const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const delta = (d) => out({ type: "stream_event", event: { type: "content_block_delta", delta: d } });
const session = flag("--session-id") ?? flag("--resume");

async function ask(input) {
  const tool = flag("--permission-prompt-tool");
  if (!tool) return { behavior: "allow" };
  const [, server, name] = tool.split("__");
  const spec = JSON.parse(flag("--mcp-config")).mcpServers[server];
  const mcp = Bun.spawn([spec.command, ...spec.args], { env: { ...process.env, ...spec.env }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { tool_name: "Bash", input, tool_use_id: "tu-1" } } };
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\\n" + JSON.stringify(call) + "\\n");
  let buf = "";
  for await (const chunk of mcp.stdout) {
    buf += new TextDecoder().decode(chunk);
    const answer = buf.split("\\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id == 2);
    if (answer) {
      mcp.kill();
      return JSON.parse(answer.result.content[0].text);
    }
  }
  return { behavior: "deny", message: "no answer" };
}

for await (const line of console) {
  if (!line.trim()) continue;
  const text = JSON.parse(line).message.content[0].text;
  out({ type: "system", subtype: "init", session_id: session, model: "mock-model" });
  if (text == "exit") process.exit(0);
  if (text == "wait") continue;
  delta({ type: "thinking_delta", thinking: "Planning" });
  delta({ type: "text_delta", text: flag("--resume") ? "Resumed. " : "First. " });
  out({ type: "assistant", message: { content: [{ type: "text", text: (flag("--resume") ? "Resumed. " : "First. ") + "Whole." }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: "No delta." }] } });
  out({ type: "assistant", parent_tool_use_id: "tu-0", message: { content: [{ type: "tool_use", id: "sub-1", name: "Read", input: {} }] } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "echo ok" } }] } });
  const verdict = await ask({ command: "echo ok" });
  const denied = verdict.behavior != "allow";
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: denied, content: denied ? verdict.message : "ok" }] } });
  delta({ type: "text_delta", text: "Verdict: " + verdict.behavior });
  out({ type: "result", subtype: "success", is_error: false, result: "done" });
}
`;

/** Writes the mock `claude` into `dir`, and names it in CLAUDE_BIN until the returned function runs. */
function mockClaude(dir: string): () => void {
  writeFileSync(join(dir, "mock-claude.js"), MOCK);
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "mock-claude.js")}" "$@"\n`);
  chmodSync(bin, 0o755);
  const before = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = bin;
  return () => {
    if (before === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = before;
  };
}

test("Claude Code driver streams a turn, ends one on abort, and resumes its session in a new process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "erga-claude-driver-"));
  const restore = mockClaude(dir);
  try {
    const handle = await createClaudeCodeDriver().open({ cwd: dir });
    const events: DriverEvent[] = [];
    handle.onEvent((ev) => events.push(ev));

    await handle.prompt({ text: "Run it" });
    expect(handle.model).toBe("mock-model");
    expect(events).toEqual([
      { t: "busy", busy: true },
      { t: "thinking", delta: "Planning" },
      { t: "text", delta: "First. " },
      // What a message has more than its deltas, and a message that came with no delta.
      { t: "text", delta: "Whole." },
      { t: "text", delta: "\n\nNo delta." },
      // The subagent's own call (sub-1) is not shown.
      { t: "tool", id: "tu-1", name: "Bash", path: "echo ok", status: "running" },
      { t: "tool", id: "tu-1", name: "Bash", path: "echo ok", status: "done" },
      { t: "text", delta: "Verdict: allow" },
      { t: "busy", busy: false },
      { t: "turn_done" },
    ]);

    // An abort ends the turn with no error. The next prompt resumes the same session in a new process.
    events.length = 0;
    const waiting = handle.prompt({ text: "wait" });
    await until(() => events.length > 0, "the turn to start");
    await handle.abort();
    await waiting;
    expect(events).toEqual([{ t: "busy", busy: true }, { t: "busy", busy: false }, { t: "turn_done" }]);
    events.length = 0;
    await handle.prompt({ text: "Again" });
    expect(events).toContainEqual({ t: "text", delta: "Resumed. " });

    // A process that ends by itself: the panel hears of it, and the session resumes as well.
    events.length = 0;
    await handle.prompt({ text: "exit" });
    expect(events).toContainEqual({ t: "error", text: "Claude Code ended before it finished the turn." });
    events.length = 0;
    await handle.prompt({ text: "Once more" });
    expect(events).toContainEqual({ t: "text", delta: "Resumed. " });
    await handle.close();
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claudeCodeHook turns Claude Code's hook payloads into the bridge's, and never decides for the user", () => {
  const base = { session_id: "s1", cwd: "/repo", transcript_path: "/t.jsonl" };
  const session = { conversationId: "s1", cwd: "/repo", transcriptPath: "/t.jsonl" };
  const of = (raw: Record<string, unknown>) => claudeCodeHook({ ...base, ...raw });

  expect(of({ hook_event_name: "UserPromptSubmit", prompt: "Fix the title" }).payload).toEqual({
    ...session,
    hookEventName: "PreInvocation",
    invocationNum: 0,
    prompt: "Fix the title",
  });
  // Claude Code's own notice in a prompt is not what the user typed.
  expect(of({ hook_event_name: "UserPromptSubmit", prompt: "<task-notification>x</task-notification>" }).payload.prompt).toBeUndefined();

  const pre = of({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "tu-9", tool_input: { file_path: "/repo/a.html" } });
  expect(pre.payload).toEqual({
    ...session,
    hookEventName: "PreToolUse",
    toolCall: { id: "tu-9", name: "Edit", args: { file_path: "/repo/a.html" } },
  });
  // The daemon's answer to an Antigravity hook is an allow: Claude Code must not get it.
  expect(pre.reply({ decision: "allow" })).toEqual({});
  expect(pre.reply(null)).toEqual({});

  expect(of({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "tu-2", error: "exit 1" }).payload.error).toBe(
    "exit 1"
  );
  expect(of({ hook_event_name: "Stop", last_assistant_message: "Done." }).payload).toEqual({
    ...session,
    hookEventName: "Stop",
    reply: "Done.",
  });
});

test("Claude Code plugin: the panel shows the terminal session's turns, and a panel prompt asks its permission in the panel", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.transact(() => {
    roomInfo(serverDoc).set("epoch", "ep-1");
    const t = new Y.Text();
    t.insert(0, "<h1>Hello</h1>");
    files(serverDoc).set("index.html", t);
  });

  // A small Erga: the document's start and room, and the bridge's socket (what the panel gets and sends).
  const fromBridge: Record<string, unknown>[] = [];
  let panel: Bun.ServerWebSocket<{ path: string }> | null = null;
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

  const root = mkdtempSync(join(tmpdir(), "erga-claude-plugin-"));
  const home = join(root, "home");
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const restore = mockClaude(root);
  const before = { home: process.env.ERGA_HOME, token: process.env.ERGA_TOKEN };
  process.env.ERGA_HOME = home;
  delete process.env.ERGA_TOKEN;
  const origin = `http://127.0.0.1:${server.port}`;
  saveToken({ origin, clientName: "Claude Code", clientId: "c1", accessToken: "tok", expiresAt: Date.now() + 60_000 });

  const daemon = new ErgaDaemon(createClaudeCodeDriver(), {
    defaultOrigin: origin,
    defaultCwd: work,
    mcpSpec: (o) => ({ name: "erga", command: process.execPath, args: [CLI, "mcp", "--agent", "claude-code", "--server", o] }),
  });
  const events = () => fromBridge.filter((m) => m.type == "event").map((m) => m.ev as DriverEvent);
  const hook = async (raw: Record<string, unknown>) => {
    const call = claudeCodeHook({ session_id: "term-1", cwd: work, ...raw });
    return call.reply(await daemon.handleHook(call.payload));
  };

  try {
    daemon.startSocket();
    // The terminal session opens the document (via `erga-agent open`).
    const opened = await daemon.openDocument({ origin, document: "/d/doc1", cwd: work, conversationId: "term-1" });
    expect(opened.ok).toBe(true);
    await until(() => fromBridge.some((m) => m.type == "bind"), "the bind");
    expect(fromBridge.find((m) => m.type == "bind")).toMatchObject({ doc: "doc1", label: "Claude Code (work)", sessionId: "term-1" });

    // A turn in the terminal: the panel shows the prompt, the tool call and the reply, and the document cuts a version.
    expect(await hook({ hook_event_name: "UserPromptSubmit", prompt: "Fix the title" })).toEqual({});
    const edit = { tool_name: "Edit", tool_use_id: "tu-9", tool_input: { file_path: "index.html" } };
    expect(await hook({ hook_event_name: "PreToolUse", ...edit })).toEqual({});
    await hook({ hook_event_name: "PostToolUse", ...edit });
    await hook({ hook_event_name: "Stop", last_assistant_message: "The title is fixed." });
    await until(() => fromBridge.some((m) => m.type == "turn_done"), "the terminal turn's end");
    expect(events()).toEqual([
      { t: "user", text: "Fix the title" },
      { t: "busy", busy: true },
      { t: "tool", id: "tu-9", name: "Edit", path: "index.html", status: "running" },
      { t: "tool", id: "tu-9", name: "Edit", path: "index.html", status: "done" },
      { t: "text", delta: "The title is fixed." },
      { t: "busy", busy: false },
    ]);

    // A prompt from the panel runs in a session of the bridge's own. Its permission prompt is a card in the panel.
    fromBridge.length = 0;
    panel!.send(JSON.stringify({ type: "prompt", doc: "doc1", text: "Run it", context: null }));
    await until(() => events().some((e) => e.t == "tool" && e.status == "asking"), "the permission card");
    const card = events().find((e) => e.t == "tool" && e.status == "asking");
    expect(card).toMatchObject({ id: "tu-1", name: "Bash", path: "echo ok", call: { tool: "Bash", args: { command: "echo ok" } } });
    expect(card?.t == "tool" && card.choices?.map((c) => c.id)).toEqual(["deny", "allow", ALLOW_SESSION_CHOICE]);
    // The terminal's hooks stay out of the panel while the panel's own turn runs.
    await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "tu-10", tool_input: {} });
    panel!.send(JSON.stringify({ type: "answer", doc: "doc1", id: "tu-1", approve: false, choice: "deny" }));
    await until(() => fromBridge.some((m) => m.type == "turn_done"), "the panel turn's end");
    expect(events().some((e) => e.t == "tool" && e.id == "tu-10")).toBe(false);
    expect(events()).toContainEqual({
      t: "tool",
      id: "tu-1",
      name: "Bash",
      path: "echo ok",
      status: "error",
      detail: "The user denied this in Erga's agent panel.",
    });
    expect(events()).toContainEqual({ t: "text", delta: "Verdict: deny" });
  } finally {
    await daemon.stop();
    restore();
    if (before.home === undefined) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = before.home;
    if (before.token !== undefined) process.env.ERGA_TOKEN = before.token;
    server.stop(true);
    serverDoc.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("erga-agent hook records a Claude Code session and prints no decision; a session of the bridge's own stays out", async () => {
  const home = mkdtempSync(join(tmpdir(), "erga-claude-hook-"));
  const before = process.env.ERGA_HOME;
  process.env.ERGA_HOME = home;
  const run = async (session: string, env: Record<string, string>) => {
    const proc = Bun.spawn([process.execPath, CLI, "hook", "--agent", "claude-code"], {
      env: { ...process.env, ...env },
      stdin: new Blob([JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, cwd: `/repo/${session}`, tool_name: "Bash" })]),
      stdout: "pipe",
      stderr: "ignore",
    });
    return (await new Response(proc.stdout).text()).trim();
  };
  try {
    expect(await run("mine", {})).toBe("{}");
    expect(findSession("claude-code", { conversationId: "mine" })?.cwd).toBe("/repo/mine");
    expect(await run("bridge", { [BRIDGE_SESSION_ENV]: "bridge" })).toBe("{}");
    expect(findSession("claude-code", { cwd: "/repo/bridge" })?.conversationId).toBe("mine");
  } finally {
    if (before === undefined) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
});

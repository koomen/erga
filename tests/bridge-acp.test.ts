// Unit tests for the generic ACP stdio driver (bridge/drivers/acp.ts) and
// declarative standalone agent presets (bridge/drivers/presets.ts).

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOW_SESSION_CHOICE, createAcpDriver, permissionChoices } from "../bridge/drivers/acp.ts";
import { detectAgents, parseCommandString, resolveAgentPreset } from "../bridge/drivers/presets.ts";
import type { DriverEvent } from "../bridge/drivers/stdio.ts";

async function until(fn: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (; Date.now() < deadline && !fn(); ) await new Promise((r) => setTimeout(r, 15));
  if (!fn()) throw new Error("Timed out waiting for condition");
}

function writeFakeAcpServer(dir: string, mode: "load" | "resume" = "load"): string {
  const script = join(dir, `fake-acp-${mode}.mjs`);
  writeFileSync(
    script,
    `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let permCount = 0;
let pendingPerm = null;
let pendingPromptId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method == "initialize") {
    return out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, serverInfo: { name: "fake-acp", version: "1.0" } } });
  }
  if (msg.method == "session/load") {
    if (${JSON.stringify(mode)} == "resume") {
      return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "session/load not supported" } });
    }
    return out({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } });
  }
  if (msg.method == "session/resume") {
    return out({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } });
  }
  if (msg.method == "session/new") {
    const mcpNames = (msg.params?.mcpServers ?? []).map((s) => s.name).join(",");
    return out({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "sess-1:" + mcpNames,
        models: { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "Model One" }, { modelId: "m2", name: "Model Two" }] },
        modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "auto", name: "Auto" }] },
      },
    });
  }
  if (msg.method == "session/set_model") {
    return out({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
  if (msg.method == "session/set_mode") {
    return out({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
  if (msg.method == "session/prompt") {
    const text = (msg.params?.prompt ?? []).map((b) => b.text || "").join(" ");
    out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking..." } } } });
    if (text.includes("need-perm")) {
      permCount++;
      const callId = "call-" + permCount;
      pendingPromptId = msg.id;
      pendingPerm = { id: "perm-rpc-" + permCount, callId };
      out({
        jsonrpc: "2.0",
        id: pendingPerm.id,
        method: "session/request_permission",
        params: {
          toolCall: { toolCallId: callId, name: "run_command", title: "Run checks", args: { command: "bun run check" } },
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "t1", name: "edit_file", args: { path: "index.html" }, status: "in_progress" } } });
    out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } } });
    out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Echo: " + text } } } });
    return out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
  if (msg.method == "session/cancel") {
    if (pendingPromptId != null) {
      const id = pendingPromptId;
      pendingPromptId = null;
      pendingPerm = null;
      out({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    }
    return;
  }
  if (msg.method === undefined && pendingPerm && msg.id == pendingPerm.id) {
    const outcome = msg.result?.outcome;
    const callId = pendingPerm.callId;
    const pid = pendingPromptId;
    pendingPerm = null;
    pendingPromptId = null;
    out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: callId, status: outcome?.outcome == "selected" && outcome?.optionId != "deny" ? "completed" : "failed" } } });
    out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Perm:" + (outcome?.optionId || outcome?.outcome) } } } });
    if (pid != null) out({ jsonrpc: "2.0", id: pid, result: { stopReason: "end_turn" } });
    return;
  }
  if (msg.method == "session/close") {
    out({ jsonrpc: "2.0", id: msg.id, result: {} });
    process.exit(0);
  }
});
`
  );
  return script;
}

test("ACP driver handles initialize, mcpServers, streaming, permission choices, allow-all-session, setModel, and session/load + session/resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "erga-acp-test-"));
  const loadScript = writeFakeAcpServer(dir, "load");
  const resumeScript = writeFakeAcpServer(dir, "resume");

  try {
    const driver = createAcpDriver({ id: "fake", label: "Fake ACP", command: process.execPath, args: [loadScript] });
    const handle = await driver.open({
      cwd: dir,
      mcpServers: [{ name: "erga", command: "erga-agent", args: ["mcp"] }],
    });
    expect(handle.sessionId).toBe("sess-1:erga");
    expect(handle.model).toBe("m1");
    expect(handle.models.map((m) => m.id)).toEqual(["m1", "m2"]);

    const events: DriverEvent[] = [];
    handle.onEvent((ev) => events.push(ev));

    // Normal streaming turn: thought + tool_call + tool_call_update + text + busy + turn_done.
    await handle.prompt({ text: "hello world" });
    expect(events.some((e) => e.t == "thinking" && e.delta == "Thinking...")).toBe(true);
    expect(events.some((e) => e.t == "tool" && e.name == "edit_file" && e.path == "index.html" && e.status == "done")).toBe(true);
    expect(events.some((e) => e.t == "text" && e.delta == "Echo: hello world")).toBe(true);
    expect(events.at(-1)).toEqual({ t: "turn_done" });

    // Permission prompt -> structured choices including Allow all (session).
    events.length = 0;
    const p1 = handle.prompt({ text: "need-perm 1" });
    await until(() => events.some((e) => e.t == "tool" && e.status == "asking"));
    const ask = events.find((e) => e.t == "tool" && e.status == "asking");
    expect(ask?.t == "tool" && ask.choices?.map((c) => c.label)).toEqual(["Deny", "Allow once", "Allow all (session)"]);
    expect(await handle.answer(ask!.t == "tool" ? ask!.id : "", true, ALLOW_SESSION_CHOICE)).toBe(true);
    await p1;
    expect(events.some((e) => e.t == "text" && e.delta == "Perm:allow_once")).toBe(true);

    // Subsequent permission in the same session auto-approves immediately without emitting asking.
    events.length = 0;
    await handle.prompt({ text: "need-perm 2" });
    expect(events.some((e) => e.t == "tool" && e.status == "asking")).toBe(false);
    expect(events.some((e) => e.t == "text" && e.delta == "Perm:allow_once")).toBe(true);

    // Model switch updates current model.
    expect(await handle.setModel?.("m2")).toBe(true);
    expect(handle.model).toBe("m2");

    await handle.close();

    // Standard ACP session/load restores the exact sessionId.
    const loaded = await driver.open({ cwd: dir, resumeId: "saved-session-99" });
    expect(loaded.sessionId).toBe("saved-session-99");
    await loaded.close();

    // Fallback to session/resume when an agent does not implement session/load.
    const resumeDriver = createAcpDriver({ id: "fake-r", label: "Fake Resume", command: process.execPath, args: [resumeScript] });
    const resumed = await resumeDriver.open({ cwd: dir, resumeId: "agy-session-42" });
    expect(resumed.sessionId).toBe("agy-session-42");
    await resumed.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("permissionChoices orders Deny, Allow, Always and appends Allow all (session)", () => {
  const choices = permissionChoices([
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ]);
  expect(choices.map((c) => [c.id, c.label, c.kind])).toEqual([
    ["deny", "Deny", "deny"],
    ["allow", "Allow once", "allow"],
    ["always", "Always allow", "always"],
    [ALLOW_SESSION_CHOICE, "Allow all (session)", "always"],
  ]);
});

test("presets resolve direct binaries, bunx adapters, aliases, and custom --acp commands", () => {
  expect(parseCommandString(`my-agent --flag "two words" 'three words'`)).toEqual(["my-agent", "--flag", "two words", "three words"]);

  const fakeWhich = (bins: Record<string, string>) => (b: string) => bins[b] ?? null;

  const agy = resolveAgentPreset({ agent: "agy" }, fakeWhich({ agy: "/usr/local/bin/agy" }));
  expect(agy).toMatchObject({
    id: "antigravity",
    label: "Antigravity",
    command: "/usr/local/bin/agy",
    args: ["acp"],
    addDirFlag: "--add-dir",
  });

  const claude = resolveAgentPreset({ agent: "claude" }, fakeWhich({ claude: "/bin/claude", bunx: "/bin/bunx" }));
  expect(claude).toMatchObject({ id: "claude-code", command: "/bin/bunx", args: ["@agentclientprotocol/claude-agent-acp"] });

  const detected = detectAgents(fakeWhich({ codex: "/bin/codex", bunx: "/bin/bunx", opencode: "/bin/opencode" }));
  expect(detected.filter((d) => d.available).map((d) => [d.id, d.via])).toEqual([
    ["codex", "bunx"],
    ["opencode", "direct"],
  ]);

  const custom = resolveAgentPreset({ acp: `"/opt/my agent" --acp --verbose` }, fakeWhich({}));
  expect(custom).toMatchObject({ command: "/opt/my agent", args: ["--acp", "--verbose"] });
});

// The helper (helper/, Rust: the program `erga` beside an agent's session), through its own doors: a pretend Erga (the
// gate's sign-in endpoints and the link's WebSocket), the real program as the plugin's monitor (`erga link`), and its
// hooks as Claude Code runs them (`erga hook`, the event on stdin). The sign-in with PKCE, the hello, the map from
// hooks to AG-UI, a message and an answer from the panel, Stop, and the header for MCP.
//
// It needs Rust (cargo): without it, this file runs nothing, and says so. The build goes to one folder for every clone
// and work folder of the machine (helper/build.ts, TARGET), so only a machine's first run builds for long.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerWebSocket, Subprocess } from "bun";
import { TARGET } from "../helper/build.ts";
import { until } from "./helpers/until.ts";

const ROOT = resolve(import.meta.dir, "..");
const CARGO = Bun.which("cargo") ?? (existsSync(`${process.env.HOME}/.cargo/bin/cargo`) ? `${process.env.HOME}/.cargo/bin/cargo` : null);
if (!CARGO) console.log("tests/helper.test.ts: not run: cargo is not installed (the helper's tests need Rust).");
const cargo = (...args: string[]) =>
  Bun.spawnSync([CARGO!, ...args, "--manifest-path", join(ROOT, "helper/Cargo.toml")], {
    env: { ...process.env, CARGO_TARGET_DIR: TARGET },
    stderr: "pipe",
  });
const BIN = join(TARGET, "debug", "erga");

const dir = mkdtempSync(join(tmpdir(), "erga-helper-"));
/** A short folder for the session's socket (a socket's path is at most 104 characters). */
const run = mkdtempSync("/tmp/eh-");
const SESSION = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

// ---------------------------------------------------------------- the pretend Erga

/** What the pretend Erga saw: the registration, each trade at the token endpoint, and the link's frames. */
const seen = {
  registered: null as Record<string, unknown> | null,
  trades: [] as Record<string, string>[],
  frames: [] as Record<string, unknown>[],
  auth: "",
};
let socket: ServerWebSocket<unknown> | null = null;
let challenge = "";
let tokens = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request, srv) {
    const url = new URL(request.url);
    const at = `http://127.0.0.1:${srv.port}`;
    if (url.pathname == "/.well-known/oauth-protected-resource")
      return Response.json({ resource: `${at}/mcp`, authorization_servers: [at] });
    if (url.pathname == "/.well-known/oauth-authorization-server")
      return Response.json({
        authorization_endpoint: `${at}/oauth/authorize`,
        token_endpoint: `${at}/oauth/token`,
        registration_endpoint: `${at}/oauth/register`,
      });
    if (url.pathname == "/oauth/register") {
      seen.registered = (await request.json()) as Record<string, unknown>;
      return Response.json({ client_id: "Claude-Code.abc123" }, { status: 201 });
    }
    if (url.pathname == "/oauth/token") {
      const fields = Object.fromEntries(new URLSearchParams(await request.text()));
      seen.trades.push(fields);
      // The code counts only with the verifier of the challenge that the approve page got.
      if (fields.grant_type == "authorization_code" && createHash("sha256").update(fields.code_verifier).digest("base64url") != challenge)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: `token-${++tokens}`, refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname == "/api/agent/link") {
      seen.auth = request.headers.get("authorization") ?? "";
      if (!/^Bearer token-\d+$/.test(seen.auth)) return new Response("Sign in first.", { status: 401 });
      return srv.upgrade(request) ? undefined : new Response("no", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      socket = ws;
    },
    message(_, text) {
      seen.frames.push(JSON.parse(String(text)));
    },
  },
});
const ERGA = `http://127.0.0.1:${server.port}`;

// ---------------------------------------------------------------- the program

/** Where the "browser" that the helper opens writes the sign-in's address. */
const opened = join(dir, "opened");
writeFileSync(join(dir, "browser.sh"), `#!/bin/sh\necho "$1" > "${opened}"\n`, { mode: 0o755 });
const env = {
  PATH: process.env.PATH ?? "",
  HOME: dir,
  XDG_RUNTIME_DIR: run,
  ERGA_HELPER_STORE: join(dir, "store"),
  BROWSER: join(dir, "browser.sh"),
  CLAUDE_CODE_SESSION_ID: SESSION,
};
let link: Subprocess<"ignore", "pipe", "pipe"> | null = null;
/** The monitor's lines so far (what Claude Code would give to Claude). */
let printed = "";
async function startLink() {
  link = Bun.spawn([BIN, "link", "--server", ERGA], { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of link!.stdout) printed += decoder.decode(chunk);
  })();
}
/** One hook of the session, as Claude Code runs it: the event on stdin; what the hook printed, as JSON (null: nothing). */
async function hook(event: string, more: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
  const p = Bun.spawn([BIN, "hook"], { env, stdin: "pipe", stdout: "pipe" });
  p.stdin.write(JSON.stringify({ session_id: SESSION, hook_event_name: event, cwd: dir, ...more }));
  await p.stdin.end();
  const out = (await new Response(p.stdout).text()).trim();
  return out ? (JSON.parse(out) as Record<string, unknown>) : null;
}
/** The frames that came up since the last call, as their types. */
let read = 0;
const types = async (n: number) => {
  await until(() => seen.frames.length >= read + n, 3000);
  const got = seen.frames.slice(read);
  read = seen.frames.length;
  return got.map((f) => String(f.type));
};

beforeAll(() => {
  if (!CARGO) return;
  const built = cargo("build", "--quiet");
  if (built.exitCode != 0) throw new Error(`the helper does not build:\n${built.stderr.toString()}`);
}, 300_000);
afterAll(() => {
  link?.kill();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  rmSync(run, { recursive: true, force: true });
});

test.skipIf(!CARGO)("the helper's own unit tests pass (cargo test): the map from hooks to AG-UI", () => {
  const r = cargo("test", "--quiet");
  expect(r.exitCode, r.stdout.toString() + r.stderr.toString()).toBe(0);
});

test.skipIf(!CARGO)("not attached, a hook ends at once with no word; the header for MCP is there, with no token in it", async () => {
  expect(await hook("PreToolUse", { tool_name: "Bash", tool_use_id: "c0", tool_input: {} })).toBeNull();
  const header = Bun.spawnSync([BIN, "header", "--server", ERGA], { env });
  expect(JSON.parse(header.stdout.toString())).toEqual({ Authorization: "Bearer not-signed-in" });
});

test.skipIf(!CARGO)("the link signs in with PKCE in the person's browser, keeps the grant, and says who the session is", async () => {
  await hook("SessionStart", { source: "startup", model: "claude-fable-5-2" });
  await startLink();
  await until(() => existsSync(opened), 5000);
  const approve = new URL(readFileSync(opened, "utf8").trim());
  expect(approve.origin + approve.pathname).toBe(`${ERGA}/oauth/authorize`);
  const q = Object.fromEntries(approve.searchParams);
  expect(q).toMatchObject({
    response_type: "code",
    client_id: "Claude-Code.abc123",
    code_challenge_method: "S256",
    resource: `${ERGA}/mcp`,
  });
  expect(q.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  expect(seen.registered).toEqual({ client_name: "Claude Code", redirect_uris: [q.redirect_uri], token_endpoint_auth_method: "none" });
  challenge = q.code_challenge;
  // A callback with another state is not the sign-in's: the helper takes no code from it.
  expect(await (await fetch(`${q.redirect_uri}?code=stolen&state=other`)).text()).toContain("did not attach");
  // The person approves: the browser comes back with the code.
  expect(await (await fetch(`${q.redirect_uri}?code=the-code&state=${q.state}`)).text()).toContain("This session is attached to Erga.");
  await until(() => socket != null, 5000);
  expect(seen.trades).toMatchObject([
    { grant_type: "authorization_code", code: "the-code", client_id: "Claude-Code.abc123", redirect_uri: q.redirect_uri },
  ]);
  expect(seen.auth).toBe("Bearer token-1");
  expect(await types(1)).toEqual(["CUSTOM"]);
  expect(seen.frames[0]).toMatchObject({ name: "hello", value: { session: SESSION, agent: "Claude Code", model: "Fable 5.2" } });
  await until(() => printed.includes("[Erga] This session is attached"), 3000);
  expect(printed).toContain("/mcp reconnect all");
  // The same sign-in gives Claude Code the header for Erga's MCP server.
  const header = Bun.spawnSync([BIN, "header", "--server", ERGA], { env });
  expect(JSON.parse(header.stdout.toString())).toEqual({ Authorization: "Bearer token-1" });
  // The credentials are in a file that only the person reads (ERGA_HELPER_STORE; the keychain, on a Mac).
  const kept = Bun.spawnSync([
    "sh",
    "-c",
    `stat -f %Lp "${env.ERGA_HELPER_STORE}"/*.json 2>/dev/null || stat -c %a "${env.ERGA_HELPER_STORE}"/*.json`,
  ]);
  expect(kept.stdout.toString().trim()).toBe("600");
});

test.skipIf(!CARGO)("a prompt in the terminal, its text and a tool call go up as AG-UI events", async () => {
  await hook("UserPromptSubmit", { prompt: "Use winter.jpg as the background" });
  expect(await types(1)).toEqual(["RUN_STARTED"]);
  expect(seen.frames.at(-1)).toMatchObject({
    threadId: SESSION,
    input: { messages: [{ role: "user", content: "Use winter.jpg as the background" }] },
  });
  await hook("MessageDisplay", { message_id: "m1", index: 0, final: true, delta: "I'll make it smaller first." });
  expect(await hook("PreToolUse", { tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "sips -Z 1600 winter.jpg" } })).toBeNull();
  expect(await types(4)).toEqual(["TEXT_MESSAGE_CHUNK", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
});

test.skipIf(!CARGO)("a permission prompt waits: the panel's Approve is the hook's answer", async () => {
  const waits = hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "sips -Z 1600 winter.jpg" } });
  expect(await types(1)).toEqual(["RUN_FINISHED"]);
  const ask = seen.frames.at(-1) as { runId: string; outcome: { type: string; interrupts: { id: string; toolCallId: string }[] } };
  expect(ask.outcome).toMatchObject({ type: "interrupt", interrupts: [{ reason: "permission", toolCallId: "c1" }] });
  socket!.send(
    JSON.stringify({
      threadId: SESSION,
      runId: "panel-2",
      messages: [],
      resume: [{ interruptId: ask.outcome.interrupts[0].id, status: "resolved", payload: { approved: true } }],
    })
  );
  expect(await waits).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  expect(await types(1)).toEqual(["RUN_STARTED"]);
  expect(seen.frames.at(-1)).toMatchObject({ runId: "panel-2", parentRunId: ask.runId });
  await hook("PostToolUse", { tool_name: "Bash", tool_use_id: "c1", tool_response: { stdout: "ok", stderr: "" } });
  await hook("Stop", { last_assistant_message: "Done." });
  expect(await types(2)).toEqual(["TOOL_CALL_RESULT", "RUN_FINISHED"]);
});

test.skipIf(!CARGO)("a message from the panel is the monitor's line; Stop from the panel ends the turn at the next tool", async () => {
  const text = "Add a map of our days";
  socket!.send(
    JSON.stringify({
      threadId: SESSION,
      runId: "panel-3",
      messages: [{ id: "u", role: "user", content: text }],
      context: [{ description: "open", value: "Open: Trip" }],
    })
  );
  await until(() => printed.includes(`${text}\n[In Erga: Open: Trip]\n`), 3000);
  // Claude Code gives the monitor's line to Claude as a prompt: the run has the panel's id.
  const prompt = `<task-notification>\n<summary>Monitor event: "Messages from the Erga panel"</summary>\n<event>${text}\n[In Erga: Open: Trip]</event>\n</task-notification>`;
  await hook("UserPromptSubmit", { prompt });
  expect(await types(1)).toEqual(["RUN_STARTED"]);
  expect(seen.frames.at(-1)).toMatchObject({ runId: "panel-3" });
  expect(seen.frames.at(-1)).not.toHaveProperty("input");
  socket!.send(JSON.stringify({ cancel: "panel-3" }));
  // (The cancel and the hook come by two ways: the hook after the cancel got there stops the turn.)
  let reply: Record<string, unknown> | null = null;
  await until(
    async () =>
      (reply = await hook("PreToolUse", {
        tool_name: "Bash",
        tool_use_id: `c${seen.frames.length}`,
        tool_input: { command: "sleep 9" },
      })) != null,
    3000
  );
  expect(reply).toMatchObject({
    continue: false,
    stopReason: "Stopped from the Erga panel",
    hookSpecificOutput: { permissionDecision: "deny" },
  });
  await until(() => seen.frames.at(-1)?.type == "RUN_FINISHED", 3000);
  expect(seen.frames.at(-1)).toMatchObject({ runId: "panel-3", outcome: { type: "cancelled" } });
});

test.skipIf(!CARGO)("a token that ended is made again with the refresh grant; the session's end closes the link", async () => {
  const store = join(env.ERGA_HELPER_STORE, `http---127.0.0.1-${server.port}.json`);
  const kept = JSON.parse(readFileSync(store, "utf8")) as { expires: number; refresh: string };
  writeFileSync(store, JSON.stringify({ ...kept, expires: 0 }));
  // (Not spawnSync: the helper asks the pretend Erga, which this process serves.)
  const header = Bun.spawn([BIN, "header", "--server", ERGA], { env, stdout: "pipe" });
  expect(JSON.parse(await new Response(header.stdout).text())).toEqual({ Authorization: "Bearer token-2" });
  expect(seen.trades.at(-1)).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "Claude-Code.abc123" });
  await hook("SessionEnd", { reason: "other" });
  expect(await link!.exited).toBe(0);
  expect(await hook("Stop")).toBeNull();
});

// The helper beside a Codex session (helper/, `erga`): Codex has no monitor, so its hooks start the link ("erga
// attach"), a message from the panel goes in with `codex queue`, the turn's text comes at its end, and a stop is
// `turn/interrupt` on the socket of Codex's local server. A pretend Erga, a pretend `codex` program and a pretend
// local server stand in; the helper is the real program. (tests/helper.test.ts has the sign-in and Claude Code's side.)
//
// It needs Rust (cargo): without it, this file runs nothing, and says so.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { TARGET } from "../helper/build.ts";
import { until } from "./helpers/until.ts";

const ROOT = resolve(import.meta.dir, "..");
const CARGO = Bun.which("cargo") ?? (existsSync(`${process.env.HOME}/.cargo/bin/cargo`) ? `${process.env.HOME}/.cargo/bin/cargo` : null);
if (!CARGO) console.log("tests/helper-codex.test.ts: not run: cargo is not installed (the helper's tests need Rust).");
const BIN = join(TARGET, "debug", "erga");
/** A short folder: the sockets' paths are at most 104 characters. */
const dir = mkdtempSync("/tmp/ec-");
const SESSION = "11112222-3333-4444-5555-666677778888";

/** The pretend Erga: the link's far end. */
const frames: Record<string, unknown>[] = [];
let link: ServerWebSocket<unknown> | null = null;
const erga = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request, srv) =>
    new URL(request.url).pathname == "/api/agent/link" && srv.upgrade(request) ? undefined : new Response("no", { status: 404 }),
  websocket: {
    open(ws) {
      link = ws;
    },
    message(_, text) {
      frames.push(JSON.parse(String(text)));
    },
    close() {
      link = null;
    },
  },
});
const ERGA = `http://127.0.0.1:${erga.port}`;

/** Codex's pretend local server: what it was asked, on the socket where Codex has it. */
const asked: Record<string, unknown>[] = [];
mkdirSync(join(dir, "codex/app-server-control"), { recursive: true });
const daemon = Bun.serve({
  unix: join(dir, "codex/app-server-control/app-server-control.sock"),
  fetch: (request, srv) => (srv.upgrade(request) ? undefined : new Response("no", { status: 400 })),
  websocket: {
    message(ws, text) {
      const m = JSON.parse(String(text)) as { id?: number; method: string };
      asked.push(m);
      if (m.id != null) ws.send(JSON.stringify({ id: m.id, result: {} }));
    },
  },
});

/** The pretend `codex`: it keeps the arguments of each call. */
mkdirSync(join(dir, "bin"));
writeFileSync(
  join(dir, "bin/codex"),
  `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> "${dir}/calls"\nprintf '\\n' >> "${dir}/calls"\n`,
  { mode: 0o755 }
);
const calls = () =>
  existsSync(join(dir, "calls"))
    ? readFileSync(join(dir, "calls"), "utf8")
        .split("\x1f\n")
        .filter(Boolean)
        .map((l) => l.split("\x1f"))
    : [];

const env = {
  PATH: `${join(dir, "bin")}:${process.env.PATH}`,
  HOME: dir,
  XDG_RUNTIME_DIR: join(dir, "run"),
  ERGA_HELPER_STORE: join(dir, "store"),
  CODEX_HOME: join(dir, "codex"),
};
/** One hook of the Codex session, as Codex runs it (its hooks name the server). */
async function hook(event: string, more: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
  const p = Bun.spawn([BIN, "hook", "--server", ERGA], { env, stdin: "pipe", stdout: "pipe" });
  p.stdin.write(
    JSON.stringify({ session_id: SESSION, hook_event_name: event, cwd: dir, model: "gpt-5.5-codex", turn_id: "turn-1", ...more })
  );
  await p.stdin.end();
  const out = (await new Response(p.stdout).text()).trim();
  return out ? (JSON.parse(out) as Record<string, unknown>) : null;
}
let read = 0;
const types = async (n: number) => {
  await until(() => frames.length >= read + n, 3000);
  const got = frames.slice(read);
  read = frames.length;
  return got.map((f) => String(f.type));
};

beforeAll(() => {
  if (!CARGO) return;
  const built = Bun.spawnSync([CARGO, "build", "--quiet", "--manifest-path", join(ROOT, "helper/Cargo.toml")], {
    env: { ...process.env, CARGO_TARGET_DIR: TARGET },
    stderr: "pipe",
  });
  if (built.exitCode != 0) throw new Error(`the helper does not build:\n${built.stderr.toString()}`);
  // The helper is signed in already (tests/helper.test.ts has the sign-in).
  mkdirSync(env.ERGA_HELPER_STORE, { recursive: true });
  writeFileSync(
    join(env.ERGA_HELPER_STORE, `http---127.0.0.1-${erga.port}.json`),
    JSON.stringify({ client: "c", token: "token-1", refresh: "r", expires: 4102444800 })
  );
}, 300_000);
afterAll(async () => {
  // The link ends with its session (it runs apart from this process).
  if (link) await hook("SessionEnd", { reason: "other" });
  erga.stop(true);
  daemon.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!CARGO)(
  "`erga codex` adds the helper's hooks to Codex's own file, keeps the person's other hooks, and takes its own out again",
  () => {
    const file = join(env.CODEX_HOME, "hooks.json");
    const mine = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
    writeFileSync(file, JSON.stringify(mine));
    const added = Bun.spawnSync([BIN, "codex", "--server", ERGA], { env });
    expect(added.stdout.toString()).toContain("type: erga attach");
    const hooks = (
      JSON.parse(readFileSync(file, "utf8")) as { hooks: Record<string, { hooks: { command: string; timeout?: number }[] }[]> }
    ).hooks;
    expect(Object.keys(hooks).sort()).toEqual([
      "Interrupt",
      "PermissionRequest",
      "PostToolUse",
      "PreToolUse",
      "SessionEnd",
      "Stop",
      "UserPromptSubmit",
    ]);
    expect(hooks.Stop.map((e) => e.hooks[0].command)).toEqual(["say done", `"${BIN}" hook --server ${ERGA}`]);
    expect(hooks.PermissionRequest[0].hooks[0].timeout).toBe(600);
    // A second time adds nothing more.
    Bun.spawnSync([BIN, "codex", "--server", ERGA], { env });
    expect((JSON.parse(readFileSync(file, "utf8")) as typeof mine).hooks.Stop.length).toBe(2);
    Bun.spawnSync([BIN, "codex", "--server", ERGA, "--remove"], { env });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(mine);
  }
);

test.skipIf(!CARGO)(
  '"erga attach" in a Codex session starts the link: the prompt stops at the hook, and the session says who it is',
  async () => {
    // Any other prompt of a session that is not attached passes with no word.
    expect(await hook("UserPromptSubmit", { prompt: "Fix the build" })).toBeNull();
    const reply = await hook("UserPromptSubmit", { prompt: "erga attach" });
    expect(reply).toMatchObject({ decision: "block" });
    expect(String(reply!.reason)).toContain("Attaching this session to Erga");
    expect(await types(1)).toEqual(["CUSTOM"]);
    expect(frames[0]).toMatchObject({ name: "hello", value: { session: SESSION, agent: "Codex", model: "Gpt 5.5 Codex" } });
    expect(await hook("UserPromptSubmit", { prompt: "Erga attach" })).toMatchObject({
      reason: "This session is attached to Erga: your agent panel shows it.",
    });
  }
);

test.skipIf(!CARGO)("a message from the panel goes in with `codex queue`, and the turn's text comes up at its end", async () => {
  link!.send(
    JSON.stringify({
      threadId: SESSION,
      runId: "panel-1",
      messages: [{ id: "u", role: "user", content: "Add a map" }],
      context: [{ description: "open", value: "Open: Trip" }],
    })
  );
  await until(() => calls().length == 1, 3000);
  const text = "Add a map\n[In Erga: Open: Trip]";
  expect(calls()[0]).toEqual(["queue", "--thread", SESSION, "--message", text]);
  // Codex starts the turn with the message: its prompt hook has the same text.
  await hook("UserPromptSubmit", { prompt: text });
  expect(await types(1)).toEqual(["RUN_STARTED"]);
  expect(frames.at(-1)).toMatchObject({ runId: "panel-1" });
  await hook("PreToolUse", { tool_name: "shell", tool_use_id: "c1", tool_input: { command: "ls" } });
  await hook("PostToolUse", { tool_name: "shell", tool_use_id: "c1", tool_input: { command: "ls" }, tool_response: "map.js" });
  await hook("Stop", { last_assistant_message: "The map is on the page." });
  expect(await types(6)).toEqual([
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "TOOL_CALL_RESULT",
    "TEXT_MESSAGE_CHUNK",
    "RUN_FINISHED",
  ]);
  expect(frames.at(-2)).toMatchObject({ delta: "The map is on the page." });
});

test.skipIf(!CARGO)("Stop from the panel is Codex's own interrupt, at once; the session's end closes the link", async () => {
  await hook("UserPromptSubmit", { prompt: "Tidy the folder", turn_id: "turn-2" });
  expect(await types(1)).toEqual(["RUN_STARTED"]);
  link!.send(JSON.stringify({ cancel: String(frames.at(-1)!.runId) }));
  await until(() => asked.some((m) => m.method == "turn/interrupt"), 3000);
  expect(asked.map((m) => m.method)).toEqual(["initialize", "initialized", "turn/interrupt"]);
  expect(asked.at(-1)).toMatchObject({ params: { threadId: SESSION, turnId: "turn-2" } });
  // Codex ends the turn, and says so with its Interrupt hook.
  await hook("Interrupt", { turn_id: "turn-2" });
  expect(await types(1)).toEqual(["RUN_FINISHED"]);
  expect(frames.at(-1)).toMatchObject({ outcome: { type: "cancelled" } });
  await hook("SessionEnd", { reason: "other" });
  await until(() => link == null, 3000);
});

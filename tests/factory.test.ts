// The factory's pure parts (README, The factory): branch names, and what a
// git token lets a VM push (dev/factory.ts, which the real Git endpoint
// should match).

import { expect, test } from "bun:test";
import { checkGitToken, mintGitToken, pushedRefs, refsAllowed } from "../dev/factory";
import { branchName, claudeToken, restartPrompt, taskPrompt } from "../factory/prompt";

test("branch names follow the task queue's", () => {
  expect(branchName(46, "Experimental: the task queue inside Erga, with Claude Code in Cloudflare VMs")).toBe("task/46-experimental-the-task-queue-inside-erga");
  expect(branchName(3, "!!!")).toBe("task/3-task");
  expect(branchName(7, "Fix  the  thing ")).toBe("task/7-fix-the-thing");
});

test("a pasted Claude token loses the spaces and line breaks the terminal put in it", () => {
  const real = `sk-ant-oat01-${"Ab9_-".repeat(20)}`;
  expect(claudeToken(real)).toEqual({ token: real });
  expect(claudeToken(`  ${real.slice(0, 40)}\n  ${real.slice(40, 80)}\r\n${real.slice(80)} \t`)).toEqual({ token: real });
  expect(claudeToken(`${real.slice(0, 50)} ${real.slice(50)}`)).toEqual({ token: real });
});

test("a bad Claude token is refused with the reason, and never repeated", () => {
  const why = (raw: string) => { const r = claudeToken(raw); expect("error" in r).toBe(true); const e = (r as { error: string }).error; if (raw.trim()) expect(e).not.toContain(raw.trim()); return e; };
  expect(why("   \n ")).toContain("Paste the token first");
  expect(why("not-a-token-but-quite-long-enough-0123456789")).toContain("doesn't start with sk-ant-");
  expect(why("sk-ant-oat01-abc$def!0123456789012345")).toContain("characters other than letters, digits, - and _");
  expect(why("sk-ant-oat01-abc")).toContain("too short");
});

const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
const Z = "0".repeat(40), A = "a".repeat(40), B = "b".repeat(40);

test("the refs a push updates are read from its commands", () => {
  const body = new TextEncoder().encode(pkt(`${A} ${B} refs/heads/task/1-x\0report-status side-band-64k\n`) + pkt(`${B} ${Z} refs/heads/staging\n`) + "0000PACK...");
  expect(pushedRefs(body)).toEqual([{ old: A, next: B, ref: "refs/heads/task/1-x" }, { old: B, next: Z, ref: "refs/heads/staging" }]);
});

test("a task's token pushes its own branch only; a merge token also moves staging, but never deletes it", () => {
  const task = { scope: "task" as const, branch: "task/1-x", exp: 0 };
  const merge = { ...task, scope: "merge" as const };
  expect(refsAllowed(task, [{ next: B, ref: "refs/heads/task/1-x" }])).toBeNull();
  expect(refsAllowed(task, [{ next: Z, ref: "refs/heads/task/1-x" }])).toBeNull();
  expect(refsAllowed(task, [{ next: B, ref: "refs/heads/staging" }])).toContain("not refs/heads/staging");
  expect(refsAllowed(task, [{ next: B, ref: "refs/heads/task/2-y" }])).toContain("not refs/heads/task/2-y");
  expect(refsAllowed(merge, [{ next: B, ref: "refs/heads/staging" }])).toBeNull();
  expect(refsAllowed(merge, [{ next: Z, ref: "refs/heads/staging" }])).not.toBeNull();
  expect(refsAllowed(merge, [{ next: B, ref: "refs/heads/main" }])).not.toBeNull();
});

test("git tokens: signed, scoped to a task branch, and expiring", () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const t = mintGitToken("s", { scope: "task", branch: "task/1-x", exp });
  expect(checkGitToken("s", t)).toEqual({ scope: "task", branch: "task/1-x", exp });
  expect(checkGitToken("other", t)).toBeNull();
  expect(checkGitToken("s", t.slice(0, -1) + (t.endsWith("0") ? "1" : "0"))).toBeNull();
  expect(checkGitToken("s", mintGitToken("s", { scope: "task", branch: "task/1-x", exp: 1 }))).toBeNull();
  expect(checkGitToken("s", mintGitToken("s", { scope: "merge", branch: "staging", exp }))).toBeNull();
});

test("a git token carries any text: a shared agent's name with a curly apostrophe and an emoji", async () => {
  const { b64url, fromB64url, verifyGitToken } = await import("../factory/git-grant");
  const secret = "s3cret";
  const by = "koomen’s agent (shared: Claude Code) 🤖 — é";
  const exp = Math.floor(Date.now() / 1000) + 600;
  expect(fromB64url(b64url(by))).toBe(by);
  expect(b64url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe("-__-");
  // Minted as the Worker does (factory/git-grant.ts b64url), read by the Git endpoint and the dev server's stand-in.
  const key = new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode("erga-factory-git")));
  const sign = async (body: string) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(body))), (x) => x.toString(16).padStart(2, "0")).join("");
  const grant = { scope: "task" as const, branch: "task/1-a-task", exp, by };
  const body = b64url(JSON.stringify(grant));
  const token = `fgt.${body}.${await sign(body)}`;
  expect(await verifyGitToken(secret, token)).toEqual(grant);
  expect(checkGitToken(secret, token)).toEqual(grant);
  // The dev server mints the same token, byte for byte.
  expect(mintGitToken(secret, grant)).toBe(token);
  // An older token (btoa alone, Latin-1 text) still reads.
  const old = { scope: "task" as const, branch: "task/1-a-task", exp, by: "José’s".replace("’", "'") };
  const oldBody = btoa(JSON.stringify(old)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(await verifyGitToken(secret, `fgt.${oldBody}.${await sign(oldBody)}`)).toEqual(old);
});

test("Claude Code's model: the factory_model setting, default opus; a model it refuses fails with the model and the setting named", async () => {
  const { MODEL, modelError } = await import("../factory/vm/common");
  const { SETTINGS: settings } = await import("../config");
  const was = process.env.FACTORY_MODEL;
  delete process.env.FACTORY_MODEL;
  expect(MODEL()).toBe("opus");
  process.env.FACTORY_MODEL = "sonnet";
  expect(MODEL()).toBe("sonnet");
  const why = modelError("There's an issue with the selected model (claude-sonnet-5-5). It may not exist or you may not have access to it. Run --model to pick a different model.");
  expect(why).toContain('"sonnet"');
  expect(why).toContain("factory_model");
  expect(modelError("Done: the footer is in.")).toBeNull();
  if (was == null) delete process.env.FACTORY_MODEL; else process.env.FACTORY_MODEL = was;
  expect(settings.factory_model.default).toBe("opus");
  expect(settings.factory_model.parse(" claude-opus-5-5 ")).toBe("claude-opus-5-5");
  expect(() => settings.factory_model.parse("opus; rm -rf /")).toThrow();
});

test("fast mode: on by default in Claude Code's settings; the factory_fast setting turns it off", async () => {
  const { prepareClaude } = await import("../factory/vm/common");
  const { SETTINGS } = await import("../config");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = process.env.HOME, fast = process.env.FACTORY_FAST;
  process.env.HOME = mkdtempSync(join(tmpdir(), "fast-"));
  try {
    delete process.env.FACTORY_FAST;
    prepareClaude();
    const file = join(process.env.HOME, ".claude", "settings.json");
    expect(JSON.parse(readFileSync(file, "utf8")).fastMode).toBe(true);
    process.env.FACTORY_FAST = "0";
    prepareClaude();
    expect(JSON.parse(readFileSync(file, "utf8")).fastMode).toBe(false);
  } finally {
    process.env.HOME = home;
    if (fast == null) delete process.env.FACTORY_FAST; else process.env.FACTORY_FAST = fast;
  }
  expect(SETTINGS.factory_fast.default).toBe("on");
  expect(SETTINGS.factory_fast.parse(false)).toBe("off");
});

test("the worker brief asks for targeted tests in a 5-minute budget, not the whole suite", () => {
  const p = taskPrompt({ id: 1, title: "T", description: "D", branch: "task/1-t", base: "staging" });
  expect(p).toContain("under 5 minutes");
  expect(p).toContain("only the tests that cover what you changed");
  expect(p).toContain("task run --timeout 180 -- bun test");
  expect(p).toContain("shared infrastructure");
  expect(p).toContain("never by default");
  expect(p).not.toContain("--timeout 900");
  expect(p).not.toContain("for the whole suite)");
});

test("a long Claude Code run with no new output repeats no line on the board; it says it is still working, at most once a minute", async () => {
  const { claudeLog } = await import("../factory/vm/common");
  let t = 1_000_000;
  const board = claudeLog(() => t);
  const lines: string[] = [];
  const text = { type: "text", text: "While the suite runs, I'll work out how to give the preview a seeded repository." };
  const tool = { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "./test.sh" } };
  // Claude Code sends the message again, with more in it, and the same text block again, seconds apart.
  lines.push(...board.event({ type: "assistant", message: { id: "msg_1", content: [text] } }));
  t += 6000; lines.push(...board.event({ type: "assistant", message: { id: "msg_1", content: [text, tool] } }));
  t += 6000; lines.push(...board.event({ type: "assistant", message: { id: "msg_1", content: [text, tool] } }));
  t += 6000; lines.push(...board.event({ type: "assistant", message: { id: "msg_2", content: [text] } }));
  // As Claude Code sends them now: one block in each event, a command in the same millisecond as the words.
  t += 6000; lines.push(...board.event({ type: "assistant", message: { id: "msg_3", content: [{ type: "text", text: "Now the build." }] } }));
  lines.push(...board.event({ type: "assistant", message: { id: "msg_3", content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "bun run build" } }] } }));
  // Ten quiet minutes, a tick every 5 s.
  for (let i = 0; i < 120; i++) { t += 5000; lines.push(...board.tick()); }
  const words = lines.filter((l) => l.startsWith("Claude:"));
  expect(words).toEqual([`Claude: ${text.text}`, "Claude: Now the build."]);
  expect(lines.filter((l) => l.startsWith("Claude runs"))).toEqual(["Claude runs Bash: ./test.sh", "Claude runs Bash: bun run build"]);
  const still = lines.filter((l) => l.includes("still working"));
  expect(still.length).toBeGreaterThan(0);
  expect(still.length).toBeLessThanOrEqual(10);
  expect(new Set(lines).size).toBe(lines.length);
});

test("a restarted task's Claude Code is told it was restarted, on its saved branch, with every earlier instruction in order", () => {
  const none = restartPrompt({ branch: "task/7-x" }, []);
  expect(none).toContain("restarted this task");
  expect(none).toContain("pushed task/7-x");
  expect(none).not.toContain("instructions, in this order");
  const two = restartPrompt({ branch: "task/7-x" }, [{ at: "2026-10-05T10:00:00.000Z", by: "ada", text: "Make it blue." }, { at: "2026-10-05T11:30:00.000Z", by: "bo", text: "Now bigger." }]);
  expect(two).toContain("1. (ada, 2026-10-05 10:00 UTC) Make it blue.");
  expect(two).toContain("2. (bo, 2026-10-05 11:30 UTC) Now bigger.");
  expect(two.indexOf("Make it blue.")).toBeLessThan(two.indexOf("Now bigger."));
});

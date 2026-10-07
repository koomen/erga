// The factory's pure parts (README, The factory): branch names, and what a
// git token lets a VM push (dev/factory.ts, which the real Git endpoint
// should match).

import { expect, mock, test } from "bun:test";
import { checkGitToken, mintGitToken, pushedRefs, refsAllowed } from "../dev/factory";
import { branchName, claudeToken, restartPrompt, taskPrompt } from "../factory/prompt";
import { quietFor, STALL_MS, stalledOf } from "../factory/stall";
import { commitIdentity, FACTORY_IDENTITY, githubIdOf, personIdentity } from "../factory/author";
import { landedIn, recovery } from "../factory/recover";
import { maxTurnsHit } from "../factory/vm/common";

test("branch names: task/<id>-<slug of the title>", () => {
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
  expect(p).toContain("task run --timeout 300 -- bun run test`");
  expect(p).toContain("shared infrastructure");
  expect(p).toContain("never by default");
  expect(p).not.toContain("--timeout 900");
  expect(p).not.toContain("test.sh");
});

test("the worker brief maps the repository and asks for batched work, and sends it to no README or docs", () => {
  const p = taskPrompt({ id: 1, title: "T", description: "D", branch: "task/1-t", base: "staging" });
  expect(p).toContain("Where things are:");
  for (const file of ["worker/index.ts", "room.ts", "src/page/", "factory/vm/", "deploy/cloudflare.ts", "e2e/affected.ts"]) expect(p).toContain(file);
  expect(p).toContain("batch independent reads and commands in one turn");
  expect(p).toContain("subagents for broad searches");
  expect(p).not.toContain("README");
  expect(p).not.toContain("Read AGENTS.md");
  expect(p).not.toContain("docs/");
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

test("the board says how long a slow tool call took, and the run's totals when it ends", async () => {
  const { claudeLog, SLOW_TOOL_MS } = await import("../factory/vm/common");
  let t = 1_000_000;
  const board = claudeLog(() => t);
  const call = (id: string, command: string) => board.event({ type: "assistant", message: { id: `msg_${id}`, content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const done = (id: string) => board.event({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  expect(call("toolu_1", "ls")).toEqual(["Claude runs Bash: ls"]);
  t += 1000;
  expect(done("toolu_1")).toEqual([]);
  t += 6000;
  call("toolu_2", "./test.sh");
  t += SLOW_TOOL_MS + 5 * 60_000;
  expect(done("toolu_2")).toEqual(["Took 5.5 min: Bash: ./test.sh"]);
  // The same result again (or one for a call it never saw) says nothing.
  expect(done("toolu_2")).toEqual([]);
  expect(board.event({ type: "system", subtype: "init", model: "claude-opus-5-5" })[0]).toStartWith("Claude Code uses the model claude-opus-5-5");
  // Right after another line: not held back.
  t += 100;
  expect(board.event({ type: "result", duration_ms: 3_000_000, duration_api_ms: 1_800_000, num_turns: 87, total_cost_usd: 12.3,
    usage: { input_tokens: 2000, cache_creation_input_tokens: 98_000, cache_read_input_tokens: 1_200_000, output_tokens: 41_000 } }))
    .toEqual(["Claude Code's run ended: 50.0 min (30.0 min in the model), 87 turns, 1.3M tokens in (1.2M from the cache), 41k out, $12.30 at API prices"]);
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

test("a task is stalled when it is working or needs agent, with no new log line in 5 minutes", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 5, 12, 0) - min * 60_000).toISOString();
  const now = Date.UTC(2026, 9, 5, 12, 0);
  const t = (status: string, logMin: number | null, updatedMin = 0) => ({ status, updatedAt: at(updatedMin), log: logMin == null ? [] : [{ at: at(60) }, { at: at(logMin) }] });
  expect(stalledOf(t("working", 4.9), now)).toBeNull();
  expect(stalledOf(t("working", 5), now)).toEqual({ since: at(5), quietMs: STALL_MS });
  expect(stalledOf(t("needs agent", 12), now)?.quietMs).toBe(12 * 60_000);
  // No log: the last update counts.
  expect(stalledOf(t("working", null, 7), now)?.since).toBe(at(7));
  for (const s of ["queued", "complete", "merging", "failed", "merged", "discarded"]) expect(stalledOf(t(s, 30), now)).toBeNull();
  expect([quietFor(5 * 60_000), quietFor(59 * 60_000 + 59_000), quietFor(60 * 60_000), quietFor(125 * 60_000)]).toEqual(["5 min", "59 min", "1 h", "2 h 5 min"]);
});

test("a preview's door: a ticket for its own VM, never from a sibling host, and none of the preview's cookies", async () => {
  mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
  const { previewDoor } = await import("../factory/cloudflare");
  const vm = "task-3-a1b2c3";
  let forwarded: Request | null = null;
  const env = {
    FACTORY_PREVIEW_DOMAIN: "pages.test",
    FACTORY_VM: { getByName: (name: string) => ({ preview: async (r: Request) => {
      forwarded = r;
      const h = new Headers({ "Content-Type": "text/html" });
      h.append("Set-Cookie", "tossed=1; Domain=pages.test; Path=/");
      h.append("Set-Cookie", "factory_preview=x; Path=/");
      return new Response(`preview of ${name}`, { headers: h });
    } }) },
  } as any;
  const ok = async (name: string, ticket: string) => name == vm && ticket == "good";
  const door = (path: string, headers: Record<string, string> = {}) => previewDoor(new Request(`https://${vm}.pages.test${path}`, { headers }), env, ok);
  // Not a preview's host (a document's pages): not this door's.
  expect(await previewDoor(new Request("https://doc-1-ada.pages.test/"), env, ok)).toBeNull();
  expect((await door("/"))!.status).toBe(403);
  expect((await door("/?factory_ticket=bad"))!.status).toBe(403);
  expect((await door("/", { cookie: "factory_preview=good", "sec-fetch-site": "same-site" }))!.status).toBe(403);
  const traded = (await door("/x?factory_ticket=good"))!;
  expect(traded.status).toBe(302);
  expect(traded.headers.get("location")).toBe("/x");
  expect(traded.headers.get("set-cookie")).toContain("HttpOnly");
  expect(forwarded).toBeNull();
  const page = (await door("/x", { cookie: "factory_preview=good" }))!;
  expect(await page.text()).toBe(`preview of ${vm}`);
  expect(page.headers.get("set-cookie")).toBeNull();
  expect(forwarded).not.toBeNull();
});

test("a task's commits are by its person: their GitHub name and noreply address; the factory commits them (#68)", async () => {
  expect(commitIdentity("Koomen", "Pete Koomen", 1234)).toEqual({ name: "Pete Koomen", email: "1234+koomen@users.noreply.github.com" });
  expect(commitIdentity("ada", null, null)).toEqual({ name: "ada", email: "ada@users.noreply.github.com" });
  expect(FACTORY_IDENTITY).toEqual({ name: "Erga factory", email: "factory@erga.dev" });
  // The id from the sign-in; GitHub asked (once, and kept) for one who hasn't signed in since; never for a stranger.
  const rows: Record<string, { login: string; name: string; created: number; githubId: number | null }> = {
    koomen: { login: "koomen", name: "Pete Koomen", created: 1, githubId: 1234 }, ada: { login: "ada", name: "Ada Lovelace", created: 1, githubId: null },
  };
  const users = { get: async (l: string) => rows[l.toLowerCase()] ?? null, setGithubId: async (l: string, id: number) => { rows[l].githubId = id; } } as any;
  const asked: string[] = [];
  const lookup = async (l: string) => { asked.push(l); return 99; };
  expect(await personIdentity(users, "koomen", lookup)).toEqual({ name: "Pete Koomen", email: "1234+koomen@users.noreply.github.com" });
  expect(await personIdentity(users, "Ada", null)).toEqual({ name: "Ada Lovelace", email: "ada@users.noreply.github.com" });
  expect(await personIdentity(users, "ada", lookup)).toEqual({ name: "Ada Lovelace", email: "99+ada@users.noreply.github.com" });
  expect(await personIdentity(users, "ada", lookup)).toEqual({ name: "Ada Lovelace", email: "99+ada@users.noreply.github.com" });
  expect(await personIdentity(users, "nobody", lookup)).toEqual({ name: "nobody", email: "nobody@users.noreply.github.com" });
  expect(asked).toEqual(["ada"]);
  // GitHub's public API: its id, or null when it doesn't answer as it should.
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  expect(await githubIdOf("ada", answer(200, { id: 42, login: "ada" }))).toBe(42);
  expect(await githubIdOf("ada", answer(404, { message: "Not Found" }))).toBeNull();
  expect(await githubIdOf("ada", answer(200, { id: "42" }))).toBeNull();
  expect(await githubIdOf("ada", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
});

test("a merge the factory was cut off from: staging's \"Merge <branch>:\" commit, or the branch gone with its commit in staging", () => {
  const C = "c".repeat(40);
  const log = { heads: { staging: A, main: B }, commits: [{ sha: A, subject: "Merge task/12-other: Other" }, { sha: B, subject: "Merge task/1-x: X" }, { sha: C, subject: "Factory task #3" }] };
  const t = (branch: string, commit: string | null, base: string | null = null) => landedIn(log, { branch, commit, base });
  expect(t("task/1-x", null)).toBe(B);
  // task/1- is not task/12-.
  expect(t("task/12-other", null)).toBe(A);
  expect(t("task/2-y", null)).toBeNull();
  // No merge commit, but the branch is gone and its last commit is in staging.
  expect(t("task/3-z", C)).toBe(C);
  // Not when the branch is still there, nor when the task made no commit (its commit is the staging it started from).
  expect(landedIn({ ...log, heads: { ...log.heads, "task/3-z": C } }, { branch: "task/3-z", commit: C, base: null })).toBeNull();
  expect(t("task/3-z", C, C)).toBeNull();
  expect(t("task/3-z", "d".repeat(40))).toBeNull();
});

test("a task the factory was cut off from: launched again only when no run of it can be going", () => {
  const r = (status: string, vm: string | null, run: string | null, up: boolean) => recovery({ status, vm, run }, up);
  // A run started in a VM that is up: it goes on (never a second launch).
  expect(r("working", "vm1", "run1", true)).toBe("none");
  expect(r("needs agent", "vm1", "run1", true)).toBe("none");
  // A restart or a revise cut off before its run started, or a VM that is gone: launched again from the branch.
  expect(r("working", null, null, false)).toBe("restart");
  expect(r("working", "vm1", null, true)).toBe("restart");
  expect(r("working", "vm1", "run1", false)).toBe("restart");
  expect(r("working", null, "run1", false)).toBe("restart");
  // A resolve cut off before its run started: woken in the VM with the merge's clone, or back to ready without it.
  expect(r("needs agent", "vm1", null, true)).toBe("resolve");
  expect(r("needs agent", "vm1", null, false)).toBe("back to ready");
  expect(r("needs agent", null, "run1", false)).toBe("back to ready");
  // Nothing else is touched.
  for (const s of ["queued", "complete", "merging", "merged", "failed", "discarded"]) expect(r(s, null, null, false)).toBe("none");
});

test("Claude Code stopped at --max-turns: its result event says so", () => {
  expect(maxTurnsHit({ type: "result", subtype: "error_max_turns", is_error: true })).toBe(true);
  expect(maxTurnsHit({ type: "result", subtype: "success", result: "done" })).toBe(false);
  expect(maxTurnsHit({ type: "assistant", subtype: "error_max_turns" })).toBe(false);
  expect(maxTurnsHit(null)).toBe(false);
});

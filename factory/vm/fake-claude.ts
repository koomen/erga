#!/usr/bin/env bun
// The scripted stand-in for Claude Code, when no Claude plan is signed in
// (or FACTORY_FAKE=1): it does what a real run does, the same way, with a
// change known in advance, so the factory can be tried and tested for free.
//
//   1. Puts a line naming the task under the front page's heading
//      (landing/index.html), and commits it.
//   2. Runs the preview (`task preview`: the app itself, or with
//      FACTORY_PREVIEW=static just the landing folder) and screenshots it.
//   3. Says it's done (`task done`), which pushes the branch.
//
// `resolve` (a merge that needs it, with the factory's instructions): it
// resolves conflicts by keeping both sides' lines, commits the merge, runs a
// check under a time limit (`task run`), and says done, so the merge goes on.
// A task whose ask says "[factory-test: can't resolve]" makes it give up
// (`task fail`), and "[factory-test: resolve after N]" makes it wait N
// seconds first (to see the card in "needs agent"), "[factory-test: resolve
// once staging moves]" makes its first wake-up wait (60 s at most) until
// another merge moves staging (so the merge conflicts again), and "[factory-test: linger
// N]" makes it go on for N seconds after it says done (or fails), as Claude
// Code does while it says its last words (the merge must wait for it, or stop
// it, before it runs again). `woken` (it ran past its
// limit): it says done.
//
// Instructions sent while it works: it asks for them as Claude Code's hooks do
// (task.ts hook) after each of its steps, and puts the first of them in its
// note. "[factory-test: long command N]" makes it run `sleep N` first, as a
// Bash tool call that it reports in Claude Code's stream-json events (so
// run.ts can stop it), and "[factory-test: deaf]" makes it never ask (the
// factory then gives them to a new run when it says done).
//
// Run in the clone, as the job's last step (run.ts).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { api, CLONE, git, log, TASK, WORK } from "./common.ts";
import { done, fail, preview, shot } from "./task.ts";

// Takes Claude Code's --model (the factory_model setting) like the real one, and says which.
const args = process.argv.slice(2);
const m = args.indexOf("--model");
const model = m >= 0 ? args.splice(m, 2)[1] : undefined;
const job = args[0] ?? "work";
const brief = await api("/brief") as { title: string; prompt: string; instructions?: string | null };
if (model) await log(`The stand-in runs in place of Claude Code with --model ${model}`);
if (job == "resolve") {
  await resolve();
  const linger = /\[factory-test: linger (\d+)\]/.exec(brief.prompt);
  if (linger) { await Bun.sleep(Number(linger[1]) * 1000); await log("The stand-in ended, after its last words"); }
  process.exit(0);
}
if (job == "woken") { await done("The stand-in was woken after its limit, and finished."); process.exit(0); }
// The dependencies, if the factory's install failed or hung (it says so in Claude Code's instructions): again, under a limit.
if (!existsSync(join(CLONE(), "node_modules"))) {
  const r = spawnSync("task", ["run", "--timeout", "600", "--", "bun", "install"], { cwd: CLONE(), stdio: "inherit" });
  await log(`The stand-in ran bun install again (exit ${r.status})`);
}
// Work that takes a while: one command, as Claude Code's Bash tool runs it.
const long = /\[factory-test: long command (\d+)\]/.exec(brief.prompt);
if (long) {
  console.log(JSON.stringify({ type: "assistant", message: { id: "stand-in-1", content: [{ type: "tool_use", id: "sleep-1", name: "Bash", input: { command: `sleep ${long[1]}` } }] } }));
  const code = await new Promise((resolve) => spawn("sleep", [long[1]], { stdio: "ignore" }).on("close", (c, sig) => resolve(sig ?? c)));
  console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "sleep-1", content: `exit ${code}` }] } }));
  await log(`The stand-in's command ended (sleep ${long[1]}: ${code})`);
}
const asked = await between("Bash");
const file = join(CLONE(), "landing/index.html");
const html = readFileSync(file, "utf8");
const n = asked ? "instructed " : job == "revise" ? "revised " : "";
const line = `<p class="factory-note" style="margin:0;padding:10px 14px;border:1px dashed var(--accent);border-radius:8px;font-family:var(--mono);font-size:13px">Made by the factory, ${n}task #${TASK()}: ${escape(brief.title)}${asked ? ` (asked while it worked: ${escape(asked.slice(0, 120))})` : ""}</p>`;
// After the first heading (or at the top of the body).
const at = html.search(/<\/h1>/i);
const next = html.replace(/<p class="factory-note"[^]*?<\/p>\n?/g, "");
const changed = at >= 0 ? next.replace(/<\/h1>/i, `</h1>\n${line}`) : next.replace(/<body[^>]*>/i, (b) => `${b}\n${line}`);
writeFileSync(file, changed);
await git(["add", "landing/index.html"]);
await git(["commit", "--quiet", "--allow-empty", "-m", `${asked ? "Instructed" : job == "revise" ? "Revise" : "Factory"} task #${TASK()}: a note on the front page`]);
await log("Changed landing/index.html and committed it");

const statics = process.env.FACTORY_PREVIEW == "static";
await preview("/", statics ? "landing" : undefined);
await log("Preview up");
const port = process.env.FACTORY_PREVIEW_PORT ?? "4400";
await shot(`http://localhost:${port}/`, `The front page, with task #${TASK()}'s note`, true);
await done([
  `This task puts a note on the front page. The scripted stand-in made it, not Claude Code.`,
  ``,
  `Changes:`,
  `1. The front page shows a line with the task number and title.`,
  ``,
  `Tests: The stand-in made a screenshot of the front page.`,
  ``,
  `To see it: open the preview.`,
].join("\n"));

/** A step ends: the instructions that wait, as Claude Code's hook gives them (task.ts hook), noted on the board. */
async function between(tool: string): Promise<string> {
  if (brief.prompt.includes("[factory-test: deaf]")) return "";
  const r = spawnSync("bun", [join(import.meta.dirname, "task.ts"), "hook"], { input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: tool }), encoding: "utf8" });
  if (!r.stdout.trim()) return "";
  const said: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  const ask = /asks: (.*)/.exec(said)?.[1] ?? said;
  await log(`The stand-in got the instructions: ${ask.slice(0, 200)}${said.includes("The factory stopped your command") ? " (its command was stopped for them)" : ""}`);
  return ask;
}

function escape(s: string) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!); }

/** A merge that needs the task's Claude Code: conflicts resolved (both sides kept), committed, checked, done. */
async function resolve() {
  await log(`The stand-in reads the merge's instructions: ${(brief.instructions ?? "").split("\n")[0].slice(0, 200)}`);
  const wait = /\[factory-test: resolve after (\d+)\]/.exec(brief.prompt);
  if (wait) await Bun.sleep(Number(wait[1]) * 1000);
  const once = join(WORK(), ".waited-for-staging");
  if (brief.prompt.includes("[factory-test: resolve once staging moves]") && !existsSync(once)) {
    writeFileSync(once, "");
    const seen = (await git(["rev-parse", "origin/staging"], CLONE(), { quiet: true })).out;
    const staging = async () => (await git(["ls-remote", "origin", "refs/heads/staging"], CLONE(), { quiet: true })).out.split(/\s/)[0];
    for (let i = 0; i < 120 && (await staging()) == seen; i++) await Bun.sleep(500);
    await log("The stand-in saw staging move");
  }
  const files = (await git(["diff", "--name-only", "--diff-filter=U"], CLONE(), { quiet: true })).out.split("\n").filter(Boolean);
  if (brief.prompt.includes("[factory-test: can't resolve]")) {
    await fail(files.length ? `The branch conflicts with staging in ${files.join(", ")}, and the stand-in can't resolve it.` : "The stand-in can't finish the merge.");
    return;
  }
  for (const f of files) {
    // Both sides' lines, ours first: the stand-in's notes are lines that can sit side by side.
    const text = readFileSync(join(CLONE(), f), "utf8").replace(/^<<<<<<< [^\n]*\n([^]*?)^=======\n([^]*?)^>>>>>>> [^\n]*\n/gm, "$1$2");
    writeFileSync(join(CLONE(), f), text);
    await git(["add", f]);
  }
  if (files.length) {
    await git(["commit", "--quiet", "--no-edit"]);
    await log(`Resolved the conflicts in ${files.join(", ")} (both sides kept) and committed the merge`);
  }
  // The check, under a time limit, as the prompt asks of Claude Code.
  const check = spawnSync("task", ["run", "--timeout", "60", "--", "git", "diff", "--check", "HEAD~1"], { cwd: CLONE(), encoding: "utf8" });
  await log(`Check: git diff --check under a 60 s limit: exit ${check.status}`);
  await done(files.length ? `Resolved the conflicts with staging in ${files.join(", ")}, keeping both sides.` : "Looked at the merge's problem; nothing to change. The merge can go on.");
}

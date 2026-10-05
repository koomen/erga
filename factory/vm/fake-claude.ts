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
// seconds first (to see the card in "needs agent"). `woken` (it ran past its
// limit): it says done.
//
// Run in the clone, as the job's last step (run.ts).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { api, CLONE, git, log, TASK } from "./common.ts";
import { done, fail, preview, shot } from "./task.ts";

const job = process.argv[2] ?? "work";
const brief = await api("/brief") as { title: string; prompt: string; instructions?: string | null };
if (job == "resolve") { await resolve(); process.exit(0); }
if (job == "woken") { await done("The stand-in was woken after its limit, and finished."); process.exit(0); }
// The dependencies, if the factory's install failed or hung (it says so in Claude Code's instructions): again, under a limit.
if (!existsSync(join(CLONE(), "node_modules"))) {
  const r = spawnSync("task", ["run", "--timeout", "600", "--", "bun", "install"], { cwd: CLONE(), stdio: "inherit" });
  await log(`The stand-in ran bun install again (exit ${r.status})`);
}
const file = join(CLONE(), "landing/index.html");
const html = readFileSync(file, "utf8");
const n = job == "revise" ? "revised " : "";
const line = `<p class="factory-note" style="margin:0;padding:10px 14px;border:1px dashed var(--accent);border-radius:8px;font-family:var(--mono);font-size:13px">Made by the factory, ${n}task #${TASK()}: ${escape(brief.title)}</p>`;
// After the first heading (or at the top of the body).
const at = html.search(/<\/h1>/i);
const next = html.replace(/<p class="factory-note"[^]*?<\/p>\n?/g, "");
const changed = at >= 0 ? next.replace(/<\/h1>/i, `</h1>\n${line}`) : next.replace(/<body[^>]*>/i, (b) => `${b}\n${line}`);
writeFileSync(file, changed);
await git(["add", "landing/index.html"]);
await git(["commit", "--quiet", "--allow-empty", "-m", `${job == "revise" ? "Revise" : "Factory"} task #${TASK()}: a note on the front page`]);
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

function escape(s: string) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!); }

/** A merge that needs the task's Claude Code: conflicts resolved (both sides kept), committed, checked, done. */
async function resolve() {
  await log(`The stand-in reads the merge's instructions: ${(brief.instructions ?? "").split("\n")[0].slice(0, 200)}`);
  const wait = /\[factory-test: resolve after (\d+)\]/.exec(brief.prompt);
  if (wait) await Bun.sleep(Number(wait[1]) * 1000);
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

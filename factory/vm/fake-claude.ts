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
// Run in the clone, as the job's last step (run.ts).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, CLONE, git, log, TASK } from "./common.ts";
import { done, preview, shot } from "./task.ts";

// Takes Claude Code's --model (the factory_model setting) like the real one, and says which.
const args = process.argv.slice(2);
const m = args.indexOf("--model");
const model = m >= 0 ? args.splice(m, 2)[1] : undefined;
const job = args[0] ?? "work";
const brief = await api("/brief") as { title: string; instructions?: string | null };
const file = join(CLONE(), "landing/index.html");
const html = readFileSync(file, "utf8");
const n = job == "revise" ? "revised " : "";
const line = `<p class="factory-note" style="margin:0;padding:10px 14px;border:1px dashed var(--accent);border-radius:8px;font-family:var(--mono);font-size:13px">Made by the factory, ${n}task #${TASK()}: ${escape(brief.title)}</p>`;
// After the first heading (or at the top of the body).
const at = html.search(/<\/h1>/i);
const next = html.replace(/<p class="factory-note"[^]*?<\/p>\n?/g, "");
const changed = at >= 0 ? next.replace(/<\/h1>/i, `</h1>\n${line}`) : next.replace(/<body[^>]*>/i, (b) => `${b}\n${line}`);
writeFileSync(file, changed);
if (model) await log(`The stand-in runs in place of Claude Code with --model ${model}`);
git(["add", "landing/index.html"]);
git(["commit", "--quiet", "-m", `${job == "revise" ? "Revise" : "Factory"} task #${TASK()}: a note on the front page`]);
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

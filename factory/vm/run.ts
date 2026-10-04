#!/usr/bin/env bun
// A task's work, in its VM (the factory runs it as a job: `bun
// /opt/factory/run.ts work`, or `revise` for the user's further
// instructions). Settings: factory/vm/common.ts.
//
//   1. Clones Erga's repository and makes the task's branch from staging
//      (pushed at once, so the branch exists from the start), or checks it
//      out if it's there already (a revision, or a VM that was replaced).
//   2. Installs the dependencies (from the image's cache: seconds).
//   3. Runs Claude Code with the task's prompt (the factory's brief), which
//      works, tests, previews and screenshots, and reports with `task`.
//      Without a signed-in Claude plan, the scripted stand-in
//      (fake-claude.ts) makes a small change and reports the same way.
//   4. If Claude Code ended without saying done or failed: pushes what's
//      committed and reports it, or fails the task with why.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, CLONE, env, git, log, prepareClaude, realClaude, REPORTED, run, scrub, WORK } from "./common.ts";
import { pushBranch } from "./task.ts";

const job = process.argv[2] ?? "work";
const started = Date.now();
const secs = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

interface Brief { title: string; branch: string; base: string; prompt: string; instructions?: string | null; maxTurns?: number }

async function main() {
  const brief = await api("/brief") as Brief;
  mkdirSync(WORK(), { recursive: true });
  rmSync(REPORTED(), { force: true });
  // `task` on the PATH, for Claude Code (and the stand-in).
  const bin = join(WORK(), "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "task"), `#!/bin/sh\nexec bun '${join(import.meta.dirname, "task.ts")}' "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;

  // 1. The clone, on the task's branch.
  if (!existsSync(join(CLONE(), ".git"))) {
    git(["clone", "--quiet", "--no-checkout", env("REPO_URL"), CLONE()], WORK());
  } else git(["fetch", "--quiet", "origin"]);
  const remoteHas = git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${brief.branch}`], CLONE(), { quiet: true }).code == 0;
  if (remoteHas) {
    git(["checkout", "--quiet", "-B", brief.branch, `origin/${brief.branch}`]);
    await log(`VM ready in ${secs()}: ${brief.branch} checked out at ${git(["rev-parse", "--short", "HEAD"]).out}`);
  } else {
    git(["checkout", "--quiet", "-B", brief.branch, `origin/${brief.base}`]);
    git(["push", "--quiet", "origin", `HEAD:refs/heads/${brief.branch}`]);
    await log(`VM ready in ${secs()}: made ${brief.branch} from ${brief.base} at ${git(["rev-parse", "--short", "HEAD"]).out}`);
  }
  await api("/branch", { json: { base: git(["rev-parse", `origin/${brief.base}`]).out } });

  // 2. Dependencies, from the image's cache.
  const t = Date.now();
  if (await run(["bun", "install", "--frozen-lockfile"], { cwd: CLONE() }) != 0) await run(["bun", "install"], { cwd: CLONE() });
  await log(`Dependencies installed in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  // 3. Claude Code, or the stand-in.
  let code: number;
  let lastText = "";
  if (realClaude()) {
    prepareClaude();
    const continuing = job == "revise" && existsSync(join(process.env.HOME ?? "/home/bun", ".claude", "projects"));
    const prompt = job == "revise" ? (continuing ? brief.instructions! : `${brief.prompt}\n\nThe user looked at your work and asks for more:\n\n${brief.instructions}`) : brief.prompt;
    await log(job == "revise" ? "Claude Code is working on the new instructions" : "Claude Code started");
    let lastLog = 0;
    code = await run(["claude", "-p", prompt, ...(continuing ? ["--continue"] : []), "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", "--max-turns", String(brief.maxTurns ?? 200)], {
      cwd: CLONE(),
      onLine: (line) => {
        // Claude Code's events: what it says goes on the board, at most every 5 seconds.
        let ev: any;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type == "assistant") for (const c of ev.message?.content ?? []) if (c.type == "text" && c.text.trim()) lastText = c.text.trim();
        if (ev.type == "result" && typeof ev.result == "string") lastText = ev.result.trim();
        if (lastText && Date.now() - lastLog > 5000) { lastLog = Date.now(); log(`Claude: ${scrub(lastText).slice(0, 300)}`); }
      },
    });
  } else {
    await log(process.env.CLAUDE_CODE_OAUTH_TOKEN ? "The scripted stand-in runs (FACTORY_FAKE=1)" : "No Claude sign-in: the scripted stand-in runs instead of Claude Code");
    code = await run(["bun", join(import.meta.dirname, "fake-claude.ts"), job], { cwd: CLONE() });
  }

  // 4. Claude Code ended: did it report?
  if (existsSync(REPORTED())) return;
  if (code == 0) {
    const commit = pushBranch();
    await api("", { method: "PATCH", json: { status: "complete", commit, summary: lastText ? `Claude Code ended without a summary. Its last words:\n\n${scrub(lastText).slice(0, 2000)}` : "Claude Code ended without a summary." } });
  } else {
    await api("", { method: "PATCH", json: { status: "failed", error: `Claude Code stopped (exit ${code}) without reporting.${lastText ? ` Its last words: ${scrub(lastText).slice(0, 600)}` : ""}` } });
  }
}

main().catch(async (e) => {
  const why = scrub((e as Error).message);
  console.error(why);
  await api("", { method: "PATCH", json: { status: "failed", error: `The VM's job failed: ${why}` } }).catch(() => {});
  process.exit(1);
});

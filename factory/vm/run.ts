#!/usr/bin/env bun
// A task's work, in its VM (the factory runs it as a job: `bun
// /opt/factory/run.ts work`, `revise` for the user's further instructions, or
// `resolve` when a merge needs the task's Claude Code). Settings:
// factory/vm/common.ts.
//
//   1. Clones Erga's repository and makes the task's branch from staging
//      (pushed at once, so the branch exists from the start), or checks it
//      out if it's there already (a revision, or a VM that was replaced).
//      Not for `resolve`: the merge left the clone as Claude Code must see it.
//   2. Installs the dependencies (from the image's cache: seconds).
//   3. Runs Claude Code with the task's prompt (the factory's brief), which
//      works, tests, previews and screenshots, and reports with `task`. For
//      `revise` and `resolve`, the same Claude Code session (--continue), with
//      the new instructions. Without a signed-in Claude plan, the scripted
//      stand-in (fake-claude.ts) does the same, with a change known in advance.
//   4. If Claude Code ended without saying done or failed: pushes what's
//      committed and reports it, or fails the task with why.
//
// Every step has a time limit (common.ts, LIMITS). A step that times out has
// its process tree killed. The clone is tried twice, then the task fails (no
// Claude Code has worked on it yet). A failed or hung install wakes Claude
// Code with its log, as the first thing in its instructions. Claude Code that
// runs past its limit is stopped and woken once (--continue) to finish; a
// second time, the task fails.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, claudeLog, CLONE, env, git, LIMITS, log, MODEL, modelError, prepareClaude, realClaude, REPORTED, scrub, step, stepError, testHooks, WORK } from "./common.ts";
import { pushBranch } from "./task.ts";

const job = (process.argv[2] ?? "work") as Job;
const started = Date.now();
const secs = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

interface Brief { title: string; branch: string; base: string; prompt: string; instructions?: string | null; maxTurns?: number }
type Job = "work" | "revise" | "resolve";

async function main() {
  const brief = await api("/brief") as Brief;
  testHooks(brief.prompt);
  mkdirSync(WORK(), { recursive: true });
  rmSync(REPORTED(), { force: true });
  // `task` on the PATH, for Claude Code (and the stand-in).
  const bin = join(WORK(), "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "task"), `#!/bin/sh\nexec bun '${join(import.meta.dirname, "task.ts")}' "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;

  // 1. The clone, on the task's branch (a merge that needs Claude Code left it as it must be seen: untouched).
  const hasClone = existsSync(join(CLONE(), ".git"));
  if (job == "resolve") {
    if (!hasClone) throw new Error("the merge left no clone to resolve in");
    await log(`Claude Code is woken to finish the merge: ${(brief.instructions ?? "").split("\n")[0].slice(0, 300)}`);
  } else {
    if (!hasClone) {
      for (let attempt = 1; ; attempt++) {
        const r = await git(["clone", "--quiet", "--no-checkout", env("REPO_URL"), CLONE()], WORK(), { quiet: true });
        if (r.code == 0) break;
        rmSync(CLONE(), { recursive: true, force: true });
        const why = stepError("Cloning the repository", r);
        if (attempt >= 2) throw new Error(why);
        await log(`${why.split("\n")[0]}; trying again`);
      }
    } else {
      await git(["fetch", "--quiet", "origin"]);
      // A merge that Claude Code didn't finish (it failed): dropped, so the branch checks out.
      if ((await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], CLONE(), { quiet: true })).code == 0) await git(["merge", "--abort"], CLONE(), { quiet: true });
    }
    const remoteHas = (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${brief.branch}`], CLONE(), { quiet: true })).code == 0;
    if (remoteHas) {
      await git(["checkout", "--quiet", "-B", brief.branch, `origin/${brief.branch}`]);
      await log(`VM ready in ${secs()}: ${brief.branch} checked out at ${(await git(["rev-parse", "--short", "HEAD"])).out}`);
    } else {
      await git(["checkout", "--quiet", "-B", brief.branch, `origin/${brief.base}`]);
      await git(["push", "--quiet", "origin", `HEAD:refs/heads/${brief.branch}`]);
      await log(`VM ready in ${secs()}: made ${brief.branch} from ${brief.base} at ${(await git(["rev-parse", "--short", "HEAD"])).out}`);
    }
    await api("/branch", { json: { base: (await git(["rev-parse", `origin/${brief.base}`])).out } });
  }

  // 2. Dependencies, from the image's cache. A failure or a timeout goes to Claude Code, with the log.
  let wake = "";
  if (job != "resolve") {
    const t = Date.now();
    let r = await step(["bun", "install", "--frozen-lockfile"], { name: "install", timeout: LIMITS.install, cwd: CLONE(), echo: true });
    if (r.code != 0 && !r.timedOut) r = await step(["bun", "install"], { name: "install", timeout: LIMITS.install, cwd: CLONE(), echo: true });
    if (r.code == 0) await log(`Dependencies installed in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    else {
      wake = stepError("`bun install`", r);
      await log(`${wake.split("\n")[0]}: Claude Code is told, to fix it first`);
      wake = `Before anything else: the factory's ${wake}\n\nFix that first (run it again under a timeout: task run --timeout 600 -- bun install).\n\n`;
    }
  }

  // 3. Claude Code, or the stand-in, with a time limit; woken once if it runs past it.
  const limit = job == "resolve" ? LIMITS.resolve : LIMITS.claude;
  let res = await claude(brief, wake, limit, false);
  if (res.timedOut && !existsSync(REPORTED())) {
    await log(`Claude Code ran past its limit (${limit / 60} min): stopped, with everything it started. Waking it to finish.`);
    res = await claude(brief, "", Math.min(limit, 3600), true);
    if (res.timedOut && !existsSync(REPORTED())) {
      await api("", { method: "PATCH", json: { status: "failed", error: `Claude Code ran past its limit twice (${limit / 60} min, then ${Math.min(limit, 3600) / 60} min) and was stopped.${res.lastText ? ` Its last words: ${scrub(res.lastText).slice(0, 600)}` : ""}` } });
      return;
    }
  }

  // 4. Claude Code ended: did it report?
  if (existsSync(REPORTED())) return;
  // A model the plan can't use (the factory_model setting): said plainly.
  if (res.code != 0 && res.badModel) { await api("", { method: "PATCH", json: { status: "failed", error: scrub(res.badModel) } }); return; }
  const unmerged = (await git(["diff", "--name-only", "--diff-filter=U"], CLONE(), { quiet: true })).out;
  if (res.code == 0 && !unmerged) {
    const commit = await pushBranch();
    await api("", { method: "PATCH", json: { status: "complete", commit, summary: res.lastText ? `Claude Code ended without a summary. Its last words:\n\n${scrub(res.lastText).slice(0, 2000)}` : "Claude Code ended without a summary." } });
  } else {
    await api("", { method: "PATCH", json: { status: "failed", error: `Claude Code stopped (exit ${res.code}) without reporting${unmerged ? `, with conflicts left in ${unmerged.split("\n").join(", ")}` : ""}.${res.lastText ? ` Its last words: ${scrub(res.lastText).slice(0, 600)}` : ""}` } });
  }
}

/**
 * One run of Claude Code (or the stand-in), as a step with a time limit. `woken`: it ran past its limit before,
 * and is told so, in the same session. Claude Code's words and the commands it runs go on the board, at most
 * every 5 seconds, so the board (and the factory's agent) can see what it's doing.
 */
async function claude(brief: Brief, wake: string, limit: number, woken: boolean): Promise<{ code: number; timedOut: boolean; lastText: string; badModel?: string | null }> {
  const late = `You were stopped: you ran for more than ${limit / 60} minutes, the factory's limit, and everything you had started was killed. Something probably hung (a dev server, a test or a build that waits forever). Don't run it again without a time limit (task run --timeout SECONDS -- CMD). Finish now: commit, then task done "summary" (or task fail "why").`;
  if (!realClaude()) {
    if (!woken) await log(process.env.CLAUDE_CODE_OAUTH_TOKEN ? "The scripted stand-in runs (FACTORY_FAKE=1)" : "No Claude sign-in: the scripted stand-in runs instead of Claude Code");
    const r = await step(["bun", join(import.meta.dirname, "fake-claude.ts"), woken ? "woken" : job, "--model", MODEL()], { name: "claude", timeout: limit, cwd: CLONE(), echo: true });
    return { code: r.code, timedOut: r.timedOut, lastText: "" };
  }
  prepareClaude();
  // The same session as before, when this VM has it (more instructions, a merge, a wake-up); else the task's whole brief first.
  const session = existsSync(join(process.env.HOME ?? "/home/bun", ".claude", "projects"));
  const continuing = woken || (job != "work" && session);
  const asked = job == "work" ? brief.prompt
    : job == "revise" ? `The user looked at your work and asks for more:\n\n${brief.instructions}`
    : brief.instructions!;
  const prompt = woken ? late : continuing ? wake + asked : `${brief.prompt}\n\n${wake}${job == "work" ? "" : asked}`;
  if (!woken) await log(job == "revise" ? "Claude Code is working on the new instructions" : job == "resolve" ? "Claude Code is working on the merge" : "Claude Code started");
  let lastText = "";
  let badModel: string | null = null;
  // Each line once; a quiet run says "still working" at most once a minute.
  const board = claudeLog();
  const quiet = setInterval(() => { for (const l of board.tick()) log(l); }, 5000);
  const r = await step(["claude", "-p", prompt, ...(continuing ? ["--continue"] : []), "--model", MODEL(), "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", "--max-turns", String(brief.maxTurns ?? 200)], {
    name: "claude", timeout: limit, cwd: CLONE(), echo: true,
    onLine: (line) => {
      let ev: any;
      try { ev = JSON.parse(line); } catch { badModel ??= modelError(line); return; }
      if (ev.type == "assistant") for (const c of ev.message?.content ?? []) if (c.type == "text" && c.text?.trim()) lastText = c.text.trim();
      for (const l of board.event(ev)) log(l);
      if (ev.type == "result" && typeof ev.result == "string") { lastText = ev.result.trim(); if (ev.is_error) badModel ??= modelError(lastText); }
    },
  });
  clearInterval(quiet);
  if (r.err) process.stderr.write(r.err.slice(-4000) + "\n");
  return { code: r.code, timedOut: r.timedOut, lastText, badModel };
}

main().catch(async (e) => {
  const why = scrub((e as Error).message);
  console.error(why);
  await api("", { method: "PATCH", json: { status: "failed", error: `The VM's job failed: ${why}` } }).catch(() => {});
  process.exit(1);
});

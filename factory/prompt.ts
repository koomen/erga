// What Claude Code is told, in a task's VM: a clone on the task's branch, the
// `task` command to report with, and the VM's own preview port. Also the check on a
// pasted Claude token (claudeToken), which the server and its tests share.

/** A task's branch: task/<id>-<slug of the title>. */
export function branchName(id: number, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return `task/${id}-${slug || "task"}`;
}

/**
 * A `claude setup-token` token as pasted: the terminal wraps it, so a copy can
 * carry spaces or line breaks inside it. They go; then the token is checked.
 * The error says what is wrong, and never repeats the token.
 */
export function claudeToken(raw: string): { token: string } | { error: string } {
  const token = raw.replace(/\s+/g, "");
  const again = " Run `claude setup-token` and paste the token it prints (sk-ant-…).";
  if (!token) return { error: "Paste the token first." + again };
  if (!token.startsWith("sk-ant-")) return { error: "That isn't a Claude Code token: it doesn't start with sk-ant-." + again };
  if (/[^A-Za-z0-9_-]/.test(token)) return { error: "That isn't a Claude Code token: it has characters other than letters, digits, - and _." + again };
  if (token.length < 27) return { error: "That isn't a Claude Code token: it's too short. Copy all of it." + again };
  return { token };
}

/**
 * Text from a VM (a log line, a summary, an error, a caption), with anything shaped like a token hidden: a Claude
 * token, the factory's own (fct., fgt., and the old erga_factory_) and Erga's (erga_, erga_test_). The board and
 * outside agents with admin tokens read this text, and the VM's code, which can read its own tokens, writes it.
 */
export function hideTokens(s: string): string {
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]{16,}/g, "[a Claude token]")
    .replace(/\bf[cg]t\.[A-Za-z0-9_.-]{16,}/g, "[a factory token]")
    .replace(/\berga(?:req)?_[A-Za-z0-9_-]{20,}/g, "[an Erga token]");
}

export function taskPrompt(t: { id: number; title: string; description: string; branch: string; base: string }): string {
  return `You are doing task #${t.id} from Erga's factory: ${t.title}. The ask: ${t.description}

You work in a fresh clone of Erga's source, in the current directory, on the branch ${t.branch} (made from ${t.base}). This is a VM of your own: nothing else runs here, and it is thrown away after the merge. Read AGENTS.md and README.md first. You are working in the hosted factory (AGENTS.md): you report with the \`task\` command.

1. Report progress with \`task log "..."\` at milestones, so the board shows where you are.
2. Do the work, committing as you go.
3. Test it: only the tests that cover what you changed, and new ones where they belong. \`task run --timeout 300 -- bun run test\` runs the unit tests and the end-to-end tests the change affects (e2e/affected.ts), and stops at the first failure; \`bun run test:e2e e2e/x/y.e2e.ts\` runs the files you name; \`task run --timeout 180 -- bun test tests/x.test.ts\` one unit test. A new end-to-end test is a small file in e2e/ (e2e/page/ shows how). Until the old harness (tests/*.ts on tests/cdp.ts) is retired, also run \`task run --timeout 300 -- ./test.sh --changed\`. Build, test and get ready to merge in under 5 minutes. Run the whole suite (\`bun run test --all\`, \`./test.sh\`) or Docker only when the change touches shared infrastructure (the test harness, the build, the server's core) and needs them; never by default. Verify in headless Chromium (tests/cdp.ts drives it; CHROME is set).
4. Make the result visible at one URL: \`task preview [/path]\` runs the app from this clone on port ${4400} and keeps it running after you finish. Pick the page that shows the change best, with any state it needs already set up, so the user only has to open it.
5. Attach screenshots that show the change, where it has a visible side: \`task shot http://localhost:4400/path "caption"\` (headless Chromium takes it), or \`task shot /path/to/file.png "caption"\` for ones you took yourself. Add \`--replace\` to the first one of a fresh set.
6. Run every build, test and server under a time limit, so nothing can hang the task: \`task run --timeout SECONDS -- CMD\` (it kills the command's whole process tree when the time is up, and exits 124), e.g. \`task run --timeout 180 -- bun test tests/x.test.ts\`. Keep each limit short: a few minutes, not tens of minutes. If a command times out, find out why (a server left running, a port in use, a test that waits forever) before you run it again. Leave no processes behind when you finish: only the preview that \`task preview\` started may keep running. The factory also gives each step and your whole run a time limit: past it, it stops everything you started and tells you.
7. Commit everything, then \`task done "summary"\`: it pushes your branch and marks the task ready to merge. Write the summary in ASD-STE100 (Simplified Technical English), as AGENTS.md ("Task summaries") shows: what changed for the user, results, limits, tests, and what the user must do. If you can't finish, \`task fail "why"\` instead.

The user can send you more instructions while you work: they come to you when a step of yours ends. Do them as part of this task.

Don't merge, and don't push to staging or main (your token can't): the user merges from the board.`;
}


/** What a merge that needs the task's Claude Code asks of it (merge.ts answered needsAgent): the same session, woken in its clone. */
export function resolvePrompt(t: { branch: string }, res: { kind?: string; step?: string; error?: string; files?: string[]; log?: string }): string {
  const what = res.kind == "conflict"
    ? `Merging staging into ${t.branch} conflicts in ${(res.files ?? []).join(", ")}. The merge is in progress in your clone, with the conflicts in the working tree.`
    : res.kind == "timeout"
      ? `A step of the merge (${res.step}) timed out, and the factory killed its processes.`
      : `A step of the merge (${res.step}) failed.`;
  return `The user pressed Merge on your task. ${what} The factory stopped your preview first.

What the factory saw:
${(res.error ?? "").slice(0, 4000)}

Finish the merge:
1. ${res.kind == "conflict" ? "Resolve the conflicts, keeping both sides' intent (staging's changes and your task's)." : "Find out why, and fix what is yours to fix (an uncommitted change, a branch that parted from the pushed one, a process that hangs). If it was the network or the repository, say so."}
2. Run the tests that cover what changed (\`task run --timeout 300 -- bun run test\`, and \`./test.sh --changed\` until the old harness is retired, or the files you name). Leave no processes behind.
3. Commit${res.kind == "conflict" ? " the merge (git commit --no-edit)" : ""}. Don't push to staging or main, and don't start a merge of your own.
4. Say \`task done "what you did, in one or two sentences"\`: the factory then runs the merge again by itself. If you can't finish it, \`task fail "why"\`: the task goes back to ready to merge, with your reason.`;
}

/**
 * What a local task's agent finds in its inbox when its merge needs it (merge.ts answered needsAgent, in a VM started
 * for the merge only, which has stopped): finish the merge in its own checkout, then `task done` runs it again.
 */
export function localResolvePrompt(t: { branch: string }, res: { kind?: string; step?: string; error?: string; files?: string[] }): string {
  const what = res.kind == "conflict"
    ? `Merging staging into ${t.branch} conflicts in ${(res.files ?? []).join(", ")}.`
    : `A step of the merge (${res.step}) ${res.kind == "timeout" ? "timed out" : "failed"}.`;
  return `The user pressed Merge on your local task. The factory ran the merge in a VM of its own, which stopped: ${what}

What the factory saw:
${(res.error ?? "").slice(0, 4000)}

Finish the merge in your checkout, on ${t.branch}:
1. ${res.kind == "conflict" ? "Run `task pull --staging`: it merges Erga's staging into your branch and stops at the conflicts. Resolve them, keeping both sides' intent (staging's changes and your task's)." : "Find out why, and fix what is yours to fix (`task pull --staging` brings in Erga's staging). If it was the network or the repository, say so."}
2. Run the tests that cover what changed, under time limits. Leave no processes behind.
3. Commit. Don't push to staging or main, and don't merge into them yourself.
4. Run \`task done "what you did, in one or two sentences"\`: it pushes the branch, and the factory runs the merge again by itself. If you can't finish it, \`task fail "why"\`: the task goes back to ready to merge, with your reason.`;
}

/**
 * What a restarted task's Claude Code is told after the task's prompt (run.ts restart): a new session in a fresh VM,
 * on the branch as the old VM saved it, with every instruction the user sent since the ask, in order. `handedFrom`: a
 * local task handed to a VM (who ran it, on which machine): only what that agent pushed is on the branch.
 */
export function restartPrompt(t: { branch: string }, asked: { at: string; by: string; text: string }[], handedFrom?: string | null): string {
  const earlier = asked.length
    ? `\n\nSince the ask, the user sent these instructions, in this order. Do them too, unless the branch shows they are done:\n\n${asked.map((a, i) => `${i + 1}. (${a.by}, ${a.at.slice(0, 16).replace("T", " ")} UTC) ${a.text}`).join("\n\n")}`
    : "";
  if (handedFrom) return `The user handed this task to you. It was a local task: ${handedFrom} worked on it in its own checkout, and stopped reporting (or the user chose a VM). What it pushed to ${t.branch} is here, and you are on that branch now; what it didn't push isn't. Look at what is there first (git log, git status, the last commit), then go on from there, and finish as the steps above say.${earlier}`;
  return `The user restarted this task. An earlier Claude Code worked on it in another VM; the factory stopped it, committed what it had not committed, and pushed ${t.branch}. You are on that branch now. Look at what is there first (git log, git status, the last commit): a commit "Work in progress …, saved by the factory before a restart" can hold unfinished work. Then go on from there, and finish as the steps above say.${earlier}`;
}

/**
 * What a local agent reads when it registers a local task (task new / task start, factory/task.ts): how it works and
 * reports. The same steps as a VM's (taskPrompt), on the agent's own checkout and machine.
 */
export function localTaskNote(t: { id: number; branch: string }): string {
  return `Task #${t.id} is a local task: you run it, in this checkout, on ${t.branch}. Report as a VM's Claude Code does:
  task log "..."                 progress, at milestones (the board marks a task stalled after 5 minutes without a line)
  task inbox                     instructions sent from the board; run it when a step ends, and before task done
  task shot FILE|URL "caption"   a screenshot (--replace drops the old ones first)
  task preview URL               where the user can see the change, if anywhere
  task push                      pushes the branch through Erga's Git endpoint
  task done "summary"            pushes, then marks the task ready to merge (ASD-STE100, AGENTS.md "Task summaries")
  task fail "why"                marks it failed
Commit as you go. Don't merge, and don't push to staging or main: the user merges from the board.`;
}

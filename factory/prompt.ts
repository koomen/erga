// What Claude Code is told, in a task's VM: AGENTS.md's worker prompt
// ("The subagent's prompt"), with the factory's ways in place of the local
// task queue's: a clone on the task's branch instead of a worktree, `task`
// instead of `tq`, and the VM's own preview port.

/** A task's branch: task/<id>-<slug of the title>, as the local task queue names them. */
export function branchName(id: number, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return `task/${id}-${slug || "task"}`;
}

export function taskPrompt(t: { id: number; title: string; description: string; branch: string; base: string }): string {
  return `You are doing task #${t.id} from Erga's factory: ${t.title}. The ask: ${t.description}

You work in a fresh clone of Erga's source, in the current directory, on the branch ${t.branch} (made from ${t.base}). This is a VM of your own: nothing else runs here, and it is thrown away after the merge. Read AGENTS.md and README.md first. Ignore AGENTS.md's task queue workflow (tq, worktrees, live mode, the outer agent): here you report with the \`task\` command instead.

1. Report progress with \`task log "..."\` at milestones, so the board shows where you are.
2. Do the work, committing as you go.
3. Test it thoroughly: the tests that cover what you changed (\`./test.sh\` for the whole suite) and new ones where they belong. Verify in headless Chromium (tests/cdp.ts drives it; CHROME is set).
4. Make the result visible at one URL: \`task preview [/path]\` runs the app from this clone on port ${4400} and keeps it running after you finish. Pick the page that shows the change best, with any state it needs already set up, so the user only has to open it.
5. Attach screenshots that show the change, where it has a visible side: \`task shot http://localhost:4400/path "caption"\` (headless Chromium takes it), or \`task shot /path/to/file.png "caption"\` for ones you took yourself. Add \`--replace\` to the first one of a fresh set.
6. Run every build, test and server under a time limit, so nothing can hang the task: \`task run --timeout SECONDS -- CMD\` (it kills the command's whole process tree when the time is up, and exits 124), e.g. \`task run --timeout 900 -- ./test.sh\`. If a command times out, find out why (a server left running, a port in use, a test that waits forever) before you run it again. Leave no processes behind when you finish: only the preview that \`task preview\` started may keep running. The factory also gives each step and your whole run a time limit: past it, it stops everything you started and tells you.
7. Commit everything, then \`task done "summary"\`: it pushes your branch and marks the task ready to merge. Write the summary in ASD-STE100 (Simplified Technical English), as AGENTS.md ("Task summaries") shows: what changed for the user, results, limits, tests, and what the user must do. If you can't finish, \`task fail "why"\` instead.

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
2. Run the tests that cover what changed, each under a time limit (\`task run --timeout SECONDS -- CMD\`). Leave no processes behind.
3. Commit${res.kind == "conflict" ? " the merge (git commit --no-edit)" : ""}. Don't push to staging or main, and don't start a merge of your own.
4. Say \`task done "what you did, in one or two sentences"\`: the factory then runs the merge again by itself. If you can't finish it, \`task fail "why"\`: the task goes back to ready to merge, with your reason.`;
}

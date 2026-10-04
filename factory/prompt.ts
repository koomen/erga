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
6. Commit everything, then \`task done "summary"\`: it pushes your branch and marks the task ready to merge. Write the summary in ASD-STE100 (Simplified Technical English), as AGENTS.md ("Task summaries") shows: what changed for the user, results, limits, tests, and what the user must do. If you can't finish, \`task fail "why"\` instead.

Don't merge, and don't push to staging or main (your token can't): the user merges from the board.`;
}

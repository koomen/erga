# Task queue

A local board (http://localhost:4700) of the tasks agents are doing in this
repo, each in its own worktree with its own preview, merged into `main` and
pushed from the board. How agents use it, and its API: `AGENTS.md` at the
repo's root.

    development/task-queue/tq serve           # start it (any tq command does)
    development/task-queue/tq watch           # one line per task status change (for Claude Code's Monitor)
    bun development/task-queue/test.ts        # its end-to-end test
    bun development/task-queue/sample.ts      # a sample board on :4507 (a throwaway repo; --tick N for live commits)

`server.ts` is the server and API, `index.html` the board, `tq` the CLI, and
`mod/` a Claude Code mod that drives it from inside a session
(`claude --plugin-dir development/task-queue/mod`; see AGENTS.md).

The board's last column, Branches, is where merged tasks go: main's latest
25 commits (its first-parent line: the queue's merges and direct commits),
newest at the top. A task's merge commit shows the task (#id and title) and
opens it on a click. The left lane is local main, the right origin/main: a
filled dot where origin has the commit, a hollow one where it isn't pushed
yet, and the header counts those. Merged tasks older than that, and
discarded ones, aren't shown (GET /api/tasks still has them). The server
re-reads main and origin/main every 1.5s and right after a merge, fetches
origin every 60s (`TASK_QUEUE_FETCH`), and sends changes to the board
(`GET /api/history`, and a `history` event on `/api/events`).

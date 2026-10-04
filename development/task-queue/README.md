# Task queue

A local board (http://localhost:4700) of the tasks agents are doing in this
repo, each in its own worktree with its own preview, merged into `main` and
pushed from the board. How agents use it, and its API: `AGENTS.md` at the
repo's root.

    development/task-queue/tq serve           # start it (any tq command does)
    bun development/task-queue/test.ts        # its end-to-end test
    bun development/task-queue/sample.ts      # a sample board on :4507 (a throwaway repo; --tick N for live commits)

`server.ts` is the server and API, `index.html` the board, `tq` the CLI, and
`mod/` a Claude Code mod that drives it from inside a session
(`claude --plugin-dir development/task-queue/mod`; see AGENTS.md).

The board's last column, Branches, is main's latest 25 commits (its
first-parent line: the queue's merges and direct commits), newest at the
top. The left lane is local main, the right origin/main: a filled dot where
origin has the commit, a hollow one where it isn't pushed yet. Done is in
the order of the tasks' merge commits, and each done card shows the same two
dots and the short sha; hover a card or a commit to see the pair joined.
The server re-reads main and origin/main every 1.5s, fetches origin every
60s (`TASK_QUEUE_FETCH`), and sends changes to the board (`GET /api/history`,
and a `history` event on `/api/events`).

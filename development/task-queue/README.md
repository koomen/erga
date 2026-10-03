# Task queue

A local board (http://localhost:4700) of the tasks agents are doing in this
repo, each in its own worktree with its own preview, merged into `main` and
pushed from the board. How agents use it, and its API: `AGENTS.md` at the
repo's root.

    development/task-queue/tq serve           # start it (any tq command does)
    bun development/task-queue/test.ts        # its end-to-end test

`server.ts` is the server and API, `index.html` the board, `tq` the CLI, and
`mod/` a Claude Code mod that drives it from inside a session
(`claude --plugin-dir development/task-queue/mod`; see AGENTS.md).

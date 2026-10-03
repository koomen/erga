# Agents working in this repo

README.md describes Erga itself: how it's built, run (`bun start`) and
tested (`./test.sh`). This file describes how agents take on work here.

## Every ask goes through the task queue

The task queue (`development/task-queue/`) is a local board at
**http://localhost:4700** where the user watches work move through
**Queued → Working → Ready to merge → Merging → Done**, live, and merges it
with one click. It runs only on this machine.

When the user asks for a change to this repo:

1. **Register it, straight away**, before doing anything else:

       development/task-queue/tq add "Short imperative title" "The user's ask, in full, with any context you have"

   This starts the queue if it isn't running, and gives the task a branch
   (`task/<id>-<slug>`), its own worktree (`.claude/worktrees/task-<id>`,
   made from `main`, with `node_modules` and `.dev.vars` from the main checkout) and a
   preview port. It prints the task as JSON: note `id`, `worktree`, `port`.

2. **Hand it to a subagent, in the background**, with the prompt below
   (Agent tool, `run_in_background: true`, no `isolation`: the queue already
   made the worktree). Then tell the user, in a line, that it's on the board
   as #id, and **stay free**: the outer agent does no implementation, testing
   or merging itself, and waits for the next instruction. Several tasks can
   be in flight at once, each in its own worktree.

3. When a subagent reports back, relay its result in a sentence or two
   (the task's URL, and anything the user must know). Don't redo its work.

Questions about the code, explanations and other asks that change nothing
in the repo are answered directly, without a task. Work on the task queue
itself goes through the queue like anything else.

### The subagent's prompt

Fill in the brackets:

> You are doing task #[id] from the task queue: [title]. The ask: [the
> user's ask, in full].
>
> Work only in the worktree [worktree] (branch [branch]): use absolute paths
> there, and never touch the main checkout or other worktrees. Read
> AGENTS.md and README.md there first. Report progress with
> `development/task-queue/tq` (run from anywhere):
>
> 1. `tq start [id]` now.
> 2. Do the work, committing as you go (`tq log [id] "..."` at milestones,
>    so the board shows where you are).
> 3. Test it thoroughly: the tests that cover what you changed (`./test.sh`
>    for the whole suite) and new ones where they belong. Verify in a real
>    browser with **headless Chrome only** (`tests/cdp.ts` drives it; never
>    open or drive the user's own browser).
> 4. Make the result visible at one URL: `tq preview [id] [/path]` runs the
>    app from the worktree on the task's port ([port]) and keeps it running
>    after you finish. Pick the page that shows the change best, with any
>    state it needs already set up, so the user only has to open it.
> 5. Attach screenshots that show the change, where it has a visible side:
>    `tq shot [id] http://localhost:[port]/path "caption"` (headless Chrome
>    takes it), or `tq shot [id] /path/to/file.png "caption"` for ones you
>    took yourself (e.g. after interacting, with tests/cdp.ts).
> 6. Commit everything (the queue won't merge uncommitted work), then
>    `tq done [id] "summary" [url]`: what changed, how you tested it, and
>    what the user should look at. If you can't finish,
>    `tq fail [id] "why"` instead.
>
> Don't merge or push: the user merges from the board. Finish by replying
> with the task's URL and a two-line summary.

### With the Claude Code mod

`development/task-queue/mod/` is a Claude Code mod that does the above for
you (`claude --plugin-dir development/task-queue/mod`). It puts the workflow
in the main agent's system prompt and gives it one tool,
`mcp__task-queue__task_create`, which registers the task and starts a
`task-queue:worker` subagent in the worktree with the prompt above built in.
The worker reports with `task_log`, `task_preview`, `task_screenshot`,
`task_done` and `task_fail`. `/tasks` opens a live pane with Open, Merge
and Discard buttons (no Merge or Discard while a task is merging), and
`/tasks board` opens the browser board. The status line counts working, ready
and merging tasks, and toasts say when one is ready, starts merging, is
merged, fails to merge or fails. With the mod loaded, use its tools instead of `tq`.

## Changing the database

The server's database (D1: users, settings, documents and their
permissions) is described in README.md (Users, admins and settings). Change
its tables with a new migration file in `migrations/` (`0002_...sql` and
on), never by editing one that's there: erga.dev has applied those, and
other tasks may be adding their own at the same time. Reach the data
through `Directory` (`directory.ts`, with `dir.users` and `dir.config`),
whose admin-only calls check who's asking themselves.

## Merging

The user merges from the board (the same as `tq merge <id>`, or
`tq merge <id> --wait` to wait for the outcome; agents don't). The task goes
straight to **Merging** (status `merging`, its own column), and stays there
while the queue works; merges run one at a time, in the order they were
asked for, and a card waiting its turn says so. The queue merges `origin/main` and `main` into the task's branch, in its
worktree; if that conflicts, it runs `claude -p` there to resolve the
conflicts, run the tests and commit. Then it merges the branch into `main`
(`--no-ff`, "Merge task/…: title"), pushes to `origin`, stops the preview and
removes the worktree and branch: the task is Done (`merged`). A merge that
fails (uncommitted changes, unresolved conflicts, the main checkout not on
`main`) goes back to Ready to merge (`complete`) with the reason on the card,
as does one the queue was stopped in the middle of, when it starts again.
Agents can't set `merging` or `merged`, nor change a merging task's status. Discard drops a task: preview stopped,
worktree removed, branch deleted.

## The task queue's API

Discover it with `curl -s localhost:4700/api`: every endpoint, the statuses
and the CLI. `development/task-queue/tq help` lists the CLI's commands; both
print the task as JSON.

| | |
|---|---|
| `POST /api/tasks {title, description}` | register (branch, worktree, port) |
| `GET /api/tasks[?status=…]`, `GET /api/tasks/:id` | read |
| `PATCH /api/tasks/:id {status, url, summary, error, message}` | update; `status` is `queued`, `working`, `complete` or `failed` (`merging`, `merged` and `discarded` are the queue's); `message` goes on the log |
| `POST /api/tasks/:id/log {message}` | a progress line |
| `POST /api/tasks/:id/preview {command?, path?}` | run the preview (default `bun start --port $PORT --no-open`) in the worktree; sets `url` |
| `DELETE /api/tasks/:id/preview` | stop it |
| `POST /api/tasks/:id/screenshots` | an image body, or `{path}`, or `{url}` (headless Chrome), with `caption` |
| `POST /api/tasks/:id/merge`, `POST /api/tasks/:id/discard` | the board's buttons; merge answers 202 with the task `merging` |
| `GET /api/events` | server-sent events: every task, on each change |

If the queue isn't running, any `tq` command starts it (or
`bun development/task-queue/server.ts`; its log is
`development/task-queue/data/server.log`). Its state is
`development/task-queue/data/` (gitignored). `bun development/task-queue/test.ts`
tests it end to end against a throwaway repo.

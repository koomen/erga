# Agents working in this repo

README.md describes Erga itself: how it's built, run (`bun start`) and
tested (`./test.sh`). This file describes how agents take on work here.

## Every ask goes through the task queue

The task queue (`development/task-queue/`) is a local board at
**http://localhost:4700** where the user watches work move through
**Queued → Working → Ready to merge → Merging → Branches** (main's latest
commits, where merged tasks show), live, and merges it
with one click. It runs only on this machine.

### Watch the queue, always

At the start of every session, before anything else, the outer agent starts
watching the queue, and keeps watching for the whole session, so it hears
when each task changes state without the user having to say so:

    development/task-queue/tq watch --state /tmp/tq-watch-<a name for this session>.json

Run it under Claude Code's **Monitor** tool (`timeout_ms` at the maximum,
a description like "task queue status changes"). It starts the queue if it
isn't running, then prints one line per task status change, and nothing
else: `#3 working: title`, `#3 ready to merge: title`, `#3 merging: title`,
`#3 merged: title`, `#4 failed: title: why`, `#5 merge failed, back to
ready to merge: title: why`, `#6 discarded: title`; and, for
[dependencies](#dependencies-between-tasks), `#7 unblocked: title (#3
merged)`, `#8 unblocked for merge: title (#3 merged)` and `#9 blocked:
title: why`. It rides out the server
restarting (and starts it again if it stays down). When the Monitor
expires, **re-arm it** with the same command: `--state` remembers what it
had seen, so changes made in between are reported then.

On each line, act without being asked:

- **ready to merge** or **failed**: if its subagent hasn't already reported
  it, relay it to the user in a sentence or two (`tq get <id>` has the
  summary, URL or error).
- **merged**: say so in a line.
- **unblocked**: its `--after` tasks have merged, so start it: hand it to a
  subagent as below (it's registered already, with its worktree).
  **unblocked for merge**: tell the user it can be merged now.
- **blocked**: a dependency was discarded or failed. Tell the user, and
  change the dependency (`tq deps`) if they agree.
- **merge failed**: tell the user why, and what would fix it.

### Two modes: task mode and live mode

Every change goes through the queue, in one of two modes:

- **Task mode**, the default: the task is queued and a subagent does it in
  the background, while the outer agent stays free (below).
- **Live mode**: the user and the outer agent work on one task together, in
  this session, in a tight loop: the user looks at the page in a Chrome
  window, says what to change, and sees it change. For iterating on the UI
  as quickly as possible (see [Live mode](#live-mode)).

The user picks live mode by asking for it: "live mode", "let's work on X
live", "work on this with me live". Anything else is task mode.

### Task mode

When the user asks for a change to this repo (and not live):

1. **Register it, straight away**, before doing anything else:

       development/task-queue/tq add "Short imperative title" "A short, clear description of the ask"

   The description is what the board shows as the ask, and the worker's
   brief: a few plain sentences saying what the user wants, plus only the
   context the worker can't find itself. Not a wall of text.

   This starts the queue if it isn't running, and gives the task a branch
   (`task/<id>-<slug>`), its own worktree (`.claude/worktrees/task-<id>`,
   made from `main`, with `node_modules` and `.dev.vars` from the main checkout) and a
   preview port. It prints the task as JSON: note `id`, `worktree`, `port`.

2. **Hand it to a subagent, in the background**, with the prompt below
   (Agent tool, `run_in_background: true`, no `isolation`: the queue already
   made the worktree). Then tell the user, in a line, that it's on the board
   as #id, and **stay free**: the outer agent does no implementation, testing
   or merging itself (except in live mode, below), and waits for the next instruction. Several tasks can
   be in flight at once, each in its own worktree.

3. When a subagent reports back, relay its result in a sentence or two
   (the task's URL, and anything the user must know). Don't redo its work.

### Dependencies between tasks

When the outer agent splits work into several tasks, it declares how they
depend on each other, and the queue enforces it (in the API and on the
board):

- `--after 12,13`: the task truly needs #12 and #13 merged first. It stays
  queued; `tq start` is refused until they merge. Register it now, but hand
  it to a subagent only when `tq watch` prints `#14 unblocked`.
- `--merge-after 12`: the tasks can be built in parallel against a contract
  written in both asks (an API, a file format), but must land in order.
  Merge stays off until #12 merges.

      development/task-queue/tq add "Title" "Ask" --after 12 --merge-after 13
      development/task-queue/tq deps 14 --after 12,13 | --merge-after none | --clear

Don't build against a throwaway stub of another task's work, to be followed
by a "connect it to the real thing" task: make the task wait (`--after`), or
write the contract and use `--merge-after`. A dependency that is discarded or
fails blocks its dependents until someone removes or changes it.

The factory inside Erga (`/admin/factory`) has the same dependencies, with
the same rules (`development/task-queue/deps.ts`: change them there, for
both), but starts an unblocked task itself (README, The factory).

Questions about the code, explanations and other asks that change nothing
in the repo are answered directly, without a task. Work on the task queue
itself goes through the queue like anything else.

When the user gives a new rule or standing instruction ("always…",
"from now on…"), add it to AGENTS.md, through the queue like any other
change, not to Claude's local memory: that way every agent sees it.

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
>    took yourself (e.g. after interacting, with tests/cdp.ts). When you
>    revise a task, remove the screenshots that no longer match
>    (`tq unshot [id] FILE|INDEX`, or `tq unshot [id] --all`), or add
>    `--replace` to the first `tq shot` of a fresh set. The card must show
>    only current screenshots.
> 6. Commit everything (the queue won't merge uncommitted work), then
>    `tq done [id] "summary" [url]`. Write the summary, and your final
>    reply, in ASD-STE100 (Simplified Technical English), as AGENTS.md
>    ("Task summaries") shows: what changed for the user, results, limits,
>    tests, and what the user must do. If you can't finish,
>    `tq fail [id] "why"` instead.
>
> Don't build against a stand-in for another task's unmerged work: if the
> ask says this task merges after #[n], build against the contract it gives,
> as the real thing; if you find an unnamed dependency, say so
> (`tq fail [id] "why"`) rather than stub it.
>
> Don't merge or push: the user merges from the board. Finish by replying
> with the task's URL and a two-line summary.

### Live mode

The outer agent does the work itself, in the task's worktree, with the user
watching. Step by step:

1. **Register a live task, and start it**:

       development/task-queue/tq add --live "Short imperative title" "A short, clear description of the ask"
       development/task-queue/tq live <id> [/path]

   `tq live` marks the task live and working; runs the dev server from the
   task's worktree on the task's port, with live reload (`bun start --reload`;
   it waits until the server answers); and opens a **Chrome window of its
   own** on `http://localhost:<port><path>`: its own profile
   (`development/task-queue/data/chrome/task-<id>`) and its own DevTools port,
   never the user's everyday browser or tabs. It records the window on the
   task (`chrome: {pid, port, profile, target}`, in `tq get <id>`), so this
   agent, or a later session, finds it again: running `tq live <id>` again
   brings the same window to the front (opening the page if its tabs were
   closed), or opens a new one if the window is gone. Tell the user, in a
   line, that #id is live, and where.

2. **Look before acting.** Before acting on anything the user says, check
   what they're looking at:

       development/task-queue/tq look <id>                 # the tab in front: url, title; every tab; selected text; console errors
       development/task-queue/tq look <id> --shot [FILE]   # and a screenshot (read it)
       development/task-queue/tq look <id> --console       # and every console message

   "This", "here" and "that button" mean what's on screen and selected
   there. Take a screenshot whenever the ask is about how something looks.
   To click, type or scroll in the window, drive it over its DevTools port
   (`chrome.port`; `tests/cdp.ts`'s `Page` takes a tab's
   `webSocketDebuggerUrl` from `http://127.0.0.1:<port>/json/list`). It's
   the agent's own window; the user's own browser stays untouched.

3. **Edit in the worktree directly**: absolute paths under it, no subagent,
   never the main checkout. Open pages reload by themselves on every edit:
   the editor's own code (`src/page/`, `page.html`, `style.css`, `fonts/`)
   is rebuilt and the page reloads; Worker code is reloaded and so is the
   page; the dev server restarts when its config or the files it imports
   (`front.ts` and what it imports) change, and the page reloads once it's
   back. Don't ask the user to reload. After each change, `tq look` (with
   `--shot` for visible changes) to see that it landed and the console is
   clean.

4. **Commit as you go**, each commit a working state, with `tq log <id>` at
   milestones so the board shows where things are.

5. **Finish when the user says so**: test as in task mode (the tests that
   cover what changed; `./test.sh` when the app changed), attach screenshots
   (`tq shot`), commit everything, then `tq done <id> "summary" <url>` (the summary in
   ASD-STE100, as in "Task summaries"). The
   user merges from the board as usual: a live task merges like any other,
   and merging or discarding it stops its dev server and closes its window.
   If the user drops it instead, `tq fail <id> "why"` (or they discard it).

**The outer agent's other duties carry on during live mode.** The queue
watch stays armed (re-arm it when the Monitor expires) and its lines are
relayed between edits, as always. Any other change the user asks for
meanwhile, unrelated to the live task, goes through task mode: registered
and handed to a background subagent, while the live session carries on. One
live task at a time per session; a new session picks an unfinished live task
back up with `tq live <id>` (`tq list working` shows them; live ones have
`live: true` in `tq get`).

### With the Claude Code mod

`development/task-queue/mod/` is a Claude Code mod that does the above for
you (`claude --plugin-dir development/task-queue/mod`). It puts the workflow
in the main agent's system prompt and gives it one tool,
`mcp__task-queue__task_create`, which registers the task and starts a
`task-queue:worker` subagent in the worktree with the prompt above built in.
The worker reports with `task_log`, `task_preview`, `task_screenshot`
(`replace: true` for a fresh set), `task_unscreenshot`, `task_done` and
`task_fail`. `task_create` also takes `after` and `mergeAfter`
(dependencies, as above): a task with `after` gets no worker until its
dependencies merge, and then `task_start` starts it; `task_deps` changes
them. `/tasks` opens a live pane with Open, Merge
and Discard buttons (no Merge or Discard while a task is merging), and
`/tasks board` opens the browser board. The status line counts working, ready
and merging tasks (and those waiting on others), and toasts say when one is
ready, starts merging, is merged, fails to merge, fails, is unblocked or is
blocked. With the mod loaded, use its tools instead of `tq` (but still watch the queue with `tq watch` under Monitor, as above: the mod's toasts tell the user, not the agent; its system prompt says so too). Live mode has no tool of its own: use `tq add --live`, `tq live` and `tq look`, as above (the mod's system prompt says so).

## Task summaries

Every task summary (`tq done`, `task_done`, a `tq fail` reason, and the
worker's final reply) is written in **ASD-STE100**, Simplified Technical
English. The user reads it cold, on the board, and must understand it on
one read. The rules that matter most:

- Short sentences: at most 20 words in an instruction, 25 in a description.
- One idea in each sentence.
- Active voice: "The server sends the file", not "The file is sent".
- Simple tenses only: present, past, future.
- No -ing forms as nouns or adjectives ("the loading spinner" becomes
  "the spinner that shows during load").
- Keep the articles: "the", "a".
- Common, approved words, and one word for one meaning: if it is a "page",
  it is always a "page".
- Technical names (file names, commands, settings, keys) stay as they are.
- Numbered steps for procedures; lists for results.
- No implementation trivia, strings of internal names or arrow chains.

The shape, with only the parts that apply:

1. One sentence: what the task changes for the user.
2. Results, with numbers (before and after) where there are any.
3. Changes: a numbered list, one change in each item.
4. Limits: what does not work, or what is different, and the risk.
5. Tests: what you tested and the result.
6. What the user must do: where to look, and anything before the merge.

For example:

    This task makes documents open faster for readers.

    Results (desktop, first visit):
    - Time until the document shows: 517 ms before, 193 ms after.

    Changes:
    1. The server reads the database one time for each page. Before, it
       read the database four times.
    2. The browser keeps a copy of the document files.

    Limits:
    - If the server stops in the 400 ms after an edit, readers can see
      the old version. The edit is not lost.

    Tests: All tests pass. A new test measures the time to open a document.

    To see it: open http://localhost:4712/demo and reload the page.

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
`tq merge <id> --wait` to wait for the outcome; agents don't). Merge is off,
with the reason, while a task's dependencies (`--after`, `--merge-after`)
aren't merged; a dependency that is merging just ahead of it is fine. The task goes
straight to **Merging** (status `merging`, its own column), and stays there
while the queue works; merges run one at a time, in the order they were
asked for, and a card waiting its turn says so. The queue merges `origin/main` and `main` into the task's branch, in its
worktree; if that conflicts, it runs `claude -p` there to resolve the
conflicts, run the tests and commit. Then it merges the branch into `main`
(`--no-ff`, "Merge task/…: title"), pushes to `origin`, stops the preview and
removes the worktree and branch: the task is Done (`merged`). Last, it puts
`main` into Erga's own source (Cloudflare Artifacts) and tells the servers,
which deploys staging.erga.dev and **erga.dev** (`deploy/publish.ts`; README,
"Pushes from this machine"). Before the merge it also merges Erga's `staging`
into the task's branch, so commits made in Erga come back to `main`. A push
to GitHub alone deploys nothing. A merge that
fails (uncommitted changes, unresolved conflicts, the main checkout not on
`main`, or a `--merge-after` task that didn't merge first) goes back to Ready to merge (`complete`) with the reason on the card,
as does one the queue was stopped in the middle of, when it starts again.
Agents can't set `merging` or `merged`, nor change a merging task's status. Discard drops a task: preview stopped,
worktree removed, branch deleted. A live task's Chrome window is closed on
merge and on discard, as its dev server (the preview) is stopped.

### The queue restarts itself after merging its own code

When a merge changes the queue's own code (files under
`development/task-queue/` that the server, the board or `tq` run; not docs,
`mod/` or its tests), the queue restarts itself so it runs the new code. It
waits until nothing else is merging and that merge's bookkeeping is done
(merged, pushed, worktree removed), then starts a fresh server and exits
(the new pid is in `GET /api`). Tasks are kept, previews carry on, and boards
and `tq watch` reconnect (a board reloads if the board itself changed).

If it ever doesn't (`curl -s localhost:4700/api` still answers with the old
code), the outer agent restarts it by hand: kill the server listening on 4700
(`kill $(lsof -ti tcp:4700 -sTCP:LISTEN)`), then any `tq` command starts it
again.

## The task queue's API

Discover it with `curl -s localhost:4700/api`: every endpoint, the statuses
and the CLI. `development/task-queue/tq help` lists the CLI's commands; both
print the task as JSON.

| | |
|---|---|
| `POST /api/tasks {title, description, live?, startAfter?, mergeAfter?}` | register (branch, worktree, port); `live: true` for a live task; `startAfter`, `mergeAfter`: task ids it depends on |
| `GET /api/tasks[?status=…]`, `GET /api/tasks/:id` | read |
| `PATCH /api/tasks/:id {status, url, summary, error, live, startAfter, mergeAfter, message}` | update; `status` is `queued`, `working`, `complete` or `failed` (`merging`, `merged` and `discarded` are the queue's; `working` is a 409 while a `startAfter` task isn't merged); `message` goes on the log. Reads carry `blockedBy {start, merge, stuck, reason}` while something blocks the task |
| `POST /api/tasks/:id/log {message}` | a progress line |
| `POST /api/tasks/:id/preview {command?, path?}` | run the preview (default `bun start --port $PORT --no-open`) in the worktree; sets `url` |
| `DELETE /api/tasks/:id/preview` | stop it |
| `POST /api/tasks/:id/live {path?, command?}` | live mode: mark it live, run the dev server with live reload, open (or bring back) its Chrome window; records `chrome` |
| `GET /api/tasks/:id/look[?shot=1&console=1]` | what that window shows: `url`, `title`, `tabs`, `selection`, `console`, `screenshot` |
| `POST /api/tasks/:id/screenshots` | an image body, or `{path}`, or `{url}` (headless Chrome), with `caption` |
| `DELETE /api/tasks/:id/screenshots/:file`, `DELETE /api/tasks/:id/screenshots` | remove one screenshot (by file name or 1-based index), or all, and delete the files; not while merging. The board's detail view has a × on each screenshot (on hover) |
| `POST /api/tasks/:id/merge`, `POST /api/tasks/:id/discard` | the board's buttons; merge answers 202 with the task `merging`, or 409 while its dependencies aren't merged |
| `GET /api/events` | server-sent events: every task, on each change |

If the queue isn't running, any `tq` command starts it (or
`bun development/task-queue/server.ts`; its log is
`development/task-queue/data/server.log`). Its state is
`development/task-queue/data/` (gitignored). `bun development/task-queue/test.ts`
tests it end to end against a throwaway repo.

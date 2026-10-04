# Task queue

A local board (http://localhost:4700) of the tasks agents are doing in this
repo, each in its own worktree with its own preview, merged into `main` and
pushed from the board. How agents use it, and its API: `AGENTS.md` at the
repo's root.

    development/task-queue/tq serve           # start it (any tq command does)
    development/task-queue/tq watch           # one line per task status change (for Claude Code's Monitor)
    development/task-queue/tq live ID         # live mode: the task's dev server (live reload) and a Chrome window of its own
    development/task-queue/tq look ID         # what that window shows (--shot, --console)
    bun development/task-queue/test.ts        # its end-to-end test
    bun development/task-queue/sample.ts      # a sample board on :4507 (a throwaway repo; --tick N for live commits)

`server.ts` is the server and API, `index.html` the board, `tq` the CLI,
`chrome.ts` live mode's Chrome window (launch, reattach, look, close), and
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

After a merge that changes the queue's own code (not docs, `mod/`, or the
tests), the server restarts itself once nothing else is merging: it spawns
a fresh, detached `server.ts` (logging to `data/server.log`) and exits; the
new one waits for the old one to be gone, then reads `data/` and listens.
Previews run in their own process groups and carry on. The board's event
stream sends its version first, so an open board reloads when `index.html`
changed. If it doesn't restart, kill whatever listens on 4700 and run any
`tq` command.

Live tasks (`live: true`, `tq add --live`) are worked on in a session with
the user rather than by a background worker (AGENTS.md, "Live mode"). Their
card has a Live badge (pulsing while the dev server and window are up), and
their detail view shows the window. `tq live` (`POST /api/tasks/:id/live`)
runs the preview with `bun start --reload` (`TASK_QUEUE_LIVE`) and launches
Chrome detached, in its own process group, with a profile in
`data/chrome/task-<id>`, so it outlives the queue and its restarts; the
queue checks it every 4s (`chromeUp`), and closes it (`Browser.close`, then
a kill) and drops its profile on merge or discard. `tq look`
(`GET /api/tasks/:id/look`) picks the tab in front (focused, else visible)
and reads it over DevTools; screenshots go to `data/looks/`.

Dependencies between tasks (AGENTS.md, "Dependencies between tasks") are
two lists of task ids on a task, kept in `data/tasks.json`: `startAfter`
(don't start until they're merged) and `mergeAfter` (don't merge until
they're merged; `startAfter` counts too). The model is meant to carry over
as it is to the in-app factory:

- Only `merged` satisfies a dependency. Ids must name other tasks, not
  discarded ones, and a cycle (through either list) is refused.
- `blockedBy` is derived, never stored: `{start, merge, stuck, reason}`,
  recomputed on every change and sent with every read and event. `start`
  only applies to a queued task; `stuck` lists dependencies that are
  discarded or failed, which block until someone removes or changes them.
- Starting (status `working`, live mode) is refused (409) while `start` is
  not empty. Merging is refused (409) while a `merge` dependency is neither
  merged nor merging ahead of it, and checked again when the queued merge
  runs; if a dependency didn't merge, the merge fails back to `complete`.
- When a dependency merges, is discarded or fails, each dependent's log says
  what it means for it, and `tq watch` (and the mod's toasts) say
  "unblocked" or "blocked".
- On the board: a chip on the card ("waiting for #12", "merges after #12",
  "blocked by #12"), blocked tasks set back at the bottom of Queued, Merge
  disabled with the reason, and a Dependencies section in the detail view
  (links, ×, and Add).

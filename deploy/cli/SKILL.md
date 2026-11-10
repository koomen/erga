# How to work in Erga's repository

Pete (`koomen`) owns Erga. `origin` is GitHub (`koomen/erga`). Every change
goes through a feature branch. `bun erga` is the only way onto `staging`
and `main`. There are no pull requests.

## The workflow

1. Start a feature branch for each task, in a work folder of its own:

       bun erga start <branch>

   Any name but `staging` and `main`. It gets the newest staging from
   GitHub, makes the branch there, in the folder `worktrees/<branch>` of
   the main clone, and installs the packages. Work in that folder.
2. Commit. A commit message is one line of ten words at most, with no
   body. Then push with the one command, never with `git push`:

       bun erga push

   It formats the lines you changed, builds `.build/inline-code.ts`
   again, runs `bun run test` (format, lint, typecheck, unit tests, smoke
   run) and pushes the branch only when the tests end with `all passing`.
   When a step fails, it prints the failure and pushes nothing. It stops
   before the tests when a file has a change that no commit has (the
   formatter's too): commit it, and run the command again. It replaces
   your own earlier push of the branch (after an amend or a rebase), but
   never commits on GitHub that this checkout has not seen. Also run the
   e2e tests of the part you change (`bun run test:e2e e2e/full/page/`).
   The whole suite (`bun run test:full`) only when Pete asks.
3. A push deploys nothing. Make the branch's proof page, so that Pete sees
   the change before the merge:

       bun erga proof "<what changed, one sentence>" --look "--path /docs"

   Each `--look` has the arguments of `bun run look` (`--path <path>`: a
   page of the server; `--view --doc <fixture>`: a document as a reader
   sees it; `--doc <fixture> <keys>`: the editor after those keys). It
   takes each picture before the change and after it, at desktop width
   and at phone width. A change with nothing to show names its tests:
   `--no-picture "<the tests that prove it>"`. Look at the page yourself.
   Then tell Pete the branch name, what it changes, and the proof's
   address. The ops page has the link beside the branch's Merge button.
4. When Pete asks, merge the branch into staging, or many branches in
   one run:

       bun erga merge <branch> [-m "message"]
       bun erga merge a -m "message of a" b c

   The message tells what the whole task does, in one line of ten words
   at most. A `-m` is for the branch before it. Without `-m`, the message
   is the subject of the branch's first commit.

   It squashes each branch into one commit, in the order given. Then it
   runs the tests one time, on the last commit, deploys that commit from
   this machine to each registered staging instance, pushes staging and
   deletes the merged branches on GitHub. A branch that conflicts stays
   out: rebase it on `origin/staging`, push it again, and merge it again.
   When the tests fail on many branches, it merges them one by one, each
   with its own test run, and a branch that fails stays out. It names each
   branch that stays out, and then ends with exit code 1. It stops when no
   branch merges, and when a deploy fails: staging stays where it was.
   After the merge, every end-to-end test runs on the merged commit, in
   the background (about 4 minutes; nothing waits for it). The ops page
   shows the result at the commit, with the name of each failed test.
   A test that fails there is the merge's: repair it in a new task.
5. `merge` reports each staging instance's commit and health. Check the
   change on https://staging.erga.dev before you say that it works.
   Staging is for admins only.
6. Only when Pete asks: `bun erga deploy erga.dev` deploys the commit that
   staging runs to production, from this machine. Then it moves `main` to
   that commit and pushes it. erga.koomen.dev has no staging instance:
   `bun erga deploy main erga.koomen.dev`.
7. Only when Pete asks: `bun erga release [vX.Y.Z|major|minor|patch]`
   tags `main` and makes a GitHub release with notes from the commits.
   `--dry-run` shows the version and the notes first.

## The other commands

- `bun erga loops [--days N]`: the time of each loop in the last 7 days.
  One row for each branch: the minutes of work (start to first push), the
  failed test runs, the minutes of wait for the merge, the minutes of the
  merge to staging, and from there to production; then the medians. The
  log is `.erga/loops.jsonl` (`bun erga start`, each `bun run test` and
  `bun erga push` add a line) and the job records. The ops page shows
  the week's medians.
- `bun erga full [<commit>]`: every end-to-end test on a commit (default:
  staging's head), in a scratch folder: what a merge starts in the
  background. Its state is `.erga/full/<sha>.json`. One run at a time.
- `bun erga clean [--yes]`: lists the work folders and the local branches
  whose task is merged (the merge records in `.erga/jobs/`) and on
  production, and removes them after a yes. One with a later commit, or
  with a change that no commit has, stays. It also removes a scratch
  folder that a crashed merge left.
- `bun erga status`: each instance in `.erga/config.json` with its commit
  and health, the feature branches (ahead, behind, conflicts) and the
  commits on staging that are not on main. It only reads: no fetch. It asks
  GitHub for its branches (`git ls-remote`) and leaves out a branch that a
  merge deleted; offline, it lists the clone's branches, with a note.
- `bun erga`: the ops page on localhost. It lists the instances of `.erga/config.json`,
  each primary with its staging instances, the feature branches, the newest run of all the tests, the log with "live" at each
  instance's commit, and the job that runs. Its tabs: Setup (the checklist of `bun erga setup`), Deploys,
  Logs (a job's output, live) and History (the jobs). It checks its sources, each on its own
  period, whatever happens: GitHub at most once a minute, with `git fetch --prune` in the main
  clone, and each instance's commit and health every 5 seconds. The Deploys tab's Sources box shows each source's
  last check, its answer or its error, and "stale" after three of its periods with no good answer. A new job
  on another primary's instance switches the page to that primary. Each feature branch has a Proof link (`bun erga proof`) and a Merge
  button (`bun erga merge <branch> -m <text>`). A commit row shows a Deploy button on hover in each
  column whose instance does not run it (`bun erga deploy <commit> <host>`). They run the same
  commands, with the same locks, and only one job at a time. Only when Pete asks.
- `bun erga deploy [<commit>] <host>`: deploys a registered instance from
  this machine, with the facts in `.erga/config.json`. Only when Pete asks.
  It asks no question. A staging instance needs a commit, and keeps its
  copy of production's data. A primary with no commit takes the commit
  that its staging instances run (they must agree and be healthy). It
  deploys only a commit whose tests passed (`.erga/tests/<sha>`; `merge`
  writes it), else it runs them first; `--no-tests` skips them. After a healthy deploy of a
  primary, `main` moves forward to the commit and the CLI pushes it. A
  primary does not deploy a commit apart from `main`. `--home <domain>`
  (a primary only, a name on one of its account's zones) serves the
  homepage's site on that domain from then on. The server keeps it, and
  the CLI copies it into the entry after the deploy: never edit it there.
- `bun erga rollback <host>`: a registered instance's Worker version from
  before its last deploy, in seconds. Only when Pete asks. The next deploy
  goes forward again.
- `bun erga snapshot-secret <host>`: a new `SNAPSHOT_TOKEN` on a primary and
  each of its staging instances, and in `.erga/secrets.json`. The old one
  opens nothing from then on. Only when Pete asks (when it may have leaked).
- A deploy or a rollback holds the lock `.erga/jobs/<host>.lock` and writes
  its record in `.erga/jobs/`. A second one on the same instance stops.
- `bun erga register <host> [--staging-of <host>]`: signs in to an instance
  as an admin (Pete approves in the browser), and writes its deploy facts,
  its plain settings and an ops token into `.erga/config.json` in the main
  clone. Only when Pete asks.
- `bun erga login <host>`: a new ops token for a registered instance.
- `bun erga setup <host>`: a new instance. It writes its entry, deploys it the
  first time with its secrets, writes the first admin, and registers it
  (`bun erga setup skill`).

## The rules

- Never push to `staging` or `main` with git. The pre-push hook stops it
  (`bun install` turns the hook on, in a clone).
- Never open a pull request. Pull requests are off on GitHub.
- `merge`, `deploy`, `release`, `rollback` and `snapshot-secret` run only
  when Pete asks.
- Report what you observed (a version, a health check, a run's result),
  never what you assumed.
- When a deploy fails, read its output, or its job record in
  `.erga/jobs/`. A failed health check rolls the Worker back by itself.
- AGENTS.md has the code's rules. A file's traps are in the comment at
  its top.

## How a deploy runs

- Every deploy runs on a machine, with its Cloudflare credential:
  `CLOUDFLARE_API_TOKEN`, else the cf CLI's login (`bunx cf auth login`).
  GitHub only keeps the repository: it runs no workflow and has no token.
- A deploy builds the commit in a scratch worktree, then runs the pipeline:
  the D1 migrations, the static files, the Worker, the addresses, the
  health check. A deploy sends no secret: the Workers keep their own.
- Staging runs on a frozen copy of production's data. Only
  `bun erga deploy <commit> <staging host> --fresh` copies it again, with
  the primary's `SNAPSHOT_TOKEN` (in `.erga/secrets.json` under the
  primary's host, or in the environment).
- A rollback never changes the database: migrations only add.

## Run it locally

- `bun start`: the app in your browser, signed in without GitHub. An
  Anthropic key in `.dev.vars` (`ANTHROPIC_API_KEY`) turns on the agent.
  `bun start path/to/folder` opens a folder on disk as a document.
- `bun run look Enter`: presses keys in the editor, headless, and prints the
  page as text with a screenshot.
- `bun run format`: formats only the lines you changed.

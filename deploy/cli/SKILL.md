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
   again, runs `bun run test` and pushes the branch only when the tests
   end with `all passing`. `bun run test` is the one suite: format, lint,
   typecheck, unit tests and browser tests, all at once, in under one
   minute. One run at a time on this machine: a second run waits for its
   turn, and says its place.
   When a step fails, it prints the failure and pushes nothing. It stops
   before the tests when a file has a change that no commit has (the
   formatter's too): commit it, and run the command again. It replaces
   your own earlier push of the branch (after an amend or a rebase), but
   never commits on GitHub that this checkout has not seen.

   While you work, run the quick check, not the suite:

       bun run check

   In under 5 seconds it checks the format, the lint and the types, and
   runs the unit tests that your change reaches. It is loose: it runs no
   browser test, and it says what it did not run. For one journey of the
   suite: `bun run test:e2e e2e/editor/typing.e2e.ts`.

   The suite is designed (`e2e/COVERAGE.md`): each journey has a budget,
   and the run fails over 60 seconds. A test that you write to reproduce
   a bug is a tool of the task: it stays only as a step of a journey or
   as a unit test, inside the budget. Else delete it before the push.
3. A push deploys nothing. Make the branch's proof page, so that Pete sees
   the change before the merge:

       bun erga proof "<what changed, one sentence>" --look "--path /docs"

   Each `--look` has the arguments of `bun run look` (`--path <path>`: a
   page of the server; `--view --doc <fixture>`: a document as a reader
   sees it; `--doc <fixture> <keys>`: the editor after those keys). It
   takes each picture before the change and after it, at desktop width
   and at phone width. A change with nothing to show names its tests:
   `--no-picture "<the tests that prove it>"`. Look at the page yourself.
   The ops page has the link beside the branch's Merge button.
4. Your branch must be green before Pete merges it. The ops page runs
   the tests (`bun run test`, about a minute) on the commit that the merge
   of your branch would make: your branch as one commit on staging's
   head. The runs go one at a time, in a queue. Watch your branch's row:

       bun erga status

   It says, for each branch: the tests wait in the queue, they run, they
   passed, or they failed, with each failed test's name, the end of the
   step that failed and the log's path. No retry makes the row green.
   Repair each failure on your branch and push again. A new commit on
   your branch, or on staging, makes the old result stale: the branch
   goes back in the queue. When the row says that the tests passed,
   tell Pete the branch name, what it changes, and the proof's address.
   Then stop: you do not merge.
5. When Pete asks, merge the branch into staging, or many branches in
   one run:

       bun erga merge <branch> [-m "message"]
       bun erga merge a -m "message of a" b c

   The message tells what the whole task does, in one line of ten words
   at most. A `-m` is for the branch before it. Without `-m`, the message
   is the subject of the branch's first commit.

   It squashes each branch into one commit, in the order given. Then the
   gate: the tests (`bun run test`) must have passed on the last commit.
   A merge of one green branch runs no test: the row's run was on the
   same code. With no result for that code (many branches, or staging
   moved), it runs the tests itself, one time. It refuses a branch whose tests failed, and
   names the failed tests. No flag skips the gate. Then it deploys the
   commit from this machine to each registered staging instance, pushes
   staging and deletes the merged branches on GitHub. A branch that
   conflicts stays out: rebase it on `origin/staging`, push it again, and
   merge it again. When the tests fail on many branches, it merges them
   one by one, each with its own gate, and a branch that fails stays out.
   It names each branch that stays out, and then ends with exit code 1.
   It stops when no branch merges, and when a deploy fails: staging stays
   where it was.
6. `merge` reports each staging instance's commit and health. Check the
   change on https://staging.erga.dev before you say that it works.
   Staging is for admins only.
7. Only when Pete asks: `bun erga deploy erga.dev` deploys the commit that
   staging runs to production, from this machine. Then it moves `main` to
   that commit and pushes it. erga.koomen.dev has no staging instance:
   `bun erga deploy main erga.koomen.dev`.
8. Only when Pete asks: `bun erga release [vX.Y.Z|major|minor|patch]`
   tags `main` and makes a GitHub release with notes from the commits.
   `--dry-run` shows the version and the notes first.

## The other commands

- `bun erga test [<branch>|<commit>]`: the gate's run. `bun run test` on
  a branch's merge onto staging, or on a commit (default: staging's
  head), in a scratch folder: what the ops page runs for each branch. Its
  record is `.erga/tests/<tree>.json`, under the git tree it tested: code
  that ran before runs no more. One run at a time on this machine: a
  second run waits.
- `bun erga clean [--yes]`: lists the work folders and the local branches
  whose task is merged (the merge records in `.erga/jobs/`) and on
  production, and removes them after a yes. One with a later commit, or
  with a change that no commit has, stays. It also removes a scratch
  folder that a crashed merge left.
- `bun erga status`: each instance in `.erga/config.json` with its commit
  and health, the feature branches (ahead, behind, conflicts, and the
  state of the tests on its merge, with each failed test) and the
  commits on staging that are not on main. It only reads: no fetch. It asks
  GitHub for its branches (`git ls-remote`) and leaves out a branch that a
  merge deleted; offline, it lists the clone's branches, with a note.
- `bun erga`: the ops page on localhost. It lists the instances of `.erga/config.json`,
  each primary with its staging instances, the feature branches, the log with "live" at each
  instance's commit, and the job that runs. Its tabs: Setup (the checklist of `bun erga setup`), Deploys,
  Logs (a job's output, live) and History (the jobs). It checks its sources, each on its own
  period, whatever happens: GitHub at most once a minute, with `git fetch --prune` in the main
  clone, and each instance's commit and health every 5 seconds. The Deploys tab's Sources box shows each source's
  last check, its answer or its error, and "stale" after three of its periods with no good answer. A new job
  on another primary's instance switches the page to that primary. Each feature branch is one row: its tests' state (in the queue, running, passed, or failed, which opens
  to the failed tests), its Proof link (`bun erga proof`) and its Merge button (`bun erga merge <branch> -m <text>`),
  which works only when the tests (`bun run test`) passed on the branch's merge. The page's server works the tests' queue. A commit row shows a Deploy button on hover in each
  column whose instance does not run it (`bun erga deploy <commit> <host>`). They run the same
  commands, with the same locks, and only one job at a time. Only when Pete asks.
- `bun erga deploy [<commit>] <host>`: deploys a registered instance from
  this machine, with the facts in `.erga/config.json`. Only when Pete asks.
  It asks no question. A staging instance needs a commit, and keeps its
  copy of production's data. A primary with no commit takes the commit
  that its staging instances run (they must agree and be healthy). It
  deploys only a commit whose tests (`bun run test`) passed (the record
  of its tree in `.erga/tests/`, which its merge wrote). With no record,
  it runs them first; a failed run refuses the deploy, with the failed
  tests. `--no-tests` skips this, and the job record says so. After a healthy deploy of a
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

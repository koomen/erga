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

       bun erga proof "<what changed, one sentence>" --look "--path /documents"

   Each `--look` has the arguments of `bun run look` (`--path <path>`: a
   page of the server; `--view --doc <fixture>`: a document as a reader
   sees it; `--doc <fixture> <keys>`: the editor after those keys). It
   takes each picture before the change and after it, at desktop width
   and at phone width. A change with nothing to show names its tests:
   `--no-picture "<the tests that prove it>"`. Look at the page yourself.
   The command prints its address on the ops page: give it to Pete.
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
   names the failed tests. No flag skips the gate. Then it pushes
   staging and deletes the merged branches on GitHub. It deploys nothing.
   A branch that
   conflicts stays out: rebase it on `origin/staging`, push it again, and
   merge it again. When the tests fail on many branches, it merges them
   one by one, each with its own gate, and a branch that fails stays out.
   It names each branch that stays out, and then ends with exit code 1.
   It stops when no branch merges: staging stays where it was.
6. An instance tracks one branch of one repository (its entry in
   `.erga/config.json`: `repo` and `branch`). `merge` names each instance
   that tracks `staging`. With auto-deploy on (`bun erga --auto-deploy`, below),
   the ops page deploys the commit to each of them within about a minute:
   watch `bun erga status`. Without it, a merge that Pete asked for
   includes the deploy of its commit to each of them:

       bun erga deploy <host>

   With no commit, an instance gets the head of the branch that it tracks.
   Check the change there (`bun erga status` has its address, and how far
   it is behind its branch) before you say that it works.
7. Only when Pete asks: `bun erga promote` moves `main` forward to the
   head of `staging`, and pushes it. It refuses when the tests did not pass
   on that commit, or when an instance that tracks `staging` does not run
   it, healthy. It deploys nothing. Then auto-deploy deploys each instance
   that tracks `main`; without it, when Pete asks, `bun erga deploy
   <host>` does. `main` and `staging` are the branches
   on GitHub, never this clone's own branch of that name.
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
- `bun erga status`: each instance in `.erga/config.json` with the
  repository and branch that it tracks, its commit, how many commits it is
  behind that branch, and its health, the feature branches (ahead, behind, conflicts, and the
  state of the tests on its merge, with each failed test) and the
  commits on staging that are not on main. It only reads: no fetch. An
  instance's commit comes from its platform, with this machine's login: on
  Cloudflare, the Worker's deployment (its API); on AWS, a parameter that
  each deploy and rollback writes. Its health is the row that the server
  writes into its database each minute (D1's API); on AWS, the machine's own
  check of its server (Systems Manager). The instance itself is asked
  nothing. It asks
  GitHub for its branches (`git ls-remote`) and leaves out a branch that a
  merge deleted; offline, it lists the clone's branches, with a note.
- `bun erga`: the ops page on localhost. It lists the instances of `.erga/config.json`,
  each with the branch that it tracks, the log with a column for each instance that tracks the
  chosen one's repository and "live" at its commit, and the job that runs. Its tabs: Setup (the steps of `bun erga setup`), Deploys,
  Logs (a job's output, live) and History (the jobs). It checks its sources, each on its own
  period, whatever happens: GitHub at most once a minute, with `git fetch --prune` in the main
  clone, and each instance's commit (from Cloudflare's API or AWS's, never from the instance) and health every 15 seconds. The Deploys tab's Sources box shows each source's
  last check, its answer or its error, and "stale" after three of its periods with no good answer. A new job
  on an instance that the page does not show switches the page to that instance. The page shows no feature branch and merges nothing: `bun erga status` lists the branches with their tests' state,
  and `bun erga merge` merges. The page's server works the tests' queue all the same. A commit row shows a Deploy button on hover in each
  column whose instance does not run it, when the commit is on that instance's branch (`bun erga deploy <commit> <host>`). It runs the same
  command, with the same locks, and only one job at a time. Only when Pete asks.
- `bun erga --auto-deploy`: the ops page with auto-deploy on. Pete starts it. It asks each repository that an instance
  tracks for its branches' heads once a minute (`git ls-remote`). When an instance does not run its branch's head, it
  starts `bun erga deploy <head> <host>`: one job at a time, with the same gate (the tests) as every deploy. Each
  column's head on the page shows its instance's state: idle, a commit that is next, a deploy that runs, or failed.
  A head is tried one time: a failed deploy stays failed, and the page says why. A new commit on the branch, or
  `bun erga deploy <host>`, starts it again. After `bun erga rollback`, it does not deploy the same commit again. A
  branch that was written again (a force push) stops it, until `bun erga deploy <host>` accepts the new head.
- `bun erga deploy [<commit>] <host>`: deploys a registered instance from
  this machine, with the facts in `.erga/config.json`. Only when Pete asks.
  It asks no question. Every instance deploys by the same steps, from its
  entry. With no commit, it gets the head of the branch that it tracks, as
  its repository has it now. It never gets a commit that its branch does
  not have: to try another branch on it, `bun erga track <host> --branch
  <branch>` first. No deploy moves a branch. A Worker that runs keeps its
  database: an entry that names another one takes that database's name. It
  deploys only a commit whose tests (`bun run test`) passed (the record
  of its tree in `.erga/tests/`, which its merge wrote). With no record,
  it runs them first; a failed run refuses the deploy, with the failed
  tests. `--no-tests` skips this, and the job record says so. `--domain <domain>`
  (it can repeat; a name on one of its account's
  zones) registers a custom domain: an admin can publish a document to it
  from then on (the document's settings, "Publish to"). The server keeps
  its domains, and the CLI copies them into the entry after the deploy:
  never edit them there.
- `bun erga track <host> [--repo <repo>] [--branch <branch>]`: the
  repository and the branch that a registered instance tracks. The
  defaults are `github.com/koomen/erga` and `main`. With no option, it
  prints them. It deploys nothing. Only when Pete asks.
- `bun erga rollback <host>`: a registered instance's Worker version from
  before its last deploy, in seconds. Only when Pete asks. The next deploy
  goes forward again.
- A deploy or a rollback holds the lock `.erga/jobs/<host>.lock` and writes
  its record in `.erga/jobs/`. A second one on the same instance stops.
- `bun erga register <host> [--repo <repo>] [--branch <branch>]`:
  adds an instance that runs already to `.erga/config.json` in the main
  clone: its deploy facts and its plain settings, read from Cloudflare's API
  with this machine's Cloudflare login (the Worker at the host, and the
  bindings of the version that serves), and what it tracks. With
  `--host aws [--profile <name>] [--region <region>]`: from AWS, with the
  AWS CLI's login. It asks the instance nothing, and there is no token.
  Only when Pete asks.
- `bun erga setup <host> --host ... --sign-in ...`: a new instance, from
  nothing to a registered one, on Cloudflare or AWS. The agent asks the user
  the README's questions first; `--dry-run` checks the answers and prints the
  plan; then the command does all the work, and opens the browser only for the
  user's own steps (`bun erga setup --help`). `--repo <repo>` and
  `--branch <branch>` say what the instance tracks (the defaults: `github.com/koomen/erga`, `main`): its first deploy
  takes that branch's head.

## The rules

- Never push to `staging` or `main` with git. The pre-push hook stops it
  (`bun install` turns the hook on, in a clone).
- Never open a pull request. Pull requests are off on GitHub.
- `merge`, `promote`, `deploy`, `track`, `release` and `rollback` run only
  when Pete asks.
- Report what you observed (a version, a health check, a run's result),
  never what you assumed.
- When a deploy fails, read its output, or its job record in
  `.erga/jobs/`. A release whose own health row says that it fails for three
  minutes rolls the Worker back by itself.
- AGENTS.md has the code's rules. A file's traps are in the comment at
  its top.

## How a deploy runs

- Every deploy runs on a machine, with its Cloudflare credential:
  `CLOUDFLARE_API_TOKEN`, else the cf CLI's login (`bunx cf auth login`).
  GitHub only keeps the repository: it runs no workflow and has no token.
- A deploy builds the commit in a scratch worktree, then runs the pipeline:
  the D1 migrations, the static files, the Worker with its Cron Trigger, the
  addresses, the health. No step asks the deployed server: the server
  writes its health into its database each minute (its Cron Trigger), and
  the deploy reads that row through D1's API, as `bun erga status` does. A
  new release's row comes in about a minute; the first deploy of a server
  can wait up to 15 minutes for its first row (a new Cron Trigger starts
  slowly). The same run makes the default homepage when the server has
  none. A deploy sends no secret: the Workers keep their own.
- A rollback never changes the database: migrations only add.

## Run it locally

- `bun start`: the app in your browser, signed in without GitHub. An
  Anthropic key in `.dev.vars` (`ANTHROPIC_API_KEY`) turns on the agent.
  `bun start path/to/folder` opens a folder on disk as a document.
- `bun run look Enter`: presses keys in the editor, headless, and prints the
  page as text with a screenshot.
- `bun run format`: formats only the lines you changed.

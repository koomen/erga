# How to work in Erga's repository

Pete (`koomen`) owns Erga. `origin` is GitHub (`koomen/erga`). Every change
goes through a feature branch. `bun erga` is the only way onto `staging`
and `main`. There are no pull requests.

## The workflow

1. Start a feature branch for each task, from staging:

       bun erga start <branch>

   Any name but `staging` and `main`. In a worktree of your own, run a real
   `bun install --frozen-lockfile` first.
2. Commit. Before each push, run the tests and gate the push on the log:

       bun run test > test.log 2>&1; grep -q "^all passing" test.log && git push origin HEAD:<branch>

   `bun run test` (format, lint, typecheck, unit tests, smoke run) must end
   with `all passing`. Also run the e2e tests of the part you change
   (`bun run test:e2e e2e/full/page/`). The whole suite
   (`bun run test:full`) only when Pete asks.
3. A push deploys nothing. Tell Pete the branch name and what it changes.
4. When Pete asks, merge the branch into staging:

       bun erga merge <branch> [-m "message"]

   It squashes the branch into one commit, runs the tests on that commit,
   deploys it from this machine to each registered staging instance, then
   pushes staging and deletes the branch on GitHub. It stops on a conflict:
   rebase the branch on `origin/staging`, push it again, and merge again.
   It stops when a deploy fails, and staging stays where it was.
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

- `bun erga status`: each instance in `.erga/config.json` with its commit
  and health, the feature branches (ahead, behind, conflicts) and the
  commits on staging that are not on main. It only reads: no fetch.
- `bun erga`: the ops page on localhost. It lists the instances of `.erga/config.json`,
  each primary with its staging instances, the feature branches, the log with "live" at each
  instance's commit, and the job that runs. Its tabs: Setup (the checklist of `bun erga setup`), Deploys,
  Logs (a job's output, live) and History (the jobs). It only reads, and never fetches. A new job
  on another primary's instance switches the page to that primary.
- `bun erga deploy [<commit>] <host>`: deploys a registered instance from
  this machine, with the facts in `.erga/config.json`. Only when Pete asks.
  It asks no question. A staging instance needs a commit, and keeps its
  copy of production's data. A primary with no commit takes the commit
  that its staging instances run (they must agree and be healthy). It
  deploys only a commit whose tests passed (`.erga/tests/<sha>`; `merge`
  writes it), else it runs them first; `--no-tests` skips them. After a healthy deploy of a
  primary, `main` moves forward to the commit and the CLI pushes it. A
  primary does not deploy a commit apart from `main`.
- `bun erga rollback <host>`: a registered instance's Worker version from
  before its last deploy, in seconds. Only when Pete asks. The next deploy
  goes forward again.
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
- `merge`, `deploy`, `release` and `rollback` run only when Pete asks.
- Report what you observed (a version, a health check, a run's result),
  never what you assumed.
- When a deploy fails, read its output, or its job record in
  `.erga/jobs/`. A failed health check rolls the Worker back by itself.
- AGENTS.md has the code's rules and traps.

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

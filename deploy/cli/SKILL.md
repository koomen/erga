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
3. A pushed feature branch does not deploy. Tell Pete the branch name and
   what it changes.
4. When Pete asks, merge the branch into staging:

       bun erga merge <branch> [-m "message"]

   It squashes the branch into one commit on staging, runs the tests on that
   commit, pushes staging, deletes the branch on GitHub, and waits for the
   deploy. It stops on a conflict: rebase the branch on `origin/staging`,
   push it again, and merge again.
5. A push is not a deploy. `merge` reports staging's version and health
   when the deploy ends. Check the change on https://staging.erga.dev
   before you say that it works. Staging is for admins only.
6. Only when Pete asks: `bun erga promote` moves `main` to staging's head,
   and production deploys. It refuses when staging's run failed, or when
   staging does not run staging's head.
7. Only when Pete asks: `bun erga release [vX.Y.Z|major|minor|patch]`
   tags `main` and makes a GitHub release with notes from the commits.
   `--dry-run` shows the version and the notes first.

## The other commands

- `bun erga status`: production, staging, the feature branches (ahead,
  behind, conflicts) and the commits that wait for promote.
- `bun erga dashboard`: the same, as a live page on localhost.
- `bun erga rollback <staging|production>`: the Worker version from before
  the last deploy, in seconds. Only when Pete asks. The next deploy goes
  forward again.
- `bun erga own ...`: a person's own Erga on their own domain (`bun erga own skill`).

## The rules

- Never push to `staging` or `main` with git. The pre-push hook stops it
  (`bun erga hooks` turns the hook on; `bun install` does it too).
- Never open a pull request. Pull requests are off on GitHub.
- `merge`, `promote`, `release` and `rollback` run only when Pete asks.
- Report what you observed (a version, a health check, a run's result),
  never what you assumed.
- When a deploy fails, read the run's log: `gh run list --branch staging`,
  then `gh run view <id> --log-failed`. A failed health check rolls the
  Worker back by itself.
- AGENTS.md has the code's rules and traps.

## How a deploy runs

- `.github/workflows/test.yml` runs the tests on each push. After they pass,
  a push to `staging` or `main` runs `bun deploy/actions.ts <branch>`: the
  build, the D1 migrations, the Worker, the addresses, the health check.
  `deploy/actions-plan.ts` decides what a push deploys.
- The Workers keep their own secrets. The workflow has only
  `CLOUDFLARE_API_TOKEN` (its permissions: `TOKEN_PERMISSIONS` in
  `deploy/own/plan.ts`).
- erga.koomen.dev deploys after production, from the GitHub environment
  `koomen-test` and its variables. Another deployment: a new environment,
  and a copy of the `deploy-koomen` job.
- Staging runs on a frozen copy of production's data. Only
  `bun deploy/run.ts staging --fresh`, from a machine, copies it again.
- A rollback never changes the database: migrations only add.

## Run it locally

- `bun start`: the app in your browser, signed in without GitHub. An
  Anthropic key in `.dev.vars` (`ANTHROPIC_API_KEY`) turns on the agent.
  `bun start path/to/folder` opens a folder on disk as a document.
- `bun run look Enter`: presses keys in the editor, headless, and prints the
  page as text with a screenshot.
- `bun run format`: formats only the lines you changed.

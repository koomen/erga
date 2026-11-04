# Operations: how a deployment runs

This page tells how an Erga deployment builds, deploys and rolls back.
The examples use Erga's own deployment: erga.dev (production) and
staging.erga.dev (staging). Another deployment has its own names in
`deploy/targets.json`, or (a fork) in its GitHub repository's variables.

## The parts

- **The GitHub repository** `koomen/erga`. It is the source of truth.
- **The deploy workflow.** The `deploy` job of `.github/workflows/test.yml`
  runs `bun deploy/actions.ts <branch>` after the tests pass. It builds the
  commit and deploys it with the same pipeline as `bun own deploy` and
  `bun deploy/run.ts` (`control/deploys/pipeline.ts`, `runPipeline`).
- **The app Workers.** One for each target in `deploy/targets.json`. Erga's
  own: `erga` (production, from `main`) and `erga-staging` (staging, from
  `staging`).
- **The control Worker** (`control/`, `erga-control` at ops.erga.dev). It
  holds the old repository and its Git endpoint, the old deploy pipeline,
  the Ops page, the release store and the build container. It goes away in
  a later change. Until then, the app Workers keep their `CONTROL` service
  binding to it.

## The branches

1. A small fix that fits in one commit goes straight to `staging`. Larger
   work goes on a feature branch: any name but `staging` and `main`.

       git push origin HEAD:<branch>

   A feature branch does not deploy. Pete merges it into `staging`.
2. Push to `staging`:

       git push origin HEAD:staging

   GitHub runs the tests, then the deploy job deploys staging. `origin` is
   `git@github.com:koomen/erga.git`.
3. Check the deploy: `GET /api/deploys/version` on staging shows the commit
   when it is live. The run's log on GitHub (the Actions tab) shows each
   step.
4. Production deploys when `main` moves. Only a maintainer moves `main`.
   Agents never push to `main`.

Only one deploy of a branch runs at a time (the job's `concurrency`). A
newer push waits for it. If two pushes wait, only the newest deploys.

## What a deploy does

`bun deploy/actions.ts` does these steps:

1. It decides what the push deploys (`deploy/actions-plan.ts`).
2. It stops if the Worker has no `SESSION_SECRET` or no `FACTORY_KEY`.
   A deploy from GitHub sends no secrets. The Worker keeps the secrets that
   it has (`keepSecrets`).
3. It builds the commit (`buildHere`, as `bun own deploy` does).
4. It runs the pipeline: the D1 migrations, the files, the Worker with its
   bindings, the addresses, and the health check.
5. If the new version is not healthy, it rolls the Worker back to the
   version before, and the job fails.

Staging keeps its frozen copy of production's data. A fresh copy needs
`SNAPSHOT_TOKEN`, so it runs from a machine:
`bun deploy/run.ts staging --fresh`.

## The deploy credential

The workflow uses the repository secret `CLOUDFLARE_API_TOKEN`. Make it on
Cloudflare (My Profile > API Tokens > Create Custom Token) with these
permissions.

Account permissions (the deployment's account):

- Account Settings: Read
- Workers Scripts: Edit
- D1: Edit
- Workers R2 Storage: Edit

Zone permissions (all zones of the account, or the app's zones and the
pages' zones: for Erga, `erga.dev`, `erga-pages.dev` and
`erga-pages-staging.dev`):

- Zone: Read
- DNS: Edit
- Workers Routes: Edit

The variable `CLOUDFLARE_ACCOUNT_ID` names the account. Erga's own
repository can leave it out: `deploy/targets.json` has the account.

## A fork on its own domain

README.md ("Fork on GitHub") gives the steps. In short:

1. Deploy one time from a machine with `bun own deploy`. That deploy puts
   `SESSION_SECRET`, `FACTORY_KEY` and the sign-in secrets on the Worker.
   The Actions deploy refuses a Worker without them.
2. Set the secret `CLOUDFLARE_API_TOKEN`, and the variables
   `CLOUDFLARE_ACCOUNT_ID`, `ERGA_HOST`, `ERGA_ADMIN`,
   `ERGA_GITHUB_CLIENT_ID` and any other answers
   (`deploy/actions-plan.ts` lists them).
3. "Sync fork" on GitHub moves `main`, and the workflow deploys it.

The variable `ERGA_HOST` tells the workflow that the repository is a fork.
Without it, the workflow deploys the targets in `deploy/targets.json`, and
only in Erga's own account.

## A second deployment from the same repository

`koomen/erga` also deploys erga.koomen.dev. It is in the same Cloudflare
account, so the same `CLOUDFLARE_API_TOKEN` deploys it.

- The job `deploy-koomen` (`.github/workflows/test.yml`) runs after
  production's deploy, on a push to `main` only. erga.koomen.dev has no
  staging.
- Its answers are the variables of the GitHub environment `koomen-test`
  (Settings > Environments > koomen-test): `CLOUDFLARE_ACCOUNT_ID`, `ERGA_HOST`,
  `ERGA_STAGING`, `ERGA_PROVIDERS`, `ERGA_PRESET`, `ERGA_ADMIN`,
  `ERGA_PAGES` and `ERGA_GITHUB_CLIENT_ID`. They are the same as a
  fork's. The environment's variables replace the repository's.
- Its Worker keeps its own secrets. No secret of it is in GitHub.

To add another deployment, make an environment with its variables, and
copy the job with the environment's name.

## Staging

Staging is for admins only. It runs on a copy of production's data. The
copy is frozen: a deploy keeps it, and only a deploy with a fresh copy
(`bun deploy/run.ts staging --fresh`) replaces it. Every request there
needs an admin: an admin's session or an admin-scope token. The guard is
`server/identity/admins-only.ts`, from `adminsOnly` in
`deploy/targets.json`.

## Health checks and rollback

1. After each deploy, the pipeline checks the target's health
   (`GET /api/health`, `server/health.ts`).
2. If the check fails, `deploy/actions.ts` rolls the Worker back to the
   version before, by itself.
3. To roll back by hand, use one of these:
   - Revert the commit, and push the branch. The workflow deploys the
     revert.
   - On GitHub, open an earlier successful run of the branch, and click
     "Re-run jobs" on its deploy job. It deploys that run's commit again.
   - With no build, in seconds: Cloudflare's dashboard (the Worker,
     Deployments, Rollback), or
     `bunx cf workers deployments create --worker erga --strategy percentage --versions '[{"version_id":"<id>","percentage":100}]'`.

A rollback does not change the database. Migrations only add, so the
version before runs on the new tables.

## The move from the control Worker to GitHub

Before this move, the control Worker deploys on each push to its own Git
(https://ops.erga.dev/git/erga.git). Its GitHub sync also brings each push
on GitHub into that Git, and that push deploys too. If both systems run,
each push deploys two times. Do these steps one time, in this order:

1. On the Ops page (https://ops.erga.dev), on the GitHub card, click
   "Sync now". GitHub then has the latest `staging` and `main`.
2. On the GitHub card, click "Disconnect". The control Worker no longer
   sees pushes on GitHub, and it no longer pushes there. (The admin agent
   can do the same: the operation "Sync or disconnect GitHub", action
   `disconnect`.)
3. On the Deploy credential card, click "Disconnect". The control Worker
   then cannot deploy anything, also if someone pushes to its Git.
4. In each checkout, point `origin` to GitHub:

       git remote set-url origin git@github.com:koomen/erga.git

5. Add the secret `CLOUDFLARE_API_TOKEN` to `koomen/erga` (Settings >
   Secrets and variables > Actions), with the permissions above.
6. Merge the change into `staging` on GitHub, and push. The workflow
   deploys staging. Check `GET /api/deploys/version` on staging.
7. Move `main` when staging is good. The workflow deploys production.

After the move, these things stop:

- The Ops page's deploys, its Merge of feature branches and its rollbacks.
- New releases in the release store. Production's deploy published them
  for `/deploy` and for installs.
- New code for the control Worker. It deployed itself after production.

## A new deployment

docs/self-host.md tells how to set up a new deployment.

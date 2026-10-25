# Operations: how a deployment runs

This page tells how an Erga deployment builds, deploys and rolls back.
The examples use Erga's own deployment: erga.dev (production),
staging.erga.dev (staging) and ops.erga.dev (the control Worker). Another
deployment has its own names in `deploy/targets.json` and
`control/wrangler.jsonc`.

## The parts

- **The app Workers.** One for each target in `deploy/targets.json`. Erga's
  own: `erga` (production, from `main`) and `erga-staging` (staging, from
  `staging`).
- **The control Worker** (`control/`, `erga-control` at ops.erga.dev). It
  holds the repository and its Git endpoint, the deploy pipeline, the Ops
  page, the release store and the build container (`control/builder/`).
  It is apart from the app, so a broken app never stops a fix.

## The branches

1. Work on a branch of `staging`, or on `staging` for a small change.
2. Push to `staging`:

       git push origin HEAD:staging

   The control Worker builds the commit and deploys staging at once.
   The repository's remote is the control Worker's Git endpoint
   (https://ops.erga.dev/git/erga.git). A checkout whose origin is
   https://erga.dev/git/erga.git still works: erga.dev redirects Git there.
3. Check the deploy: `GET /api/deploys/version` on staging shows the commit
   when it is live.
4. Production deploys when `main` moves to a staging commit. An admin does
   this with Merge on the Ops page, the admin agent's `deploy_production`,
   the API, or a push to `main`. On Erga's own deployment, only a
   maintainer moves `main`. Agents never push to `main`.

## Staging

Staging is for admins only. It runs on a copy of production's data. The
copy is frozen: a deploy keeps it, and only a Redeploy with a fresh copy
replaces it. Every request there needs an admin: an admin's session or an
admin-scope token. The guard is `server/identity/admins-only.ts`, from
`adminsOnly` in `deploy/targets.json`.

## The deploy credential

The control Worker deploys with an OAuth grant that an admin gave once. No
API token is stored anywhere. An admin gives the grant with Connect
Cloudflare on the Ops page (a consent in a popup, `deploy/credential.ts`).
When Cloudflare refuses the grant, the Ops page's Cloudflare card shows
Cloudflare's own words, and Connect Cloudflare. The deploys that waited
start after the new grant.

## Health checks and rollback

1. After each deploy, the pipeline checks the target's health
   (`GET /api/health`, `server/health.ts`).
2. If the check fails, the pipeline rolls back by itself.
3. To roll back by hand, use Roll back on the deploy's log.

## The control Worker's own deploy

After production deploys, the control Worker deploys itself from the same
commit (`deploy/control.ts`). So a change under `control/` reaches the
control Worker when it reaches `main`.

Two changes still need wrangler from a machine
(`bun deploy/setup.ts --control`):

- A change to the build container's image (`control/builder/`).
- A new Durable Object class in `control/wrangler.jsonc`.

## A new deployment

`deploy/setup.ts` is the runbook for the first setup, as a script. It
tells each step first, and does it only after you say yes
(`bun deploy/setup.ts --dry-run` changes nothing). After the setup:

1. An admin opens the control Worker's Ops page and connects Cloudflare.
2. The first push to `staging` deploys staging.
3. The first move of `main` deploys production and then the control Worker.

# Deploy your own Erga

## The quick way: `bun own`

Give your coding agent the prompt at the top of DEPLOY.md. It deploys your
own Erga to your Cloudflare account with `bun own`, and a checklist page on
your machine shows each step. You need a Cloudflare account on the Workers
Paid plan, a domain on that account, a GitHub account, Bun and git.

`bun own deploy` deploys again from your machine. `bun own status` tells
how each server is.

## Deploys from GitHub

After the first deploy, GitHub Actions can deploy your Erga for you: a push
to `main` deploys production, and a push to `staging` deploys staging, if you
have one. README.md ("Fork on GitHub, deploy with GitHub Actions") gives the
steps, and docs/operations.md tells how a deploy works.

## Erga's own deployment

Erga's own servers (erga.dev and staging.erga.dev) are in
`deploy/targets.json`, and GitHub Actions deploys them from `koomen/erga`. A
fork does not change that file: it deploys with `bun own`, and its GitHub
repository's variables name its servers.

To deploy one of Erga's own targets from a machine (a fresh copy of
production's data on staging, say):

1. Log in to Cloudflare: `bunx cf auth login`. Or set `CLOUDFLARE_API_TOKEN`.
2. Run `bun deploy/run.ts staging --fresh`, or `bun deploy/run.ts production`.
   Staging's copy needs `SNAPSHOT_TOKEN` in the environment (production's).

A first deploy of a target sets its secrets by hand after it:

```sh
bunx cf workers secrets update SESSION_SECRET --name <worker>        # 64 random hex digits
bunx cf workers secrets update FACTORY_KEY --name <worker>           # 64 random hex digits
bunx cf workers secrets update GITHUB_CLIENT_SECRET --name <worker>  # its GitHub OAuth app's
bunx cf workers secrets update SNAPSHOT_TOKEN --name <worker>        # the same on production and staging
```

## What stays Erga's

- **The landing document** (`assets/landing/index.html`) links to erga.dev.
  It is product content: change it if you want.
- **Comments in the code** describe Erga's own deployment (erga.dev) as the
  example.

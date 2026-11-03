# Deploy your own Erga

## The quick way: erga.dev/deploy

Open **https://erga.dev/deploy** and sign in with GitHub. The page is the
manual: each step checks itself and tells you what to do.

1. **Connect Cloudflare.** Click *Authorize with Cloudflare* and choose your
   account. You need the Workers Paid plan ($5 a month). No account yet: the
   page links to Cloudflare's sign-up and plan pages.
2. **Where it goes.** Keep the free `workers.dev` address. You do not need a
   domain.
3. **Sign-in and the agent.** Nothing to make: people sign in with GitHub
   through Erga's GitHub App. The Anthropic key is optional.
4. **Install.** The page shows each step. If a step fails, it says why;
   fix it and click *Try again*. Try again continues where it stopped, also
   after a reload.

Your Erga keeps itself up to date: its control Worker installs Erga's new
releases with the consent you gave in step 1, and rolls back by itself
when a release fails its health check. You consent only one time.

### Your own domain, later

On your Erga's Ops page (`/admin/ops`), click **+ Add domain** under
production and type the name, for example `docs.example.com`. Erga checks
the name and shows the next step in the dialog:

| What Erga finds | What the dialog tells you |
| --- | --- |
| The domain is not on Cloudflare | Add it on Cloudflare (a link), or buy one on Cloudflare Registrar. Then *Check again*. |
| The domain is on Cloudflare, but its name servers did not move | The two name servers to set at your registrar, with *Copy*. Erga checks again each minute. |
| The name already has a DNS record | The record. *Replace it* only if you agree. |
| Another Worker has the name | Its name, and where to remove it. |
| Nothing is in the way | Erga adds it, waits for the certificate, and says when the name answers. |

The `workers.dev` address keeps working. Cloudflare needs the whole domain
(its name servers): a CNAME-only setup needs Cloudflare's Business plan, so
Erga does not offer it.

## A fork that you change (advanced)

The rest of this guide is for a fork of Erga with its own code, its own
GitHub App and its own Cloudflare OAuth client. It takes about an hour and
several apps made by hand. Use it only if the quick way is not enough. You
change one config file, `deploy/targets.json`. You do not change code.

Erga's own values (erga.dev) are in that file. They are the example: replace
each one with yours.

### What you need

- A Cloudflare account on the Workers Paid plan (Durable Objects, D1, R2,
  Containers, Artifacts and Browser Rendering, which the agents' `view_page`
  renders pages in: it needs no setup of its own).
- Three zones in that account:
  - the app's zone, for example `example.com`. Production, staging and the
    control Worker use hostnames in it.
  - a pages zone for production, for example `example-pages.com`.
  - a pages zone for staging, for example `example-pages-staging.com`.

  Each document's page runs on an origin of its own, `<id>-<owner>.<pages zone>`.
  A page zone must not be the app's zone: a page's scripts must never run on
  the app's origin. Each pages zone is a zone of its own because its free
  certificate covers only one level of subdomains.
- Docker (or OrbStack) on your machine, for the first deploy of the control
  Worker. Wrangler builds its container image.
- Bun, and a checkout of your fork with `bun install` done.

### 1. Change `deploy/targets.json`

```json
{
  "account": "<your Cloudflare account id: 32 hex digits>",
  "admins": "<GitHub logins, comma-separated: your bootstrap admins>",
  "source": { "namespace": "erga", "repo": "erga" },
  "control": {
    "branch": "main",
    "worker": "erga-control",
    "host": "ops.example.com",
    "zone": "example.com",
    "releases": "example-erga-releases",
    "vars": {
      "GITHUB_APP_ID": "<your GitHub App's id>",
      "GITHUB_APP_SLUG": "<your GitHub App's slug>",
      "GITHUB_APP_CLIENT_ID": "<your GitHub App's client id>",
      "CLOUDFLARE_OAUTH_CLIENT_ID": "<your Cloudflare OAuth client's id>"
    }
  },
  "targets": {
    "production": {
      "name": "production", "branch": "main",
      "worker": "erga", "database": "erga",
      "host": "example.com", "zone": "example.com",
      "pages": { "zone": "example-pages.com", "domain": "example-pages.com" },
      "vars": { "GITHUB_CLIENT_ID": "<production's GitHub OAuth app's client id>" }
    },
    "staging": {
      "name": "staging", "branch": "staging",
      "worker": "erga-staging", "database": "erga-staging",
      "host": "staging.example.com", "zone": "example.com",
      "pages": { "zone": "example-pages-staging.com", "domain": "example-pages-staging.com" },
      "vars": { "GITHUB_CLIENT_ID": "<staging's GitHub OAuth app's client id>", "CLOUDFLARE_OAUTH_CLIENT_ID": "" },
      "snapshotFrom": "production",
      "adminsOnly": true
    }
  }
}
```

The fields:

| Field | What it is |
| --- | --- |
| `account` | The Cloudflare account. `CLOUDFLARE_ACCOUNT_ID` in the environment overrides it for `deploy/run.ts` and `deploy/setup.ts`. |
| `admins` | The bootstrap admins. They are always admins, on every target. Other admins are added on the Users page. |
| `source` | The Cloudflare Artifacts namespace and repository that hold your Erga's Git history. |
| `control` | The control Worker: your repository's Git endpoint, the deploy pipeline, the Ops page and the build container. `releases` is the R2 bucket of the release store. `vars` are the public ids of your GitHub App and your Cloudflare OAuth client. |
| `targets` | Production and staging: each one's branch, Worker, D1 database, hostname, zone and pages zone. `vars` are text settings for that Worker. |

The names (Worker, database, bucket) must be free in your account. Keep the
key names as they are. The worker and database names can stay `erga` and
`erga-staging` in your own account.

`control/wrangler.jsonc` holds only the control Worker's bindings.
`deploy/targets.ts` (`controlWrangler`) fills in the names from
`deploy/targets.json`. You do not change `control/wrangler.jsonc`.

### 2. Make the apps

These are made by hand. None of them has an API.

1. **A GitHub OAuth app for production** (github.com/settings/developers).
   Homepage `https://<production host>`, callback
   `https://<production host>/auth/github/callback`. Put its client id in
   `targets.production.vars.GITHUB_CLIENT_ID`.
2. **A GitHub OAuth app for staging**, the same with the staging host. Put
   its client id in `targets.staging.vars.GITHUB_CLIENT_ID`.
3. **A GitHub App for the control Worker** (github.com/settings/apps/new,
   public). Callback `https://<control host>/auth/github/callback`, with
   "Request user authorization during installation". Webhook
   `https://<control host>/github/webhook`, push events. Permissions:
   Contents read and write, Metadata read, Administration read and write.
   Put its id, slug and client id in `control.vars`. Keep its client secret,
   webhook secret and private key in files. Convert the private key to
   PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in <github.pem> -out key.pem`.
4. **A Cloudflare OAuth client** (dashboard: Manage account › OAuth clients).
   Public, PKCE, redirect `https://<control host>/install/callback`, the
   Refresh Token grant, and the scopes that `bun deploy/setup.ts --dry-run`
   shows. Put its id in `control.vars.CLOUDFLARE_OAUTH_CLIENT_ID`.

Commit the changed `deploy/targets.json` before the next steps:
`deploy/run.ts` builds a commit, not the working tree.

### 3. Deploy

1. Log in to Cloudflare on your machine: `bunx cf auth login`. Or set
   `CLOUDFLARE_API_TOKEN`.
2. Deploy production the first time: `bun deploy/run.ts production`. This
   makes the Worker, its database, its hostname and its pages route.
3. Set production's secrets:

   ```sh
   bunx cf workers secrets update SESSION_SECRET --name <production worker>        # 64 random hex digits
   bunx cf workers secrets update GITHUB_CLIENT_SECRET --name <production worker>   # from step 2.1
   ```

   The Anthropic API key is optional. An admin can paste it later in the
   admin agent's panel.
4. Set up the control Worker and staging:

   ```sh
   bun deploy/setup.ts --dry-run       # shows each step; changes nothing
   GITHUB_APP_CLIENT_SECRET_FILE=… GITHUB_WEBHOOK_SECRET_FILE=… GITHUB_APP_PRIVATE_KEY_FILE=key.pem \
     bun deploy/setup.ts
   ```

   The setup makes the Artifacts repository and the R2 bucket, deploys the
   control Worker with wrangler, sets its secrets, and deploys staging the
   first time with a copy of production's data. It asks before each step.
5. Push your history into the repository:
   `ERGA_TOKEN=<admin-scope token> bun deploy/import-source.ts https://<control host> --from .`
   Make the token at `https://<production host>/tokens`.
6. Open `https://<control host>/` and click **Connect Cloudflare**. This
   gives the control Worker its deploy credential (an OAuth grant). There is
   no API token to keep.

After this, a push to `staging` deploys staging, and a move of `main` deploys
production and then the control Worker. Each deploy checks the target's
health and rolls back if the check fails.

## What stays Erga's

- **Installs from the deploy page** follow erga.dev as their upstream: their
  repository is a fork kept at erga.dev, and erga.dev builds their commits.
  A self-hosted fork has no upstream.
- **Sign-in with Google for installs** goes through Erga's own Google client.
  A self-hosted fork sets its own Google client on its Authentication page.
- **The landing document** (`assets/landing/index.html`) links to erga.dev.
  It is product content: change it if you want.
- **Comments in the code** describe Erga's own deployment (erga.dev) as the
  example.

# Erga on AWS

`bun erga` deploys Erga to Cloudflare or to AWS. The person chooses the host one time, in `bun erga setup`
(`provider=aws`). After that, `bun erga deploy`, `rollback`, `status` and the ops page work on both hosts.

On AWS, [celld](https://github.com/denoland/celld) (Deno, Apache-2.0) runs Erga's own Cloudflare release, with no
change to Erga's code: `project.ts` only turns the release into a celld project. The code fixes no account, region,
name or domain: each instance takes its names from its name in setup, and the AWS CLI's profile names the account.

## The files

| File | What it does |
| --- | --- |
| `template.ts` | The CloudFormation templates, from the answers (pure) |
| `stack.ts` | The templates in `.erga/aws/`, AWS's change sets, the stacks |
| `machine.ts` | celld and Chrome in the bucket and on the machine; the commands the CLI runs there (Systems Manager) |
| `project.ts` | A release as a celld project |
| `deploy.ts` | `bun erga deploy` and `rollback` of an instance on AWS |
| `setup.ts` | `bun erga setup` on AWS: what it observes, the `stack` step, the first deploy |
| `cli.ts` | The AWS CLI with the instance's profile and region |
| `check.ts` | Checks a live server feature by feature, in a browser and through the tools API |

## What runs where

| Part of Erga | On Cloudflare | On AWS |
| --- | --- | --- |
| The Worker (`cloudflare/index.ts`) | Workers | celld, on one EC2 machine (t4g.small) in a private subnet |
| Each document, the homepage, each person's agent, the news hub | Durable Objects | celld cells: SQLite on the machine's disk, copied to S3 |
| The database (users, settings, the directory) | D1 | celld's D1: a cell, copied to S3 |
| Blobs (FILES) | R2 | celld's R2: the instance's bucket, under `fleet/r2/` |
| The editor's files (ASSETS) | Static assets | celld's static assets: the bucket, cached on the disk |
| A page's own API (LOADER) | Worker Loader | celld's Dynamic Workers |
| HTTPS | Cloudflare's edge | CloudFront: an ACM certificate for a domain, or CloudFront's own name. Or a load balancer with the company's sign-in (below) |
| Each document's pages origin | A Worker route and a wildcard DNS record | With domains: a second CloudFront with a wildcard certificate, `*.<pages domain>`. Without: one shared CloudFront name |
| view_page's browser (BROWSER) | Browser Rendering | headless Chrome on the same machine (`ERGA_CHROME`), on the loopback only |
| The Cache API | Cloudflare's cache | celld's KV, namespace EDGE_CACHE (`cloudflare/kv-cache.ts`): celld's own Cache API always misses |
| Secrets | Worker secrets | Parameter Store, encrypted with the stack's KMS key; the machine adds them at each deploy |

## The stack

`bun erga setup <name> stack` writes `.erga/aws/<stack>.json` (and `<stack>-certs.json` with domains), then shows
AWS's change set. The person reads the template, may change it (the machine size, the disk, the image are its
parameters), and says yes; then `stack --yes` applies it. A later change to the file goes through the same steps: the
setup's status shows a template that changed since it was applied.

- **The network.** A new VPC: a private subnet for the machine, a public one for its way out. The way out is a NAT
  machine (t4g.nano) or a NAT gateway. Or the person names a VPC and a private subnet of their own, with its own way
  out and an internet gateway (`egress=vpc-.../subnet-...`): the stack then makes no network.
- **The machine.** No public address. Its firewall lets in only CloudFront's origin-facing prefix list, on celld's
  port. Systems Manager runs each deploy's commands: no SSH.
- **CloudFront.** Two distributions, the app's and the pages'. Each reaches the machine as a VPC origin, over the
  VPC. A CloudFront Function sets `X-Forwarded-Host` (the viewer's host) and `X-Forwarded-Proto` (https) on each
  request, over any value the viewer sent; celld trusts them (`CELLD_TRUST_FORWARDED_HEADERS`), and takes the last
  value. The cache keeps a response only when its Cache-Control lets a shared cache keep it; its key is the host, the
  path and the query.
- **Domains.** Each must have a Route 53 hosted zone in the account, and the pages' domain must not be under the
  app's. The certificates are in a second stack in us-east-1, where CloudFront needs them; DNS validates them.
- **Or a load balancer, with the company's sign-in**: the proxy mode (`signIn=proxy oidc=<issuer's URL>
  oidcClient=<client ID>`; `server/identity/mode.ts` has the two modes). A public Application Load Balancer takes
  CloudFront's place. It sends each browser to the company's OIDC sign-in first, and that sign-in is Erga's own: no
  GitHub, no Google (`server/identity/proxy.ts` reads the balancer's signed header; the setup writes which balancer
  and which client as `PROXY_SIGN_IN`). The first admin is an email address: a person added before their first
  sign-in, as an admin adds one on the Users page. With the company preset, everybody who passes the sign-in may make
  an account.
  - Erga knows each person by the email address the sign-in gives: the `email` claim, or the one `proxyEmail` names
    (`proxyEmail="username SSO_"` for a sign-in that gives `SSO_you@example.com` as `username`). A sign-in that gives
    none there makes no account, and its page names the claims that came.
  - The setup reads the sign-in's endpoints from its issuer. The client's secret is never in a file: the person who
    has it stores it in Secrets Manager as `erga/<stack>/oidc-client-secret` (plain text), and the stack reads it there.
  - Without the sign-in pass only: a document's own address (its files by their token; a frame can't sign in); on the
    app's address, what Erga's tokens guard (MCP and its OAuth, the operations, the CLI's token request, the deploy's
    checks: `shared/proxy-paths.ts`), a page's keyed requests to its room, and the server's own browser, by the NAT's fixed
    address. A person approves an agent on a page behind the sign-in.
  - The balancer refuses a request that brings its own `X-Forwarded-Host`, which celld would take for the host.
  - One certificate, in the stack and its region, for the app's name and the pages' wildcard. The pages' name may be
    under the app's (`pages.erga.example.com`): the person decides, since under one registrable domain a page's script
    can set a cookie for that domain.
  - It needs a domain, and the stack's own network (two public subnets; the NAT gets an Elastic IP).
- **The bucket** holds celld's state, the releases and the programs. Its key (KMS) lets only the machine's role read;
  the account's admins use it only to write, through Parameter Store and S3. Its policy denies a read to anyone but
  the machine's role. The stack keeps the bucket when it is deleted: the documents are in it.

## Nothing from outside AWS

The machine reaches only its bucket (S3's gateway endpoint), Parameter Store, Systems Manager, and, for Erga's own
features, the model APIs and the sign-in providers. celld and Chrome come from the bucket: the CLI downloads each one
time on the person's machine, checks its SHA-256, and puts it there. There is no outside DNS, no outside certificate
authority, and no Caddy.

## Deploy and rollback

- `bun erga deploy <commit> <name>`: the tests, the build, the release as a celld project into the bucket
  (`releases/<version>.tgz`), then on the machine: the migrations, `celld deploy`, and a wait until the new version
  answers. A release that doesn't answer goes back to the one before it. Then the health check through CloudFront.
- `bun erga rollback <name>`: the release before the one that runs, from the bucket. The database stays as it is.
- The secrets go into the settings on the machine only, at each deploy: the bucket's release holds none.

## Cost (us-west-2, each month)

| Part | Cost |
| --- | --- |
| EC2 t4g.small and its 16 GB disk | $13.54 |
| NAT machine: t4g.nano, its disk and its public address | about $7.40 (a NAT gateway: about $33) |
| S3 (a few GB, few requests) | under $1 |
| KMS key | $1 |
| CloudFront (two distributions; free tier: 1 TB out, 10 million requests) | $0 |
| KV writes of the edge cache (S3 requests) | under $3 |
| Route 53 hosted zones, with domains | $0.50 each |

Total: about $23 each month. With a load balancer in place of CloudFront: its hours ($16.43), its use (a few
dollars), its two public addresses ($7.30) and the secret ($0.40) more: about $52 to $56.

## What the first run showed (EC2, 2026-11-06)

That run used an earlier deploy script, Caddy and temporary names, with the same release and celld:

- Rooms and live editing, versions, blobs, the homepage, a page's own API and offline editing all worked.
- Each document's page had its own origin; Erga's service worker was active on it, and a reload offline showed the
  page and its editor.
- The edge cache: after a restart of celld, the first `/` came from the KV copy (7 ms); a blob was a hit the second
  time; CloudFront answered Hit for the homepage's and the editor's files.
- view_page: a render took 2.2 to 2.5 s the first time and 1.2 to 1.4 s after. Chrome used 265 MB.
- A scan of the bucket found 811 files: 8 hold a secret, all 8 encrypted with the KMS key, 0 plain.
- On one machine, 24 calls to a document took 3 to 8 ms, or 57 to 85 ms just after an edit (the wait for S3).

## Limits

- Staging on AWS isn't there yet: setup refuses `staging` with `provider=aws`.
- An agent's admin token (`bun erga setup <name> token`) and `--home` are for Cloudflare only.
- Without domains, CloudFront's names are random, and change if the stack makes a distribution again. The GitHub
  app's callback must then change too. The shared pages host has no offline copy, as on Cloudflare.
- A secret set in Parameter Store reaches the Worker at the next deploy.
- One machine: each write waits for S3 (about 90 ms by celld's docs). A second machine on the same bucket makes
  writes faster and takes over if the first one stops.
- A deploy reaches the machine about 10 s after `celld deploy`. An editor that opens in those seconds can fail to
  load; a reload fixes it.
- An admin of the account can still change the key's policy or the bucket's.
- With a load balancer: no edge cache and no compression but celld's own; the balancer's sign-in lasts 7 days, and an
  editor that is open when it ends gets errors until a reload; Erga's sign-out doesn't end the company's sign-in;
  `check.ts`'s browser can't pass the sign-in. The load balancer was not deployed for real yet.

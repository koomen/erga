# Erga on AWS

`bun erga` deploys Erga to Cloudflare or to AWS. The user chooses the host one time, in `bun erga setup`
(`provider=aws`). After that, `bun erga deploy`, `rollback`, `status` and the ops page work on both hosts.

On AWS, [celld](https://github.com/denoland/celld) (Deno, Apache-2.0) runs Erga's own Cloudflare release, with no
change to Erga's code: `deploy/deployer/celld.ts` only turns the release into a celld project. celld takes one
module: the release carries the Worker as one (`deploy/release.ts`), so no deploy bundles. The code fixes no account, region,
name or domain: each instance takes its names from its name in setup, and the AWS CLI's profile names the account.

## The files

| File | What it does |
| --- | --- |
| `template.ts` | The CloudFormation templates, from the answers (pure) |
| `gate.ts` | The gate in front (SSO): its code for the instance, and its edge key |
| `stack.ts` | The templates in `.erga/aws/`, AWS's change sets, the stacks |
| `machine.ts` | celld and Chrome in the bucket and on the machine; the commands the CLI runs there (Systems Manager) |
| `deploy.ts` | `bun erga deploy` and `rollback` of an instance on AWS |
| `deployer.ts` | The deployer in the cloud: its stack (role, function, schedule, the instance's document) and its install |
| `setup.ts` | `bun erga setup` on AWS: what it observes, the plan, the stacks, the first deploy |
| `cli.ts` | The AWS CLI with the instance's profile and region |
| `check.ts` | Checks a live server feature by feature, in a browser and through the tools API |

## What runs where

| Part of Erga | On Cloudflare | On AWS |
| --- | --- | --- |
| The Worker (`cloudflare/index.ts`) | Workers | celld, on one EC2 machine (t4g.small) in a private subnet |
| Each document, each domain's published site, each user's agent, the news hub | Durable Objects | celld cells: SQLite on the machine's disk, copied to S3 |
| The database (users, settings, the directory) | D1 | celld's D1: a cell, copied to S3 |
| Blobs (FILES) | R2 | celld's R2: the instance's bucket, under `fleet/r2/` |
| The editor's files (ASSETS) | Static assets | celld's static assets: the bucket, cached on the disk |
| A page's own API (LOADER) | Worker Loader | celld's Dynamic Workers |
| HTTPS | Cloudflare's edge | CloudFront: an ACM certificate for a domain, or CloudFront's own name |
| The gate, with the organization's sign-in | A Worker in front (`gate/mounts/worker.ts`) | CloudFront Functions and Lambda@Edge on the same distributions (below) |
| Each document's pages origin | A Worker route and a wildcard DNS record | With domains: a second CloudFront with a wildcard certificate, `*.<pages domain>`. Without: one shared CloudFront name |
| view_page's browser (BROWSER) | Browser Rendering | headless Chrome on the same machine (`ERGA_CHROME`), on the loopback only |
| The Cache API | Cloudflare's cache | celld's KV, namespace EDGE_CACHE (`cloudflare/kv-cache.ts`): celld's own Cache API always misses |
| Secrets | Worker secrets | Parameter Store, encrypted with the stack's KMS key; the machine adds them at each deploy |

## The stack

`bun erga setup <host> --host aws ...` writes `.erga/aws/<stack>.json` and `<stack>-certs.json` from the user's
answers. The dry run (`--dry-run`) lists each resource, and the agent asks for the user's
yes. Then the build writes the templates again, makes AWS's change sets, shows them in its log, and applies them.

- **The network.** A new VPC: a private subnet for the machine, a public one for its way out. The way out is a NAT
  machine (t4g.micro) or a NAT gateway. Or the user names a VPC and a private subnet of their own, with its own way
  out and an internet gateway (`--egress vpc-.../subnet-...`): the stack then makes no network.
- **The machine.** No public address. Its firewall lets in only CloudFront's origin-facing prefix list, on celld's
  port. Systems Manager runs each deploy's commands: no SSH.
- **CloudFront.** Two distributions, the app's and the pages'. Each reaches the machine as a VPC origin, over the
  VPC. A CloudFront Function sets `X-Forwarded-Host` (the viewer's host) on each request, over any value the viewer
  sent; celld trusts it (`CELLD_TRUST_FORWARDED_HEADERS`), and takes the last value. No header says the scheme:
  CloudFront refuses a function that sets `X-Forwarded-Proto`, and removes that header from each request. celld hears
  plain HTTP, and the server takes each address that is not on this machine for https (`shared/http.ts`, `overHttps`).
  The cache keeps a response only when its Cache-Control lets a shared cache keep it; its key is the host, the
  path and the query.
- **Domains.** Each must have a Route 53 hosted zone in the account, and the pages' domain must not be under the
  app's. The certificates are in a second stack in us-east-1, where CloudFront needs them; DNS validates them.
- **Or the gate in front, with the organization's sign-in** (`--sign-in sso --issuer <issuer's URL> --client <client
  ID>`). The gate (`gate/core.ts`) runs on CloudFront, in front of the same private machine
  (`gate/mounts/cloudfront.ts`; `gate.ts` builds it for the instance). Only a request with a proof goes on to Erga.
  **`bun erga setup` still refuses `--sign-in sso`**: no deploy of this stack passed on a real account yet. The verify
  suite deploys it with this code (`bun erga verify 5`).
  - Four CloudFront Functions, on both distributions: the gate's own paths (`/_edge/*`), the agents' open addresses
    (`/.well-known/oauth-*`, `/oauth/token`), every other request, and every response. Their settings (the hosts, the
    issuer) are in their code. No cache keeps one of the gate's own answers.
  - One KeyValueStore holds the edge key, which signs each cookie and token of the gate. The deploy writes it one
    time, before a distribution exists. It is in no file, and Erga never holds it.
  - One Lambda@Edge function: the sign-in's code exchange, and the token endpoint's form. It holds no edge key and
    signs nothing.
  - The functions, the store and the Lambda are in the us-east-1 stack, with the certificates (CloudFront takes a
    Lambda only from there). The main stack takes their ARNs. That keeps each template under the 51,200 bytes that
    CloudFormation takes from a command.
  - The client's secret is never in a file: the user types it on a page that setup opens on this machine, which
    stores it in Parameter Store in us-east-1 as `/erga-gate/<stack>/idp-secret` (a SecureString). Only the Lambda
    reads it. It is not in the machine's folder: Erga never holds it.
  - `GATE_KEY`: AWS makes it (a Secrets Manager secret of the stack). Both distributions send it to the machine with
    each request (`x-erga-front`), and the machine reads it at each deploy for Erga. Erga answers no request without
    it. It is in no file and no command.
  - A sign-in lasts 30 days, or `--sign-in-days <1 to 90>`: it is in the functions' code, and a change applies to new
    sign-ins. Erga's own setting (`sign_in_days`, on the Settings page) does not reach the gate.
  - The setup reads the sign-in's endpoints from its issuer. The first admin is the user who opens setup's one-time
    link and signs in (`server/identity/claim.ts`). Everybody who passes the sign-in may make an account.
  - It needs domains: the functions hold the app's host. The pages' name may be under the app's
    (`pages.erga.example.com`): the gate then needs no hand-off, and a page's script can set a cookie for the app's
    domain, so the user decides.
- **The bucket** holds celld's state, the releases and the programs. Its key (KMS) lets only the machine's role read;
  the account's admins use it only to write, through Parameter Store and S3. Its policy denies a read to anyone but
  the machine's role. The stack keeps the bucket when it is deleted: the documents are in it.

## Nothing from outside AWS

The machine reaches only its bucket (S3's gateway endpoint), Parameter Store, Systems Manager, and, for Erga's own
features, the model APIs and the sign-in providers. celld and Chrome come from the bucket: the CLI downloads each one
time on the user's machine, checks its SHA-256, and puts it there. There is no outside DNS, no outside certificate
authority, and no Caddy.

## Deploy and rollback

- `bun erga deploy <commit> <name>`: the tests, the build, the release as a celld project into the bucket
  (`releases/<version>.tgz`), then on the machine: the migrations, `celld deploy`, and a wait (3 minutes at most) until
  the new release answers its own health check on the loopback, healthy. A release that doesn't goes back to the one
  before it. Nothing asks the server from outside: `bun erga status` reads its health through Systems Manager, as the
  machine sees it on the loopback. The server makes its default homepage itself, in its scheduled run (a Cron Trigger
  in the project's wrangler.json, each minute; celld's Cron Triggers are not tested on a real machine yet).
- `bun erga rollback <name>`: the release before the one that runs, from the bucket. The database stays as it is.
- The secrets go into the settings on the machine only, at each deploy: the bucket's release holds none.

## The deployer in the cloud

`installDeployer` (`deployer.ts`) installs it with the person's own login: one more stack, `<stack>-deployer`, and the
function's code. Setup's cloud choice calls it. After that, no person's login is in a deploy.

- **The function** (`deploy/deployer/lambda.ts`, Node, 512 MB). It has no URL. Its schedule starts it each minute, one
  time. A run is one look (`deploy/deployer/look.ts`): the instance's spec, the branch's head at GitHub, and with
  auto-deploy on the deploy of the head's release, with the same steps as `bun erga deploy`. It fetches the release
  from GitHub, checks its digest, and packs the celld project itself.
- **The role** is its only credential: AWS changes its keys, and no person holds them. Its statements, each for this
  one instance: `s3:PutObject` on `releases/*` of the bucket; `kms:GenerateDataKey` on the stack's key, through S3
  only; `ssm:SendCommand` with the instance's document to the instance's machine; `ssm:GetCommandInvocation` (AWS has
  no narrower form than `*`); `ssm:PutParameter` on `/erga-live/<stack>`; with the gate in front, `ssm:GetParameter`
  on `/erga-gate/<stack>/installed`; and its own log group. It cannot read the bucket, run a shell, read a secret, or
  change IAM, a stack, a distribution, the document or its own code.
- **The instance's document** (`<stack>-deploy`, Systems Manager) is the fixed script (`machine.ts`, `documentScript`)
  with three actions: `load` a release, list the `deployed` releases, and one `sql` statement of the deploys' record.
  Systems Manager checks each parameter (a release is 12 hex characters; a statement is a read, or a write of the
  deploys' own tables, of plain characters only), and
  the agent gives them to the script as environment variables, never as text of the script. That needs the agent
  3.3.2746.0 or newer: with an older one the script stops at its start.
- **The gate.** Only setup installs the gate's code, and it records the hash of the gate's source
  (`/erga-gate/<stack>/installed`). A release carries the hash of its own gate. With the gate in front, the deployer
  deploys no release whose hash differs: it stops before any change and says to run setup (plan decision D7).
- **Each look is four commands on the machine** (the spec, the control row, the look's row, the jobs), each some
  seconds. Not deployed to a real account yet.

## Cost (us-west-2, each month)

| Part | Cost |
| --- | --- |
| EC2 t4g.small and its 16 GB disk | $13.54 |
| NAT machine: t4g.micro, its disk and its public address | about $10.40 (a NAT gateway: about $33) |
| S3 (a few GB, few requests) | under $1 |
| KMS key | $1 |
| CloudFront (two distributions; free tier: 1 TB out, 10 million requests) | $0 |
| KV writes of the edge cache (S3 requests) | under $3 |
| Route 53 hosted zones, with domains | $0.50 each |

Total: about $26 each month. With the gate in front: its secret ($0.40), and the functions' and the Lambda's use
(CloudFront Functions: $0.10 for each million requests after the free 2 million) more.

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

- The app has a domain in Route 53. The documents' pages have a zone of their own; with the organization's sign-in, a name
  under the app's (pages.<host>) too.
- A secret set in Parameter Store reaches the Worker at the next deploy.
- `bun erga status` and the ops page read the release that an instance runs from the parameter `/erga-live/<stack>`
  (a plain String), which each deploy and rollback writes with the AWS CLI. The admin's login needs
  `ssm:PutParameter` and `ssm:GetParameter` on it. An instance from before this parameter shows "no release on record
  yet" until its next deploy. This is not tested on a real AWS account yet.
- One machine: each write waits for S3 (about 90 ms by celld's docs). A second machine on the same bucket makes
  writes faster and takes over if the first one stops.
- A deploy reaches the machine about 10 s after `celld deploy`. An editor that opens in those seconds can fail to
  load; a reload fixes it.
- An admin of the account can still change the key's policy or the bucket's.
- With the gate in front: not deployed to a real account from this code yet. The four functions and the Lambda ran
  on a real distribution (2026-11-18, the verify suite's own stack then), with a Worker as the origin. Erga's
  sign-out doesn't end the organization's sign-in at its issuer.

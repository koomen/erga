# Erga on celld

[celld](https://github.com/denoland/celld) (Deno, Apache-2.0) runs Cloudflare
Workers and Durable Objects on machines of our own. Erga's own Cloudflare
release (`bun deploy/release.ts`, `.build/release/`) runs on it with no change
to Erga's code: `project.ts` only turns the release into a celld project.

## What runs where

| Part of Erga | On Cloudflare | On celld on AWS |
| --- | --- | --- |
| The Worker (`cloudflare/index.ts`) | Workers | celld, on one EC2 machine (t4g.small) |
| Each document, the homepage, each person's agent, the news hub | Durable Objects | celld cells: SQLite on the machine's disk, copied to S3 |
| The database (users, settings, the directory) | D1 | celld's D1: a cell, copied to S3 |
| Blobs (FILES) | R2 | celld's R2: the S3 bucket, under `fleet/r2/` |
| The editor's files (ASSETS) | Static assets | celld's static assets: the S3 bucket, cached on the disk |
| A page's own API (LOADER) | Worker Loader | celld's Dynamic Workers |
| HTTPS | Cloudflare's edge | Caddy on the machine (Let's Encrypt) |
| view_page's browser (BROWSER) | Browser Rendering | none |
| The Cache API | Cloudflare's cache | none: celld's cache always misses |
| Secrets (SESSION_SECRET, FACTORY_KEY) | Worker secrets | Parameter Store; the machine adds them at each deploy, and the bucket keeps them encrypted with a KMS key that only the machine may use |

The addresses are sslip.io names, so no DNS change is necessary:
`https://erga-<ip with dashes>.sslip.io` (the app) and
`https://pages-<ip with dashes>.sslip.io` (the documents' pages, PAGES_HOST).

## Cost (us-west-2, each month)

| Part | Cost |
| --- | --- |
| EC2 t4g.small | $12.26 |
| EBS gp3, 16 GB | $1.28 |
| Public IPv4 address | $3.65 |
| S3 (a few GB, few requests) | under $1 |
| KMS key (S3 Bucket Keys keep its requests few) | $1 |

Total: about $19 each month. Every resource has the tag `erga=aws-provider`.

## Deploy, check, remove

1. `aws sso login --profile labs`
2. `bun deploy/celld/aws.ts up`: it makes what is missing (the bucket, the
   machine's role, the key, the security group, the machine, SESSION_SECRET
   and FACTORY_KEY), then
   builds this checkout and deploys it. Its last line gives the check command.
3. `SESSION_SECRET=... bun deploy/celld/check.ts <app address>`: each feature,
   in a browser and through the tools API.
4. `bun deploy/celld/aws.ts down`: it removes all of it, the documents too. Its
   last line must say `nothing tagged erga=aws-provider is left`.

## Secrets

celld has no secret store: a Worker's settings are plain vars in its
deployment, in the bucket. So:

1. The secrets are in Parameter Store under `/erga-celld/`, encrypted with
   the KMS key `alias/erga-celld`. The release that `up` sends holds none.
2. The machine reads them at each deploy and adds them to the project just
   before `celld deploy`. The Mac never decrypts them.
3. The bucket encrypts each new object with the same key. The key's policy
   lets only the machine's role use it for S3. The account's admins manage
   the key, and use it only through Parameter Store.
4. The bucket's policy denies a read to anyone but the machine's role.

An admin of the account (AdministratorAccess) gets "explicit deny" from the
bucket, and "no resource-based policy allows the kms:Decrypt action" from
the key. An admin can still change either policy: the key stops the
bucket's readers, not the account's owners.

To turn on the agents, an admin pastes the Anthropic key on
`/admin/api-keys`. FACTORY_KEY encrypts it in the database.

## Limits

- view_page and eval_in_page: no browser. They say so.
- Sign-in with GitHub or Google needs an OAuth app for the test address. The
  check signs its own session cookie with the server's SESSION_SECRET.
- A secret set in Parameter Store reaches the Worker only at the next `up`.
- An object that the bucket held before the key keeps S3's own encryption.
  The release files also use S3's own key: they hold no secret.
- One machine: each write waits for S3. celld's docs give about 90 ms to a
  bucket in the same region. On the EC2 machine, 24 calls to a document took
  3 to 8 ms, or 57 to 85 ms when they came just after an edit (the server's
  Server-Timing header). The longer ones probably wait for the edit to reach
  S3, but celld does not log that wait. A second machine on the same bucket
  makes writes faster and takes over if the first one stops.
- A deploy reaches the machine about 10 s after `celld deploy`. An editor that
  opens in those seconds can fail to load; a reload fixes it.
- `bun erga` has no celld target: `up` is the deploy.

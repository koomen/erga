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
| HTTPS | Cloudflare's edge | The app: CloudFront (`cdn.ts`), then Caddy on the machine (Let's Encrypt). The pages: Caddy only |
| Each document's pages origin, `<id>-<owner>.<pages domain>` | A Worker route and a wildcard DNS record | A name under the machine's sslip.io name; Caddy gets a certificate for it at its first visit (on-demand TLS) |
| view_page's browser (BROWSER) | Browser Rendering | headless Chrome on the same machine (`ERGA_CHROME`), on the loopback only |
| HTTP caching of files kept for good (`/_home-files/`, the editor's hashed files) | Workers' own cache code | CloudFront, as each response's Cache-Control lets it |
| The Cache API (the homepage's copy, blobs, viewer decisions) | Cloudflare's cache | celld's KV, namespace EDGE_CACHE (`cloudflare/kv-cache.ts`): celld's own Cache API always misses |
| Secrets (SESSION_SECRET, FACTORY_KEY) | Worker secrets | Parameter Store; the machine adds them at each deploy, and the bucket keeps them encrypted with a KMS key that only the machine may use |

People use the app at a CloudFront name, `https://<id>.cloudfront.net`. Behind it, the machine has an sslip.io name, so
no DNS change is necessary: `erga-<ip with dashes>.sslip.io`. CloudFront sends the machine's name as Host and its own
as X-Erga-Host; Caddy passes that on as X-Forwarded-Host, so the Worker sees the CloudFront name. The machine's name
still answers directly, without the CDN.

### Each document's pages origin

As on Cloudflare, each document's page has an origin of its own (PAGES_DOMAIN):
`https://<id>-<owner>.pages-<ip with dashes>.sslip.io`. sslip.io sends each of these names to the machine. So Erga's
service worker works on a document's page, and the editor opens the page again offline.

1. A browser opens a new name. Caddy asks the Worker, on the loopback, whether the name is a document's
   (`GET /erga-host` as that host: 204 or 404).
2. Only for a real document, Caddy gets a certificate for that one name from Let's Encrypt. This takes a few seconds,
   one time for each document. Caddy keeps the certificate on the machine's disk and renews it.
3. A name that is not a document's gets no certificate, and the browser shows a TLS error.

CloudFront is not in front of the pages. CloudFront takes a name like `*.pages-....sslip.io` only with a wildcard
certificate in ACM, and ACM issues that only to the owner of the domain's DNS. The owner of sslip.io is not us.
CloudFront's own names (`<id>.cloudfront.net`) are one for each distribution, not one for each document. Without
CloudFront, a page's files come from Caddy. The browser still keeps them (ETag), and blobs still come from the edge
cache (KV).

What `check.ts` showed on EC2 (2026-11-06):

- Two documents opened on two origins: `https://re93nq48-koomen.pages-184-34-110-28.sslip.io` and
  `https://tj43mabk-koomen.pages-184-34-110-28.sslip.io`.
- Erga's service worker became active on the first page's origin. Offline, a reload showed the page and its editor.
- Caddy got a Let's Encrypt certificate for each of the two names: 3.4 s and 3.8 s. A name that is not a document's got
  no certificate (`tlsv1 alert internal error`).
- The scan of the bucket found 811 files: 8 hold a secret, all 8 encrypted with the KMS key, 0 plain.

Let's Encrypt's limits, and what they mean for many documents:

- Let's Encrypt counts all sslip.io names as one domain: sslip.io is not on the Public Suffix List. sslip.io has a
  larger limit, 50,000 new certificates each week, but all sslip.io users in the world share it. When they use it up,
  a document opened for the first time gets no certificate until the limit refills (hours). The documents opened
  before keep their certificates.
- Each account can ask for 300 new certificates each 3 hours: 300 new documents opened in 3 hours, at most.
- Renewals do not count against these limits.
- Each certificate is in the public Certificate Transparency logs. So the logs show each opened document's id and its
  owner's login. The id alone does not open the document: its page needs a signed token.
- For many documents, use a domain of our own. Then one wildcard certificate (DNS-01) covers all pages origins, with
  no limit and nothing in the logs, and CloudFront can be in front of the pages too.

### The edge cache

The Worker's code is the same on both hosts. Only the platform layer differs: where the celld project binds
EDGE_CACHE, `cloudflare/platform.ts` uses that KV namespace in place of `caches.default`. It keeps a response for its
max-age (at least 60 s, at most a week), whole, when it is at most 1 MiB (a larger KV value is in the bucket, no
faster than R2), and never a range. All isolates and nodes share it, and it outlives a restart.

What `check.ts` and a restart showed on EC2 (2026-11-06), each second request a hit:

- The homepage's copy: after `systemctl restart celld`, the first `/` came from the KV copy (`home;desc="cache"`,
  7 ms in the Worker), not from the home object. Before this change, a new isolate always asked the home object.
- A blob: the second GET said `blob from the edge's cache`. The same PNG, written again in a later run, was a hit on
  its first GET.
- The homepage's files and the editor's: the first GET through CloudFront said `Miss from cloudfront`, the second
  `Hit from cloudfront`.

CloudFront keeps a response only when its Cache-Control lets a shared cache keep it; with none, it keeps nothing. No
cookie or header is in its key. Everything else, WebSockets too, goes through to Caddy.

## Cost (us-west-2, each month)

| Part | Cost |
| --- | --- |
| EC2 t4g.small | $12.26 |
| EBS gp3, 16 GB | $1.28 |
| Public IPv4 address | $3.65 |
| S3 (a few GB, few requests) | under $1 |
| KMS key (S3 Bucket Keys keep its requests few) | $1 |
| CloudFront (one distribution, for the app; free tier: 1 TB out, 10 million requests) | $0 |
| Certificates for the pages origins (Let's Encrypt, on the machine's disk) | $0 |
| KV writes of the edge cache (S3 requests; at most one each 5 s of traffic) | under $3 |

Total: about $19 each month. Every resource has the tag `erga=aws-provider`, but for CloudFront's cache policy
(`erga-celld-origin-cache-control`, which takes no tag): `down` removes it by its name.

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

- `up` waits for CloudFront each time it makes or changes a distribution: a few minutes. `down` waits for it to
  turn each one off before it deletes it: a few minutes more.
- The edge cache's KV namespace is one celld cell: its writes run one at a time, and each goes to S3. A blob over
  1 MiB, and a range of any blob, still come from the bucket each time.
- view_page and eval_in_page use one headless Chrome on the machine (Playwright's
  ARM64 build, 153). It shares the 2 GB: after renders of two documents, Chrome
  used 265 MB and the machine had 630 MB free. systemd stops Chrome at 900 MB
  and starts it again, so a large page can't stop celld. A render took 2.2 to
  2.5 s the first time, and 1.2 to 1.4 s after. Chrome opens the app at its
  public address, as a person does.
- CloudFront's names are random (`<id>.cloudfront.net`). A name of our own needs a certificate in ACM.
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
- The first visit to a document's page waits for its certificate: a few seconds. See "Each document's pages origin"
  for Let's Encrypt's limits.
- sslip.io gives a name the first IP address in it, from the left. An owner whose login has four numbers in a row
  (`a-10-0-0-1`) gets a pages name that goes to that address, not to the machine: that owner's pages do not open.
- A new machine has a new IP address, so each pages origin has a new name: the browsers' offline copies of the old
  names are not used again.

# Erga's secrets

The single, complete list of every token, key and secret Erga needs or makes:
what it is for, what breaks without it, where it is set, whether Erga encrypts
it at rest, who can read it, and whether an admin should enter or rotate it on
the admin pages or it should stay a deploy-time secret. Keep this list current
when you add or remove one. The audit of 2026-10-06 (factory task #35) made it,
and its findings are at the end.

"Encrypted at rest" here means encrypted by Erga itself. Cloudflare encrypts
D1, Durable Object storage and Worker secrets on its disks for every customer.
That protects against a lost disk, but not against someone who can read the
database, the object or the Worker's settings through Cloudflare.

**Admin panel?** says where a secret belongs:

- **Admin panel**: an admin can enter and rotate it on the server's admin
  pages, encrypted, never shown back. Losing it breaks one feature, not the
  sign-in or the admin pages themselves.
- **Deploy-time**: a Worker secret (`bunx cf workers secrets update NAME`, or
  `deploy/setup.ts`). It is a root key, guards the sign-in, or keeps the admin
  pages working, so a wrong value entered on those pages could lock admins out.
- **Per person**: each person makes their own in the app. No admin sets it.
- **Machine**: lives only on a developer's or operator's machine.

## Worker secrets (deploy-time)

### `SESSION_SECRET`
- **For**: the server's root signing key. It signs session cookies (`worker/auth.ts`), OAuth state cookies, test tokens (`erga_test_…`), documents' pages tokens (`/t/<token>/`, `front.ts`). It derives agent tokens (`erga_…`, `tokens.ts`) and, with a cookie half, the key that seals a person's Cloudflare token on `/deploy` (`worker/deploy.ts`). Locally it also stands in for `FACTORY_KEY`.
- **Without it**: nobody can sign in. If it changes, every session, agent token (any scope), share token, test token and pages link stops working.
- **Set**: a Worker secret on each server. `deploy/setup.ts` makes a random one for staging, `/deploy` makes one for each new server, and `bun start` writes one to `.dev.vars` locally.
- **At rest**: only as a Worker secret.
- **Who reads it**: the Worker's code, and anyone who can read or change the Worker's secrets in Cloudflare.
- **Admin panel?** Deploy-time. It is the root of every other credential.

### `FACTORY_KEY`
- **For**: the factory. It encrypts the stored Claude token (AES-GCM, a fresh IV each time, key = SHA-256 of `erga-factory-secrets:` + the key). It signs the VMs' task tokens (`fct.…`), git tokens (`fgt.…`) and preview tickets, each with its own derived key.
- **Without it**: a hosted server can't store a Claude token or run factory VMs. If it changes, the stored Claude token can't be decrypted. Today the board still says "signed in" then, and the VMs run the scripted stand-in.
- **Set**: a Worker secret, made by `bun deploy/setup.ts --factory` (32 random bytes, never printed).
- **At rest**: only as a Worker secret.
- **Who reads it**: the Worker's code.
- **Admin panel?** Deploy-time. It is the key that protects the secrets admins enter.

### `GITHUB_CLIENT_SECRET`
- **For**: signing in with GitHub (the OAuth app whose public client ID, `GITHUB_CLIENT_ID`, is in `deploy/targets.json`).
- **Without it**: nobody can sign in on a hosted server (`DEV_LOGIN` does without it locally).
- **Set**: a Worker secret. Locally it is optional, in `.dev.vars`.
- **At rest**: only as a Worker secret. The GitHub access token it gets at each sign-in is used once, to read the login, and never stored.
- **Who reads it**: the Worker's code.
- **Admin panel?** Deploy-time. A wrong value stops every sign-in, including the admin who would fix it.

### `ANTHROPIC_API_KEY`
- **For**: the editor's embedded agent (`agent.ts`), in each document's Durable Object.
- **Without it**: the agent is off. Everything else works.
- **Set**: an admin enters it on `/admin/api-keys` (the Anthropic API key), since factory task #38. The Worker secret is the fallback while none is stored there. Locally the fallback is `.dev.vars`, or the shell's environment (`dev/agent-key.ts`).
- **At rest**: **encrypted** when an admin enters it: AES-GCM, a fresh IV each time, the key's name as additional data, key = SHA-256 of `erga-credentials:` + `FACTORY_KEY`, in D1's `credentials` table (`credentials.ts`). The Worker secret is only a Worker secret.
- **Who reads it**: the document's Durable Object, the `Factory` Durable Object (its agent), and version descriptions (`versions.ts`), through `withKeys` (`worker/d1.ts`). It is read as a redacted value and never reaches a page, a log or the agent's tools. `/admin/api-keys` shows only whether it is set, its last four characters, and who set it when.
- **Admin panel?** **Admin panel** (it is there). See "Keys entered on the admin pages" below.

### `OPENAI_API_KEY`
- **For**: models from OpenAI, beside Anthropic's. No code calls OpenAI yet. Code that does reads the key through `withKeys` (`worker/d1.ts`), as for `ANTHROPIC_API_KEY`.
- **Without it**: those models are not offered.
- **Set**: an admin enters it on `/admin/api-keys` (the OpenAI API key). The fallback is a Worker secret of the same name, if there is one.
- **At rest**: **encrypted**, as `ANTHROPIC_API_KEY`, in the same table.
- **Who reads it**: the server's own calls to OpenAI only. `/admin/api-keys` shows only whether it is set, its last four characters, and who set it when.
- **Admin panel?** **Admin panel** (it is there).

### `CLOUDFLARE_DEPLOY_TOKEN`
- **For**: a server deploying itself when its branch moves (branch deploys, `deploy/branches.ts`, `worker/pipeline.ts`). With `CLOUDFLARE_ACCOUNT_ID` (not a secret).
- **Without it**: the server doesn't deploy itself. Deploys from a machine still work.
- **Set**: `bun deploy/setup.ts` makes it as narrow as Cloudflare allows (Workers edit on named Workers, D1 on the account, read on the zones), checks it, and stores it as a Worker secret, never printed. Staging's token is on `erga-staging`. Production's token is on `erga`, only with `--production`.
- **At rest**: only as a Worker secret.
- **Who reads it**: the Worker's code, so any code that runs on that server. Cloudflare has no per-database D1 scope, so staging's token can also write production's D1.
- **Admin panel?** **Admin panel**, since factory task #51: an admin can enter it on `/admin/api-keys` (the Cloudflare deploy token), encrypted as `ANTHROPIC_API_KEY`. The Worker secret is the fallback. A wrong value breaks only the server's own deploys. `deploy/setup.ts --tokens` still rotates the Worker secret.

### `SNAPSHOT_TOKEN`
- **For**: staging copying production's documents (`deploy/snapshot.ts`). The same value is on both servers. Production serves its read-only snapshot endpoint to it, and staging sends it.
- **Without it**: staging's deploy can't copy production's documents.
- **Set**: `deploy/setup.ts` (random), on both Workers. It is compared in constant time and must be at least 32 characters.
- **At rest**: only as a Worker secret.
- **Who reads it**: both Workers' code. With it, staging can read every production document.
- **Admin panel?** Deploy-time.

### `DEPLOY_HOOK_SECRET`
- **For**: production and staging telling each other a branch moved, and reading each other's deploy status (`worker/deploys.ts`).
- **Without it**: a push heard on one server doesn't reach the other. Each still deploys its own pushes.
- **Set**: `deploy/setup.ts` (random), or `deploy/setup.ts --hook-secret` to rotate it, on both Workers. It is compared in constant time and must be at least 16 characters.
- **At rest**: only as a Worker secret.
- **Admin panel?** Deploy-time.

### `GITHUB_MIRROR_TOKEN`
- **For**: pushing Erga's source to its GitHub mirror (`github.com/koomen/erga`, or `GITHUB_MIRROR_URL`).
- **Without it**: no mirror. The source on Erga's own Git endpoint is not affected.
- **Set**: a Worker secret (`bunx cf workers secrets update GITHUB_MIRROR_TOKEN`), bound only when the deploy names an Artifacts namespace. A fine-grained GitHub token: Contents read and write, on the one repository.
- **At rest**: only as a Worker secret. It goes to GitHub only in a header. Mirror errors show only the host.
- **Admin panel?** **Admin panel**, since factory task #51: an admin can enter it on `/admin/api-keys` (the GitHub mirror token), encrypted as `ANTHROPIC_API_KEY`. The Worker secret is the fallback. It expires every year and breaks only the mirror.

## Kept by the app

### The Claude plan token (`CLAUDE_CODE_OAUTH_TOKEN`)
- **For**: the factory's VMs run Claude Code on a Pro or Max plan (`claude setup-token` prints it: `sk-ant-oat01-…`, valid for one year).
- **Without it**: the factory's VMs run a scripted stand-in.
- **Set**: an admin pastes it on the board (`/admin/factory`, "Claude: not signed in") or on `/admin/api-keys` (the Claude plan token). An admin in a browser and a same-origin request are necessary.
- **At rest**: **encrypted**, AES-GCM with a key from `FACTORY_KEY`, in the `Factory` Durable Object's `secrets` table.
- **Who reads it**: no route returns it (`GET /api/factory/claude` says only whether there is one, who set it and when). Since this audit, only the jobs that run Claude Code get it in their environment. The merge, save, stop and discard jobs do not. Any command Claude Code runs in the VM can read it.
- **Admin panel?** **Admin panel** (it is there already).

### Agent tokens (`erga_…`), including the share buttons'
- **For**: the only credential for agents, scripts, the API, `/mcp`, documents' `/api/ext`, the factory's API and git push. Each has a scope: `document` (one document), `documents` (the person's documents, no admin power) or `admin` (all the person can do; only admins make one; admin power checked live with `Users.isAdmin`; git push needs it). The editor's share button's token is a `documents` token. "Share with agent" on the admin pages makes an `admin` token that ends in at most 12 hours (README, Tokens).
- **Set**: per person: `/tokens`, the editor's share button, Share with agent on the admin pages (`POST /admin/share`), or an agent's device-flow request (`/api/auth/request`, its polling code `ergareq_…`). No token can make or approve another: only a person signed in in a browser can.
- **At rest**: only the SHA-256 is in D1 (`agent_tokens`). The token is an HMAC of its id with `SESSION_SECRET`, so the share button can show its token again. Since this audit, a token works only on the server whose secret made it: production's tokens do not work on staging, although staging's D1 is a copy of production's.
- **Exposure**: the share buttons' tokens go into prompts for outside agents; Share with agent's carries admin power until it ends (12 hours at most). A token has an expiry if its maker chose one; an expired token stops working. Revoke on `/tokens`.
- **Admin panel?** Per person.

### Factory tokens (`erga_factory_…`): gone
- Share with agent made these until it made admin tokens (above). The `Factory` Durable Object dropped their table, so none works; the factory's API answers one with 401, saying to ask for a new token.

### The factory's VM tokens: task tokens (`fct.…`), git tokens (`fgt.…`), preview tickets, `FACTORY_AGENT_SECRET`
- **For**: a task's VM reports on its task (`fct`), pushes its branch (`fgt`, task scope; merge scope also moves `staging`, once, only to the merge itself, for 35 minutes: README, "What a task's VM can reach"), and an admin opens its preview (ticket, then a cookie on the preview's host). `FACTORY_AGENT_SECRET` is random for each VM and lets only the factory reach the VM's agent.
- **At rest**: not stored (signed with keys from `FACTORY_KEY`). They are in the VM job's environment.
- **Exposure**: the VM's own code can read them. Since this audit, the factory hides anything shaped like a token in what a VM reports (log lines, summaries, errors, captions), because the board and outside agents with admin tokens read that text.

### Test tokens (`erga_test_…`)
- **For**: the test suite against erga.dev (`ERGA_TEST_TOKEN=… bun run test:prod`). They sign in throwaway test people who can open only test documents.
- **At rest**: not stored. Signed with `SESSION_SECRET`, they last 7 days. They travel in a URL (`/auth/test?token=…`), so they can show in Worker logs.
- **Admin panel?** Per person (`/settings`).

### A person's Cloudflare token on `/deploy`
- **For**: deploying Erga to their own Cloudflare account.
- **At rest**: **encrypted** (`deploy/seal.ts`, AES-256-GCM). The key is an HMAC of a random cookie half (32 bytes, HttpOnly, `Path=/deploy`) with `SESSION_SECRET`, so neither the storage nor the cookie alone opens it. It is deleted after the deploy, on "forget", and after 2 hours at most. A token from Cloudflare's OAuth is revoked after a deploy that succeeds.
- **Admin panel?** Per person, transient.

### Artifacts tokens
- **For**: reading and writing Erga's source in Cloudflare Artifacts (the server, the builder).
- **At rest**: not stored. The server mints them through its Artifacts binding (one hour) and keeps them in memory. Since this audit, the builder gives git its token through the environment, never its command line, so a failed fetch can't put it in the deploy log.

## Not secret (listed so nobody treats them as secret)

`GITHUB_CLIENT_ID`, `CLOUDFLARE_OAUTH_CLIENT_ID` (a public PKCE client), `CLOUDFLARE_ACCOUNT_ID`, `ADMINS`, `SERVER_CONFIG`, `DEPLOY_TARGET`, and admins' SSH public keys.

## Local development only

- `DEV_LOGIN`: signs everyone in as this login, on localhost only. It is never bound on a hosted server.
- `ERGA_LINK_SECRET`: the dev server proves itself with it to link files on disk to documents. The dev server makes it for each run.
- `.dev.vars` (gitignored, as is `.dev.vars.*`): the local `SESSION_SECRET`, `ANTHROPIC_API_KEY` (and `OPENAI_API_KEY`, if you want one), `GITHUB_CLIENT_SECRET`. A key stored on the local `/admin` wins over them.

## On the operator's machine

- The Cloudflare login (`bunx cf auth login`) or `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_TOKEN_MAKER` (Account API Tokens Edit, for `deploy/setup.ts`). Use them only in the shell that runs the setup, never in a file.
- The admin token that git push uses (scope `admin`, made at `/tokens`), in Git's credential store (`git credential approve`; README, Tokens).

## Keys entered on the admin pages

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_MIRROR_TOKEN` and
`CLOUDFLARE_DEPLOY_TOKEN` are on the admin pages (`/admin/api-keys`;
`credentials.ts`, factory tasks #38 and #51). The page also lists the other
deploy-time secrets, read-only: only whether the deploy has each. They are not ordinary settings. The settings
(`server_config`) are plain JSON in D1. Every change is copied into the change
log (`server_config_versions`), which admins read, and staging's database is a
copy of production's. Do as the Claude token does instead:

1. Encrypt the key with AES-GCM, a fresh IV each time, under a deploy-time key
   (`FACTORY_KEY`, or a new key for these), in a table or object of its own.
2. Show back only whether there is a key, who set it and when (and perhaps
   its last four characters). Never return the key itself.
3. Record "key changed by …" in the change log, never the value.
4. Accept a change only from an admin in a browser, with a same-origin request.
5. Keep the Worker secret as a fallback, so a server deployed without the
   admin pages' key still works.

`credentials.ts` does all five. The encryption key comes from `FACTORY_KEY`
(with its own derivation, `erga-credentials:`), so a server without
`FACTORY_KEY` can't store a key and the page says so. Staging has its own
`FACTORY_KEY`, so production's stored keys, copied into staging's database,
do not open there: staging uses its own stored keys or its Worker secrets.
The table keeps the last four characters in plain text, for the page.
`tests/credentials.test.ts` tests each point.

## Audit of 2026-10-06: findings, by severity

Fixed in this task (each with a test in `tests/secrets.test.ts`
or `development/task-queue/test.ts`):

1. High: the local task queue (port 4700) checked nothing about who asked, so
   a web page in the user's browser could make it run a command (a preview's
   `command`), release to production, or serve a local file. It now refuses
   any other Origin or Host, and reads only `application/json` as JSON.
2. High: the share button's token, which goes into prompts for outside
   agents, had an admin's full power (settings, users, Git, deploys) while
   admin keys are off. It now has the person's documents only.
3. High: a factory VM's code could put the Claude token (or its task and git
   tokens) in a log line, summary, error or caption, which the board and
   factory-token holders read. The factory now hides anything shaped like a
   token there. The Claude token now goes only to the jobs that run Claude Code.
4. Medium: production's agent tokens worked on staging (staging's D1 is a
   copy). A token now works only on the server whose secret made it.
5. Low–medium: a build that failed to fetch put the Artifacts token, in base64,
   in its error, and so in the deploy log and history.
6. Low: a VM could set a preview path such as `//evil.example`, and "Open
   preview" would redirect there with its ticket. Screenshots from VMs now have
   `nosniff` and a sandbox CSP. The board of the task queue opens only http(s)
   links. The pages token's MAC is compared in constant time. `.gitignore`
   covers `.dev.vars.*`, `*.pem` and `*.key`.

Not fixed (design changes, for their own tasks):

1. Critical: a factory merge runs in the task's own VM, where Claude Code and
   the task's code ran as the same user. That code can change the merge's
   script or add a git hook, take the merge's git token, and push anything to
   `staging`, which deploys itself. Fix: the Worker (or `SourceRepo`) merges
   the reviewed commit itself, and the VM gets a task-scoped token only.
   Also tie the merge to the reviewed commit.
2. High: staging holds `CLOUDFLARE_DEPLOY_TOKEN` (D1 write on every database
   in the account, production's too), `SNAPSHOT_TOKEN` (reads every production
   document) and `DEPLOY_HOOK_SECRET`. Any code that reaches `staging` can read
   or change production's data. Fix: production pushes its copy to staging,
   or staging moves to its own Cloudflare account.
3. High (fixed by task #65): an admin's plain agent token (no expiry) had
   full admin power, up to a production merge. Now only a token with the
   `admin` scope has admin power, and any token can have an expiry.
4. Medium: the Claude token is in the environment of every command Claude
   Code runs, and the VM has the internet. A prompt injection can send it out.
   Fix: narrow the VM's egress, or proxy Anthropic's API through the Worker.
5. Medium: the homepage's script runs on erga.dev's own origin and could mint
   a visitor's agent token. WebSocket upgrades check no Origin. Fix: serve the
   homepage from its own origin; refuse upgrades from other origins.
6. Low: a person who loses access to a document can still read its pages for
   up to 8 days (the pages token). Session cookies can't be revoked before
   their 30 days. A Cloudflare OAuth token on `/deploy` is not revoked when a
   deploy fails or is forgotten. Test tokens travel in URLs.
   `/api/auth/request` has no rate limit. In the dev server's simulated VMs,
   the real Claude Code can run outside any sandbox when a token is stored.

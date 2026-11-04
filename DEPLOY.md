# Deploy your own Erga

Your own Erga runs on your own Cloudflare account. Your coding agent (for
example Claude Code) deploys it with `bun own`, a CLI made for agents. You
make the decisions and do the few things that only a person can do in a
browser. A checklist page on your machine shows each step.

## The prompt

Give this prompt to your coding agent, in an empty folder:

```prompt
Deploy my own Erga (https://erga.dev) to my Cloudflare account.

1. Run: git clone https://github.com/koomen/erga.git erga && cd erga && bun install --frozen-lockfile
2. Read DEPLOY.md in it, and do what its "For the agent" part says.
3. Ask me all of its questions in one message, with the defaults. Do nothing in my account before I answer.
4. Never ask me to paste a secret or a token into this chat. Secrets go only into the checklist page or a file.
5. When it is done, give me my Erga's address, and tell me what is left for me to do.
```

You need: a Cloudflare account on the Workers Paid plan ($5 a month), a
domain on that account, a GitHub account, [Bun](https://bun.sh) 1.3 or
newer, and git. About 15 minutes; most of it is the build and the deploy.

## What you decide

The agent asks these in one message. `bun own ask` prints them with the
defaults.

| Question | Default | What it does |
| --- | --- | --- |
| Production address | (you choose) | A name on a domain of your account, e.g. `erga.example.com`. Nothing may use it yet. |
| Staging server | no | A second server at its own address, to try updates first. It has its own, empty data. |
| Sign-in | GitHub | GitHub, or GitHub and Google. You (the first admin) sign in with GitHub. |
| Server preset | website | `website`: a public homepage; documents shared "with anyone with the link" open for everyone; only you and people you add sign in. `company` ("sharing docs in my company"): nothing opens for people who are not signed in; people of your company's Google Workspace domain or GitHub organization sign in by themselves. Both keep documents until they are deleted. Admins can change each setting later on /admin/settings. |
| Admin | your GitHub login | The first admin. |
| Company domain or org | none | Only for `company`. |
| Documents' pages | shared | Each document's page runs on an address apart from the app, for safety. `shared`: one workers.dev address (no domain needed). Or a second domain of your account: each document gets its own origin. |

## What only you do

1. **Log in to Cloudflare.** The agent runs `bunx cf auth login`. A browser
   opens: sign in, and click Allow.
2. **Answer the questions.** In the chat, or on the checklist page.
3. **Make the GitHub sign-in app.** On the checklist page, click *Create the
   GitHub App*, then *Create GitHub App* on GitHub. GitHub sends the app's
   values back to the page. You copy nothing. (Google sign-in: the page
   gives the exact steps, and you type the client's values on the page.)
4. **Sign in.** Open `https://<your address>/auth/sign-in` and sign in with
   GitHub.

## Updates

Your Erga updates from erga.dev. Ask your agent to "update my Erga". It runs
`bun own update`: it pulls `main` from https://github.com/koomen/erga.git, and
deploys staging (if you have it), then production. Your own changes stay in
your checkout; a conflict stops the update before any deploy.

## For the agent

You drive `bun own`. Each command prints `PASS` or `FAIL`, and a `NEXT`
line: who does the next step (the agent or the person) and how. Never guess
past a `FAIL`. Run every command from the checkout's folder.

1. `bun own status`: where the deploy is. Run it first, and after each step.
2. `bun own start` in the background (it keeps running), and give the person
   the address it prints (http://localhost:4747/ unless that port is
   taken). The page shows the same
   steps, live. Read the person's messages from it with `bun own inbox`, and
   answer there with `bun own say "<text>"`, as well as in the chat.
3. If `bun own status` says the person is not logged in to Cloudflare, run
   `bunx cf auth login` and tell the person to finish it in the browser. If
   it lists more than one account, ask which one, then
   `bun own set account=<id>`.
4. `bun own ask`, then ask the person every question in ONE message, with
   the defaults. Record the answers: `bun own set host=... staging=no
   providers=github preset=website admin=<login> pages=shared`.
5. Sign-in. Tell the person to click *Create the GitHub App* on the
   checklist page. Wait for it: `bun own status` shows the step done. If the
   person already has a GitHub App or OAuth app, they put its values in a
   file (`GITHUB_CLIENT_ID=...` and `GITHUB_CLIENT_SECRET=...` lines) and
   tell you its path: `bun own signin github --from-file <path>`. Never
   print the file. The app's callback URL must be
   `https://<host>/auth/github/callback`: tell the person to check it.
6. Tell the person what you will make (the `NEXT` line names it), and wait
   for their yes. Then `bun own deploy production` (and
   `bun own deploy staging`). It builds this checkout, and makes the Worker,
   the D1 database, the R2 bucket, the address and the pages address. It
   takes 3 to 6 minutes. It waits until the server answers and its health
   check is ok. It is safe to run again after a failure.
7. Tell the person to sign in at `https://<host>/auth/sign-in`. Then
   `bun own status` until every step is done.
8. If the person wants it: `bun own token` gives you an admin token for
   their server (stored in `.erga/secrets.json`, never printed). With it,
   `bun own home <folder>` makes a folder the homepage, and `bun own preset`
   adds the company preset's access rule.
9. Tell the person: the address, that `.erga/secrets.json` holds the
   server's secrets (keep a copy in a password manager), and how to update.

Rules:

- Don't curl or open the new address yourself before `bun own deploy` says
  it answers: this machine would remember "no such host" for up to 30
  minutes. `bun own` asks Cloudflare's DNS directly.
- Bun installs into `~/.bun/bin`, which a new shell may not have on its
  PATH: look there before you install it again.

- Ask the person before you make, change or delete anything in their
  account. `bun own remove` deletes a server with all its documents: only
  when the person asks for it, in those words.
- A secret never goes into the chat, a commit or a command line. The
  person types it on the checklist page, or puts it in a file.
- `bun own` refuses a name or an address that something else uses. Tell the
  person what is there, and let them decide.

## What the CLI makes

For each server (the names come from its address: `erga.example.com` gives
`erga-example-com`):

- the Worker `erga-example-com`, on the custom domain `erga.example.com`;
- the D1 database `erga-example-com` and the R2 bucket `erga-example-com-files`;
- the Worker `erga-example-com-pages` on `erga-example-com-pages.<you>.workers.dev`
  (shared pages), or a wildcard route and DNS record on your pages domain.

On this machine, `.erga/` (git ignores it): `own.json` (your answers, no
secrets), `secrets.json` (mode 600), and the checklist page's messages.

## When it fails

| `FAIL` says | Do |
| --- | --- |
| Not logged in to Cloudflare | `bunx cf auth login` |
| isn't on a domain of this Cloudflare account | Add the domain to Cloudflare, or pick a name on one it has. |
| is taken / a Worker ... isn't Erga | The person decides: free it, or pick another address. |
| Tracked files have changes | Commit or stash them: a deploy builds a commit. |
| hasn't answered yet | A new address can take a few minutes. Run `bun own status` again; deploy again if it stays. |
| Sign-in: GitHub would come back to ... | The app's callback URL is wrong: fix it in the app's settings on GitHub. |

To roll back by hand: `bunx cf workers deployments list --worker <worker>`, then
create a deployment of the version before at 100%.

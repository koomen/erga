// `bun erga own skill`: the manual for a coding agent that deploys a person's own Erga. The person decides; the agent
// runs `bun erga own`; a checklist page on the person's machine shows each step (deploy/own/page.ts).

export const OWN_SKILL = `# Deploy a person's own Erga

The person's Erga runs on their own Cloudflare account, at an address on
their own domain. You drive \`bun erga own\`. Each command prints PASS or
FAIL and a NEXT line: who does the next step (you, or the person) and how.
Never guess past a FAIL. Run every command from the checkout's folder.

The person needs: a Cloudflare account on the Workers Paid plan, a domain
on it, a GitHub account with the GitHub CLI logged in (gh auth login), Bun
1.4 or newer, and git. It takes about 15 minutes.

## The steps

1. bun erga own fork: the person's fork of koomen/erga on GitHub becomes
   origin (koomen/erga becomes upstream).
2. bun erga own status: where the deploy is. Run it first, and after each
   step.
3. bun erga own start, in the background (it keeps running). Give the
   person the address it prints. The page shows the same steps, live.
   Read the person's messages from it with bun erga own inbox, and answer
   with bun erga own say "<text>", as well as in the chat.
4. Not logged in to Cloudflare: run bunx cf auth login, and tell the person
   to finish it in the browser. More than one account: ask which one, then
   bun erga own set account=<id>.
5. bun erga own ask, then ask the person every question in ONE message,
   with the defaults. Record the answers: bun erga own set host=...
   staging=no providers=github preset=website admin=<login> pages=shared
6. Sign-in: the person clicks "Create the GitHub App" on the checklist page.
   An app they have already: they put GITHUB_CLIENT_ID=... and
   GITHUB_CLIENT_SECRET=... lines in a file, and you run
   bun erga own signin github --from-file <path>. Never print the file. The
   app's callback URL is https://<host>/auth/github/callback.
7. Tell the person what you will make (the NEXT line names it), and wait
   for their yes. Then bun erga own deploy production (and staging). It
   builds this checkout and makes the Worker, the D1 database, the R2
   bucket, the address and the pages address, in 3 to 6 minutes. It is
   safe to run again after a failure.
8. The person signs in at https://<host>/auth/sign-in.
9. bun erga own actions: the fork's GitHub Actions variables, and Actions
   on. Then the person makes a Cloudflare API token with the link that
   bun erga own status gives, and pastes it on the checklist page (or runs
   bun erga own actions-token in a terminal). From then on, a push to the
   fork's main deploys production, and a push to staging deploys staging.
10. bun erga own update: syncs the fork's main with Erga's (as "Sync fork"
    on GitHub). GitHub then tests it and deploys it. bun erga own status
    shows the run.
11. If the person wants it: bun erga own token gives you an admin token for
    their server (in .erga/secrets.json, never printed). With it,
    bun erga own home <folder> makes a folder the homepage, and
    bun erga own preset adds the company preset's access rule.
12. Tell the person the address, that .erga/secrets.json holds the
    server's secrets (keep a copy in a password manager), and how to update.

## The rules

- Ask the person before you make, change or delete anything in their
  account. bun erga own remove deletes a server with all its documents:
  only when the person asks for it, in those words.
- A secret never goes into the chat, a commit or a command line. The person
  types it on the checklist page, in a hidden terminal prompt, or in a file.
- Don't curl or open a new address before bun erga own deploy says it
  answers: this machine would remember "no such host" for up to 30 minutes.
- bun erga own refuses a name or an address that something else uses. Tell
  the person what is there, and let them decide.
- Bun installs into ~/.bun/bin, which a new shell may not have on its PATH.

## When it fails

- Not logged in to Cloudflare: bunx cf auth login.
- "isn't on a domain of this Cloudflare account": add the domain to
  Cloudflare, or pick a name on a domain it has.
- "is taken", or "a Worker ... isn't Erga": the person decides.
- "Tracked files have changes": commit or stash them; a deploy builds a commit.
- "hasn't answered yet": a new address can take minutes. Run
  bun erga own status again.
- "GitHub would come back to ...": fix the app's callback URL on GitHub.
- A bad deploy: bun erga register <host> one time, then bun erga rollback <host> puts back the version before.
`;

// `bun erga setup skill`: the manual for a coding agent that sets up an Erga instance. The person decides; the agent
// runs `bun erga setup <host>`; the Setup tab of the ops page on the person's machine shows each step (deploy/own/page.ts).

export const SETUP_SKILL = `# Set up a new Erga instance

A new Erga runs on the person's own Cloudflare account, at an address on
their own domain. You drive \`bun erga setup <host>\`, where <host> is the
new server's address. Each command prints PASS or FAIL and a NEXT line:
who does the next step (you, or the person) and how. Never guess past a
FAIL. Run every command from the clone's folder: the clone is the source.

The person needs: a Cloudflare account on the Workers Paid plan, a domain
on it, a GitHub account, Bun 1.4 or newer, and git. It takes about 15
minutes.

## The steps

1. bun erga setup <host> status: where the setup is. Run it first, and
   after each step.
2. bun erga setup <host> start, in the background (it keeps running). Give
   the person the address it prints. The page shows the same steps, live.
   Read the person's messages from it with bun erga setup <host> inbox, and
   answer with bun erga setup <host> say "<text>", as well as in the chat.
3. Not logged in to Cloudflare: run bunx cf auth login, and tell the person
   to finish it in the browser. More than one account: ask which one, then
   bun erga setup <host> set account=<id>.
4. bun erga setup <host> ask, then ask the person every question in ONE
   message, with the defaults. Record the answers:
   bun erga setup <host> set staging=no providers=github preset=website
   admin=<login> pages=shared feedback=no
5. Sign-in: the person clicks "Create the GitHub App" on the Setup tab.
   An app they have already: they put GITHUB_CLIENT_ID=... and
   GITHUB_CLIENT_SECRET=... lines in a file, and you run
   bun erga setup <host> signin github --from-file <path>. Never print the
   file. The app's callback URL is https://<host>/auth/github/callback.
6. Tell the person what you will make (status names it), and wait for
   their yes. Then run bun erga setup <host>. It does the agent's steps,
   in order, and stops at a step of the person's:
   - It writes the entries into .erga/config.json (the staging
     instance's too), with no token yet. An instance that is registered
     already keeps its entry as it is: the steps run on it.
   - It deploys origin/main's commit (run git fetch first) with
     bun erga deploy's code: the Worker, the D1 database, the R2 bucket,
     the address and the pages address, in 3 to 6 minutes. It runs the commit's tests first (about
     a minute), unless they passed before (--no-tests skips them, and
     the job record says so).
   - It sends each secret one time: SESSION_SECRET, FACTORY_KEY, the
     sign-in apps' secrets, and SNAPSHOT_TOKEN with a staging instance. They
     are also in .erga/secrets.json. No later deploy sends a secret.
   - After the health check, it writes the first admin, and the feedback
     repository if the person gave one, into the new database.
   - It prints a link for the ops token. The person opens it, signs in with
     GitHub as the admin, and approves. The token goes into the entry: the
     instance is registered.
   It is safe to run again after a failure.
7. If the person wants it: bun erga setup <host> token gives you an admin
   token for their server (in .erga/secrets.json, never printed). With it,
   bun erga setup <host> home <folder> makes a folder the homepage, and
   bun erga setup <host> preset adds the company preset's access rule.
8. Tell the person the address, that .erga/secrets.json holds the
   server's secrets (keep a copy in a password manager), and how to
   deploy a new commit: bun erga deploy <commit> <host>.

## The rules

- Ask the person before you make, change or delete anything in their
  account. bun erga setup <host> remove deletes a server with all its
  documents: only when the person asks for it, in those words.
- A secret never goes into the chat, a commit or a command line. The person
  types it on the Setup tab, or puts it in a file.
- Don't curl or open a new address before bun erga setup says it answers:
  this machine would remember "no such host" for up to 30 minutes.
- Setup refuses a name or an address that something else uses. Tell the
  person what is there, and let them decide.
- A staging instance is any instance's choice (staging=<address>). It runs
  on a copy of its primary's data, for admins only. Its pages are shared,
  or on a domain of their own (stagingPages).
- Bun installs into ~/.bun/bin, which a new shell may not have on its PATH.

## When it fails

- Not logged in to Cloudflare: bunx cf auth login.
- "isn't on a domain of this Cloudflare account": add the domain to
  Cloudflare, or pick a name on a domain it has.
- "is taken", or "a Worker ... isn't Erga": the person decides.
- "Tracked files have changes": commit or stash them; a deploy builds a commit.
- "GitHub would come back to ...": fix the app's callback URL on GitHub.
- The ops token was not approved in time: run bun erga setup <host> again.
- A bad deploy: bun erga rollback <host> puts back the version before.
`;

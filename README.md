# Erga

**An AI document editor for people who care about words.**

Erga gives you the expressive power of a coding agent without forcing you to
give up control over your text.

Write it with your agents: ask an agent for a change in plain words, and
watch it land in the text, where you can still edit it by hand. A document
is a real web page, so it can be a design doc with a working prototype, a
slide deck or an interactive explainer. Everyone in it sees each edit as it
happens.

Try it at [erga.dev](https://erga.dev).

## Setup

Run your own Erga on your own domain, on Cloudflare (the Workers Paid plan)
or AWS (the domain in Route 53). You also need a GitHub account, Bun and
git. Give your coding agent this prompt:

> Set up my own Erga. Follow https://github.com/koomen/erga#setup.

### For the agent

Ask the user these questions, one at a time. Do not guess an answer, and
do not choose for the user.

1. **Which repository and branch does this Erga deploy from?** The default
   is `koomen/erga` (`main`); a fork of the user's own is the other answer.
   Then clone it, and run `bun install` (Bun is in `~/.bun/bin`).
2. **Where does Erga run: Cloudflare or AWS?** Sign in if the CLI is not
   signed in (`bunx cf auth login`, or `aws sso login`). With several
   Cloudflare accounts or AWS profiles, ask which one.
3. **At which domain or subdomain does Erga live?** For example
   `erga.example.com`.
   - The domain is not in Cloudflare or Route 53 yet: offer to add it with
     the CLI. If the user must buy a domain first, wait for them.
   - An Erga runs at the address already: setup takes it over as it is,
     with its database and its documents. Offer to deploy it again (`bun
     erga deploy <address>`, after setup), or to replace it with a new one
     (`bun erga setup <address> remove --yes` after setup, then setup
     again). Ask which one. Remove nothing without the user's yes in those
     words.
   - Another Worker has the address: offer to take the address off that
     Worker with the CLI, or ask for another address.
4. **Which domain holds the documents' pages?** A second domain, not the
   app's domain and not a subdomain of it: a document's scripts must not
   share the app's site or its cookies. Each document gets a subdomain of
   its own there (`--pages <domain>`). AWS needs it, and so does single
   sign-on on Cloudflare. On Cloudflare without single sign-on, a user who
   is the only author can leave it out: the pages then share one
   `workers.dev` address.
5. **Does Erga update by itself when a new release comes out?**
   - Yes (`--deploys cloud`): a small deployer in the user's own account
     deploys each new release. On AWS it is a Lambda function with a role of
     its own. On Cloudflare it is a Worker with a token for the one Worker,
     which the user makes and pastes on the setup page. An admin turns the
     updates off and on later, and gives the deployer another token, on the
     server's Deploy page.
   - No (`--deploys local`): no deploy credential stays in the cloud. The
     user runs `bun erga deploy <address>` for each update.
6. **Do people sign in with GitHub or Google, or with the organization's
   single sign-on?**
   - GitHub or Google: no option. The user sets it up on the setup page.
   - Single sign-on (`--sign-in sso`): only people who pass it reach Erga.
     - Cloudflare, with Cloudflare Access (`--team <name> --aud <tag>`):
       the Zero Trust team name, and the Application Audience (AUD) tag of
       a self-hosted Access application that the user adds for the
       address. The user adds a second Access application too, for the
       paths of the address that carry no Access sign-in, with one policy:
       Bypass, everyone. The dry run lists those paths.
     - Cloudflare with no Access, or AWS (`--issuer <URL> --client <ID>`):
       the OpenID Connect issuer URL, and Erga's client ID there (its
       callback: `https://<address>/_edge/callback`). The issuer must give
       the `email` claim, with `email_verified`. The user types the
       client's secret on a page that opens.

Then run the dry run. It makes nothing, and prints the plan:

    bun erga setup <address> --host cloudflare|aws [--repo <repo>] [--branch <branch>] \
      [--account <name>] [--profile <name>] [--pages <domain>] --deploys cloud|local \
      [--sign-in sso --team <name> --aud <tag> | --sign-in sso --issuer <URL> --client <ID>] --dry-run

Show the user the plan, and ask if you may go on. On their yes, run the
same command without `--dry-run`, in the background: the first build takes
10 to 20 minutes. The last line of each run (DRY RUN, DONE, WAIT or FAIL)
says what to do next. Do it. When it needs a choice, ask the user.

Rules:

- **Do for the user what you can do.** When you can solve a problem, offer
  to solve it. Ask the user only for a decision, a sign-in, or a secret
  that they type on a page.
- **The user finishes on one page.** When the server runs, the command
  opens its setup page (`https://<address>/setup`) in the user's browser,
  with a link that works one time. There the user sets up GitHub or Google
  sign-in, pastes the deployer's token if the page asks for it, and signs
  in: they become the admin. With single sign-on the page has no GitHub or
  Google step: the user signs in with it first. Tell the user to finish
  there.
- **No secret goes through you.** A secret goes only into the page, where
  the user types it: never into the chat, a command or a file. You make no
  token. Never open, read or repeat the setup page or its link.
- **A remote shell.** When the user is at another computer (SSH), or no
  browser can open on this machine, add `--remote`: no browser opens here.
  A run that ends in WAIT or FAIL then names a command for the user to run
  in their own terminal session, not through you: the link shows there.

A server tracks one branch of one repository (`bun erga track <address>`
changes them later). A server that tracks the user's own fork can name
Erga's `main` as its upstream: `bun erga track <address> --upstream main
--upstream-repo github.com/koomen/erga`. `bun erga status` then says how
many of Erga's commits the fork lacks. Take them with a merge commit or a
rebase, not as one squashed commit: git can then tell which ones you have.
Run setup again with the other `--deploys` answer to change who deploys.

## Develop

`bun erga skill` tells how to work in this repository: a feature branch for
each project, the tests, and how a change reaches staging and production.
`bun erga --help` lists the commands. The code is the source of truth.

## License

MIT (LICENSE). THIRD_PARTY_NOTICES.md lists the code of others that Erga
ships. SECURITY.md tells how to report a vulnerability.

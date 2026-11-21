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

1. `git clone https://github.com/koomen/erga && cd erga && bun install`
   (Bun is in `~/.bun/bin`).
2. Ask the user these questions, one at a time. Ask nothing else, and
   decide nothing for them.
   1. Are you at this computer, with a browser on its screen, or connected
      from another one (SSH, a remote shell)? If remote: `--remote`.
   2. Erga's address, for example erga.example.com: on a domain they own,
      and not in use.
   3. Cloudflare ($5 a month, recommended) or AWS (billed by use)? On AWS:
      which profile, if `aws configure list-profiles` shows several.
   4. Who may sign in? 1. Only users you invite (recommended) 2. Anyone in
      your organization: which GitHub organization or email domain?
      3. Your organization's single sign-on:
      - Cloudflare, with Cloudflare Access: the Zero Trust team name, and
        the Application Audience (AUD) tag of a self-hosted Access
        application that the user adds for the address. The user adds a
        second Access application too, for the paths of the address that
        carry no Access sign-in, with one policy: Bypass, everyone. The
        dry run lists those paths.
      - Cloudflare with no Access, or AWS: the OpenID Connect issuer URL,
        and Erga's client ID there (its callback:
        `https://<address>/_edge/callback`). The issuer must give the
        `email` claim, with `email_verified`.
   5. A second domain of the account, not the address's, for the
      documents' pages: on AWS without single sign-on, and on Cloudflare
      with it.
   6. Who deploys each new release of Erga? 1. A deployer in your own
      account, by itself (`--deploys cloud`). On Cloudflare you make one
      token for it, for the one Worker, and paste it on a page that opens.
      On AWS it has no token: it is a Lambda function with a role of its
      own. 2. You, from this clone, with `bun erga deploy`
      (`--deploys local`): no credential stays in the cloud.
3. Run this with the answers. It makes nothing and prints the plan:

       bun erga setup <address> --host cloudflare|aws --sign-in invite|organization|sso \
         [--profile <name>] [--organization <org or domain>] \
         [--team <name> --aud <tag>] [--issuer <URL> --client <ID>] [--pages <domain>] \
         --deploys cloud|local [--remote] --dry-run

   Show the user the plan. On their yes, run it again without `--dry-run`,
   in the background: the first build takes 10 to 20 minutes, a redeploy
   about 2.
4. The last line of each run (DRY RUN, DONE, WAIT or FAIL) says what to
   do next. Do it. When it needs a choice, ask the user. When it ends in
   WAIT, don't run it again yourself: give the user the exact command to
   run in their own terminal session, not through you, and ask them to
   tell you only the last line.

You make nothing yourself: no resource, file or token. A secret goes only
into the browser, where the user types it: never into the chat, a command
or a file. Never open, read or repeat a link that the command opens. Run
`bun erga setup <address> remove --yes` only when the user asks for it in
those words.

A server tracks one branch of one repository: Erga's `main`, unless
`--repo <repo>` and `--branch <branch>` say another (`bun erga track
<address>` changes them later). A server that tracks your own fork can
name Erga's `main` as its upstream: `bun erga track <address> --upstream
main --upstream-repo github.com/koomen/erga`. `bun erga status` then
says how many of Erga's commits your fork lacks. Take them with a merge
commit or a rebase, not as one squashed commit: git can then tell which
ones you have. With `--deploys local`, later deploys run from your clone:
`git pull`, then `bun erga deploy <address>`, which gives the server that
branch's newest commit. With `--deploys cloud`, the deployer in your
account deploys each new release of that branch by itself. Run setup
again with the other answer to change who deploys.

Setup in a new clone, for an address where an Erga of yours runs
already, takes that server over as it is: it adds the server to the
clone's `.erga/config.json`, and makes no second one. An address of a
Worker that isn't Erga stays refused.

## Develop

`bun erga skill` tells how to work in this repository: a feature branch for
each change, the tests, and how a change reaches staging and production.
`bun erga --help` lists the commands. The code is the source of truth.

## License

MIT (LICENSE). THIRD_PARTY_NOTICES.md lists the code of others that Erga
ships. SECURITY.md tells how to report a vulnerability.

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
   4. Cloudflare only: a second server too, to try updates on (a copy of
      the first one's data, for admins only)? No, or its address.
   5. Who may sign in? 1. Only users you invite (recommended) 2. Anyone in
      your organization: which GitHub organization or email domain?
      3. Your organization's single sign-on:
      - Cloudflare: the Zero Trust team name, and the Application Audience
        (AUD) tag of a self-hosted Access application that the user adds
        for the address (and one for the second server's), with a Bypass policy for the
        paths that need no sign-in.
      - AWS: the OpenID Connect issuer URL, and Erga's client ID there
        (its callback: `https://<address>/oauth2/idpresponse`). Which claim
        gives the email address, after what prefix? Not the `email` claim:
        `--email-claim <claim>:<prefix>` (`preferred_username:corp|`).
        If the user doesn't know, find it without a change: the user pool's
        identity provider attribute mapping, or how their other apps behind
        the same sign-in read `x-amzn-oidc-data`. Never guess.
   6. AWS without single sign-on: a second Route 53 domain, not the
      address's, for the documents' pages.
3. Run this with the answers. It makes nothing and prints the plan:

       bun erga setup <address> --host cloudflare|aws --sign-in invite|organization|sso \
         [--profile <name>] [--organization <org or domain>] \
         [--team <name> --aud <tag>] [--issuer <URL> --client <ID>] [--pages <domain>] [--remote] --dry-run

   Show the user the plan. On their yes, run it again without `--dry-run`,
   in the background: the first build takes 10 to 20 minutes, a redeploy
   about 2. For a second server (question 4), when the first one is
   done, run the same two steps with its address and
   `--copy-of <the first address>`.
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
<address>` changes them later). Later deploys run from your clone:
`git pull`, then `bun erga deploy <address>`, which gives the server that
branch's newest commit.

## Develop

`bun erga skill` tells how to work in this repository: a feature branch for
each change, the tests, and how a change reaches staging and production.
`bun erga --help` lists the commands. The code is the source of truth.

## License

MIT (LICENSE). THIRD_PARTY_NOTICES.md lists the code of others that Erga
ships. SECURITY.md tells how to report a vulnerability.

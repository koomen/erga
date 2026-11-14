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
   1. Erga's address, for example erga.example.com: on a domain they own,
      and not in use.
   2. Cloudflare ($5 a month, recommended) or AWS (billed by use)? On AWS:
      which profile, if `aws configure list-profiles` shows several.
   3. Cloudflare only: a staging server too (a copy for admins, to try
      updates)? No, or its address.
   4. Who may sign in? 1. Only users you invite (recommended) 2. Anyone in
      your organization: which GitHub organization or email domain?
      3. Your organization's single sign-on:
      - Cloudflare: the Zero Trust team name, and the Application Audience
        (AUD) tag of a self-hosted Access application that the user adds
        for the address (and staging's), with a Bypass policy for the
        paths that need no sign-in.
      - AWS: the OpenID Connect issuer URL, and Erga's client ID there
        (its callback: `https://<address>/oauth2/idpresponse`). Which claim
        gives the email address, after what prefix? Not the `email` claim:
        `--email-claim <claim>:<prefix>` (`preferred_username:corp|`).
   5. AWS without single sign-on: a second Route 53 domain, not the
      address's, for the documents' pages.
3. Run this with the answers, with a 10-minute timeout. It makes nothing
   and prints the plan:

       bun erga setup <address> --host cloudflare|aws --sign-in invite|company|sso \
         [--staging <address>] [--profile <name>] [--company <org or domain>] \
         [--team <name> --aud <tag>] [--issuer <URL> --client <ID>] [--pages <domain>] --dry-run

   Show the user the plan. On their yes, run it again without `--dry-run`.
4. The last line of each run (DRY RUN, DONE, WAIT or FAIL) says what to
   do next. Do it. When it needs a choice, ask the user.

You make nothing yourself: no resource, file or token. A secret goes only
into the browser, where the user types it: never into the chat, a command
or a file. Never open, read or repeat a link that the command opens. Run
`bun erga setup <address> remove --yes` only when the user asks for it in
those words.

Later deploys run from your clone: `git pull`, then
`bun erga deploy <commit> <address>`.

## Develop

`bun erga skill` tells how to work in this repository: a feature branch for
each change, the tests, and how a change reaches staging and production.
`bun erga --help` lists the commands. The code is the source of truth.

## License

MIT (LICENSE). THIRD_PARTY_NOTICES.md lists the code of others that Erga
ships. SECURITY.md tells how to report a vulnerability.

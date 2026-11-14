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

![erga.dev: an AI document editor for people who care about words](docs/home.png)

![The editor: the agent's panel on the left, a document on the right](docs/screenshot.png)

## Setup

Run your own Erga on your own domain, in your Cloudflare account (the
Workers Paid plan) or your AWS account (the domain in Route 53). You also
need a GitHub account, Bun and git. Give your coding agent this prompt, in
any folder:

> Set up my own Erga at erga.example.com. Follow https://github.com/koomen/erga#setup.

The agent runs three commands:

    git clone https://github.com/koomen/erga && cd erga
    bun install
    bun erga setup erga.example.com

The last command does all the work. It opens a setup page in your browser,
and tells the agent what to ask you: where Erga runs, who may sign in, and
your yes to the plan. Your sign-ins, clicks and secrets go on the setup
page, never to the agent. The agent runs the command again after each
answer, as it says (`bun erga setup skill` is the agent's manual).

Later deploys run on your machine, from your clone: `git pull`, then
`bun erga deploy <commit> <host>`.

## Develop

`bun erga skill` tells how to work in this repository: a feature branch for
each change, the tests, and how a change reaches staging and production.
`bun erga --help` lists the commands. The code is the source of truth.

## License

MIT (LICENSE). THIRD_PARTY_NOTICES.md lists the code of others that Erga
ships. SECURITY.md tells how to report a vulnerability.

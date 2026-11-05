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

## Run your own Erga

Erga runs on your own Cloudflare account and domain. You need Bun, git, a
GitHub account and a Cloudflare account on the Workers Paid plan.

    git clone https://github.com/koomen/erga.git && cd erga && bun install
    bun erga setup erga.example.com start   # the ops page's Setup tab shows each step, live

Or give your coding agent this prompt in an empty folder: "Set up my own Erga
from https://github.com/koomen/erga at <your address>. Clone it, run
`bun install`, then follow `bun erga setup skill`." Every deploy runs on your
machine, from your clone: `git pull`, then `bun erga deploy <commit> <host>`.

## Develop

`bun erga skill` tells how to work in this repository: a feature branch for
each change, the tests, and how a change reaches staging and production.
`bun erga --help` lists the commands. The code is the source of truth.

## License

MIT (LICENSE). THIRD_PARTY_NOTICES.md lists the code of others that Erga
ships. SECURITY.md tells how to report a vulnerability.

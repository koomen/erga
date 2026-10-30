# Contributing to Erga

Thank you for your help. This page tells how to set up Erga and send a
change. AGENTS.md has the rules of the code, for people and for agents.

## Set up

You need [Bun](https://bun.sh) 1.4 or newer, and Git.

    git clone <this repository> erga
    cd erga
    bun install
    bun run test:browsers   # once: the browser that the end-to-end tests use
    bun start               # the app, on http://localhost:4400 in the main checkout

`bun start` makes `.dev.vars` the first time (`.dev.vars.example` lists
its settings). To turn on the embedded agent, put an Anthropic API key in
`.dev.vars`, or export `ANTHROPIC_API_KEY` in your shell. `bun start --help`
tells the rest.

## Send a change

1. Run `bun run test`. It must say "all passing". GitHub runs the same
   tests on each pull request.
2. A bug fix comes with a test that fails before the fix.
3. Make one change in each commit. The title is short, and often names the
   area first: `Access: shares only to people who may sign in`.
4. A pull request says what changes for the user, how you tested it, and
   the limits of the change. A long message is in ASD-STE100 (AGENTS.md,
   "Summaries").

## Report a problem

- A bug or an idea: open an issue.
- A vulnerability: do not open an issue. SECURITY.md tells how to report it.

By contributing, you agree that your work is under the MIT license
(LICENSE), and that you follow the code of conduct (CODE_OF_CONDUCT.md).

# Contributing to Erga

Thank you for your help. This page tells how to set up Erga, test a
change and send it. AGENTS.md has the same rules for coding agents.

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

## Test

    bun run test        # the format check, lint, typecheck, unit tests and smoke run: under a minute
    bun run format      # formats the lines your change touches, and no others
    bun run test:e2e e2e/full/page/html-typing.e2e.ts   # one end-to-end file or folder
    bun run test:full   # every end-to-end test: before a large change

- Run `bun run test` before every pull request. It must say "all passing".
  GitHub runs the same tests on each pull request
  (`.github/workflows/test.yml`).
- If the format check fails, run `bun run format`. It formats only the
  lines that your change touches. Do not format whole files.
- When you change a part of the app, run the end-to-end tests for that
  part too (`e2e/full/<part>/`).
- The smoke run (`e2e/smoke/`) has a time limit of 90 s. A new test there
  replaces one. Put other end-to-end tests in `e2e/full/`.
- A bug fix comes with a test that fails before the fix.

## The rules of the code

AGENTS.md has the full rules. The most important:

1. **Migrations only add.** Change the database with a new file in
   `server/migrations/`. Never edit a migration that is there. A migration
   never drops or renames a column; `tests/migrations.test.ts` checks it.
2. **The embedded agents can do what their person can.** A new button or
   HTTP route needs a tool for the agent, and a line in `agents/actions.ts`.
   `tests/agent-actions.test.ts` checks it.
3. **Keep the module boundaries.** Import each area of `server/` through
   its `index.ts`. Only `cloudflare/` and `control/` read the Worker's
   bindings. The browser's code imports only `shared/` and a few files of
   `document/`; `tests/browser-imports.test.ts` checks it.
4. **New routes on staging stay behind the admins-only guard**
   (`server/identity/admins-only.ts`).
5. **Write code like the code around it**: the same names, the same
   amount of comment, the same idiom. A comment tells why, not the
   history of the change.

## Commits and pull requests

- Make one change in each commit.
- The title is short, and often names the area first:
  `Access: shares only to people who may sign in`.
- A long message is in ASD-STE100, Simplified Technical English. AGENTS.md
  (Summaries) gives the rules and an example.
- A pull request says what changes for the user, how you tested it, and
  the limits of the change.

## Report a problem

- A bug or an idea: open an issue.
- A vulnerability: do not open an issue. SECURITY.md tells how to report it.

By contributing, you agree that your work is under the MIT license
(LICENSE), and that you follow the code of conduct (CODE_OF_CONDUCT.md).

# Erga

Erga is a multiplayer page editor: people and their agents edit an HTML or
Markdown page together, in place, on the rendered page. It runs on
Cloudflare at erga.dev.

    bun install
    bun start          # the app, locally (bun start --help for the rest)
    bun run test       # the typecheck, the unit tests and the smoke run: under a minute
    bun run test:full  # and every end-to-end test (e2e/full): only when you want the whole suite

`ANTHROPIC_API_KEY` (in the environment or `.dev.vars`) turns the agent on.
AGENTS.md has the rules for working on it.

# Erga

Erga is a multiplayer page editor. It opens any HTML or Markdown page and
lets people and their agents edit its text together, in place, on the
rendered page, with the page's own styles and scripts running around it.
It runs on Cloudflare (a Worker, Durable Objects, D1) at erga.dev, with an
admin area, a deploy pipeline (staging.erga.dev, then erga.dev) and a
factory: a task queue whose tasks Claude Code does in VMs.

The code and its comments are the source of truth. Start at the file named
in the map below.

## Run it

With [Bun](https://bun.sh) 1.4 or later, and Node (it runs Vite):

    bun install
    bun start                  # erga.dev's app, locally, signed in as DEV_LOGIN
    bun start ./some/folder    # and a folder (index.html or index.md) or file, edited in place on disk
    bun start --help           # the rest: --reload, --port, --print-url, ...

`ANTHROPIC_API_KEY` (in the environment or `.dev.vars`) turns the agent on.

## Test it

    bun run test               # the unit tests and the end-to-end tests your change affects (fail-fast)
    bun run test --all         # everything
    bun run test:e2e e2e/x/y.e2e.ts    # the files you name
    bun run typecheck

## Two ways to work

- **Locally, as a local task**: `bun task new "Title" "The ask"` registers
  the work on the board at erga.dev/admin/factory and makes its branch;
  `bun task log`, `bun task done "summary"` report on it (`bun task --help`).
  It needs an admin token, in `ERGA_TOKEN` or Git's credential store
  ("Share with agent" on any admin page, or `/tokens`).
- **In the hosted factory**: add a task on erga.dev/admin/factory (or ask
  the admin agent beside the board). Claude Code does it in a VM, on its own
  branch, and an admin merges it from the board.

AGENTS.md has the rules for both.

## Where things live

| Path | What |
| --- | --- |
| `worker/` | erga.dev's Worker: the front door (`index.ts`), sign-in, Durable Objects, the API |
| `front.ts`, `admin.ts`, `admin-layout.ts` | the site's own pages: the front page, `/docs`, `/new`, `/admin` |
| `room.ts`, `host.ts`, `tree.ts`, `versions.ts` | a document: its shared Yjs room, its host and API, its pages, its versions |
| `agent.ts`, `workspace.ts`, `server-tools.ts`, `DOCUMENT_PROMPT.md` | the document agent and its tools |
| `directory.ts`, `users.ts`, `config.ts`, `tokens.ts`, `migrations/` | the server's database (D1): documents, users, settings, tokens |
| `server-api.ts`, `api.ts` | the API for agents (`/llms.txt`, `/mcp`) and the host's HTTP API |
| `src/page/`, `page.html`, `style.css`, `fonts/` | the editor in the browser (CodeMirror 6), bundled by `build.sh` into `.site/` |
| `templates/`, `templates.ts`, `landing/` | what new documents start from, and the default front page |
| `factory/` | the factory: the board, the admin agent, the worker's prompt, `bun task`, the VM (`factory/vm/`) |
| `deploy/` | the deploy pipeline, the builder, the test gate, staging and production (`targets.json`) |
| `source/` | Erga's own source on erga.dev (Git endpoint, mirror) |
| `dev.ts`, `dev/`, `vite.config.ts` | local development (`bun start`) |
| `e2e/`, `tests/` | the end-to-end tests (`e2e/run.ts`) and the unit tests |

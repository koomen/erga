# Erga

Erga is a multiplayer page editor. It opens any HTML or Markdown page and
lets people and their agents edit its text together, in place, on the
rendered page, with the page's own styles and scripts running around it.
It runs on Cloudflare (a Worker, Durable Objects, D1) at erga.dev, with an
admin area and a deploy pipeline (staging.erga.dev, then erga.dev).

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

    bun run typecheck          # seconds
    bun test tests/            # the unit tests, seconds
    bun run test:e2e e2e/x/y.e2e.ts    # one end-to-end file (slow: only when you need it)

## How to work

Push to `staging` (`git push origin HEAD:staging`): staging.erga.dev deploys
it. Merge on erga.dev/admin/source (or push to `main`) to deploy erga.dev.
AGENTS.md has the rules.

## Where things live

| Path | What |
| --- | --- |
| `worker/` | erga.dev's Worker: the front door (`index.ts`), sign-in, Durable Objects, the API |
| `front.ts`, `admin.ts`, `admin-layout.ts` | the site's own pages: the front page, `/docs`, `/new`, `/admin` |
| `room.ts`, `host.ts`, `tree.ts`, `versions.ts` | a document: its shared Yjs room, its host and API, its pages, its versions |
| `agent.ts`, `workspace.ts`, `server-tools.ts`, `DOCUMENT_PROMPT.md` | the document agent and its tools |
| `admin-agent/`, `worker/admin-agent.ts` | the admin's agent, on every admin page, and the guide for outside agents (`/api/admin/guide`) |
| `directory.ts`, `users.ts`, `config.ts`, `tokens.ts`, `migrations/` | the server's database (D1): documents, users, settings, tokens |
| `server-api.ts`, `api.ts` | the API for agents (`/llms.txt`, `/mcp`) and the host's HTTP API |
| `src/page/`, `page.html`, `style.css`, `fonts/` | the editor in the browser (CodeMirror 6), bundled by `build.sh` into `.site/` |
| `templates/`, `templates.ts`, `landing/` | what new documents start from, and the default front page |
| `deploy/` | the deploy pipeline, the builder, staging and production (`targets.json`) |
| `source/` | Erga's own source on erga.dev (Git endpoint, mirror) |
| `dev.ts`, `dev/`, `vite.config.ts` | local development (`bun start`) |
| `e2e/`, `tests/` | the end-to-end tests (`e2e/run.ts`) and the unit tests |

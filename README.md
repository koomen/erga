# Erga

Erga is a multiplayer editor for web pages. People and their AI agents
edit an HTML page together, in place, on the rendered page. A document is a
folder of files (HTML, CSS, scripts, images) that shows as one page. You
type into the page as you would into a word processor, and the agent
changes any file when you ask it to. Everyone sees each edit as it happens.

Erga is for people who want more than a text document can show, such as a
design doc with a working prototype, a slide deck or an interactive
explainer, but who want to keep control of their own words.

It runs on Cloudflare. The hosted version is at https://erga.dev.

![The editor: the agent's panel on the left, a document on the right](docs/screenshot.png)

## Quick start

You need [Bun](https://bun.sh) 1.4 or newer, and Git.

    bun install
    bun start          # the app, locally, in your browser (bun start --help for the rest)
    bun run test       # the format check, lint, typecheck, unit tests and smoke run: under a minute
    bun run format     # formats the lines your change touches (Biome, biome.json), and no others
    bun run test:full  # and every end-to-end test (e2e/full): only when you want the whole suite
    bun run look Enter # presses keys in the editor, headless: prints the page as text, saves a screenshot

`bun start` runs the same Worker that Cloudflare runs, under Vite and
Miniflare, and signs you in without GitHub. To turn on the agent, put an
Anthropic API key in `.dev.vars` (`ANTHROPIC_API_KEY`), or export it in the
shell. `bun start path/to/folder` opens a folder on disk as a document:
edits in the browser go to the files, and edits to the files show in the
browser.

`ERGA_DEV_LATENCY_MS=120 bun start` (or a range, `60-180`) delays each message
between a tab and the room by that much, each way, as a deployed Worker's
network does. `bun run look --latency 120` and the e2e helper
`startServer({ latency })` set it too. It is for the dev server only.

CONTRIBUTING.md tells how to send a change. AGENTS.md has the rules for
coding agents.

## How it works

```mermaid
flowchart LR
  subgraph Browser
    shell["Viewer and editor shell<br/>(app origin: erga.dev)"]
    page["The document's page,<br/>with the page editor<br/>(pages origin: &lt;id&gt;-&lt;owner&gt;.erga-pages.dev)"]
    shell -- "one frame, postMessage" --> page
  end
  subgraph Worker["App Worker (cloudflare/, server/)"]
    app["Routes: sign-in, documents list,<br/>API, MCP, admin pages"]
  end
  subgraph DO["Durable Objects"]
    doc["Document object (one per document):<br/>the room (Yjs), files, versions,<br/>agent sessions"]
    agents["Each person's agent conversations;<br/>the admin agent"]
  end
  D1[("D1: users, settings,<br/>documents and permissions")]
  R2[("R2: files that are not text")]
  actions["GitHub Actions (deploy/):<br/>tests, build, deploy"]
  shell -- "HTTP" --> app
  shell -- "WebSocket (Yjs)" --> doc
  page -- "files, by a signed token" --> app
  app --> D1
  app --> doc
  doc --> R2
  doc --> agents
  agents -- "model API" --> model["Anthropic"]
  actions -- "deploys" --> Worker
```

- **The shell** is the page at `/<owner>/<slug>` on the app's origin. It
  shows the band above the document, the agent's panel and the people who
  are in the document. It holds the document's page in one frame.
- **The page** runs on a separate origin for each document (the pages
  origin). A page is not trusted: it can run any script, so its origin
  holds nothing but its own document. The server gives each page the source
  marks that the editor needs. When you start to edit, the shell loads the
  page editor into the page, and the page editor edits the page in place.
- **The document** is a Durable Object (`cloudflare/objects/document.ts`)
  around a `Document` (`document/`) that has no Cloudflare code in it. The
  document keeps its files and versions in the object's storage, and large
  files in R2. Its room is a shared Yjs document: each editor tab joins it
  over a WebSocket, and each agent session joins it in the same process.
- **The agents.** Each person has one agent (`agents/person/`), on every
  page: it does what they can, and edits a document's files in its room as
  they would (`agents/document/`: one session per person per document, where
  every agent's document tools run). An outside agent uses the same tools with
  a person's agent token, over the HTTP API or MCP (`server/api.ts`).
- **The database** is D1: the users, the server's settings, and each
  document's address, owner and permissions (`server/directory/`).
- **The deploys.** GitHub holds Erga's repository (`koomen/erga`). GitHub
  Actions runs the tests on each push, builds the commit, deploys it through
  the Cloudflare API (`deploy/pipeline/`), checks the app's health and rolls
  back a bad deploy. A broken app cannot stop the way to fix it.

## Self-host on Cloudflare

The quick way: give your coding agent the prompt at the top of DEPLOY.md. It
deploys your own Erga with `bun own`, and a checklist page on your machine
shows each step.

### Fork on GitHub, deploy with GitHub Actions

After the first deploy, GitHub can deploy your Erga for you. A push to `main`
deploys production. A push to `staging` deploys staging, if you have one.
The workflow is `.github/workflows/test.yml`: the deploy runs only after the
tests pass.

1. Fork `koomen/erga` on GitHub, and clone your fork.
2. Deploy one time from your machine: `bun own` (DEPLOY.md). This makes
   the Worker and puts its secrets on it: `SESSION_SECRET`, `FACTORY_KEY`
   and the sign-in app's secret. The Actions deploy keeps the secrets that
   the Worker has, and never sets them.
3. In your fork, open Settings > Secrets and variables > Actions.
4. Add the secret `CLOUDFLARE_API_TOKEN`. docs/operations.md lists the
   permissions that it needs.
5. Add these variables, with the same answers that `.erga/own.json` has:
   - `CLOUDFLARE_ACCOUNT_ID`: the account's id.
   - `ERGA_HOST`: the production address, for example `erga.example.com`.
   - `ERGA_ADMIN`: the first admin's GitHub login.
   - `ERGA_GITHUB_CLIENT_ID`: the client id of your GitHub sign-in app.
   - If you need them: `ERGA_STAGING`, `ERGA_PROVIDERS`, `ERGA_PRESET`,
     `ERGA_COMPANY`, `ERGA_PAGES`, `ERGA_GOOGLE_CLIENT_ID`.
6. To get Erga's updates, click "Sync fork" on GitHub. The push to `main`
   deploys them.

`deploy/actions-plan.ts` reads the variables. A repository without the
secret deploys nothing.

### Erga's own deployment

Erga's own servers are in `deploy/targets.json`. The repository
`koomen/erga` has no `ERGA_HOST` variable, so its workflow deploys those
targets. The rest of this part tells how they were set up.

Erga needs a Cloudflare account on the Workers Paid plan: Workers, Durable
Objects, D1, R2 and Browser Rendering. You need a zone for the app, and a
separate zone for the pages origins, so that a page can never run on the
app's origin.

1. `deploy/targets.json` has the values: the account, the admins, the hosts
   and zones, and the ids of the GitHub OAuth apps.
2. The first deploy of a target ran from a machine
   (`bun deploy/run.ts production`), and its secrets were set by hand.
3. After that, a push to `staging` on GitHub deploys staging, and a push to
   `main` deploys production.

docs/self-host.md gives each step. docs/operations.md tells how deploys,
health checks and rollbacks work.

## The layout

    document/     one document, with no Cloudflare, server or agent code in it (it gets them through DocumentDeps)
      document.ts     class Document: one running document over a Storage (files, room, versions, expiry)
      access.ts       who may do what: the document's copy of its permissions, and the requests it decides with them
      view.ts         what viewers see: the files as they are now, under a version that is their digest
      names.ts        a document's name: its title and address (/<owner>/<slug>), and renames
      agent.ts        what the document needs of its agents (agents/document/ fulfils it)
      storage.ts      the Storage a document needs; MemoryStorage for the tests
      host.ts         the document's HTTP API: its routes, each person's agent session, the tabs
      snapshot.ts     a document's storage as one value: the export, the import and their endpoints
      tabs.ts         the document's tabs, over WebSockets that outlive the open document
      content.ts      what a document room holds: files, assets, authors, folders (the shared Yjs doc)
      pages.ts        a document's files as pages, and their addresses
      room.ts         the document room: the shared doc and who is in it
      versions.ts     a document's versions: snapshots to look back at and restore
      history.ts      a document's versions as it is edited: when one is cut, its description, reads and restores
      uploads.ts      files that arrive whole (a publish, a PUT, an agent's bytes): text into the room, the rest as blobs
      open.ts         opening the room: the room and the host on the document's storage, and Opened, the open document
      blobs.ts        the files that are not text, by their sha-256
      merge.ts        an outside edit, as a small change to the open document
      pdf.ts          PDFs for the agents: their pages and their text
      page-api.ts     a page's own API: its module, run in a sandbox for the agents (shared/page-ops.ts checks its answer)
      disk.ts         local development: a document's files in a folder on disk, through the dev server
      api.ts          the document API's contract (document/host.ts has its routes)
    server/       the app: web Requests in, Responses out (the unit tests run it under bun)
      app.ts          the one route table, and what every page of the site's own gets
      platform.ts     Platform, what the app needs from where it runs, and Session, who is asking
      http.ts         the routes' HTTP in Effect (effect/http): a route is an Effect, the Platform a service, the answers they share
      api.ts          the HTTP API: /api/tools (the operations, for the pages and every agent), tokens, /mcp, and /llms.txt (a pointer to /mcp)
                      (the tools: agents/tools.ts)
      health.ts       the health check, GET /api/health
      security.ts     the security headers on every answer of the app
      live.ts         open pages follow a redeploy
      news/           live pages: which rows changed, for the open pages that show them (hub.ts, its Durable Object
                      cloudflare/objects/news.ts), and the rows a page asks for then (routes.ts)
      directory/      the database: documents, owners and permissions (directory.ts), users, sign-in identities,
                      access rules, settings and their change log, the API keys admins store
      identity/       who is asking: sessions (session.ts), agent tokens (tokens.ts) and their page (tokens-page.ts:
                      /tokens, /settings), MCP's sign-in for agents' apps (oauth.ts), sign-in with GitHub or Google (sign-in.ts, accounts.ts) and its settings
                      (settings.ts, apps.ts), cookies, the staging guard (admins-only.ts)
      documents/      the app for documents: a document's address and access (routes.ts), the pages origin
                      and its tokens (pages-origin.ts), the viewer (view.ts), new documents and the list (make.ts),
                      the homepage's document (landing.ts)
      pages/          the HTML the server renders, no routing: the viewer's scripts and styles (viewer.ts), the page's
                      own script (reader.ts), the documents list (docs.ts), the start page,
                      the account menu, the templates, and what every page shares (chrome.ts)
      home/           the homepage: its deploys (deploys.ts), serving / from the snapshot (serve.ts), the page (render.ts), the API
      repo-api.ts     /api/repo: Erga's repository on GitHub, read-only (repo-github.ts)
      admin/          the admin pages, one file for each (settings.ts, api-keys.ts, auth.ts, access.ts, changes.ts,
                      users.ts), their routes (routes.ts) and the layout they share
      operations/     each thing a person does on the server, defined once (operation.ts): documents, sharing and
                      tokens (documents.ts), the admin pages' settings, keys, sign-in, users and rules (admin.ts).
                      The pages call them over POST /api/tools/<name>; every agent has them as tools
      migrations/     the database's schema, one file for each change (AGENTS.md, rule 3)
    agents/       each person's agent and the tools
      run.ts          the agent loop, on Effect AI: the model, the transcript, the checkpoints
      tools.ts        the one tool set: the server's operations and the document tools for any document, for every
                      agent as its person (a document token never with admin power); actions.ts, the audit of
                      every action and its tool
      models.ts       the models (Effect AI's Anthropic provider), the agent's configuration and the scripted test model
      checkpoint.ts   an agent's conversation, kept step by step (chat-store.ts, in a Durable Object's SQLite)
      document/       every agent's hands in a document: session.ts (one session per person per document, where the
                      document tools run), workspace.ts, tools.ts, prompt.ts and PROMPT.md (what a prompt says of documents)
      person/         each person's agent: agent.ts (its session), prompt.ts, sessions.ts (one session per person, in
                      their object, and its routes), panel.ts (the panel's preferences)
    shared/       code the server and the browser bundles both use: the agent's transcript (agent-log.ts), attached
                  files (attach.ts), who did something (attribution.ts), a page's text and its source (manuscript.ts,
                  page-html.ts), the room's socket (room-socket.ts), ... The browser's bundles may have shared/, and of
                  document/ only content.ts, pages.ts, merge.ts and api.ts's types: tests/browser-imports.test.ts keeps it so
    libs/         Erga's editing libraries, apart from Erga's code: each has an api/ (named edits on the page's HTML, with
                  no browser: the layer of shared/) and a ui/ (keys, carets, the drawing: the browser's layer). The API never
                  imports the UI
      text/           erga/text, the page editor in the page (frame.js: ui/frame.ts, with its own socket and replica of the
                      room, ui/collab.ts, opened with the edit key the shell gives it; its own controls, ui/controls.ts,
                      and uploads, ui/uploads.ts): api/ has the editing rules (rules.ts,
                      blocks.ts, lists.ts), styles and links (format.ts), the source's helpers (source.ts), the clipboard's
                      blocks, and erga/text's API (edits.ts: the named edits agents run with call_edit)
      steps/          erga/steps, Erga's one presentation library, in the page: a page with its own window.ergaSteps
                      imports it (steps.js: ui/library.ts), and it works outside Erga too. ui/steps.ts draws the bar
                      (back, forward, the step) and the list of steps with their pictures, takes the arrow keys, and
                      answers the agent's view_page step (window.ergaStepTo). api/steps.ts has the contract (Steps) and
                      the steps as the agent names them ("3.2"). A deck or a canvas holds its own code, from its
                      template (assets/templates/slides, assets/templates/canvas)
    client/       the browser side: editor.html, style.css, fonts/, and the scripts build.ts bundles into .build/
      shell/          the editor's shell (page.js): main.ts, its one word to the page's editor (page-frame.ts: edit, with the
                      edit key, or view), its replica of the room (libs/text/ui/collab.ts), the source view, the shell's parts
      page-tools/     Erga's page tools in the document's page: the live page's tools (tools.js: tools.ts,
                      live-page-tab.ts), apart from the editing libraries, which the page's first script loads when the
                      viewer first asks; and view_page's and eval_in_page's part in the server's browser (capture.ts,
                      which client/inline/page-render.ts puts in the page)
      agent/          the agent panel both the editor and the admin pages use (agent-chat.ts, layout.ts, ...)
      admin/          the admin pages' scripts (admin-agent.ts, admin-nav.ts, admin-share.ts)
      pages/          the other pages' scripts: the settings, the pages tree
      live/           open pages across a redeploy (live.ts, client.ts, restore.ts)
      inline/         the scripts and styles a page carries inline, typed (build.ts --inline writes
                      server/pages/inline-code.ts): the documents list, the admin pages, ...
      common/         what the inline scripts and the bundles share: fast-click.ts, new-doc.ts, bars.ts, quick.ts, ...
      styles/         admin.css, which the build writes as the admin pages' one stylesheet
    cloudflare/   only what runs on Cloudflare: the Worker's entry (index.ts), the Platform from its bindings
                  (platform.ts; env.ts types them), D1 (d1.ts), R2 (blobs.ts), the sandbox for pages' own APIs (sandbox.ts),
                  view_page's render in Browser Rendering (render.ts, browser.ts), the app's Durable Objects (objects/:
                  each gives its logic in server/, agents/ or document/ storage, alarms and sockets, and decides
                  nothing), what the deploy pipeline asks of the app (deploy-routes.ts), the dev server's routes
                  (dev.ts)
    deploy/       the deploys, which run on a machine or on GitHub Actions: Erga's own targets from a machine (run.ts),
                  the GitHub Actions deploy (actions.ts, and actions-plan.ts, which decides what a push deploys), your
                  own Erga (own/: `bun own`), the release build (release.ts), the targets (targets.json, targets.ts),
                  the settings a deploy locks (locked-settings.ts)
      pipeline/       the deploy pipeline through the Cloudflare API (pipeline.ts, and account.ts: the Worker's upload,
                      D1, the health check, a rollback), the build of a checkout (build.ts, bundle.ts), the release's
                      format and bindings (release-format.ts, bindings.ts), staging's copy of production's documents
                      (copy-documents.ts)
    dev/          local development: start.ts (`bun start`), the Vite plugin, live reload, the server's own headless
                  Chrome for view_page (browser.ts), the formatter on changed
                  lines (format.ts, `bun run format`), a mock GitHub, Google and Cloudflare
                  (mock-cloudflare.ts) for tests, and the folders on disk that documents link to (the plugin)
    assets/       files the server ships: logo/, landing/ (the first homepage) and templates/ (new documents)
    docs/         self-host.md (deploy your own Erga), operations.md (how a deployment deploys), the screenshot above
    tests/        the unit tests (bun test, no browser), their helpers in tests/helpers/; e2e/ the browser tests
                  (e2e/smoke, e2e/full), benchmarks (e2e/bench) and their helpers (e2e/helpers/)
    .github/      the tests on each pull request and push (workflows/test.yml)

The folders are layers. A file imports only its own layer and the layers
below it, lowest first: `shared/` (and each library's `api/`), `document/`, the areas of `server/`,
`agents/`, `server/app.ts` and `server/api.ts`, `cloudflare/`.
`client/` and each library's `ui/` import `shared/`, `libs/` and a few files of `document/`; `deploy/`,
`dev/`, `tests/` and `e2e/` import anything. Each area of `server/`
(directory, identity, documents, pages, home, admin, operations) is imported through
its `index.ts`, its interface. Only `cloudflare/` reads the Worker's bindings. `tests/imports.test.ts` has the
whole rules and checks them.

The configs at the root are the ones their tools look for there:
`cloudflare.config.ts` (the Worker and its bindings), `vite.config.ts`,
`e2e.config.ts`, `biome.json`, and the typecheck's three projects:
`tsconfig.json` (what runs under Bun: deploy/, dev/, tests/, e2e/),
`tsconfig.workers.json` (the Worker) and `tsconfig.browser.json` (the
browser).

Building: `bun run build` (client/build.ts) writes the client's files to
`.build/`; `bun run release` (deploy/release.ts) adds the Worker's release to
`.build/release/`. A deploy runs both in the commit it deploys (deploy/pipeline/build.ts).

## License

MIT (LICENSE). The fonts and packages that Erga ships have their own
licenses: THIRD_PARTY_NOTICES.md lists them.

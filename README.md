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

## The layout

    document/     one document, with no Cloudflare in it
      document.ts     class Document: one running document over a Storage (files, room, versions, publishing, expiry)
      storage.ts      the Storage a document needs; MemoryStorage for the tests
      host.ts         the document's HTTP API: its routes, the agent sessions, the tabs
      content.ts      what a document room holds: files, assets, authors, folders (the shared Yjs doc)
      pages.ts        a document's files as pages, and their addresses
      room.ts         the document room: the shared doc and who is in it
      versions.ts     a document's versions and what is published
      merge.ts        an outside edit, as a small change to the open document
      api.ts          the document API's contract (its routes are in document/host.ts for now)
    server/       the app: web Requests in, Responses out (the unit tests run it under bun)
      routes.ts       the front door: every route around the documents
      api.ts          the server's HTTP API for outside agents: tokens, /api, /mcp, the guide, /tokens, /settings
      directory.ts    documents, owners and permissions, in SQL; users.ts, settings.ts, api-keys.ts, tokens.ts, auth.ts beside it
      sites.ts, site-publish.ts   a document on its own domain
      home.ts         the homepage; account-menu.ts, who you are on every page; templates.ts, what a new document starts from
      admin/          the admin pages (pages.ts), the layout they share (layout.ts)
      source/         Erga's own Git repository: the Git endpoint, the mirror, and the Source admin page
      migrations/     the database's schema, one file for each change (AGENTS.md, rule 3)
    editor-agent/ the document agent: session.ts (one session per person per document), workspace.ts, PROMPT.md
    agents/       what the agents share, and the admin agent
      tools.ts        the tools both agents and the outside API share; actions.ts, the audit of every action and its tool
      models.ts       the models, their prices, the agent's configuration and the scripted test model
      admin.ts        the admin agent, with admin-chats.ts
    shared/       code the server and the browser bundles both use: agent-log.ts (the transcript), attach.ts (attached
                  files), attribution.ts (who did something, and how). The browser's bundles may have shared/, and of
                  document/ only content.ts, pages.ts, merge.ts and api.ts's types: tests/browser-imports.test.ts keeps it so
    client/       the browser side: editor.html, style.css, fonts/, and the scripts build.sh bundles into .build/
                  (main.ts the editor's shell, frame.ts the editor, settings.ts, pages-tree.ts, admin-agent.ts, live.ts, ...)
    cloudflare/   the Cloudflare adapter: the Worker's entry (index.ts), the Durable Objects (document-object.ts, home.ts,
                  site-host.ts, source-host.ts, pipeline.ts, deploy-session.ts, admin-agent-host.ts), D1 (d1.ts) and sign-in
    deploy/       the deploy pipeline (pipeline.ts), branch deploys (branches.ts), the builder container (builder/), the
                  release build (release.ts), the targets (targets.json), the setup runbook (setup.ts), the settings a
                  deploy locks (locked-settings.ts), and the mock Cloudflare the tests use
    dev/          local development: start.ts (`bun start`), the Vite plugin, live reload, a Git server for tests, and a
                  document's files on disk as its Storage (disk-storage.ts, over the mirror the plugin serves)
    assets/       files the server ships: logo/, landing/ (the first homepage) and templates/ (new documents)
    tests/        the unit tests (bun test); e2e/ the end-to-end tests (e2e/smoke, e2e/full)

A file in `cloudflare/` with the same name as one in `server/` is its
Cloudflare side: `cloudflare/document-object.ts` runs `document/host.ts` in a
Durable Object. The configs at the root are the ones their tools look for
there: `cloudflare.config.ts` (the Worker and its bindings),
`vite.config.ts`, `e2e.config.ts`, `tsconfig.json`.

Building: `bun run build` (client/build.sh) writes the client's files to
`.build/`; `bun run release` (deploy/release.ts) adds the Worker's release to
`.build/release/`. The builder container runs both in each commit it deploys.

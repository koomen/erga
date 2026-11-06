// Erga on Cloudflare: the app Worker, also
// serving documents' pages on their own origins, one Durable Object per
// document, the directory of documents in D1
// (server/directory/, its tables in server/migrations/), and the editor's own files as
// static assets (built into .build/ by client/build.ts). In local development (`bun
// start`, dev/start.ts) the same Worker runs under Vite.
import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./cloudflare/index.ts" with { type: "cf-worker" };
// The server settings the deploy fixes (locks): deploy/locked-settings.ts, with ERGA_SERVER_CONFIG
// (JSON, from the environment) over them. client/build.ts and dev/start.ts check them first (`bun deploy/locked-settings.ts`).
import { deployed } from "./deploy/locked-settings.ts";
import { hasDevSecret, localAgentKey } from "./dev/agent-key.ts";

// Neutral names only: no instance's domain, route or settings. The deploy pipeline gives each instance its own Worker,
// database, bucket, domain, pages route and plain settings, from its entry in .erga/config.json (`bun erga deploy`).
const WORKER = "erga";

/** The local database's id (the dev server's D1): any UUID. Production's is found by name (the deploy pipeline). */
const LOCAL_DB = "00000000-0000-4000-8000-00000000e29a";

/** Where the dev server's .dev.vars is (tests give each server its own). */
const ENV_DIR = process.env.ERGA_ENV_DIR || process.cwd();
/** A secret local development does without: declared there only when set, so Vite doesn't warn that it's missing. */
const optionalSecret = (mode: string | undefined, name: string) => (mode != "development" || hasDevSecret(ENV_DIR, name) ? { [name]: bindings.secret() } : {});

export default defineConfig(({ mode }) => ({
  worker: {
    name: WORKER,
    compatibilityDate: "2026-09-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    // No domain and no route: the pipeline gives each instance its domain, and the wildcard route of its documents'
    // pages (<id>-<owner>.<pages domain>, with a proxied wildcard DNS record and the zone's Universal SSL certificate).
    // Logs and exceptions, queryable afterwards (cf observability telemetry query).
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    // The Worker runs first for every path, and decides everything (view mode at /, documents under /<owner>/<id>),
    // the editor's hashed files (/_erga/..., client/build.ts) too: it serves them from the static assets with a year in
    // the browser's cache, to any origin, and a missing one with no-store (server/pages/assets.ts, serveAsset). They are
    // public code, which staging's admins-only guard lets anyone have (server/identity/admins-only.ts). Not the static
    // assets alone for /_erga/*: their 404 carried the year-long header (the build's _headers), and the homepage's own
    // domain answers its /_erga/ routes in the Worker (server/app.ts).
    assets: { htmlHandling: "none", notFoundHandling: "none", runWorkerFirst: true },
    exports: {
      // Each document (cloudflare/objects/document.ts), named by its id.
      DocumentObject: exports.durableObject({ storage: "sqlite" }),
      // The deploy page's sessions (/deploy, which installed Erga in other accounts): gone, with what they held (2026-11-04).
      Deployer: exports.durableObject({ state: "deleted" }),
      // Erga's repository and the deploys, which the control Worker held before: gone, with what they held (the old
      // history and index, until 2026-10-13).
      SourceHost: exports.durableObject({ state: "deleted" }),
      Pipeline: exports.durableObject({ state: "deleted" }),
      // The homepage's deploys and the snapshot / serves: one object, "home".
      Home: exports.durableObject({ storage: "sqlite" }),
      // The server's own small storage (the sign-in values set on /admin/auth): one object, "own", which no copy of another server's data replaces.
      OwnStorage: exports.durableObject({ storage: "sqlite" }),
      // Live pages' hub (server/news/): the open pages' sockets and which rows changed. One object, "news".
      NewsHub: exports.durableObject({ storage: "sqlite" }),
      // Each document's site on its person's own Cloudflare account (a document at a domain of its own): gone, with what it held.
      SiteHost: exports.durableObject({ state: "deleted" }),
      // The admins' agents before each person had one (PersonAgent): gone, with their conversations (2026-11-01).
      AdminAgentHost: exports.durableObject({ state: "deleted" }),
      // Each person's agent (agents/person/): one object per person, named by their login.
      PersonAgent: exports.durableObject({ storage: "sqlite" }),
      // The factory (its task queue) and its VMs: gone, with what they held.
      Factory: exports.durableObject({ state: "deleted" }),
      FactoryVm: exports.durableObject({ state: "deleted" }),
      // Each person's list of documents before the directory: gone, with what it held.
      DocList: exports.durableObject({ state: "deleted" }),
      // The documents' namespace from before the storage cutover of 2026-10-11: gone, with what it held.
      DocHost: exports.durableObject({ state: "deleted" }),
    },
    env: {
      DOCUMENTS: bindings.durableObject({ worker: WORKER, exportName: "DocumentObject" }),
      HOME: bindings.durableObject({ worker: WORKER, exportName: "Home" }),
      OWN: bindings.durableObject({ worker: WORKER, exportName: "OwnStorage" }),
      NEWS: bindings.durableObject({ worker: WORKER, exportName: "NewsHub" }),
      AGENTS: bindings.durableObject({ worker: WORKER, exportName: "PersonAgent" }),
      // The server's database: users, settings and the directory. The deploy pipeline finds it by name, or
      // makes it, and applies server/migrations/ before each deploy. Locally (vite dev) it's a database of its own, at a fixed made-up id that
      // `bun run db:local` applies the migrations to.
      DB: bindings.d1({ name: WORKER, ...(mode == "development" ? { id: LOCAL_DB } : {}) }),
      ASSETS: bindings.assets(),
      // Cloudflare Browser Rendering (Workers Paid): the browser view_page and eval_in_page render pages in
      // (cloudflare/render.ts). Local development has none: the dev server's own headless Chrome stands in (dev/browser.ts).
      ...(mode == "development" ? {} : { BROWSER: bindings.browser() }),
      // Starts the sandbox Workers a page's own API runs in, one for each module's code (cloudflare/sandbox.ts).
      LOADER: bindings.workerLoader(),
      // Documents' blobs: their files that aren't text, by sha-256 (cloudflare/blobs.ts). Each target has a bucket of its
      // own, named after its Worker (the pipeline binds <worker>-files); locally, Miniflare's R2.
      FILES: bindings.r2({ name: `${WORKER}-files` }),
      // The settings the deploy fixes, as JSON. Admins set the rest.
      SERVER_CONFIG: bindings.text(JSON.stringify(deployed())),
      // The GitHub OAuth app's client ID: each instance's own, from its entry's vars. Locally, ERGA_GITHUB_CLIENT_ID only.
      GITHUB_CLIENT_ID: bindings.text(mode == "development" ? (process.env.ERGA_GITHUB_CLIENT_ID ?? "") : ""),

      // "staging" on a staging instance (admins only): `bun erga deploy` sets it. Locally: ERGA_DEPLOY_TARGET.
      DEPLOY_TARGET: bindings.text(mode == "development" ? (process.env.ERGA_DEPLOY_TARGET ?? "") : ""),
      ...optionalSecret(mode, "GITHUB_CLIENT_SECRET"),
      // Opens an issue in Erga's repository for each feedback (server/feedback.ts). Locally the pretend GitHub takes its own.
      ...optionalSecret(mode, "GITHUB_ISSUES_TOKEN"),
      SESSION_SECRET: bindings.secret(),
      ANTHROPIC_API_KEY: bindings.secret(),
      // Local development only (vite dev reads them from .dev.vars); a deployed instance never has them.
      ...(mode == "development" ? {
        // Sign in without GitHub, on localhost.
        DEV_LOGIN: bindings.secret(),
        // "script" swaps the agent's model for the free scripted one, for the test suite.
        ...optionalSecret(mode, "ERGA_AGENT_MODEL"),
        // From the process that runs the dev server, not .dev.vars: the
        // secret that lets it link files on disk to documents, and a shorter write delay for tests.
        ERGA_LINK_SECRET: bindings.text(process.env.ERGA_LINK_SECRET ?? ""),
        ERGA_WRITE_DELAY_MS: bindings.text(process.env.ERGA_WRITE_DELAY_MS ?? ""),
        // How often / checks for a newer homepage deploy (tests shorten it).
        ERGA_HOME_RECHECK_MS: bindings.text(process.env.ERGA_HOME_RECHECK_MS ?? ""),
        // When versions are cut: how long edits pause first, and the longest burst one version holds.
        ERGA_VERSION_IDLE_MS: bindings.text(process.env.ERGA_VERSION_IDLE_MS ?? ""),
        ERGA_VERSION_MAX_MS: bindings.text(process.env.ERGA_VERSION_MAX_MS ?? ""),
        // How long a document stays open with nothing done before it closes and its object may sleep (tests shorten it).
        ERGA_ROOM_IDLE_MS: bindings.text(process.env.ERGA_ROOM_IDLE_MS ?? ""),
        // The deploy facts a deploy would set (deploy/pipeline/account.ts, deployFacts): tests of `bun erga register`.
        ERGA_DEPLOY: bindings.text(process.env.ERGA_DEPLOY ?? ""),
        // e2e/bench/run.ts --latency: each call to the database or a document waits this long first.
        ERGA_REMOTE_LATENCY_MS: bindings.text(process.env.ERGA_REMOTE_LATENCY_MS ?? ""),

        // Sign-in's settings, for the tests: a stand-in for github.com (the dev server's pretend GitHub unless given), and the other target's server.
        ERGA_GITHUB_ORIGIN: bindings.text(process.env.ERGA_GITHUB_ORIGIN ?? (process.env.ERGA_DEV_ORIGIN ? `${process.env.ERGA_DEV_ORIGIN}/__github` : "")),
        // The dev server's address, where its stand-in for GitHub and its own headless Chrome answer.
        ERGA_DEV_ORIGIN: bindings.text(process.env.ERGA_DEV_ORIGIN ?? ""),
        // The agent's key: a real one in .dev.vars, else the environment's, so a
        // placeholder in .dev.vars doesn't hide the key you exported. Never written to .dev.vars.
        ANTHROPIC_API_KEY: bindings.text(localAgentKey(ENV_DIR)),
      } : {}),
    },
  },
}));

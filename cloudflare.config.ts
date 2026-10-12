// erga.dev on Cloudflare: the front door Worker, also
// serving documents' pages on erga-pages.dev, one Durable Object per
// document, the directory of documents in D1
// (server/directory/, its tables in server/migrations/), and the editor's own files as
// static assets (built into .build/ by client/build.sh). In local development (`bun
// start`, dev/start.ts) the same Worker runs under Vite.
import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./cloudflare/index.ts" with { type: "cf-worker" };
// The server settings the deploy fixes (locks): deploy/locked-settings.ts, with ERGA_SERVER_CONFIG
// (JSON, from the environment) over them. client/build.sh and dev/start.ts check them first (`bun deploy/locked-settings.ts`).
import { deployed } from "./deploy/locked-settings.ts";
import { localAgentKey } from "./dev/agent-key.ts";
import { readFileSync } from "node:fs";

// Production's names (its Worker, database, domain, pages route, public settings): the same list the deploy
// pipeline deploys from (deploy/targets.json, typed by deploy/targets.ts), so there's one source of truth for both.
// Read as a file, not imported: the dev server can't load a module the config imports into the Worker too.
const TARGETS = JSON.parse(readFileSync(decodeURIComponent(new URL("./deploy/targets.json", import.meta.url).pathname), "utf8"));
const PROD = { ...TARGETS.targets.production, vars: { ADMINS: TARGETS.admins, ...TARGETS.targets.production.vars } };

/** The local database's id (the dev server's D1): any UUID. Production's is found by name (the deploy pipeline). */
const LOCAL_DB = "00000000-0000-4000-8000-00000000e29a";

export default defineConfig(({ mode }) => ({
  worker: {
    name: PROD.worker,
    compatibilityDate: "2026-09-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    domains: [PROD.host],
    // Each document's page runs on an origin of its own, <id>-<owner>.erga-pages.dev:
    // a wildcard route, with a proxied wildcard DNS record
    // (* AAAA 100::) in the erga-pages.dev zone and its Universal SSL certificate.
    triggers: [triggers.fetch({ pattern: `*.${PROD.pages.domain}/*`, zone: PROD.pages.zone })],
    // Logs and exceptions, queryable afterwards (cf observability telemetry query).
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    // The Worker decides everything (view mode at /, documents under
    // /<owner>/<id>) and asks for the editor's files when it needs them.
    assets: { htmlHandling: "none", notFoundHandling: "none", runWorkerFirst: true },
    exports: {
      // Each document (cloudflare/document-object.ts), named by its id.
      DocumentObject: exports.durableObject({ storage: "sqlite" }),
      // The deploy page's sessions (/deploy, cloudflare/deploy-session.ts): each holds one person's Cloudflare token, only while they deploy.
      Deployer: exports.durableObject({ storage: "sqlite" }),
      // Erga's own repository: one object, "erga", where pushes and merges happen one at a time.
      SourceHost: exports.durableObject({ storage: "sqlite" }),
      // Branch deploys: one object, named "deploys", that builds and deploys
      // this server's own branch when it moves, keeps each target's status and log, and serves /api/events.
      Pipeline: exports.durableObject({ storage: "sqlite" }),
      // The homepage's deploys and the snapshot / serves: one object, "home".
      Home: exports.durableObject({ storage: "sqlite" }),
      // The server's own small storage (the sign-in values set on /admin/auth): one object, "own", which no copy of another server's data replaces.
      OwnStorage: exports.durableObject({ storage: "sqlite" }),
      // Each document's site on its person's own Cloudflare account: one object per document that has one.
      SiteHost: exports.durableObject({ storage: "sqlite" }),
      // Each admin's agent, its conversation and panel: one object, "admin".
      AdminAgentHost: exports.durableObject({ storage: "sqlite" }),
      // The factory (its task queue) and its VMs: gone, with what they held.
      Factory: exports.durableObject({ state: "deleted" }),
      FactoryVm: exports.durableObject({ state: "deleted" }),
      // Each person's list of documents before the directory: gone, with what it held.
      DocList: exports.durableObject({ state: "deleted" }),
      // The documents' namespace from before the storage cutover of 2026-10-11: gone, with what it held.
      DocHost: exports.durableObject({ state: "deleted" }),
    },
    env: {
      DOCUMENTS: bindings.durableObject({ worker: PROD.worker, exportName: "DocumentObject" }),
      DEPLOYS: bindings.durableObject({ worker: PROD.worker, exportName: "Deployer" }),
      PIPELINE: bindings.durableObject({ worker: PROD.worker, exportName: "Pipeline" }),
      SOURCE: bindings.durableObject({ worker: PROD.worker, exportName: "SourceHost" }),
      // Erga's own repository is in Cloudflare Artifacts, bound only when the deploy names the
      // namespace (ERGA_ARTIFACTS_NAMESPACE=erga), with the GitHub mirror's token (a secret, GITHUB_MIRROR_TOKEN) then too.
      // Locally there's no binding: the dev server stands in for Artifacts and GitHub.
      ...(mode != "development" && process.env.ERGA_ARTIFACTS_NAMESPACE ? {
        ARTIFACTS: bindings.artifacts({ namespace: process.env.ERGA_ARTIFACTS_NAMESPACE }),
        GITHUB_MIRROR_URL: bindings.text(process.env.GITHUB_MIRROR_URL ?? "https://github.com/koomen/erga.git"),
        GITHUB_MIRROR_TOKEN: bindings.secret(),
      } : {}),
      HOME: bindings.durableObject({ worker: PROD.worker, exportName: "Home" }),
      OWN: bindings.durableObject({ worker: PROD.worker, exportName: "OwnStorage" }),
      SITES: bindings.durableObject({ worker: PROD.worker, exportName: "SiteHost" }),
      ADMIN_AGENT: bindings.durableObject({ worker: PROD.worker, exportName: "AdminAgentHost" }),
      // The server's database: users, settings and the directory. The deploy pipeline finds it by name, or
      // makes it, and applies server/migrations/ before each deploy. Locally (vite dev) it's a database of its own, at a fixed made-up id that
      // `bun run db:local` applies the migrations to.
      DB: bindings.d1({ name: PROD.database, ...(mode == "development" ? { id: LOCAL_DB } : {}) }),
      ASSETS: bindings.assets(),
      // The bootstrap admins: always admins, always allowed to sign in. Admins let
      // everyone else in (the users table). Locally DEV_LOGIN is one too.
      ADMINS: bindings.text(PROD.vars.ADMINS),
      // The settings the deploy fixes, as JSON. Admins set the rest.
      SERVER_CONFIG: bindings.text(JSON.stringify(deployed())),
      // Locally, the client ID of the target the dev server plays (ERGA_DEPLOY_TARGET), else production's.
      // ERGA_GITHUB_CLIENT_ID (development only) overrides the target's, "" for none: tests simulate a target with no app.
      GITHUB_CLIENT_ID: bindings.text(mode == "development" && process.env.ERGA_GITHUB_CLIENT_ID !== undefined ? process.env.ERGA_GITHUB_CLIENT_ID : mode == "development" && TARGETS.targets[process.env.ERGA_DEPLOY_TARGET ?? ""] ? TARGETS.targets[process.env.ERGA_DEPLOY_TARGET!].vars.GITHUB_CLIENT_ID ?? "" : PROD.vars.GITHUB_CLIENT_ID),

      // Which branch-deploy target this server is: the pipeline sets it on each target it deploys
      // ("staging" on erga-staging; empty on a server /deploy made). Branch deploys run only with CLOUDFLARE_DEPLOY_TOKEN
      // set too (a secret, deploy/setup.ts), so this alone deploys nothing. Locally: ERGA_DEPLOY_TARGET.
      DEPLOY_TARGET: bindings.text(mode == "development" ? (process.env.ERGA_DEPLOY_TARGET ?? "") : PROD.name),
      // The deploy page's Cloudflare OAuth client (public, PKCE: no secret), made under Manage Account > OAuth clients
      // with the callback https://erga.dev/deploy/auth/cloudflare/callback. Empty: /deploy offers the API token link only.
      CLOUDFLARE_OAUTH_CLIENT_ID: bindings.text(process.env.CLOUDFLARE_OAUTH_CLIENT_ID ?? ""),
      GITHUB_CLIENT_SECRET: bindings.secret(),
      SESSION_SECRET: bindings.secret(),
      ANTHROPIC_API_KEY: bindings.secret(),
      // Local development only (vite dev reads them from .dev.vars); erga.dev never has them.
      ...(mode == "development" ? {
        // Sign in without GitHub, on localhost.
        DEV_LOGIN: bindings.secret(),
        // "script" swaps the agent's model for the free scripted one, for the test suite.
        ERGA_AGENT_MODEL: bindings.secret(),
        // From the process that runs the dev server, not .dev.vars: the
        // secret that lets it link files on disk to documents, and a shorter write delay for tests.
        ERGA_LINK_SECRET: bindings.text(process.env.ERGA_LINK_SECRET ?? ""),
        ERGA_WRITE_DELAY_MS: bindings.text(process.env.ERGA_WRITE_DELAY_MS ?? ""),
        // The homepage's deploys: how long after a change the next runs, and how often / checks for one (tests shorten both).
        ERGA_HOME_DELAY_MS: bindings.text(process.env.ERGA_HOME_DELAY_MS ?? ""),
        ERGA_HOME_RECHECK_MS: bindings.text(process.env.ERGA_HOME_RECHECK_MS ?? ""),
        // Documents' sites on Cloudflare: how long after a publish the next deploy runs.
        ERGA_SITE_DELAY_MS: bindings.text(process.env.ERGA_SITE_DELAY_MS ?? ""),
        // When versions are cut: how long edits pause first, and the longest burst one version holds.
        ERGA_VERSION_IDLE_MS: bindings.text(process.env.ERGA_VERSION_IDLE_MS ?? ""),
        ERGA_VERSION_MAX_MS: bindings.text(process.env.ERGA_VERSION_MAX_MS ?? ""),
        // e2e/load-bench.ts --latency: each call to the database or a document waits this long first.
        ERGA_REMOTE_LATENCY_MS: bindings.text(process.env.ERGA_REMOTE_LATENCY_MS ?? ""),

        // Sign-in's settings, for the tests: a stand-in for github.com, and the other target's server.
        ERGA_GITHUB_ORIGIN: bindings.text(process.env.ERGA_GITHUB_ORIGIN ?? ""),
        ERGA_PEER_ORIGIN: bindings.text(process.env.ERGA_PEER_ORIGIN ?? ""),
        // "1": /deploy and the branch deploys talk to a pretend Cloudflare, for their tests and for trying them safely.
        ERGA_DEPLOY_MOCK: bindings.text(process.env.ERGA_DEPLOY_MOCK ?? ""),
        // The dev server's address, where its stand-ins for Artifacts and GitHub answer.
        ERGA_DEV_ORIGIN: bindings.text(process.env.ERGA_DEV_ORIGIN ?? ""),
        // The agent's key: a real one in .dev.vars, else the environment's, so a
        // placeholder in .dev.vars doesn't hide the key you exported. Never written to .dev.vars.
        ANTHROPIC_API_KEY: bindings.text(localAgentKey(process.env.ERGA_ENV_DIR || process.cwd())),
      } : {}),
    },
  },
}));

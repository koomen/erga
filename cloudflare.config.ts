// erga.dev on Cloudflare: the front door Worker (worker/index.ts), also
// serving documents' pages on erga-pages.dev, one Durable Object per
// document (worker/doc-host.ts), the directory of documents in D1
// (directory.ts, its tables in migrations/), and the editor's own files as
// static assets (built into .site/ by site.sh). In local development (`bun
// start`, dev.ts) the same Worker runs under Vite.
import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };
// The server settings the deploy fixes (locks): server.config.ts, with ERGA_SERVER_CONFIG
// (JSON, from the environment) over them. site.sh and dev.ts check them first (`bun server.config.ts`).
import { deployed } from "./server.config.ts";
import { localAgentKey } from "./dev/agent-key.ts";
// Production's names (its Worker, database, domain, pages route, public settings): the same list the deploy
// pipeline deploys from (deploy/targets.ts), so there's one source of truth for both.
import { TARGETS } from "./deploy/targets.ts";

const PROD = TARGETS.production;

/** The local database's id (the dev server's D1): any UUID. Production's is found by name (migrate.ts). */
const LOCAL_DB = "00000000-0000-4000-8000-00000000e29a";

export default defineConfig(({ mode }) => ({
  worker: {
    name: PROD.worker,
    compatibilityDate: "2026-09-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    domains: [PROD.host],
    // Each document's page runs on an origin of its own, <id>-<owner>.erga-pages.dev
    // (front.ts, pagesDoor): a wildcard route, with a proxied wildcard DNS record
    // (* AAAA 100::) in the erga-pages.dev zone and its Universal SSL certificate.
    triggers: [triggers.fetch({ pattern: `*.${PROD.pages.domain}/*`, zone: PROD.pages.zone })],
    // Logs and exceptions, queryable afterwards (cf observability telemetry query).
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    // The Worker decides everything (view mode at /, documents under
    // /<owner>/<id>) and asks for the editor's files when it needs them.
    assets: { htmlHandling: "none", notFoundHandling: "none", runWorkerFirst: true },
    exports: {
      DocHost: exports.durableObject({ storage: "sqlite" }),
      // The deploy page's sessions (/deploy, worker/deployer.ts): each holds one person's Cloudflare token, only while they deploy.
      Deployer: exports.durableObject({ storage: "sqlite" }),
      // Branch deploys (deploy/branches.ts, worker/pipeline.ts): one object, named "deploys", that builds and deploys
      // this server's own branch when it moves, keeps each target's status and log, and serves /api/events.
      Pipeline: exports.durableObject({ storage: "sqlite" }),
      // Each person's list of documents before the directory: gone, with what it held.
      DocList: exports.durableObject({ state: "deleted" }),
    },
    env: {
      DOCS: bindings.durableObject({ worker: PROD.worker, exportName: "DocHost" }),
      DEPLOYS: bindings.durableObject({ worker: PROD.worker, exportName: "Deployer" }),
      PIPELINE: bindings.durableObject({ worker: PROD.worker, exportName: "Pipeline" }),
      // The server's database: users, settings and the directory. `cf deploy` makes the database by name if there's none; its tables come
      // from migrations/, applied by migrate.ts (site.sh runs it on Workers Builds, before
      // the deploy). Locally (vite dev) it's a database of its own, at a fixed made-up id that
      // `bun run db:local` applies the migrations to.
      DB: bindings.d1({ name: PROD.database, ...(mode == "development" ? { id: LOCAL_DB } : {}) }),
      ASSETS: bindings.assets(),
      // The bootstrap admins: always admins, always allowed to sign in (users.ts). Admins let
      // everyone else in (the users table). Locally DEV_LOGIN is one too (worker/d1.ts).
      ADMINS: bindings.text(PROD.vars.ADMINS),
      // The settings the deploy fixes, as JSON (server.config.ts; config.ts). Admins set the rest.
      SERVER_CONFIG: bindings.text(JSON.stringify(deployed())),
      GITHUB_CLIENT_ID: bindings.text(PROD.vars.GITHUB_CLIENT_ID),
      // Which branch-deploy target this server is (deploy/targets.ts): the pipeline sets it on each target it deploys
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
        // "script" swaps the agent's model for the free scripted one (agent.ts), for the test suite.
        ERGA_AGENT_MODEL: bindings.secret(),
        // From the process that runs the dev server (dev.ts, dev/plugin.ts), not .dev.vars: the
        // secret that lets it link files on disk to documents, and a shorter write delay for tests.
        ERGA_LINK_SECRET: bindings.text(process.env.ERGA_LINK_SECRET ?? ""),
        ERGA_WRITE_DELAY_MS: bindings.text(process.env.ERGA_WRITE_DELAY_MS ?? ""),
        // tests/bench.ts --latency: each call to the database or a document waits this long first (worker/timing.ts).
        ERGA_REMOTE_LATENCY_MS: bindings.text(process.env.ERGA_REMOTE_LATENCY_MS ?? ""),
        // "1": /deploy talks to a pretend Cloudflare (deploy/mock.ts), for its tests and for trying it safely.
        ERGA_DEPLOY_MOCK: bindings.text(process.env.ERGA_DEPLOY_MOCK ?? ""),
        // The agent's key: a real one in .dev.vars, else the environment's (dev/agent-key.ts), so a
        // placeholder in .dev.vars doesn't hide the key you exported. Never written to .dev.vars.
        ANTHROPIC_API_KEY: bindings.text(localAgentKey(process.env.ERGA_ENV_DIR || process.cwd())),
      } : {}),
    },
  },
}));

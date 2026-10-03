// erga.dev on Cloudflare: the front door Worker (worker/index.ts), also
// serving documents' pages on erga-pages.dev, one Durable Object per
// document (worker/doc-host.ts), the directory of documents in D1
// (directory.ts, its tables in migrations/), and the editor's own files as
// static assets (built into .site/ by site.sh). In local development (`bun
// start`, dev.ts) the same Worker runs under Vite.
import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

/** The local database's id (the dev server's D1): any UUID. Production's is found by name (migrate.ts). */
const LOCAL_DB = "00000000-0000-4000-8000-00000000e29a";

export default defineConfig(({ mode }) => ({
  worker: {
    name: "erga",
    compatibilityDate: "2026-09-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    domains: ["erga.dev"],
    // Each document's page runs on an origin of its own, <id>-<owner>.erga-pages.dev
    // (front.ts, pagesDoor): a wildcard route, with a proxied wildcard DNS record
    // (* AAAA 100::) in the erga-pages.dev zone and its Universal SSL certificate.
    triggers: [triggers.fetch({ pattern: "*.erga-pages.dev/*", zone: "erga-pages.dev" })],
    // Logs and exceptions, queryable afterwards (cf observability telemetry query).
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    // The Worker decides everything (view mode at /, documents under
    // /<owner>/<id>) and asks for the editor's files when it needs them.
    assets: { htmlHandling: "none", notFoundHandling: "none", runWorkerFirst: true },
    exports: {
      DocHost: exports.durableObject({ storage: "sqlite" }),
      // Each person's list of documents before the directory: gone, with what it held.
      DocList: exports.durableObject({ state: "deleted" }),
    },
    env: {
      DOCS: bindings.durableObject({ worker: "erga", exportName: "DocHost" }),
      // The server's database: users, settings and the directory. `cf deploy` makes the database by name if there's none; its tables come
      // from migrations/, applied by migrate.ts (site.sh runs it on Workers Builds, before
      // the deploy). Locally (vite dev) it's a database of its own, at a fixed made-up id that
      // `bun run db:local` applies the migrations to.
      DB: bindings.d1({ name: "erga", ...(mode == "development" ? { id: LOCAL_DB } : {}) }),
      ASSETS: bindings.assets(),
      // The bootstrap admins: always admins, always allowed to sign in (users.ts). Admins let
      // everyone else in (the users table). Locally DEV_LOGIN is one too (worker/d1.ts).
      ADMINS: bindings.text("koomen,dsiroker"),
      GITHUB_CLIENT_ID: bindings.text("Ov23ctkY7oLarHcPA97b"),
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
      } : {}),
    },
  },
}));

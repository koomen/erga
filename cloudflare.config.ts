// erga.dev on Cloudflare: the front door Worker (worker/index.ts), also
// serving documents' pages on erga-pages.dev, one
// Durable Object per document (worker/doc-host.ts) and one per person
// listing their documents (worker/doc-list.ts), and the editor's own
// files as static assets (built into .site/ by `bun run site`).
import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

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
      DocList: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      DOCS: bindings.durableObject({ worker: "erga", exportName: "DocHost" }),
      LISTS: bindings.durableObject({ worker: "erga", exportName: "DocList" }),
      ASSETS: bindings.assets(),
      ALLOWED_USERS: bindings.text("koomen,dsiroker"),
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
      } : {}),
    },
  },
}));

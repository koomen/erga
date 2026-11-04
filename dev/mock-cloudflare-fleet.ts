// The pretend Cloudflare's fleet (dev/mock-cloudflare.ts, the `fleet` option): Erga's own account as its deploys see it.

import { memoryStore } from "../document/snapshot";
import { ACCOUNT_ID, deployVersion, MOCK_SNAPSHOT_TOKEN, PROD_DB, PROD_DOCS, type MockState } from "./mock-cloudflare";

/** Erga's own account: production as cf deploy left it (the fleet option). */
export function seedFleet(state: MockState) {
  state.account = { id: ACCOUNT_ID, name: "Erga" };
  state.subdomain = "erga";
  state.zones = [
    { id: "zone00000000000000000000000e7ga1", name: "erga.dev", status: "active" },
    { id: "zone00000000000000000000000e7ga2", name: "erga-pages.dev", status: "active" },
    { id: "zone00000000000000000000000e7ga3", name: "erga-pages-staging.dev", status: "active" },
  ];
  const tables = [
    "d1_migrations",
    "users",
    "server_config",
    "documents",
    "permissions",
    "slug_history",
    "agent_tokens",
    "token_requests",
    "admin_keys",
    "admin_challenges",
    "admin_log",
  ];
  state.databases.push({
    uuid: PROD_DB,
    name: "erga",
    statements: [],
    tables,
    migrations: ["0001_erga.sql", "0002_delete_docs_after_hours.sql", "0100_tokens.sql", "0110_admin_keys.sql"],
    rows: [
      "INSERT INTO users (login, name) VALUES ('ada', 'Ada');",
      ...PROD_DOCS.map(
        (id, i) => `INSERT INTO documents (id, owner, slug, title) VALUES ('${id}', 'ada', 'doc-${i + 1}', 'Document ${i + 1}');`
      ),
    ],
  });
  const prodBindings = [
    { type: "durable_object_namespace", name: "DOCUMENTS", class_name: "DocumentObject" },
    { type: "d1", name: "DB", database_id: PROD_DB, id: PROD_DB },
    { type: "plain_text", name: "DEPLOY_TARGET", text: "production" },
    { type: "plain_text", name: "ERGA_VERSION", text: "prod00000000" },
  ];
  state.scripts.erga = {
    metadata: { main_module: "index.js", bindings: prodBindings },
    modules: ["index.js"],
    workersDev: false,
    tags: [],
    namespaces: ["DocumentObject", "DocHost", "Deployer", "DocList"],
  };
  state.secrets.erga = {
    SESSION_SECRET: "production-session-secret",
    GITHUB_CLIENT_SECRET: "production-github-secret",
    SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN,
  };
  state.versions = { erga: 1 };
  deployVersion(state, "erga", state.scripts.erga);
  state.domains.push({ hostname: "erga.dev", service: "erga", zone_id: state.zones[0].id });
  state.routes[state.zones[1].id] = [{ pattern: "*.erga-pages.dev/*", script: "erga" }];
  state.dns[state.zones[1].id] = [{ type: "AAAA", name: "*.erga-pages.dev", content: "100::", proxied: true }];
  const docs = memoryStore();
  PROD_DOCS.forEach((id, i) =>
    docs.docs.set(id, {
      entries: new Map<string, unknown>([
        ["meta", { id, owner: "ada", index: "index.html", created: 1_700_000_000_000 + i, modified: 1_700_000_100_000 + i }],
        ["file:index.html", new TextEncoder().encode(`<h1>Document ${i + 1}</h1><p>production's words</p>`)],
        ["state", new Uint8Array([1, 2, 3, i])],
        ...(i == 2 ? [["dir:drafts", true] as [string, unknown]] : []),
      ]),
      alarm: i == 1 ? 1_900_000_000_000 : null,
    })
  );
  state.docs.erga = docs;
}

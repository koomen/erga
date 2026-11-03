// The pretend Cloudflare's fleet (dev/mock-cloudflare.ts, the `fleet` option): Erga's own account as the branch deploys
// see it (dev/mock-builder.ts is the pretend builder).

import { memoryStore } from "../document/snapshot";
import { ACCOUNT_ID, deployVersion, FLEET_ACCOUNT, MOCK_SNAPSHOT_TOKEN, PROD_DB, PROD_DOCS, type MockState } from "./mock-cloudflare";

/** Erga's own account: production as cf deploy left it, the builder, the source (the fleet option). */
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
      "INSERT INTO server_config (key, value) VALUES ('deploy_page', '\"admins\"');",
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
  // The control Worker (control/): the repository, the pipeline, the build container; deployed by deploy/setup.ts.
  // As wrangler deployed it (control/wrangler.jsonc): no ERGA_VERSION until it deploys itself.
  state.scripts["erga-control"] = {
    metadata: {
      main_module: "index.js",
      compatibility_date: "2026-09-30",
      bindings: [
        { type: "durable_object_namespace", name: "BUILDS", class_name: "Builder" },
        { type: "durable_object_namespace", name: "PIPELINE", class_name: "Pipeline" },
        { type: "durable_object_namespace", name: "SOURCE", class_name: "SourceHost" },
        { type: "durable_object_namespace", name: "DEPLOYS", class_name: "Deployer" },
        { type: "d1", name: "DB", database_id: PROD_DB, id: PROD_DB },
        { type: "artifacts", name: "ARTIFACTS", namespace: "erga" },
        { type: "version_metadata", name: "CF_VERSION_METADATA" },
        { type: "plain_text", name: "CLOUDFLARE_ACCOUNT_ID", text: FLEET_ACCOUNT },
        { type: "plain_text", name: "APP_URL", text: "https://erga.dev" },
      ],
    },
    modules: ["index.js"],
    workersDev: false,
    tags: [],
    namespaces: ["Builder", "Pipeline", "SourceHost", "Deployer"],
  };
  state.versions = { erga: 1, "erga-control": 1 };
  deployVersion(state, "erga", state.scripts.erga);
  deployVersion(state, "erga-control", state.scripts["erga-control"]);
  state.domains.push({ hostname: "erga.dev", service: "erga", zone_id: state.zones[0].id });
  state.domains.push({ hostname: "ops.erga.dev", service: "erga-control", zone_id: state.zones[0].id });
  state.routes[state.zones[1].id] = [{ pattern: "*.erga-pages.dev/*", script: "erga" }];
  state.dns[state.zones[1].id] = [{ type: "AAAA", name: "*.erga-pages.dev", content: "100::", proxied: true }];
  // The Ops page's domain cases: a zone whose name servers haven't moved to Cloudflare yet, and a name with a record of its own.
  state.zones.push({
    id: "zone00000000000000000000000e7ga4",
    name: "erga-moving.dev",
    status: "pending",
    name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    original_name_servers: ["ns1.registrar.example", "ns2.registrar.example"],
  });
  state.dns[state.zones[0].id] = [{ type: "A", name: "blog.erga.dev", content: "192.0.2.10", proxied: false }];
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

// The pretend Cloudflare's fleet (dev/mock-cloudflare.ts, the `fleet` option): an account with an instance that runs
// already and room for a second one, as their deploys see it. Example names only: example.com, its pages on
// example-pages.com.

import { ACCOUNT_ID, deployVersion, FLEET_DB, type MockState } from "./mock-cloudflare";

/** The example account: the instance as a deploy left it (the fleet option). */
export function seedFleet(state: MockState) {
  state.account = { id: ACCOUNT_ID, name: "Erga" };
  state.subdomain = "erga";
  state.zones = [
    { id: "zone00000000000000000000000e7ga1", name: "example.com", status: "active" },
    { id: "zone00000000000000000000000e7ga2", name: "example-pages.com", status: "active" },
    { id: "zone00000000000000000000000e7ga3", name: "example-pages-next.com", status: "active" },
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
    uuid: FLEET_DB,
    name: "erga",
    statements: [],
    tables,
    migrations: ["0001_erga.sql", "0002_delete_docs_after_hours.sql", "0100_tokens.sql", "0110_admin_keys.sql"],
    rows: [
      "INSERT INTO users (login, name, role, created) VALUES ('ada', 'Ada', 'admin', 1700000000000);",
      ...["abcd2345", "efgh6789", "jkmn2345"].map(
        (id, i) => `INSERT INTO documents (id, owner, slug, title) VALUES ('${id}', 'ada', 'doc-${i + 1}', 'Document ${i + 1}');`
      ),
    ],
  });
  const secrets = { SESSION_SECRET: "fleet-session-secret", SECRETS_KEY: "fleet-secrets-key", GITHUB_CLIENT_SECRET: "fleet-github-secret" };
  const bindings = [
    { type: "durable_object_namespace", name: "DOCUMENTS", class_name: "DocumentObject" },
    { type: "d1", name: "DB", database_id: FLEET_DB, id: FLEET_DB },
    { type: "plain_text", name: "ERGA_VERSION", text: "prim00000000" },
    // Its secrets, as its settings list them: never a value.
    ...Object.entries(secrets).map(([name, text]) => ({ type: "secret_text", name, text: `(${text.length} characters)` })),
  ];
  state.scripts.erga = {
    metadata: { main_module: "index.js", bindings },
    modules: ["index.js"],
    workersDev: false,
    tags: [],
    namespaces: ["DocumentObject"],
  };
  state.secrets.erga = secrets;
  state.versions = { erga: 1 };
  deployVersion(state, "erga", state.scripts.erga);
  state.domains.push({ hostname: "example.com", service: "erga", zone_id: state.zones[0].id });
  state.routes[state.zones[1].id] = [{ pattern: "*.example-pages.com/*", script: "erga" }];
  state.dns[state.zones[1].id] = [
    { id: "d0000000000000000000000000000001", type: "AAAA", name: "*.example-pages.com", content: "100::", proxied: true },
  ];
}

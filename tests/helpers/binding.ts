// What the tests of the deployer's Worker share: an instance on the mock Cloudflare whose database is a real D1 binding
// (the Workers runtime on this machine), with its spec, a pretend GitHub that has the release of SHA2, and the
// instance's health row, which its own Worker writes when a new release is uploaded.

import * as Effect from "effect/Effect";
import type { Fetch } from "../../deploy/deployer/cloudflare-api";
import { bindingDatabase, bindingSql, type D1 } from "../../deploy/deployer/d1-binding";
import { writeSpec } from "../../deploy/deployer/instance";
import type { Spec } from "../../deploy/deployer/spec";
import { FLEET_ACCOUNT, mockCloudflare } from "../../dev/mock-cloudflare";
import { bindingsOf, bootstrap, release, SHA2 } from "./deploys.ts";
import { builtBundle, github } from "./github.ts";

/** The spec of the mock's second instance (next.example.com), which tracks main of example/erga. */
export const SPEC: Spec = {
  repo: "github.com/example/erga",
  branch: "main",
  target: {
    kind: "cloudflare",
    account: FLEET_ACCOUNT,
    worker: "erga-next",
    database: "erga-next",
    app: { kind: "domain", zoneName: "example.com", hostname: "next.example.com" },
    pages: { kind: "zone", zoneName: "example-pages-next.com", domain: "example-pages-next.com" },
  },
  settings: { GITHUB_CLIENT_ID: "Ov23next" },
  secrets: [],
};

export const record = (name: string) => `INSERT INTO d1_migrations (name) VALUES ('${name}');`;

/**
 * The instance as setup's pipeline made it (release SHA1) on the mock Cloudflare, with `d1` as its database: the
 * release's tables and the spec. `fetch`: the way out for the deployer (Cloudflare's API is the mock, the rest is the
 * pretend GitHub). `calls`: the mock's calls since the instance was made.
 */
export async function instanceOn(d1: D1) {
  const mock = mockCloudflare({ fleet: true });
  await bootstrap(mock);
  const db = bindingDatabase(d1);
  await db.query("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)", [], "set up the database");
  for (const name of Object.keys(release.migrations).sort()) await db.apply(release.migrations[name], record(name), `apply ${name}`);
  const sql = bindingSql(d1);
  await Effect.runPromise(writeSpec(sql, SPEC));
  const hub = github();
  hub.state.releases.set(SHA2, builtBundle(SHA2));
  const from = mock.state.calls.length;
  const fetch: Fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.startsWith("https://api.cloudflare.com/")) return hub.fetch(request.url, init);
    const upload = request.method == "PUT" && request.url.endsWith("/workers/scripts/erga-next");
    const answer = await mock.fetch(input, init);
    if (upload)
      await db.query(
        "INSERT INTO health (id, at, version, ok, checks) VALUES (1, ?, ?, 1, '{}') ON CONFLICT (id) DO UPDATE SET at = excluded.at, version = excluded.version",
        [Date.now(), bindingsOf(mock.state, "erga-next").ERGA_VERSION.text],
        "write the health row"
      );
    return answer;
  };
  return { mock, sql, hub, fetch, calls: () => mock.state.calls.slice(from) };
}

// What the tests of the deployer's Worker share (deploy/deployer/worker.ts): an instance on the mock Cloudflare whose
// database is a real D1 binding (the Workers runtime on this machine), with its spec; a pretend GitHub that has the
// release of SHA2; the instance's own /api/health, which answers for the release that the mock serves; and the
// deployer's store, its real class on a Map.

import * as Effect from "effect/Effect";
import { DeployError } from "../../deploy/deployer/cloudflare-api";
import type { D1 } from "../../deploy/deployer/d1-binding";
import { NoTable, type Sql, writeSpec } from "../../deploy/deployer/instance";
import type { Spec } from "../../deploy/deployer/spec";
import { DeployerState, type Env, type Fetch, type IO } from "../../deploy/deployer/worker";
import { FLEET_ACCOUNT, mockCloudflare } from "../../dev/mock-cloudflare";
import { bindingsOf, bootstrap, databaseOf, release, SHA2 } from "./deploys.ts";
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

/** The instance's record of its deploys (instance.ts, Sql) through the binding: how a test reads what the deployer wrote. */
export const sqlOf =
  (d1: D1): Sql =>
  (sql, params) =>
    Effect.tryPromise({
      try: async () =>
        (
          (
            await d1
              .prepare(sql)
              .bind(...params)
              .all()
          ).results ?? []
        ).map((r) => String(Object.values(r)[0])),
      catch: (e) => (/no such table/.test(String(e)) ? new NoTable() : new DeployError({ message: String(e) })),
    });

/** The deployer's store as its binding gives it: the real class, with a Map as Cloudflare's storage. */
export function storeBinding(): Env["STATE"] & { cell: Map<string, string> } {
  /** Each value as JSON: what comes out is never the object that went in. */
  const cell = new Map<string, string>();
  const object = new DeployerState({
    storage: {
      get: async (key) => (cell.has(key) ? JSON.parse(cell.get(key)!) : undefined),
      put: async (key, value) => void cell.set(key, JSON.stringify(value)),
    },
  });
  return { cell, idFromName: (name) => name, get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }) };
}

/**
 * The instance as setup's pipeline made it (release SHA1) on the mock Cloudflare, with `d1` as its database: the
 * release's tables and the spec. `io`: the deployer's ways out (Cloudflare's API is the mock, the instance's address
 * is `server`, the rest is the pretend GitHub; a sleep moves the clock on). `calls`: the mock's calls since the
 * instance was made. `asked`: each request of the instance's health, "public" or "direct". `made`: the mock, when
 * the test made the instance on it already (bootstrap).
 */
export async function instanceOn(d1: D1, made?: ReturnType<typeof mockCloudflare>) {
  const mock = made ?? mockCloudflare({ fleet: true });
  if (!made) await bootstrap(mock);
  await d1.prepare("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)").all();
  const { statementsOf } = await import("../../deploy/deployer/d1-binding");
  for (const name of Object.keys(release.migrations).sort())
    await d1.batch(
      [...statementsOf(release.migrations[name]), `INSERT INTO d1_migrations (name) VALUES ('${name}')`].map((s) => d1.prepare(s))
    );
  const sql = sqlOf(d1);
  await Effect.runPromise(writeSpec(sql, SPEC));
  const hub = github();
  hub.state.releases.set(SHA2, builtBundle(SHA2));
  const from = mock.state.calls.length;
  const state = { now: Date.parse("2026-11-20T10:00:00Z"), access: false, asked: [] as string[] };
  /** The server's own report, for the release that the mock serves: ok, unless the test says that the release is unhealthy, or fails as it starts. */
  const server = () => {
    const version = bindingsOf(mock.state, "erga-next").ERGA_VERSION.text as string;
    if (mock.state.silent?.includes(version)) return new Response("error code: 1101", { status: 500 });
    const bad = !!mock.state.unhealthy?.includes(version);
    const documents = bad ? { ok: false, error: "a document didn't open" } : { ok: true, ms: 2 };
    return Response.json({ ok: !bad, version, checks: { db: { ok: true, ms: 1 }, documents } }, { status: bad ? 503 : 200 });
  };
  const fetch: Fetch = async (url, init) => {
    if (url.startsWith("https://api.cloudflare.com/")) return mock.fetch(url, init);
    if (url != "https://next.example.com/api/health") return hub.fetch(url, init);
    state.asked.push("public");
    // Cloudflare Access in front of the instance: its sign-in, never the server.
    return state.access
      ? new Response("<html>Sign in</html>", { status: 302, headers: { location: "https://example.cloudflareaccess.com/" } })
      : server();
  };
  const io: IO = { fetch, now: () => state.now, sleep: async (ms) => void (state.now += ms) };
  const store = storeBinding();
  const env: Env = {
    CLOUDFLARE_API_TOKEN: "mock-only-erga-next",
    ACCOUNT: FLEET_ACCOUNT,
    WORKER: "erga-next",
    DATABASE: databaseOf(mock.state, "erga-next").uuid,
    DB: d1,
    STATE: store,
    INSTANCE: {
      fetch: async () => {
        state.asked.push("direct");
        return server();
      },
    },
  };
  return { mock, sql, hub, io, env, store, state, fetch, calls: () => mock.state.calls.slice(from) };
}

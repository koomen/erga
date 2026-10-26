// A pretend Cloudflare, for testing the deploy page without a real account:
// the API calls the deploy makes, Cloudflare's OAuth
// token endpoint, Registrar, and the new server itself once it's "deployed"
// (it answers, nothing more). It keeps what it was
// asked to do in `state`, which the tests read (and the page shows, at
// /deploy/api/mock, in local development with ERGA_DEPLOY_MOCK=1).
//
// Its requests and answers follow Cloudflare's OpenAPI schema
// and workers-sdk's deploy: the Worker's
// metadata as a form field, Durable Objects as declarative exports (no
// migration tags), a D1 binding's database_id, assets in buckets of base64
// or one by one (singleAssetUploads, as the upload JWT can ask), D1's
// /query, custom domains, Registrar's workflows. A request the real API
// would refuse, it refuses.
//
// Only the tests use it (and local development with ERGA_DEPLOY_MOCK=1).
//
// Tokens: any that starts with "mock-" is good; anything else is refused as
// Cloudflare would. Some do more:
//
//   mock-nosub          the account has no workers.dev subdomain yet
//   mock-noperm         the token can't make D1 databases (a permission missing)
//   mock-fail-<step>    Cloudflare fails at that step (account, database, migrations, assets, worker, address, pages)
//   mock-slow           each call takes a little while (to watch the steps go by)
//   mock-flaky          the first asset upload fails with a 502 (the deploy tries it again)
//   mock-scoped-…       an account API token made through the mock's POST /accounts/{id}/tokens:
//                      it may do only what its policies say (Editor on the
//                       Workers it names, D1, read on the zones it names), and is refused the rest
//                       with a 403, as Cloudflare would
//
// Registrar: a name with "taken" in it is taken, ".xyz" can't be registered
// through the API, ".dev" costs 12.18 USD and anything else 10.44.
//
// With `fleet`, the account is Erga's own, as the branch deploys
// see it: the zones erga.dev and erga-pages.dev, the
// production Worker "erga" already there (deployed by cf deploy, on erga.dev
// and *.erga-pages.dev) with its database "erga" (tables, rows and
// migrations) and three documents in its Durable Objects, the control
// Worker, and the source repo in Artifacts. D1's export and import work on
// it (the SQL as text), secrets are kept per Worker (keep_bindings, the
// secrets API), and each Worker answers as the real one would where the
// pipeline needs it: /logo.png, /api/deploys/version (its ERGA_VERSION) and
// the snapshot endpoints (document/snapshot.ts, the real handler, over an
// in-memory store of its documents). `failNext` makes the next call of a
// step fail once (state.failNext = "worker"); `onUpload` hears of each
// Worker uploaded (the tests restart the server that deployed itself).

import { createHash } from "node:crypto";
import type { Fetch } from "../control/deploys/cloudflare-api";
import type { Release } from "../control/deploys/release-format";
import type { Builder } from "../control/deploys/branches";
import { memoryStore, snapshotRoutes, type DocStore } from "../document/snapshot";
import { base64, fromBase64, hex, randomBytes } from "../shared/bytes";
import { sleep } from "../shared/time";

export interface MockState {
  account: { id: string; name: string };
  subdomain: string | null;
  zones: { id: string; name: string; status: string }[];
  databases: { uuid: string; name: string; statements: string[]; migrations: string[]; tables: string[]; rows?: string[] }[];
  scripts: Record<string, { metadata: Record<string, any>; modules: string[]; workersDev: boolean; tags: string[]; namespaces: string[] }>;
  assets: { manifest: Record<string, { hash: string; size: number }>; uploaded: string[] };
  /** Each asset's bytes, by hash (base64), and each Worker's files as its last upload had them (path -> hash): what mockSite serves. */
  blobs: Record<string, string>;
  served: Record<string, Record<string, string>>;
  domains: { hostname: string; service: string; zone_id: string }[];
  /** The Artifacts repos in the namespace erga (the fleet mock): Erga's own, and the installs' forks. */
  repos: string[];
  routes: Record<string, { pattern: string; script: string }[]>;
  dns: Record<string, { type: string; name: string; content: string; proxied: boolean }[]>;
  registrations: { domain: string; price?: string }[];
  /** Every call, "METHOD path" (tokens never). */
  calls: string[];
  revoked: number;
  /** Each Worker's secrets, by name (never in `scripts`' metadata, which shows only their lengths). */
  secrets: Record<string, Record<string, string>>;
  /** Each Worker's documents' Durable Objects (the snapshot endpoints read and write these). */
  docs: Record<string, ReturnType<typeof memoryStore>>;
  /** The snapshot endpoint's characters in one answer (SNAPSHOT_BUDGET unless a test makes it small, with the stores' rpcLimit). */
  snapshotBudget?: number;
  /** How many versions of each Worker were uploaded. */
  versions: Record<string, number>;
  /** Each Worker's versions as uploaded (newest last), by id: what a deployment can point back to (a rollback). */
  kept: Record<string, { id: string; script: MockState["scripts"][string] }[]>;
  /** Each Worker's deployments, newest first: the first is the one serving. */
  deployments: Record<string, { id: string; created_on: string; strategy: string; versions: { version_id: string; percentage: number }[] }[]>;
  /** Deleted D1 databases, by name. */
  deletedDatabases: string[];
  /** R2 buckets, by name (the release store's). */
  buckets?: string[];
  /** Releases (ERGA_VERSION values) whose /api/health answers ok false: a test's broken deploy. */
  unhealthy?: string[];
  /** OAuth: the refresh tokens still good (each refresh rotates), how many grants were given, and how long an access token lasts. */
  refreshTokens: string[];
  oauthGrants: number;
  oauthExpiresIn?: number;
  /** The next refresh answers this status (a 429, a 503) and nothing else, once. */
  oauthRefreshStatus?: number;
  /** Access tokens the API refuses (401), as a grant revoked on the dashboard: the refresh tells. */
  refusedTokens?: string[];
  /** What a consent grants when set (fewer scopes than asked: a client that lost one); else MOCK_OAUTH_SCOPES. */
  oauthScopes?: string;
  /** The next call of this step fails once (a 500), as mock-fail-<step> does for every call. */
  failNext: string | null;
  /** Account API tokens made through the API (their values aren't here: only the tests read them, from `tokenValues`). */
  tokens: { id: string; name: string; policies: TokenPolicy[] }[];
  /** Containers (the build containers, control/builder/): images prepared, and applications by id (= their namespace's id). */
  containers: { prepared: string[]; apps: Record<string, { name: string; scheduling_policy: string; durable_objects: { namespace_id: string }; configuration?: { instance_type?: string } }> };
}

interface TokenPolicy { effect: string; permission_groups: { id: string; name?: string }[]; resources: Record<string, string | Record<string, string>> }
/** A policy's resource keys, a Worker's nested under its account. */
const keysOf = (p: TokenPolicy) => Object.entries(p.resources ?? {}).flatMap(([k, v]) => (typeof v == "string" ? [k] : Object.keys(v)));

/** The permission groups the mock knows, by id (Cloudflare's ids). */
const GROUPS: Record<string, string> = {
  "7e79ec33834341f28dd431ab73884400": "Individual Workers Editor",
  "bdbcd690c763475a985e8641dddc09f7": "Workers Containers Write",
  "09b2857d1c31407795e75e3fed8617a1": "D1 Write",
  "c8fed203ed3043cba015a93ad1616f1f": "Zone Read",
  "2072033d694d415a936eaeb94e6405b8": "Workers Routes Read",
  "82e64a83756745bbbb1c9c2701bf816b": "DNS Read",
};

/** A Worker's tag (its id in GET /workers/scripts, and in a token's resources): fixed by its name, here. */
export const scriptTag = (name: string) => createHash("md5").update(`script:${name}`).digest("hex");
/** A Durable Object namespace's id: fixed by its Worker and class, here. */
export const namespaceId = (script: string, className: string) => createHash("md5").update(`ns:${script}:${className}`).digest("hex");

export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
/** A custom domain's id: fixed by its hostname, here. */
const domainId = (hostname: string) => createHash("md5").update(`domain:${hostname}`).digest("hex");

/**
 * What a hostname on the mock's custom domains would answer for `path`: the
 * file its Worker's last upload had there (as html_handling "auto-trailing-slash"
 * finds a page: /, /about, /about/), or null. For the tests and the dev server
 * to see a site as it was published.
 */
export function mockSite(state: MockState, hostname: string, path: string): { bytes: Uint8Array; path: string } | null {
  const d = state.domains.find((x) => x.hostname == hostname);
  const files = d && state.served[d.service];
  if (!files) return null;
  const p = decodeURIComponent(path.replace(/^\/+/, ""));
  for (const c of [p, `${p}.html`, `${p.replace(/\/$/, "")}/index.html`, p == "" ? "index.html" : null]) {
    const hash = c != null ? files["/" + c] : undefined;
    if (hash && state.blobs[hash] != null) return { bytes: fromBase64(state.blobs[hash]), path: "/" + c };
  }
  return null;
}

/** A JWT-shaped token with these claims (the deploy reads wrangler_single_asset_uploads from the upload one). */
const jwt = (claims: Record<string, unknown>) => `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.mock`;
const UPLOAD = (single: boolean) => jwt({ kind: "upload", ...(single ? { wrangler_single_asset_uploads: true } : {}) });
const COMPLETE = jwt({ kind: "complete" });

/** Erga's own account in the fleet mock (control/deploys/branches.ts's tests and the dev server's ERGA_DEPLOY_MOCK). */
export const FLEET_ACCOUNT = ACCOUNT_ID;
/** What the mock's consent grants (control/deploys/credential.ts CONTROL_OAUTH_SCOPES, as Cloudflare echoes them in the token's `scope`). */
export const MOCK_OAUTH_SCOPES = "workers-scripts.edit containers.write cloudchamber.write d1.write artifacts.write workers-routes.write dns.write zone.read account-settings.read offline_access";
export const PROD_DB = "0b0d0b0d-0000-4000-8000-00000000e9a0";
/** Production's SNAPSHOT_TOKEN in the fleet mock (the tests give staging the same). */
export const MOCK_SNAPSHOT_TOKEN = "mock-snapshot-token-0123456789abcdef0123456789";
export const MOCK_HOOK_SECRET = "mock-hook-secret-0123456789abcdef";
/** Production's documents in the fleet mock: their ids, and what each holds. */
export const PROD_DOCS = ["abcd2345", "efgh6789", "jkmn2345"];

export function mockCloudflare(opts: {
  delayMs?: number; singleAssetUploads?: boolean; fleet?: boolean;
  /** With fleet: staging's secrets already given (as deploy/setup.ts gives them to its first deploy), for the dev server's mock. */
  stagingSecrets?: boolean;
  onUpload?: (script: string, metadata: Record<string, any>) => void;
  /** A Worker's own answer, before the mock's (the tests route /api/deploys/... to the servers they run). */
  sites?: (req: Request, script: string) => Promise<Response | null> | Response | null;
  /**
   * Whether a token made through the API (mock-scoped-…) without Workers Containers Write may upload a version
   * that names a container's class. Cloudflare's answer isn't known yet: "refuse" (the default) plays the cautious
   * one. (Erga deploys with an OAuth grant now, control/deploys/credential.ts; the mock's tokens stay for the API's shape.)
   */
  scopedContainers?: "refuse" | "accept";
} = {}): { fetch: Fetch; state: MockState; tokenValues: Map<string, string> } {
  const state: MockState = {
    account: { id: ACCOUNT_ID, name: "Ada's account" },
    subdomain: "ada-mock",
    zones: [{ id: "zone0000000000000000000000000001", name: "ada-example.com", status: "active" }, { id: "zone0000000000000000000000000002", name: "ada-pages.net", status: "active" }],
    databases: [], scripts: {}, assets: { manifest: {}, uploaded: [] }, blobs: {}, served: {}, domains: [], repos: opts.fleet ? ["erga"] : [], buckets: opts.fleet ? ["erga-releases"] : [], routes: {}, dns: {}, registrations: [], calls: [], revoked: 0,
    secrets: {}, docs: {}, versions: {}, kept: {}, deployments: {}, deletedDatabases: [], failNext: null, tokens: [], containers: { prepared: [], apps: {} }, refreshTokens: [], oauthGrants: 0,
  };
  /** Tokens' values, by token id (never in `state`). */
  const tokenValues = new Map<string, string>();
  // Secrets' values never go out with the state (/deploy/api/mock shows it): only the tests read them, in this process.
  Object.defineProperty(state, "secrets", { value: {}, enumerable: false, writable: true });
  if (opts.fleet) seedFleet(state);
  if (opts.fleet && opts.stagingSecrets) state.secrets["erga-staging"] = { SESSION_SECRET: "mock-staging-session-secret", GITHUB_CLIENT_SECRET: "mock-staging-github-secret", SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: MOCK_HOOK_SECRET, CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" };
  /** D1 exports ready to download, and imports uploaded, by URL. */
  const exportsAt = new Map<string, string>(), uploads = new Map<string, string>();
  const importing = new Map<string, string>();
  let subFor: string | null = null, flaked = false;
  const ok = (result: unknown, status = 200) => Response.json({ success: true, errors: [], messages: [], result }, { status });
  const fail = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
  const randomHex = (n: number) => hex(randomBytes(n));
  const tokenOf = (value: string) => state.tokens.find((t) => tokenValues.get(t.id) == value);

  /** What a token made through the API may do (its policies), as Cloudflare checks it: a refusal, or null to go on. */
  /** Whether a token made through the API has Workers Containers Write on the account (a version naming a container's class). */
  function grantsContainers(value: string): boolean {
    const t = tokenOf(value);
    return !!t && t.policies.some((p) => p.permission_groups.some((g) => GROUPS[g.id] == "Workers Containers Write") && keysOf(p).includes(`com.cloudflare.api.account.${ACCOUNT_ID}`));
  }

  function scoped(m: string, path: string, value: string): Response | null {
    const t = tokenOf(value);
    if (!t) return fail(401, 1000, "Invalid API Token");
    const no = () => fail(403, 10000, "Authentication error");
    const grants = (group: string) => t.policies.filter((p) => p.permission_groups.some((g) => GROUPS[g.id] == group)).flatMap(keysOf);
    const workers = grants("Individual Workers Editor").map((k) => k.split(".").pop()!);
    const d1 = grants("D1 Write").includes(`com.cloudflare.api.account.${ACCOUNT_ID}`);
    const zoneIds = (group: string) => grants(group).map((k) => /zone\.(\w+)$/.exec(k)?.[1]).filter(Boolean) as string[];
    const zones = zoneIds("Zone Read");
    const acc = /^\/accounts\/[^/]+(\/[^?]*)?/.exec(path);
    if (acc) {
      const rest = acc[1] ?? "";
      if (rest == "/tokens/verify") return null;
      const script = /^\/workers\/scripts\/([^/]+)/.exec(rest);
      if (script) return workers.includes(scriptTag(script[1])) && state.scripts[script[1]] ? null : no();
      if (rest == "/d1/database" || rest.startsWith("/d1/")) return d1 ? null : no();
      // The account's custom domains: no per-zone read reaches them (as on Cloudflare: a 403 for a scoped token).
      return no();
    }
    if (path.startsWith("/zones?")) return zones.length ? null : no();
    const zone = /^\/zones\/([^/?]+)(\/[^?]*)/.exec(path);
    if (zone) {
      if (m != "GET") return no();
      const need = zone[2].startsWith("/dns_records") ? "DNS Read" : zone[2].startsWith("/workers/routes") ? "Workers Routes Read" : "Zone Read";
      return zoneIds(need).includes(zone[1]) ? null : no();
    }
    return no();
  }

  async function api(req: Request, path: string, token: string): Promise<Response> {
    const m = req.method;
    // The account's workers.dev subdomain is set per token the first time it's seen (mock-nosub has none until it makes one).
    if (subFor != token) { subFor = token; if (token == "mock-nosub") state.subdomain = null; }
    const failAt = /^mock-fail-(\w+)$/.exec(token)?.[1];
    const step = stepOf(m, path);
    if (failAt == "registration" && step == "registration") return fail(400, 10500, "Your account has no default payment method");
    if (failAt && failAt == step) return fail(500, 10013, "An unknown error has occurred");
    if (state.failNext && state.failNext == step) { state.failNext = null; return fail(500, 10013, "An unknown error has occurred"); }
    let r: RegExpExecArray | null;
    if (token.startsWith("mock-scoped-")) { const no = scoped(m, path, token); if (no) return no; }
    if (m == "GET" && /^\/accounts(\?|$)/.test(path)) return ok([state.account]);
    if (m == "GET" && path == "/user/tokens/verify") return ok({ status: "active" });
    if ((r = /^\/accounts\/([^/]+)(\/.*)?$/.exec(path))) {
      if (r[1] != ACCOUNT_ID) return fail(403, 9109, "Unauthorized to access requested resource");
      const rest = r[2] ?? "";
      const body = async () => req.headers.get("content-type")?.includes("json") ? await req.json() as any : null;
      if (m == "GET" && rest == "") return ok(state.account);
      if (rest == "/workers/subdomain") {
        if (m == "GET") return state.subdomain ? ok({ subdomain: state.subdomain }) : fail(404, 10007, "workers.dev subdomain not found");
        if (m == "PUT") { state.subdomain = (await body()).subdomain; return ok({ subdomain: state.subdomain }); }
      }
      if (m == "GET" && rest == "/workers/scripts") return ok(Object.entries(state.scripts).map(([id, s]) => ({ id, tag: scriptTag(id), tags: s.tags, named_handlers: s.namespaces.map((name) => ({ name, handlers: ["class"] })) })));
      if (rest.startsWith("/tokens")) {
        if (m == "GET" && rest == "/tokens/permission_groups") return ok(Object.entries(GROUPS).map(([id, name]) => ({ id, name, scopes: [] })));
        if (m == "GET" && rest == "/tokens/verify") return token.startsWith("mock-scoped-") ? ok({ id: tokenOf(token)?.id, status: "active" }) : fail(400, 1000, "not an account token");
        if (token.startsWith("mock-scoped-")) return fail(403, 9109, "Unauthorized to access requested resource");
        if (m == "GET" && rest.startsWith("/tokens?")) return ok(state.tokens.map(({ id, name }) => ({ id, name, status: "active" })));
        if (m == "POST" && rest == "/tokens") {
          const b = await body();
          if (!b?.name || !Array.isArray(b.policies) || !b.policies.length) return fail(400, 400, "name and policies are required");
          for (const pol of b.policies as TokenPolicy[]) {
            for (const g of pol.permission_groups ?? []) if (!GROUPS[g.id]) return fail(400, 400, `unknown permission group ${g.id}`);
            // A Worker's key on its own is refused, as Cloudflare does (code 1004): it must sit under its account's.
            if (Object.keys(pol.resources ?? {}).some((k) => k.startsWith("com.cloudflare.edge.worker.script."))) return fail(500, 1004, "server error when creating the token");
            for (const key of keysOf(pol)) {
              const w = /^com\.cloudflare\.edge\.worker\.script\.([0-9a-f]{32})$/.exec(key), z = /^com\.cloudflare\.api\.account\.zone\.(\w+)$/.exec(key), a = /^com\.cloudflare\.api\.account\.(\w+)$/.exec(key);
              if (w && !Object.keys(state.scripts).some((n) => scriptTag(n) == w[1])) return fail(400, 400, `no Worker with the tag ${w[1]}`);
              if (z && !state.zones.some((x) => x.id == z[1])) return fail(400, 400, `no zone ${z[1]}`);
              if (!w && !z && !(a && a[1] == ACCOUNT_ID)) return fail(400, 400, `unknown resource ${key}`);
            }
          }
          const id = randomHex(16),
            value = `mock-scoped-${randomHex(16)}`;
          state.tokens.push({ id, name: b.name, policies: b.policies });
          tokenValues.set(id, value);
          return ok({ id, name: b.name, status: "active", policies: b.policies, value });
        }
        const one = /^\/tokens\/([0-9a-f]+)$/.exec(rest);
        const t = one && state.tokens.find((x) => x.id == one[1]);
        if (one && !t) return fail(404, 1003, "token not found");
        if (m == "GET" && t) return ok({ id: t.id, name: t.name, status: "active", policies: t.policies });
        if (m == "DELETE" && t) { state.tokens = state.tokens.filter((x) => x != t); tokenValues.delete(t.id); return ok({ id: t.id }); }
      }
      if (rest.startsWith("/r2/buckets")) {
        state.buckets ??= [];
        if (m == "GET") { const q = new URLSearchParams(rest.split("?")[1] ?? "").get("name_contains") ?? ""; return ok({ buckets: state.buckets.filter((b) => b.includes(q)).map((name) => ({ name })) }); }
        if (m == "POST" && rest == "/r2/buckets") { const { name } = await body(); if (state.buckets.includes(name)) return fail(409, 10004, "The bucket you tried to create already exists"); state.buckets.push(name); return ok({ name }); }
      }
      if (rest.startsWith("/d1/database")) {
        if (token == "mock-noperm") return fail(403, 10000, "Authentication error");
        if (m == "GET" && rest.startsWith("/d1/database?")) {
          const name = new URLSearchParams(rest.split("?")[1]).get("name");
          return ok(state.databases.filter((d) => !name || d.name == name).map(({ uuid, name }) => ({ uuid, name })));
        }
        if (m == "POST" && rest == "/d1/database") {
          const { name } = await body();
          if (state.databases.some((d) => d.name == name)) return fail(400, 7502, "A database with that name already exists");
          const db = {
            uuid: `${randomHex(4)}-${randomHex(2)}-${randomHex(2)}-${randomHex(2)}-${randomHex(6)}`,
            name,
            statements: [],
            migrations: [],
            tables: [],
          };
          state.databases.push(db);
          return ok({ uuid: db.uuid, name });
        }
        const del = /^\/d1\/database\/([^/?]+)$/.exec(rest);
        if (m == "DELETE" && del) {
          const i = state.databases.findIndex((d) => d.uuid == del[1]);
          if (i < 0) return fail(404, 7404, "The database could not be found");
          state.deletedDatabases.push(state.databases[i].name);
          state.databases.splice(i, 1);
          return ok(null);
        }
        const tt = /^\/d1\/database\/([^/]+)\/time_travel\/bookmark(?:\?.*)?$/.exec(rest);
        if (m == "GET" && tt) {
          const ttDb = state.databases.find((d) => d.uuid == tt[1]);
          if (!ttDb) return fail(404, 7404, "The database could not be found");
          return ok({ bookmark: `${randomHex(8)}-00000000-00000000-${randomHex(8)}` });
        }
        const ex = /^\/d1\/database\/([^/]+)\/export$/.exec(rest);
        const exDb = ex && state.databases.find((d) => d.uuid == ex[1]);
        if (m == "POST" && ex) {
          if (!exDb) return fail(404, 7404, "The database could not be found");
          const { output_format, current_bookmark } = await body();
          if (output_format != "polling") return fail(400, 7400, "output_format must be polling");
          // The first call starts it; the next (with its bookmark) finds it done.
          if (!current_bookmark) return ok({ success: true, type: "export", at_bookmark: `bm-${exDb.uuid}`, status: "active", messages: ["Generating"] });
          const url = `https://d1-export.mock/${exDb.uuid}/${randomHex(4)}.sql`;
          exportsAt.set(url, dumpOf(exDb));
          return ok({ success: true, type: "export", at_bookmark: current_bookmark, status: "complete", result: { filename: url.split("/").pop(), signed_url: url } });
        }
        const im = /^\/d1\/database\/([^/]+)\/import$/.exec(rest);
        const imDb = im && state.databases.find((d) => d.uuid == im[1]);
        if (m == "POST" && im) {
          if (!imDb) return fail(404, 7404, "The database could not be found");
          const b = await body();
          if (b.action == "init") {
            if (!/^[0-9a-f]{32}$/.test(b.etag ?? "")) return fail(400, 7400, "etag must be the file's MD5");
            return ok({ success: true, filename: `${b.etag}.sql`, upload_url: `https://d1-import.mock/${imDb.uuid}/${b.etag}` });
          }
          if (b.action == "ingest") {
            const sql = uploads.get(`${imDb.uuid}/${b.etag}`);
            if (sql == null) return fail(400, 7400, "Nothing was uploaded for that etag");
            applySql(imDb, sql);
            importing.set(imDb.uuid, `bm-import-${randomHex(4)}`);
            return ok({ success: true, at_bookmark: importing.get(imDb.uuid), status: "active" });
          }
          if (b.action == "poll") {
            if (!importing.has(imDb.uuid)) return ok({ success: false, error: "Not currently importing anything.", status: "complete" });
            importing.delete(imDb.uuid);
            return ok({ success: true, status: "complete", result: { num_queries: (imDb.rows ?? []).length } });
          }
          return fail(400, 7400, "action must be init, ingest or poll");
        }
        const q = /^\/d1\/database\/([^/]+)\/query$/.exec(rest);
        const db = q && state.databases.find((d) => d.uuid == q[1]);
        if (m == "POST" && db) {
          try { return ok([{ success: true, results: d1Query(db, (await body()) as { sql: string; params?: unknown[] }), meta: { served_by_primary: true } }]); } catch (e) {
            if (e instanceof D1Error) return fail(400, 7500, e.message);
            throw e;
          }
        }
      }
      if (m == "POST" && (r = /^\/workers\/scripts\/([^/]+)\/assets-upload-session$/.exec(rest))) {
        const { manifest } = await body();
        state.assets.manifest = manifest;
        const missing = Object.values(manifest as Record<string, { hash: string }>).map((f) => f.hash).filter((h) => !state.assets.uploaded.includes(h));
        const buckets: string[][] = [];
        for (let i = 0; i < missing.length; i += 10) buckets.push(missing.slice(i, i + 10));
        return ok({ jwt: buckets.length ? UPLOAD(!!opts.singleAssetUploads) : COMPLETE, buckets });
      }
      if (m == "POST" && rest.startsWith("/workers/assets/upload")) {
        if (req.headers.get("authorization") != `Bearer ${UPLOAD(!!opts.singleAssetUploads)}`) return fail(401, 10001, "Invalid assets upload token");
        if (token == "mock-flaky" && !flaked) { flaked = true; return new Response("Bad gateway", { status: 502 }); }
        const known = (hash: string) => Object.values(state.assets.manifest).some((f) => f.hash == hash);
        const one = /^\/workers\/assets\/upload\/([0-9a-f]{32})$/.exec(rest);
        if (one) {
          if (!opts.singleAssetUploads) return fail(400, 10002, "single asset uploads aren't enabled for this session");
          if (!known(one[1])) return fail(400, 10002, `unexpected ${one[1]}`);
          state.blobs[one[1]] = base64(await req.arrayBuffer());
          state.assets.uploaded.push(one[1]);
        } else if (rest == "/workers/assets/upload?base64=true") {
          if (opts.singleAssetUploads) return fail(400, 10002, "this session takes one file at a time");
          const form = await req.formData();
          for (const [hash, value] of form.entries() as Iterable<[string, File | string]>) {
            if (typeof value == "string" || !known(hash)) return fail(400, 10002, `unexpected ${hash}`);
            const text = await value.text();
            atob(text);
            state.blobs[hash] = text;
            state.assets.uploaded.push(hash);
          }
        } else return fail(400, 10002, "base64=true is required");
        const all = Object.values(state.assets.manifest).every((f) => state.assets.uploaded.includes(f.hash));
        return ok(all ? { jwt: COMPLETE } : {}, all ? 201 : 202);
      }
      if (m == "PUT" && (r = /^\/workers\/scripts\/([^/]+)$/.exec(rest))) {
        const form = await req.formData();
        const field = form.get("metadata");
        const meta = JSON.parse(typeof field == "string" ? field : await (field as File).text());
        if (meta.assets && meta.assets.jwt != COMPLETE) return fail(400, 10021, "assets jwt isn't a completion token");
        const modules = [...form.keys()].filter((k) => k != "metadata");
        if (!modules.includes(meta.main_module)) return fail(400, 10021, `No such module "${meta.main_module}"`);
        if (meta.migrations && meta.exports) return fail(400, 10021, "migrations and Durable Object exports can't be used together");
        // A version naming container images (the factory's): each prepared first, its class one of the version's Durable Objects.
        for (const c of meta.containers ?? []) {
          if (token.startsWith("mock-scoped-") && (opts.scopedContainers ?? "refuse") == "refuse" && !grantsContainers(token)) return fail(403, 10000, "Authentication error: containers");
          if (!c.class_name || !(meta.exports?.[c.class_name] || state.scripts[r[1]]?.namespaces.includes(c.class_name))) return fail(400, 10021, `container ${c.name ?? c.class_name}: no Durable Object class ${c.class_name}`);
          for (const ref of Object.values(c.images ?? {}) as string[]) if (!state.containers.prepared.includes(ref)) return fail(400, 10021, `container ${c.name}: image ${ref} isn't prepared`);
        }
        const prev = state.scripts[r[1]];
        // Durable Objects: a namespace per class in exports, made the first time, matched after.
        const namespaces = [...new Set([...(prev?.namespaces ?? []), ...Object.entries(meta.exports ?? {}).filter(([, e]: [string, any]) => e.type == "durable-object" && e.storage == "sqlite").map(([n]) => n)])];
        for (const b of meta.bindings ?? []) {
          if (b.type == "durable_object_namespace" && !b.script_name && !namespaces.includes(b.class_name)) return fail(400, 10061, `Cannot apply binding: no Durable Object namespace for class ${b.class_name}`);
          if (b.type == "d1" && !state.databases.some((d) => d.uuid == b.database_id)) return fail(400, 10021, `binding ${b.name}: no D1 database ${b.database_id ?? "(database_id missing)"}`);
          if ((b.type == "plain_text" || b.type == "secret_text") && typeof b.text != "string") return fail(400, 10021, `binding ${b.name} needs text`);
          if (b.type == "service" && !state.scripts[b.service]) return fail(400, 10143, `service binding ${b.name}: no Worker ${b.service}`);
          if (b.type == "artifacts" && (!opts.fleet || b.namespace != "erga")) return fail(400, 10021, `binding ${b.name}: no Artifacts namespace ${b.namespace}`);
          if (b.type == "r2_bucket" && !(state.buckets ?? []).includes(b.bucket_name)) return fail(400, 10085, `binding ${b.name}: no R2 bucket ${b.bucket_name}`);
        }
        // Secrets: those in this upload, and the last version's when keep_bindings says so (as the real API does).
        const kept = (meta.keep_bindings ?? []).includes("secret_text") ? { ...(state.secrets[r[1]] ?? {}) } : {};
        for (const b of meta.bindings ?? []) if (b.type == "secret_text") kept[b.name] = b.text;
        state.secrets[r[1]] = kept;
        const named = new Set((meta.bindings ?? []).map((b: any) => b.name));
        const keptBindings = Object.keys(kept).filter((n) => !named.has(n)).map((name) => ({ type: "secret_text", name, text: kept[name] }));
        state.scripts[r[1]] = { metadata: redact({ ...meta, bindings: [...(meta.bindings ?? []), ...keptBindings] }), modules, workersDev: prev?.workersDev ?? false, tags: meta.tags ?? [], namespaces };
        state.versions[r[1]] = (state.versions[r[1]] ?? 0) + 1;
        if (meta.assets) state.served[r[1]] = Object.fromEntries(Object.entries(state.assets.manifest).map(([p, f]) => [p, f.hash]));
        const versionId = deployVersion(state, r[1], state.scripts[r[1]]);
        opts.onUpload?.(r[1], state.scripts[r[1]].metadata);
        return ok({ id: r[1], tags: meta.tags ?? [], deployment_id: state.deployments[r[1]][0].id, startup_time_ms: 1, version_id: versionId } as unknown);
      }
      if ((r = /^\/workers\/scripts\/([^/]+)\/deployments(?:\?.*)?$/.exec(rest))) {
        if (!state.scripts[r[1]]) return fail(404, 10007, "This Worker does not exist on your account.");
        if (m == "GET") return ok({ deployments: state.deployments[r[1]] ?? [] });
        if (m == "POST") {
          const b = await body();
          const want = b?.versions?.[0]?.version_id;
          const kept = (state.kept[r[1]] ?? []).find((v) => v.id == want);
          if (b?.strategy != "percentage" || !kept || b.versions.length != 1 || b.versions[0].percentage != 100) return fail(400, 10215, "a deployment names one version of this Worker, at 100%");
          // As Cloudflare does: the message is the one annotation a request may set.
          const other = Object.keys(b.annotations ?? {}).find((k) => k != "workers/message");
          if (other) return fail(400, 10210, `Invalid deployment: Invalid annotations: "${other}" is not supported - check the request details and try again.`);
          // The named version serves again: its bindings as they were, with the secrets the Worker has now (as a rollback does).
          state.scripts[r[1]] = structuredClone(kept.script);
          const id = uuid();
          (state.deployments[r[1]] ??= []).unshift({ id, created_on: new Date().toISOString(), strategy: "percentage", versions: [{ version_id: kept.id, percentage: 100 }] });
          return ok({ id, strategy: "percentage", versions: [{ version_id: kept.id, percentage: 100 }] });
        }
      }
      if (m == "DELETE" && (r = /^\/workers\/scripts\/([^/?]+)(?:\?.*)?$/.exec(rest))) {
        if (!state.scripts[r[1]]) return fail(404, 10007, "This Worker does not exist on your account.");
        if (state.domains.some((d) => d.service == r![1]) && !rest.includes("force=true")) return fail(400, 10064, "This Worker is still attached to a custom domain");
        delete state.scripts[r[1]]; delete state.served[r[1]];
        state.domains = state.domains.filter((d) => d.service != r![1]);
        return ok(null);
      }
      if (m == "POST" && (r = /^\/workers\/scripts\/([^/]+)\/subdomain$/.exec(rest))) {
        if (!state.scripts[r[1]]) return fail(404, 10007, "script not found");
        state.scripts[r[1]].workersDev = !!(await body()).enabled;
        return ok({ enabled: state.scripts[r[1]].workersDev });
      }
      if (m == "GET" && (r = /^\/workers\/scripts\/([^/]+)\/settings$/.exec(rest))) {
        if (!state.scripts[r[1]]) return fail(404, 10007, "This Worker does not exist on your account.");
        const bindings = (state.scripts[r[1]].metadata.bindings ?? []).map((b: any) => (b.type == "durable_object_namespace" && !b.script_name ? { ...b, namespace_id: namespaceId(r![1], b.class_name) } : b));
        return ok({ bindings, compatibility_date: state.scripts[r[1]].metadata.compatibility_date, tags: state.scripts[r[1]].tags });
      }
      if ((r = /^\/workers\/scripts\/([^/]+)\/secrets$/.exec(rest))) {
        if (!state.scripts[r[1]]) return fail(404, 10007, "This Worker does not exist on your account.");
        if (m == "GET") return ok(Object.keys(state.secrets[r[1]] ?? {}).map((name) => ({ name, type: "secret_text" })));
        if (m == "PUT") {
          const b = await body();
          if (!b?.name || typeof b.text != "string" || b.type != "secret_text") return fail(400, 10021, "name, text and type secret_text are required");
          (state.secrets[r[1]] ??= {})[b.name] = b.text;
          const meta = state.scripts[r[1]].metadata;
          meta.bindings = [...(meta.bindings ?? []).filter((x: any) => x.name != b.name), { type: "secret_text", name: b.name, text: `(${b.text.length} characters)` }];
          state.versions[r[1]] = (state.versions[r[1]] ?? 0) + 1;
          return ok({ name: b.name, type: "secret_text" });
        }
      }
      // Containers: images prepared (any in this account's registry), and the factory's application.
      if (m == "POST" && rest == "/containers/image-preparations") {
        const b = await body();
        if (typeof b?.image != "string" || !b.image.startsWith(`registry.cloudflare.com/${ACCOUNT_ID}/`) || !/@sha256:[0-9a-f]{64}$/.test(b.image)) return fail(400, 1000, "image must be digest-pinned and hosted in a supported managed registry");
        if (!state.containers.prepared.includes(b.image)) state.containers.prepared.push(b.image);
        return ok({ status: "ready" });
      }
      if (m == "GET" && rest == "/containers/applications") return ok(Object.entries(state.containers.apps).map(([id, a]) => ({ id, ...a })));
      if (m == "GET" && (r = /^\/containers\/applications\/([0-9a-f]+)$/.exec(rest))) {
        const app = state.containers.apps[r[1]];
        return app ? ok({ id: r[1], ...app }) : fail(404, 1404, "application not found");
      }
      if (m == "PATCH" && (r = /^\/containers\/applications\/([0-9a-f]+)$/.exec(rest))) {
        const app = state.containers.apps[r[1]];
        if (!app) return fail(404, 1404, "application not found");
        const b = await body();
        if (b?.configuration) app.configuration = { ...app.configuration, ...b.configuration };
        return ok({ id: r[1], ...app });
      }
      if (m == "POST" && rest == "/containers/applications") {
        const b = await body();
        const ns = b?.durable_objects?.namespace_id;
        if (b?.scheduling_policy != "durable_object" || !ns || !b.name) return fail(400, 10021, "name, scheduling_policy durable_object and durable_objects.namespace_id are required");
        if (state.containers.apps[ns]) return fail(409, 10409, "an application for that namespace exists");
        state.containers.apps[ns] = { name: b.name, scheduling_policy: b.scheduling_policy, durable_objects: { namespace_id: ns } };
        return ok({ id: ns, ...state.containers.apps[ns] });
      }
      if (m == "GET" && (r = /^\/artifacts\/namespaces\/([^/]+)\/repos\/([^/]+)$/.exec(rest))) {
        if (!opts.fleet || r[1] != "erga" || !state.repos.includes(r[2])) return fail(404, 10404, "repo not found");
        return ok({ name: r[2], namespace: r[1], remote: `https://artifacts.mock/git/erga/${r[2]}.git`, default_branch: "main" });
      }
      // A repo made (an install's fork: control/install/forks.ts).
      if (m == "POST" && (r = /^\/artifacts\/namespaces\/([^/]+)\/repos$/.exec(rest))) {
        const b = await body();
        if (!opts.fleet || r[1] != "erga") return fail(404, 10404, "namespace not found");
        if (!/^[a-z0-9][\w.-]*$/.test(b?.name ?? "")) return fail(400, 10400, "a repo name is needed");
        if (state.repos.includes(b.name)) return fail(409, 10409, "a repo of that name exists");
        state.repos.push(b.name);
        return ok({ name: b.name, namespace: r[1], remote: `https://artifacts.mock/git/erga/${b.name}.git`, default_branch: b.default_branch ?? "main" });
      }
      if (m == "POST" && (r = /^\/artifacts\/namespaces\/([^/]+)\/tokens$/.exec(rest))) {
        const b = await body();
        if (!opts.fleet || r[1] != "erga" || !state.repos.includes(b?.repo)) return fail(404, 10404, "repo not found");
        return ok({
          id: randomHex(8),
          token: `art-read-${randomHex(8)}`,
          scope: b.scope ?? "write",
          expires_at: new Date(Date.now() + (b.ttl ?? 3600) * 1000).toISOString(),
        });
      }
      if (m == "GET" && rest.startsWith("/workers/domains")) {
        const q = new URLSearchParams(rest.split("?")[1] ?? ""), hostname = q.get("hostname"), service = q.get("service");
        return ok(state.domains.filter((d) => (!hostname || d.hostname == hostname) && (!service || d.service == service)).map((d) => ({ id: domainId(d.hostname), zone_name: state.zones.find((z) => z.id == d.zone_id)?.name, ...d })));
      }
      if (m == "DELETE" && (r = /^\/workers\/domains\/([0-9a-f]+)$/.exec(rest))) {
        const d = state.domains.find((x) => domainId(x.hostname) == r![1]);
        if (!d) return fail(404, 100114, "Domain not found");
        state.domains = state.domains.filter((x) => x != d);
        return ok(null);
      }
      if (m == "PUT" && rest == "/workers/domains") {
        const d = await body();
        if (!d.hostname || !d.service) return fail(400, 100101, "hostname and service are required");
        if (!state.scripts[d.service]) return fail(400, 100103, `Worker ${d.service} not found`);
        if (!state.zones.some((z) => z.id == d.zone_id && (d.hostname == z.name || d.hostname.endsWith(`.${z.name}`)))) return fail(400, 100117, "Hostname is not in the zone");
        if (state.domains.some((x) => x.hostname == d.hostname && x.service != d.service)) return fail(409, 100116, "Hostname is already in use by another Worker");
        state.domains = state.domains.filter((x) => x.hostname != d.hostname);
        if ((state.dns[d.zone_id] ?? []).some((x) => x.name == d.hostname)) return fail(409, 100117, "Hostname already has externally managed DNS records (A, CNAME, etc). Either delete them, try a different hostname, or use the option 'override_existing_dns_record' to override.");
        state.domains.push({ hostname: d.hostname, service: d.service, zone_id: d.zone_id });
        return ok({ id: domainId(d.hostname), ...d });
      }
      if (m == "GET" && rest.startsWith("/registrar/domain-search?")) {
        const q = (new URLSearchParams(rest.split("?")[1]).get("q") ?? "").replace(/\..*$/, "");
        return ok({ domains: [".com", ".dev", ".app", ".xyz"].map((tld) => ({ name: `${q}${tld}` })) });
      }
      if (m == "POST" && rest == "/registrar/domain-check") {
        const { domains } = await body() as { domains: string[] };
        return ok({ domains: domains.map(check) });
      }
      if (m == "POST" && rest == "/registrar/registrations") {
        const { domain_name } = await body();
        const c = check(domain_name);
        if (!c.registrable) return fail(400, 10500, `${domain_name} is not available`);
        state.registrations.push({ domain: domain_name, price: c.pricing?.registration_cost });
        state.zones.push({ id: `zone${randomHex(14)}`, name: domain_name, status: "active" });
        return ok({ domain_name, state: "succeeded", completed: true, context: { registration: { status: "active" } } }, 201);
      }
      if (m == "GET" && (r = /^\/registrar\/registrations\/([^/]+)\/registration-status$/.exec(rest))) {
        const done = state.registrations.some((x) => x.domain == decodeURIComponent(r![1]));
        return done ? ok({ domain_name: r[1], state: "succeeded", completed: true }) : fail(404, 10404, "no such registration");
      }
    }
    if (m == "GET" && path.startsWith("/zones?")) {
      const name = new URLSearchParams(path.split("?")[1]).get("name");
      const t = token.startsWith("mock-scoped-") ? tokenOf(token) : null;
      const readable = (id: string) => !t || t.policies.some((p) => p.permission_groups.some((g) => GROUPS[g.id] == "Zone Read") && keysOf(p).includes(`com.cloudflare.api.account.zone.${id}`));
      return ok(state.zones.filter((z) => (!name || z.name == name) && readable(z.id)).map((z) => ({ ...z, account: { id: state.account.id, name: state.account.name } })));
    }
    if ((r = /^\/zones\/([^/?]+)(\/[^?]*)(?:\?(.*))?$/.exec(path))) {
      const [, zone, rest, query] = r;
      if (!state.zones.some((z) => z.id == zone)) return fail(404, 1001, "Invalid zone identifier");
      const body = async () => await req.json() as any;
      if (rest == "/dns_records") {
        const list = state.dns[zone] ??= [];
        if (m == "GET") { const p = new URLSearchParams(query); return ok(list.filter((x) => (!p.get("type") || x.type == p.get("type")) && (!p.get("name") || x.name == p.get("name")))); }
        if (m == "POST") { const d = await body(); list.push({ type: d.type, name: d.name, content: d.content, proxied: d.proxied }); return ok(d); }
      }
      if (rest == "/workers/routes") {
        const list = state.routes[zone] ??= [];
        if (m == "GET") return ok(list);
        if (m == "POST") {
          const d = await body();
          list.push({ pattern: d.pattern, script: d.script });
          return ok({ id: randomHex(16), ...d });
        }
      }
      // Every zone's free Universal SSL certificate: the zone and one level down.
      if (rest == "/ssl/certificate_packs" && m == "GET") {
        const name = state.zones.find((z) => z.id == zone)!.name;
        return ok([{ type: "universal", hosts: [name, `*.${name}`], status: "active" }]);
      }
    }
    return fail(404, 7003, `No route for that URI (${m} ${path})`);
  }

  function check(name: string) {
    if (name.includes("taken")) return { name, registrable: false, reason: "domain_unavailable" };
    if (name.endsWith(".xyz")) return { name, registrable: false, reason: "extension_not_supported_via_api" };
    const cost = name.endsWith(".dev") ? "12.18" : "10.44";
    return { name, registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: cost, renewal_cost: cost } };
  }

  /** The few statements the deploy runs, understood well enough to answer them. */
  function d1Query(db: MockState["databases"][number], { sql, params }: { sql: string; params?: unknown[] }): Record<string, unknown>[] {
    db.statements.push(sql.slice(0, 200));
    if (/FROM sqlite_master/i.test(sql)) return db.tables.map((name) => ({ name }));
    if (/^SELECT id FROM documents/i.test(sql.trim())) {
      if (!db.tables.includes("documents")) throw new D1Error("no such table: documents: SQLITE_ERROR");
      return (db.rows ?? []).map((r) => /^INSERT INTO documents \(id[^)]*\) VALUES \('([^']+)'/.exec(r)?.[1]).filter(Boolean).map((id) => ({ id }));
    }
    if (/^SELECT name FROM d1_migrations/i.test(sql.trim())) {
      if (!db.tables.includes("d1_migrations")) throw new D1Error("no such table: d1_migrations: SQLITE_ERROR");
      return db.migrations.map((name) => ({ name }));
    }
    // The API keys, as the deploy keeps a server's own on a new copy.
    const CRED = /^INSERT INTO credentials \(([^)]+)\) VALUES \((.*)\);?$/;
    if (/^SELECT \* FROM credentials/i.test(sql.trim())) {
      if (!db.tables.includes("credentials")) throw new D1Error("no such table: credentials: SQLITE_ERROR");
      return (db.rows ?? []).map((r) => CRED.exec(r)).filter((m) => m != null).map((m) => {
        const values = [...m[2].matchAll(/'((?:[^']|'')*)'|(-?\d+)|NULL/g)].map((v) => (v[1] != null ? v[1].replace(/''/g, "'") : v[2] != null ? Number(v[2]) : null));
        return Object.fromEntries(m[1].split(",").map((c, i) => [c.trim(), values[i]]));
      });
    }
    if (/^DELETE FROM credentials$/i.test(sql.trim())) { db.rows = (db.rows ?? []).filter((r) => !CRED.test(r)); return []; }
    const put = /^INSERT INTO credentials \(([^)]+)\) VALUES \(\?/.exec(sql);
    if (put) {
      const lit = (v: unknown) => (v == null ? "NULL" : typeof v == "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
      (db.rows ??= []).push(`INSERT INTO credentials (${put[1]}) VALUES (${(params ?? []).map(lit).join(", ")});`);
      return [];
    }
    // A statement batch is all or nothing: a CREATE TABLE of one that's there fails the lot, as SQLite would.
    const made = [...sql.matchAll(/CREATE TABLE (IF NOT EXISTS )?(\w+)/gi)];
    const dropped = [...sql.matchAll(/DROP TABLE IF EXISTS (\w+)/gi)].map((m) => m[1]);
    const have = db.tables.filter((t) => !dropped.includes(t));
    for (const m of made) if (!m[1] && have.includes(m[2])) throw new D1Error(`table ${m[2]} already exists: SQLITE_ERROR`);
    db.tables = [...new Set([...have, ...made.map((m) => m[2])])];
    for (const m of sql.matchAll(/INSERT INTO d1_migrations \(name\) VALUES \('([^']+)'\)/g)) db.migrations.push(m[1]);
    return [];
  }

  /** A deployed server: it answers, as the real one would where the pipeline needs it. */
  async function site(req: Request, url: URL): Promise<Response | null> {
    const host = url.hostname;
    if (host == "d1-export.mock") { const sql = exportsAt.get(url.href); return sql == null ? new Response("expired", { status: 403 }) : new Response(sql); }
    if (host == "d1-import.mock" && req.method == "PUT") {
      const sql = await req.text();
      uploads.set(url.pathname.slice(1), sql);
      return new Response(null, { headers: { ETag: `"${createHash("md5").update(sql).digest("hex")}"` } });
    }
    const script = Object.entries(state.scripts).find(([name, s]) =>
      (s.workersDev && state.subdomain && host == `${name}.${state.subdomain}.workers.dev`) || state.domains.some((d) => d.hostname == host && d.service == name));
    if (!script || script[0].endsWith("-pages")) return null;
    const [name, s] = script;
    const own = await opts.sites?.(req, name);
    if (own) return own;
    const text = (n: string) => (s.metadata.bindings ?? []).find((b: any) => b.name == n && b.type == "plain_text")?.text as string | undefined;
    if (url.pathname == "/logo.png") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
    if (url.pathname == "/api/deploys/version") return Response.json({ version: text("ERGA_VERSION") ?? null, target: text("DEPLOY_TARGET") || null });
    // The app's health check: healthy, unless a test says this release isn't (state.unhealthy).
    if (url.pathname == "/api/health") {
      const version = text("ERGA_VERSION") ?? null;
      const bad = !!version && (state.unhealthy ?? []).includes(version);
      return Response.json({ ok: !bad, version, target: text("DEPLOY_TARGET") || null, checks: { db: { ok: true, ms: 1 }, documents: bad ? { ok: false, error: "a document didn't open (the mock says this release is unhealthy)" } : { ok: true, ms: 2 } } }, { status: bad ? 503 : 200 });
    }
    const snap = await snapshotRoutes(req, {
      token: state.secrets[name]?.SNAPSHOT_TOKEN,
      importAllowed: text("SNAPSHOT_IMPORT") == "1" && text("DEPLOY_TARGET") != "production",
      store: (state.docs[name] ??= memoryStore()) as DocStore,
      budget: state.snapshotBudget,
    });
    if (snap) return snap;
    return new Response("Not found", { status: 404 });
  }

  const fetch: Fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (opts.delayMs) await sleep(opts.delayMs);
    // Cloudflare's OAuth: a code (always mock-code) for a grant, a refresh token for a new access token (the refresh token
    // rotated, as Cloudflare's are), and revoke. The access tokens it gives are the mock's full-access ones.
    if (url.origin == "https://dash.cloudflare.com" && url.pathname == "/oauth2/token" && req.method == "POST") {
      const form = new URLSearchParams(await req.text());
      const grant = (scope: string) => {
        const refresh = `mock-refresh-${randomHex(8)}`;
        state.refreshTokens.push(refresh);
        state.oauthGrants++;
        return Response.json({
          access_token: `mock-oauth-${randomHex(8)}`,
          token_type: "bearer",
          expires_in: state.oauthExpiresIn ?? 3600,
          refresh_token: refresh,
          scope,
        });
      };
      if (form.get("grant_type") == "refresh_token") {
        // A test's 429 (Cloudflare's rate limit): once, then the refresh goes as usual.
        if (state.oauthRefreshStatus) { const status = state.oauthRefreshStatus; state.oauthRefreshStatus = undefined; return Response.json({ error: "rate_limited" }, { status }); }
        const old = form.get("refresh_token") ?? "";
        if (!state.refreshTokens.includes(old)) return Response.json({ error: "invalid_grant", error_description: "refresh token revoked or unknown" }, { status: 400 });
        state.refreshTokens = state.refreshTokens.filter((t) => t != old);
        return grant(form.get("scope") || MOCK_OAUTH_SCOPES);
      }
      // mock-code-dead (the tests'): a grant whose access token has expired and whose refresh token Cloudflare no longer
      // takes, as one revoked on the dashboard is: its first use refreshes, and the refresh is refused.
      if (form.get("code") == "mock-code-dead" && form.get("code_verifier"))
        return Response.json({
          access_token: `mock-oauth-${randomHex(8)}`,
          token_type: "bearer",
          expires_in: 0,
          refresh_token: `mock-refresh-dead-${randomHex(8)}`,
          scope: state.oauthScopes || MOCK_OAUTH_SCOPES,
        });
      if (form.get("code") != "mock-code" || !form.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return grant(state.oauthScopes || form.get("scope") || MOCK_OAUTH_SCOPES);
    }
    if (url.origin == "https://dash.cloudflare.com" && url.pathname == "/oauth2/revoke" && req.method == "POST") {
      const form = new URLSearchParams(await req.text());
      state.refreshTokens = state.refreshTokens.filter((t) => t != form.get("token"));
      state.revoked++;
      return new Response(null, { status: 200 });
    }
    if (url.origin == "https://api.cloudflare.com") {
      const path = url.pathname.replace(/^\/client\/v4/, "") + url.search;
      const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
      const upload = path.startsWith("/accounts/") && path.includes("/workers/assets/upload");
      state.calls.push(`${req.method} ${path}`);
      if (!upload && (!token.startsWith("mock-") || state.refusedTokens?.includes(token))) return fail(401, 1000, "Invalid API Token");
      if (token == "mock-slow") await sleep(150);
      return api(req, path, upload ? subFor ?? "" : token);
    }
    return (await site(req, url)) ?? new Response("This mock doesn't know that address", { status: 502 });
  };
  return { fetch, state, tokenValues };
}

class D1Error extends Error {}

/** A Worker's upload as a version of it, and a deployment of that version: `kept` and `deployments` in the state. */
function deployVersion(state: MockState, name: string, script: MockState["scripts"][string]): string {
  const id = uuid();
  (state.kept[name] ??= []).push({ id, script: structuredClone(script) });
  (state.deployments[name] ??= []).unshift({ id: uuid(), created_on: new Date().toISOString(), strategy: "percentage", versions: [{ version_id: id, percentage: 100 }] });
  return id;
}
/** A made-up id in Cloudflare's shape. */
function uuid(): string {
  const h = (n: number) => hex(randomBytes(n));
  return `${h(4)}-${h(2)}-${h(2)}-${h(2)}-${h(6)}`;
}

/** Which deploy step a call belongs to (for mock-fail-<step>). */
function stepOf(method: string, path: string): string {
  if (/^\/accounts\/[^/]+$/.test(path)) return "account";
  if (/\/registrar\/registrations$/.test(path) && method == "POST") return "registration";
  if (/\/d1\/database\/[^/]+\/(export|import)$/.test(path)) return "data";
  if (/\/d1\/database(\?|$)/.test(path) || (method == "DELETE" && /\/d1\/database\/[^/]+$/.test(path))) return "database";
  if (/\/d1\/database\/[^/]+\/query/.test(path)) return "migrations";
  if (/assets/.test(path)) return "assets";
  if (/\/containers\/image-preparations$/.test(path)) return "image";
  if (/\/containers\/applications/.test(path)) return "vms";
  if (/\/workers\/scripts\/[^/]+$/.test(path) && !/-pages$/.test(path) && method == "PUT") return "worker";
  if (/\/workers\/domains|\/workers\/scripts\/[^/]+\/subdomain/.test(path) && !/-pages\/subdomain/.test(path)) return "address";
  if (/\/dns_records|\/workers\/routes|-pages/.test(path)) return "pages";
  return "";
}

/** The Worker's metadata as the mock keeps it: secrets' values left out. */
function redact(meta: Record<string, any>) {
  return { ...meta, bindings: (meta.bindings ?? []).map((b: any) => (b.type == "secret_text" ? { ...b, text: `(${String(b.text).length} characters)` } : b)) };
}

/** A database as D1's export writes it: its tables, its migrations, its rows. */
function dumpOf(db: MockState["databases"][number]): string {
  const lines = ["PRAGMA defer_foreign_keys=TRUE;"];
  for (const t of db.tables) lines.push(t == "d1_migrations" ? "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);" : `CREATE TABLE ${t} (mock);`);
  for (const name of db.migrations) lines.push(`INSERT INTO d1_migrations (name) VALUES ('${name}');`);
  lines.push(...(db.rows ?? []));
  return lines.join("\n") + "\n";
}

/** SQL loaded into a database (D1's import): its tables, migrations and rows, as dumpOf writes them. */
function applySql(db: MockState["databases"][number], sql: string) {
  for (const line of sql.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const made = /^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i.exec(line);
    if (made) { if (db.tables.includes(made[1])) throw new D1Error(`table ${made[1]} already exists`); db.tables.push(made[1]); continue; }
    const mig = /^INSERT INTO d1_migrations \(name\) VALUES \('([^']+)'\)/.exec(line);
    if (mig) { db.migrations.push(mig[1]); continue; }
    if (/^INSERT INTO/i.test(line)) (db.rows ??= []).push(line);
  }
  db.statements.push(`(import of ${sql.length} bytes)`);
}

/** Erga's own account: production as cf deploy left it, the builder, the source (the fleet option). */
function seedFleet(state: MockState) {
  state.account = { id: ACCOUNT_ID, name: "Erga" };
  state.subdomain = "erga";
  state.zones = [{ id: "zone00000000000000000000000e7ga1", name: "erga.dev", status: "active" }, { id: "zone00000000000000000000000e7ga2", name: "erga-pages.dev", status: "active" }, { id: "zone00000000000000000000000e7ga3", name: "erga-pages-staging.dev", status: "active" }];
  const tables = ["d1_migrations", "users", "server_config", "documents", "permissions", "slug_history", "agent_tokens", "token_requests", "admin_keys", "admin_challenges", "admin_log"];
  state.databases.push({
    uuid: PROD_DB, name: "erga", statements: [], tables,
    migrations: ["0001_erga.sql", "0002_delete_docs_after_hours.sql", "0100_tokens.sql", "0110_admin_keys.sql"],
    rows: [
      "INSERT INTO users (login, name) VALUES ('ada', 'Ada');",
      ...PROD_DOCS.map((id, i) => `INSERT INTO documents (id, owner, slug, title) VALUES ('${id}', 'ada', 'doc-${i + 1}', 'Document ${i + 1}');`),
      "INSERT INTO server_config (key, value) VALUES ('deploy_page', '\"admins\"');",
    ],
  });
  const prodBindings = [
    { type: "durable_object_namespace", name: "DOCUMENTS", class_name: "DocumentObject" },
    { type: "d1", name: "DB", database_id: PROD_DB, id: PROD_DB },
    { type: "plain_text", name: "DEPLOY_TARGET", text: "production" },
    { type: "plain_text", name: "ERGA_VERSION", text: "prod00000000" },
  ];
  state.scripts.erga = { metadata: { main_module: "index.js", bindings: prodBindings }, modules: ["index.js"], workersDev: false, tags: [], namespaces: ["DocumentObject", "DocHost", "Deployer", "DocList"] };
  state.secrets.erga = { SESSION_SECRET: "production-session-secret", GITHUB_CLIENT_SECRET: "production-github-secret", SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: MOCK_HOOK_SECRET };
  // The control Worker (control/): the repository, the pipeline, the build container; deployed by deploy/setup.ts.
  // As wrangler deployed it (control/wrangler.jsonc): no ERGA_VERSION until it deploys itself.
  state.scripts["erga-control"] = { metadata: { main_module: "index.js", compatibility_date: "2026-09-30", bindings: [
    { type: "durable_object_namespace", name: "BUILDS", class_name: "Builder" }, { type: "durable_object_namespace", name: "PIPELINE", class_name: "Pipeline" }, { type: "durable_object_namespace", name: "SOURCE", class_name: "SourceHost" }, { type: "durable_object_namespace", name: "DEPLOYS", class_name: "Deployer" },
    { type: "d1", name: "DB", database_id: PROD_DB, id: PROD_DB }, { type: "artifacts", name: "ARTIFACTS", namespace: "erga" }, { type: "version_metadata", name: "CF_VERSION_METADATA" },
    { type: "plain_text", name: "CLOUDFLARE_ACCOUNT_ID", text: FLEET_ACCOUNT }, { type: "plain_text", name: "APP_URL", text: "https://erga.dev" },
  ] }, modules: ["index.js"], workersDev: false, tags: [], namespaces: ["Builder", "Pipeline", "SourceHost", "Deployer"] };
  state.versions = { erga: 1, "erga-control": 1 };
  deployVersion(state, "erga", state.scripts.erga);
  deployVersion(state, "erga-control", state.scripts["erga-control"]);
  state.domains.push({ hostname: "erga.dev", service: "erga", zone_id: state.zones[0].id });
  state.domains.push({ hostname: "ops.erga.dev", service: "erga-control", zone_id: state.zones[0].id });
  state.routes[state.zones[1].id] = [{ pattern: "*.erga-pages.dev/*", script: "erga" }];
  state.dns[state.zones[1].id] = [{ type: "AAAA", name: "*.erga-pages.dev", content: "100::", proxied: true }];
  const docs = memoryStore();
  PROD_DOCS.forEach((id, i) => docs.docs.set(id, {
    entries: new Map<string, unknown>([
      ["meta", { id, owner: "ada", index: "index.html", created: 1_700_000_000_000 + i, modified: 1_700_000_100_000 + i }],
      ["file:index.html", new TextEncoder().encode(`<h1>Document ${i + 1}</h1><p>production's words</p>`)],
      ["state", new Uint8Array([1, 2, 3, i])],
      ...(i == 2 ? [["dir:drafts", true] as [string, unknown]] : []),
    ]),
    alarm: i == 1 ? 1_900_000_000_000 : null,
  }));
  state.docs.erga = docs;
}

/**
 * A pretend builder (control/builder/ is the real one): it "builds" a commit
 * by handing back `release` stamped with the commit, saying what the real
 * one would run. `failNext` fails the next build once, and so does any commit
 * starting 0bad, or that `fails` says should; `built` lists what it built.
 */
export function mockBuilder(release: () => Promise<Release>, o: { delayMs?: number; fails?: (commit: string) => Promise<boolean> } = {}): Builder & { built: string[]; stopped: string[]; failNext: string | null } {
  const b = {
    built: [] as string[],
    failNext: null as string | null,
    /** Builds stopped by their signal (the deploy was cancelled), by commit. */
    stopped: [] as string[],
    async build({ commit, branch, source }: { commit: string; branch: string; source: { cloneUrl: string; token?: string } }, log: (line: string) => void, signal?: AbortSignal): Promise<Release> {
      if (!source.token) throw new Error("no read token for the source");
      log(`fetching ${commit.slice(0, 12)} (${branch}) from ${source.cloneUrl}`);
      for (const step of ["bun install --frozen-lockfile", "bun run build", "bun run release"]) {
        if (o.delayMs) await sleep(o.delayMs);
        if (signal?.aborted) { b.stopped.push(commit); log("the build was stopped"); throw signal.reason; }
        log(`$ ${step}`);
      }
      if (b.failNext) { const why = b.failNext; b.failNext = null; throw new Error(why); }
      // A commit starting 0bad fails to build (the dev server's mock, where failNext can't be reached).
      if (commit.startsWith("0bad") || await o.fails?.(commit)) throw new Error("bun install --frozen-lockfile failed (exit 1): lockfile had changes, but lockfile is frozen");
      b.built.push(commit);
      return { ...(await release()), version: commit.slice(0, 12) };
    },
  };
  return b;
}

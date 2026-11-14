// A pretend Cloudflare, for testing the deploy pipeline without a real account:
// the API calls the deploy makes, Registrar, and the new server itself once it's "deployed"
// (it answers, nothing more). It keeps what it was
// asked to do in `state`, which the tests read.
//
// Its requests and answers follow Cloudflare's OpenAPI schema
// and workers-sdk's deploy: the Worker's
// metadata as a form field, Durable Objects as declarative exports (no
// migration tags), a D1 binding's database_id, assets in buckets of base64
// or one by one (singleAssetUploads, as the upload JWT can ask), D1's
// /query, custom domains, Registrar's workflows. A request the real API
// would refuse, it refuses.
//
// Only the tests use it (and `bun erga deploy` with ERGA_DEPLOY_MOCK=1).
//
// Tokens: any that starts with "mock-" is good; anything else is refused as
// Cloudflare would. Some do more:
//
//   mock-nosub          the account has no workers.dev subdomain yet
//   mock-noperm         the token can't make D1 databases (a permission missing)
//   mock-fail-<step>    Cloudflare fails at that step (account, database, migrations, assets, worker, address, pages)
//   mock-once-<step>    Cloudflare fails at that step the first time only (an install that stops, then goes on with Try again)
//   mock-flaky          the first asset upload fails with a 502 (the deploy tries it again)
//
// Zones, custom domains and Registrar: dev/mock-cloudflare-zones.ts.
//
// With `fleet`, the account is an example instance's, as its deploys
// see it: the zones example.com and example-pages.com, the
// instance's Worker "erga" already there (on example.com
// and *.example-pages.com) with its database "erga" (tables, rows and
// migrations) and three documents in its Durable Objects. D1's export and import work on
// it (the SQL as text), secrets are kept per Worker (keep_bindings, the
// secrets API), and each Worker answers as the real one would where the
// pipeline needs it: /logo.png, /api/deploys/version (its ERGA_VERSION) and
// the snapshot endpoints (document/snapshot.ts, the real handler, over an
// in-memory store of its documents). `failNext` makes the next call of a
// step fail once (state.failNext = "worker"); `onUpload` hears of each
// Worker uploaded.

import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";
import { createHash } from "node:crypto";
import type { Fetch } from "../deploy/pipeline/cloudflare-api";
import { memoryStore, snapshotRoutes, type DocStore } from "../document/snapshot";
import { hex, randomBytes } from "../shared/bytes";
import { accountZones, waitsForCertificate, zones } from "./mock-cloudflare-zones";
import { seedFleet } from "./mock-cloudflare-fleet";
import { applySql, D1Error, d1Query, dumpOf } from "./mock-cloudflare-d1";
import { sleep } from "../shared/time";

export interface MockState {
  account: { id: string; name: string };
  subdomain: string | null;
  /** A pending zone has the name servers Cloudflare gave it, and the ones its registrar has now. */
  zones: { id: string; name: string; status: string; name_servers?: string[]; original_name_servers?: string[] }[];
  databases: { uuid: string; name: string; statements: string[]; migrations: string[]; tables: string[]; rows?: string[] }[];
  scripts: Record<string, { metadata: Record<string, any>; modules: string[]; workersDev: boolean; tags: string[]; namespaces: string[] }>;
  assets: { manifest: Record<string, { hash: string; size: number }>; uploaded: string[] };
  /** Each asset's bytes, by hash (base64), and each Worker's files as its last upload had them (path -> hash): what mockSite serves. */
  blobs: Record<string, string>;
  served: Record<string, Record<string, string>>;
  /** Workers' custom domains; one answers once its certificate is there (readyAt). */
  domains: { hostname: string; service: string; zone_id: string; readyAt?: number }[];
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
  /** R2 buckets, by name (documents' files). */
  buckets?: string[];
  /** Releases (ERGA_VERSION values) whose /api/health answers ok false: a test's broken deploy. */
  unhealthy?: string[];
  /** The next call of this step fails once (a 500), as mock-fail-<step> does for every call. */
  failNext: string | null;
  /** The Workers whose deploy made their homepage project (POST /api/deploys/home), by name. */
  homes?: string[];
}

/** A Worker's tag (its id in GET /workers/scripts): fixed by its name, here. */
export const scriptTag = (name: string) => createHash("md5").update(`script:${name}`).digest("hex");
/** A Durable Object namespace's id: fixed by its Worker and class, here. */
export const namespaceId = (script: string, className: string) => createHash("md5").update(`ns:${script}:${className}`).digest("hex");

export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

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
    if (hash && state.blobs[hash] != null) return { bytes: Result.getOrThrow(Base64.decode(state.blobs[hash])), path: "/" + c };
  }
  return null;
}

/** A JWT-shaped token with these claims (the deploy reads wrangler_single_asset_uploads from the upload one). */
const jwt = (claims: Record<string, unknown>) => `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.mock`;
const UPLOAD = (single: boolean) => jwt({ kind: "upload", ...(single ? { wrangler_single_asset_uploads: true } : {}) });
const COMPLETE = jwt({ kind: "complete" });

/** The example account in the fleet mock (the deploy tests, and `bun erga deploy` with ERGA_DEPLOY_MOCK). */
export const FLEET_ACCOUNT = ACCOUNT_ID;
export const PRIMARY_DB = "0b0d0b0d-0000-4000-8000-00000000e9a0";
/** The example instance's SNAPSHOT_TOKEN in the fleet mock (the tests give its staging instance the same). */
export const MOCK_SNAPSHOT_TOKEN = "mock-snapshot-token-0123456789abcdef0123456789";
/** The example instance's documents in the fleet mock: their ids, and what each holds. */
export const PRIMARY_DOCS = ["abcd2345", "efgh6789", "jkmn2345"];

export function mockCloudflare(
  opts: {
    delayMs?: number;
    singleAssetUploads?: boolean;
    fleet?: boolean;
    onUpload?: (script: string, metadata: Record<string, any>) => void;
    /** A Worker's own answer, before the mock's (the tests route /api/deploys/... to the servers they run). */
    sites?: (req: Request, script: string) => Promise<Response | null> | Response | null;
    /** How long a new custom domain waits for its certificate before it answers (0: at once). */
    certMs?: number;
  } = {}
): { fetch: Fetch; state: MockState } {
  const state: MockState = {
    account: { id: ACCOUNT_ID, name: "Ada's account" },
    subdomain: "ada-mock",
    zones: [
      { id: "zone0000000000000000000000000001", name: "ada-example.com", status: "active" },
      { id: "zone0000000000000000000000000002", name: "ada-pages.net", status: "active" },
    ],
    databases: [],
    scripts: {},
    assets: { manifest: {}, uploaded: [] },
    blobs: {},
    served: {},
    domains: [],
    buckets: [],
    routes: {},
    dns: {},
    registrations: [],
    calls: [],
    revoked: 0,
    secrets: {},
    docs: {},
    versions: {},
    kept: {},
    deployments: {},
    deletedDatabases: [],
    failNext: null,
  };
  // Secrets' values never go out with the state: only the tests read them, in this process.
  Object.defineProperty(state, "secrets", { value: {}, enumerable: false, writable: true });
  if (opts.fleet) seedFleet(state);
  /** D1 exports ready to download, and imports uploaded, by URL. */
  const exportsAt = new Map<string, string>(), uploads = new Map<string, string>();
  const importing = new Map<string, string>();
  let subFor: string | null = null,
    flaked = false,
    onceAt: string | null = null;
  const ok = (result: unknown, status = 200) => Response.json({ success: true, errors: [], messages: [], result }, { status });
  // The assets' upload answers as Cloudflare does: "errors" and "messages" null when there are none (not [] as elsewhere).
  const okAssets = (result: unknown, status = 200) => Response.json({ result, success: true, errors: null, messages: null }, { status });
  const fail = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
  const randomHex = (n: number) => hex(randomBytes(n));
  const answers = { ok, fail, randomHex, certMs: opts.certMs ?? 0 };
  async function api(req: Request, path: string, token: string): Promise<Response> {
    const m = req.method;
    // The account's workers.dev subdomain is set per token the first time it's seen (mock-nosub has none until it makes one).
    if (subFor != token) {
      subFor = token;
      if (token == "mock-nosub") state.subdomain = null;
      onceAt = /^mock-once-(\w+)$/.exec(token)?.[1] ?? null;
    }
    const failAt = /^mock-fail-(\w+)$/.exec(token)?.[1];
    const step = stepOf(m, path);
    if (failAt == "registration" && step == "registration") return fail(400, 10500, "Your account has no default payment method");
    if (failAt && failAt == step) return fail(500, 10013, "An unknown error has occurred");
    // A refusal (400), which the client doesn't try again: the install stops there.
    if (onceAt && onceAt == step) {
      onceAt = null;
      return fail(400, 10021, "The mock refuses this step once");
    }
    if (state.failNext && state.failNext == step) {
      state.failNext = null;
      return fail(500, 10013, "An unknown error has occurred");
    }
    let r: RegExpExecArray | null;
    if (m == "GET" && /^\/accounts(\?|$)/.test(path)) return ok([state.account]);
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
          const query = (await body()) as { sql: string; params?: unknown[] } | { batch: { sql: string; params?: unknown[] }[] };
          // A batch is all or nothing: a statement that fails puts the database back as it was.
          const was = { rows: db.rows && [...db.rows], tables: [...db.tables], migrations: [...db.migrations] };
          try {
            const results = ("batch" in query ? query.batch : [query]).map((one) => ({
              success: true,
              results: d1Query(db, one),
              meta: { served_by_primary: true },
            }));
            return ok(results);
          } catch (e) {
            Object.assign(db, was);
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
        return okAssets({ jwt: buckets.length ? UPLOAD(!!opts.singleAssetUploads) : COMPLETE, buckets });
      }
      if (m == "POST" && rest.startsWith("/workers/assets/upload")) {
        if (req.headers.get("authorization") != `Bearer ${UPLOAD(!!opts.singleAssetUploads)}`) return fail(401, 10001, "Invalid assets upload token");
        if (token == "mock-flaky" && !flaked) { flaked = true; return new Response("Bad gateway", { status: 502 }); }
        const known = (hash: string) => Object.values(state.assets.manifest).some((f) => f.hash == hash);
        const one = /^\/workers\/assets\/upload\/([0-9a-f]{32})$/.exec(rest);
        if (one) {
          if (!opts.singleAssetUploads) return fail(400, 10002, "single asset uploads aren't enabled for this session");
          if (!known(one[1])) return fail(400, 10002, `unexpected ${one[1]}`);
          state.blobs[one[1]] = Base64.encode(new Uint8Array(await req.arrayBuffer()));
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
        return okAssets(all ? { jwt: COMPLETE } : {}, all ? 201 : 202);
      }
      if (m == "PUT" && (r = /^\/workers\/scripts\/([^/]+)$/.exec(rest))) {
        const form = await req.formData();
        const field = form.get("metadata");
        const meta = JSON.parse(typeof field == "string" ? field : await (field as File).text());
        if (meta.assets && meta.assets.jwt != COMPLETE) return fail(400, 10021, "assets jwt isn't a completion token");
        const modules = [...form.keys()].filter((k) => k != "metadata");
        if (!modules.includes(meta.main_module)) return fail(400, 10021, `No such module "${meta.main_module}"`);
        if (meta.migrations && meta.exports) return fail(400, 10021, "migrations and Durable Object exports can't be used together");
        const prev = state.scripts[r[1]];
        // Durable Objects: a namespace per class in exports, made the first time, matched after.
        const namespaces = [...new Set([...(prev?.namespaces ?? []), ...Object.entries(meta.exports ?? {}).filter(([, e]: [string, any]) => e.type == "durable-object" && e.storage == "sqlite").map(([n]) => n)])];
        for (const b of meta.bindings ?? []) {
          if (b.type == "durable_object_namespace" && !b.script_name && !namespaces.includes(b.class_name)) return fail(400, 10061, `Cannot apply binding: no Durable Object namespace for class ${b.class_name}`);
          if (b.type == "d1" && !state.databases.some((d) => d.uuid == b.database_id)) return fail(400, 10021, `binding ${b.name}: no D1 database ${b.database_id ?? "(database_id missing)"}`);
          if ((b.type == "plain_text" || b.type == "secret_text") && typeof b.text != "string") return fail(400, 10021, `binding ${b.name} needs text`);
          if (b.type == "service" && !state.scripts[b.service]) return fail(400, 10143, `service binding ${b.name}: no Worker ${b.service}`);
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
      const zoned = await accountZones(state, answers, m, rest, req);
      if (zoned) return zoned;
    }
    const zoned = await zones(state, answers, m, path, req);
    if (zoned) return zoned;
    return fail(404, 7003, `No route for that URI (${m} ${path})`);
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
    // Before its certificate: no TLS, so no answer at all.
    if (waitsForCertificate(state, host)) throw new TypeError(`fetch failed: ${host} has no certificate yet`);
    const [name, s] = script;
    const own = await opts.sites?.(req, name);
    if (own) return own;
    const text = (n: string) => (s.metadata.bindings ?? []).find((b: any) => b.name == n && b.type == "plain_text")?.text as string | undefined;
    // Sign-in sends a person to GitHub with the Worker's app, as the real server does.
    if (url.pathname == "/auth/github")
      return Response.redirect(
        `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(text("GITHUB_CLIENT_ID") ?? "")}&redirect_uri=${encodeURIComponent(`https://${host}/auth/github/callback`)}`,
        302
      );
    if (url.pathname == "/logo.png") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
    if (url.pathname == "/api/deploys/version") return Response.json({ version: text("ERGA_VERSION") ?? null });
    // The homepage project: made the first time a deploy asks, there from then on.
    if (url.pathname == "/api/deploys/home" && req.method == "POST") {
      const homes = (state.homes ??= []);
      if (homes.includes(name)) return Response.json({ home: "there" });
      homes.push(name);
      return Response.json({ home: "made" });
    }
    // The deploy facts, as the app answers an ops token (any, here).
    if (url.pathname == "/api/ops")
      return Response.json({
        version: text("ERGA_VERSION") ?? null,
        host,
        deploy: JSON.parse(text("ERGA_DEPLOY") || "null"),
      });
    // The app's health check: healthy, unless a test says this release isn't (state.unhealthy).
    if (url.pathname == "/api/health") {
      const version = text("ERGA_VERSION") ?? null;
      const bad = !!version && (state.unhealthy ?? []).includes(version);
      return Response.json(
        {
          ok: !bad,
          version,
          checks: {
            db: { ok: true, ms: 1 },
            documents: bad ? { ok: false, error: "a document didn't open (the mock says this release is unhealthy)" } : { ok: true, ms: 2 },
          },
        },
        { status: bad ? 503 : 200 }
      );
    }
    const snap = await snapshotRoutes(req, {
      token: state.secrets[name]?.SNAPSHOT_TOKEN,
      importAllowed: !!text("SNAPSHOT_FROM"),
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
    if (url.origin == "https://api.cloudflare.com") {
      const path = url.pathname.replace(/^\/client\/v4/, "") + url.search;
      const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
      const upload = path.startsWith("/accounts/") && path.includes("/workers/assets/upload");
      state.calls.push(`${req.method} ${path}`);
      if (!upload && !token.startsWith("mock-")) return fail(401, 1000, "Invalid API Token");
      return api(req, path, upload ? subFor ?? "" : token);
    }
    return (await site(req, url)) ?? new Response("This mock doesn't know that address", { status: 502 });
  };
  return { fetch, state };
}

/** A Worker's upload as a version of it, and a deployment of that version: `kept` and `deployments` in the state. */
export function deployVersion(state: MockState, name: string, script: MockState["scripts"][string]): string {
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
  if (/\/workers\/scripts\/[^/]+$/.test(path) && !/-pages$/.test(path) && method == "PUT") return "worker";
  if (/\/workers\/domains|\/workers\/scripts\/[^/]+\/subdomain/.test(path) && !/-pages\/subdomain/.test(path)) return "address";
  if (/\/dns_records|\/workers\/routes|-pages/.test(path)) return "pages";
  return "";
}

/** The Worker's metadata as the mock keeps it: secrets' values left out. */
function redact(meta: Record<string, any>) {
  return { ...meta, bindings: (meta.bindings ?? []).map((b: any) => (b.type == "secret_text" ? { ...b, text: `(${String(b.text).length} characters)` } : b)) };
}

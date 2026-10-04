// A pretend Cloudflare, for testing the deploy page without a real account:
// the API calls the deploy makes (deploy/cloudflare.ts), Cloudflare's OAuth
// token endpoint, Registrar, and the new server itself once it's "deployed"
// (it answers, nothing more). It keeps what it was
// asked to do in `state`, which the tests read (and the page shows, at
// /deploy/api/mock, in local development with ERGA_DEPLOY_MOCK=1).
//
// Its requests and answers follow Cloudflare's OpenAPI schema
// (github.com/cloudflare/api-schemas) and workers-sdk's deploy: the Worker's
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
//
// Registrar: a name with "taken" in it is taken, ".xyz" can't be registered
// through the API, ".dev" costs 12.18 USD and anything else 10.44.

import type { Fetch } from "./cloudflare";

export interface MockState {
  account: { id: string; name: string };
  subdomain: string | null;
  zones: { id: string; name: string; status: string }[];
  databases: { uuid: string; name: string; statements: string[]; migrations: string[]; tables: string[] }[];
  scripts: Record<string, { metadata: Record<string, any>; modules: string[]; workersDev: boolean; tags: string[]; namespaces: string[] }>;
  assets: { manifest: Record<string, { hash: string; size: number }>; uploaded: string[] };
  domains: { hostname: string; service: string; zone_id: string }[];
  routes: Record<string, { pattern: string; script: string }[]>;
  dns: Record<string, { type: string; name: string; content: string; proxied: boolean }[]>;
  registrations: { domain: string; price?: string }[];
  /** Every call, "METHOD path" (tokens never). */
  calls: string[];
  revoked: number;
}

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

/** A JWT-shaped token with these claims (the deploy reads wrangler_single_asset_uploads from the upload one). */
const jwt = (claims: Record<string, unknown>) => `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.mock`;
const UPLOAD = (single: boolean) => jwt({ kind: "upload", ...(single ? { wrangler_single_asset_uploads: true } : {}) });
const COMPLETE = jwt({ kind: "complete" });

export function mockCloudflare(opts: { delayMs?: number; singleAssetUploads?: boolean } = {}): { fetch: Fetch; state: MockState } {
  const state: MockState = {
    account: { id: ACCOUNT_ID, name: "Ada's account" },
    subdomain: "ada-mock",
    zones: [{ id: "zone0000000000000000000000000001", name: "ada-example.com", status: "active" }, { id: "zone0000000000000000000000000002", name: "ada-pages.net", status: "active" }],
    databases: [], scripts: {}, assets: { manifest: {}, uploaded: [] }, domains: [], routes: {}, dns: {}, registrations: [], calls: [], revoked: 0,
  };
  let subFor: string | null = null, flaked = false;
  const ok = (result: unknown, status = 200) => Response.json({ success: true, errors: [], messages: [], result }, { status });
  const fail = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
  const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

  async function api(req: Request, path: string, token: string): Promise<Response> {
    const m = req.method;
    // The account's workers.dev subdomain is set per token the first time it's seen (mock-nosub has none until it makes one).
    if (subFor != token) { subFor = token; if (token == "mock-nosub") state.subdomain = null; }
    const failAt = /^mock-fail-(\w+)$/.exec(token)?.[1];
    const step = stepOf(m, path);
    if (failAt == "registration" && step == "registration") return fail(400, 10500, "Your account has no default payment method");
    if (failAt && failAt == step) return fail(500, 10013, "An unknown error has occurred");
    let r: RegExpExecArray | null;
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
      if (m == "GET" && rest == "/workers/scripts") return ok(Object.entries(state.scripts).map(([id, s]) => ({ id, tags: s.tags, named_handlers: s.namespaces.map((name) => ({ name, handlers: ["class"] })) })));
      if (rest.startsWith("/d1/database")) {
        if (token == "mock-noperm") return fail(403, 10000, "Authentication error");
        if (m == "GET" && rest.startsWith("/d1/database?")) {
          const name = new URLSearchParams(rest.split("?")[1]).get("name");
          return ok(state.databases.filter((d) => !name || d.name == name).map(({ uuid, name }) => ({ uuid, name })));
        }
        if (m == "POST" && rest == "/d1/database") {
          const { name } = await body();
          if (state.databases.some((d) => d.name == name)) return fail(400, 7502, "A database with that name already exists");
          const db = { uuid: `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`, name, statements: [], migrations: [], tables: [] };
          state.databases.push(db);
          return ok({ uuid: db.uuid, name });
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
          await req.arrayBuffer();
          state.assets.uploaded.push(one[1]);
        } else if (rest == "/workers/assets/upload?base64=true") {
          if (opts.singleAssetUploads) return fail(400, 10002, "this session takes one file at a time");
          const form = await req.formData();
          for (const [hash, value] of form.entries() as Iterable<[string, File | string]>) {
            if (typeof value == "string" || !known(hash)) return fail(400, 10002, `unexpected ${hash}`);
            atob(await value.text());
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
        const prev = state.scripts[r[1]];
        // Durable Objects: a namespace per class in exports, made the first time, matched after.
        const namespaces = [...new Set([...(prev?.namespaces ?? []), ...Object.entries(meta.exports ?? {}).filter(([, e]: [string, any]) => e.type == "durable-object" && e.storage == "sqlite").map(([n]) => n)])];
        for (const b of meta.bindings ?? []) {
          if (b.type == "durable_object_namespace" && !b.script_name && !namespaces.includes(b.class_name)) return fail(400, 10061, `Cannot apply binding: no Durable Object namespace for class ${b.class_name}`);
          if (b.type == "d1" && !state.databases.some((d) => d.uuid == b.database_id)) return fail(400, 10021, `binding ${b.name}: no D1 database ${b.database_id ?? "(database_id missing)"}`);
          if ((b.type == "plain_text" || b.type == "secret_text") && typeof b.text != "string") return fail(400, 10021, `binding ${b.name} needs text`);
          if (b.type == "service" && !state.scripts[b.service]) return fail(400, 10143, `service binding ${b.name}: no Worker ${b.service}`);
        }
        state.scripts[r[1]] = { metadata: redact(meta), modules, workersDev: prev?.workersDev ?? false, tags: meta.tags ?? [], namespaces };
        return ok({ id: r[1], tags: meta.tags ?? [] });
      }
      if (m == "POST" && (r = /^\/workers\/scripts\/([^/]+)\/subdomain$/.exec(rest))) {
        if (!state.scripts[r[1]]) return fail(404, 10007, "script not found");
        state.scripts[r[1]].workersDev = !!(await body()).enabled;
        return ok({ enabled: state.scripts[r[1]].workersDev });
      }
      if (m == "PUT" && rest == "/workers/domains") {
        const d = await body();
        if (!d.hostname || !d.service) return fail(400, 100101, "hostname and service are required");
        if (!state.scripts[d.service]) return fail(400, 100103, `Worker ${d.service} not found`);
        if (!state.zones.some((z) => z.id == d.zone_id && (d.hostname == z.name || d.hostname.endsWith(`.${z.name}`)))) return fail(400, 100117, "Hostname is not in the zone");
        if (state.domains.some((x) => x.hostname == d.hostname && x.service != d.service)) return fail(409, 100116, "Hostname is already in use by another Worker");
        state.domains = state.domains.filter((x) => x.hostname != d.hostname);
        state.domains.push({ hostname: d.hostname, service: d.service, zone_id: d.zone_id });
        return ok(d);
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
        state.zones.push({ id: `zone${hex(14)}`, name: domain_name, status: "active" });
        return ok({ domain_name, state: "succeeded", completed: true, context: { registration: { status: "active" } } }, 201);
      }
      if (m == "GET" && (r = /^\/registrar\/registrations\/([^/]+)\/registration-status$/.exec(rest))) {
        const done = state.registrations.some((x) => x.domain == decodeURIComponent(r![1]));
        return done ? ok({ domain_name: r[1], state: "succeeded", completed: true }) : fail(404, 10404, "no such registration");
      }
    }
    if (m == "GET" && path.startsWith("/zones?")) return ok(state.zones);
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
        if (m == "POST") { const d = await body(); list.push({ pattern: d.pattern, script: d.script }); return ok({ id: hex(16), ...d }); }
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
  function d1Query(db: MockState["databases"][number], { sql }: { sql: string; params?: unknown[] }): Record<string, unknown>[] {
    db.statements.push(sql.slice(0, 200));
    if (/FROM sqlite_master/i.test(sql)) return db.tables.map((name) => ({ name }));
    if (/^SELECT name FROM d1_migrations/i.test(sql.trim())) {
      if (!db.tables.includes("d1_migrations")) throw new D1Error("no such table: d1_migrations: SQLITE_ERROR");
      return db.migrations.map((name) => ({ name }));
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

  /** The new server, once deployed: it answers. */
  async function site(_req: Request, url: URL): Promise<Response | null> {
    const host = url.hostname;
    const script = Object.entries(state.scripts).find(([name, s]) =>
      (s.workersDev && state.subdomain && host == `${name}.${state.subdomain}.workers.dev`) || state.domains.some((d) => d.hostname == host && d.service == name));
    if (!script || script[0].endsWith("-pages")) return null;
    if (url.pathname == "/style.css") return new Response("/* mock */", { headers: { "Content-Type": "text/css" } });
    return new Response("Not found", { status: 404 });
  }

  const fetch: Fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (url.origin == "https://dash.cloudflare.com" && url.pathname == "/oauth2/token" && req.method == "POST") {
      const form = new URLSearchParams(await req.text());
      if (form.get("code") != "mock-code" || !form.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: `mock-oauth-${hex(8)}`, token_type: "bearer", expires_in: 3600, scope: form.get("scope") ?? "" });
    }
    if (url.origin == "https://dash.cloudflare.com" && url.pathname == "/oauth2/revoke" && req.method == "POST") { state.revoked++; return new Response(null, { status: 200 }); }
    if (url.origin == "https://api.cloudflare.com") {
      const path = url.pathname.replace(/^\/client\/v4/, "") + url.search;
      const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
      const upload = path.startsWith("/accounts/") && path.includes("/workers/assets/upload");
      state.calls.push(`${req.method} ${path}`);
      if (!upload && !token.startsWith("mock-")) return fail(401, 1000, "Invalid API Token");
      if (token == "mock-slow") await new Promise((r) => setTimeout(r, 150));
      return api(req, path, upload ? subFor ?? "" : token);
    }
    return (await site(req, url)) ?? new Response("This mock doesn't know that address", { status: 502 });
  };
  return { fetch, state };
}

class D1Error extends Error {}

/** Which deploy step a call belongs to (for mock-fail-<step>). */
function stepOf(method: string, path: string): string {
  if (/^\/accounts\/[^/]+$/.test(path)) return "account";
  if (/\/registrar\/registrations$/.test(path) && method == "POST") return "registration";
  if (/\/d1\/database(\?|$)/.test(path)) return "database";
  if (/\/d1\/database\/[^/]+\/query/.test(path)) return "migrations";
  if (/assets/.test(path)) return "assets";
  if (/\/workers\/scripts\/[^/-]+$/.test(path) && method == "PUT") return "worker";
  if (/\/workers\/domains|\/workers\/scripts\/[^/-]+\/subdomain/.test(path)) return "address";
  if (/\/dns_records|\/workers\/routes|-pages/.test(path)) return "pages";
  return "";
}

/** The Worker's metadata as the mock keeps it: secrets' values left out. */
function redact(meta: Record<string, any>) {
  return { ...meta, bindings: (meta.bindings ?? []).map((b: any) => (b.type == "secret_text" ? { ...b, text: `(${String(b.text).length} characters)` } : b)) };
}

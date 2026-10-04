// A pretend Cloudflare, for testing the deploy page without a real account:
// the API calls the deploy makes (deploy/cloudflare.ts), Cloudflare's OAuth
// token endpoint, Registrar, and the new server itself once it's "deployed"
// (enough of Erga's API for publishing the front page). It keeps what it was
// asked to do in `state`, which the tests read (and the page shows, at
// /deploy/api/mock, in local development with ERGA_DEPLOY_MOCK=1).
//
// Tokens: any that starts with "mock-" is good; anything else is refused as
// Cloudflare would. Some do more:
//
//   mock-nosub          the account has no workers.dev subdomain yet
//   mock-noperm         the token can't make D1 databases (a permission missing)
//   mock-fail-<step>    Cloudflare fails at that step (account, database, migrations, assets, worker, address, pages)
//   mock-slow           each call takes a little while (to watch the steps go by)
//
// Registrar: a name with "taken" in it is taken, ".xyz" can't be registered
// through the API, ".dev" costs 12.18 USD and anything else 10.44.

import type { Fetch } from "./cloudflare";

export interface MockState {
  account: { id: string; name: string };
  subdomain: string | null;
  zones: { id: string; name: string; status: string }[];
  databases: { uuid: string; name: string; statements: string[]; migrations: string[]; tokens: { id: string; hash: string; login: string }[] }[];
  scripts: Record<string, { metadata: Record<string, any>; modules: string[]; workersDev: boolean; migrationTag?: string }>;
  assets: { manifest: Record<string, { hash: string; size: number }>; uploaded: string[] };
  domains: { hostname: string; service: string; zone_id: string }[];
  routes: Record<string, { pattern: string; script: string }[]>;
  dns: Record<string, { type: string; name: string; content: string; proxied: boolean }[]>;
  registrations: { domain: string; price?: string }[];
  /** The front page as published to the "new server": its path and the documents published there. */
  published: { slug: string; files: string[]; landing: boolean }[];
  /** Every call, "METHOD path" (tokens never). */
  calls: string[];
  revoked: number;
}

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

export function mockCloudflare(opts: { delayMs?: number } = {}): { fetch: Fetch; state: MockState } {
  const state: MockState = {
    account: { id: ACCOUNT_ID, name: "Ada's account" },
    subdomain: "ada-mock",
    zones: [{ id: "zone0000000000000000000000000001", name: "ada-example.com", status: "active" }, { id: "zone0000000000000000000000000002", name: "ada-pages.net", status: "active" }],
    databases: [], scripts: {}, assets: { manifest: {}, uploaded: [] }, domains: [], routes: {}, dns: {}, registrations: [], published: [], calls: [], revoked: 0,
  };
  let subFor: string | null = null;
  const ok = (result: unknown, status = 200) => Response.json({ success: true, errors: [], messages: [], result }, { status });
  const fail = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
  const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

  async function api(req: Request, path: string, token: string): Promise<Response> {
    const m = req.method;
    // The account's workers.dev subdomain is set per token the first time it's seen (mock-nosub has none until it makes one).
    if (subFor != token) { subFor = token; if (token == "mock-nosub") state.subdomain = null; }
    const failAt = /^mock-fail-(\w+)$/.exec(token)?.[1];
    const step = stepOf(m, path);
    if (failAt && failAt == step) return fail(500, 10013, "An unknown error has occurred");
    let r: RegExpExecArray | null;
    if (m == "GET" && path == "/accounts") return ok([state.account]);
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
      if (m == "GET" && rest == "/workers/scripts") return ok(Object.entries(state.scripts).map(([id, s]) => ({ id, migration_tag: s.migrationTag })));
      if (rest.startsWith("/d1/database")) {
        if (token == "mock-noperm") return fail(403, 10000, "Authentication error");
        if (m == "GET" && rest.startsWith("/d1/database?")) {
          const name = new URLSearchParams(rest.split("?")[1]).get("name");
          return ok(state.databases.filter((d) => !name || d.name == name).map(({ uuid, name }) => ({ uuid, name })));
        }
        if (m == "POST" && rest == "/d1/database") {
          const { name } = await body();
          const db = { uuid: `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`, name, statements: [], migrations: [], tokens: [] };
          state.databases.push(db);
          return ok({ uuid: db.uuid, name });
        }
        const q = /^\/d1\/database\/([^/]+)\/query$/.exec(rest);
        const db = q && state.databases.find((d) => d.uuid == q[1]);
        if (m == "POST" && db) return ok([{ success: true, results: d1Query(db, (await body()) as { sql: string; params?: unknown[] }), meta: {} }]);
      }
      if (m == "POST" && (r = /^\/workers\/scripts\/([^/]+)\/assets-upload-session$/.exec(rest))) {
        const { manifest } = await body();
        state.assets.manifest = manifest;
        const missing = Object.values(manifest as Record<string, { hash: string }>).map((f) => f.hash).filter((h) => !state.assets.uploaded.includes(h));
        const buckets: string[][] = [];
        for (let i = 0; i < missing.length; i += 10) buckets.push(missing.slice(i, i + 10));
        return ok({ jwt: buckets.length ? "mock-upload-jwt" : "mock-complete-jwt", buckets });
      }
      if (m == "POST" && rest == "/workers/assets/upload?base64=true") {
        if (req.headers.get("authorization") != "Bearer mock-upload-jwt") return fail(401, 10001, "Bad upload token");
        const form = await req.formData();
        for (const [hash, value] of form.entries() as Iterable<[string, File | string]>) {
          if (typeof value == "string" || !Object.values(state.assets.manifest).some((f) => f.hash == hash)) return fail(400, 10002, `unexpected ${hash}`);
          atob(await value.text());
          state.assets.uploaded.push(hash);
        }
        const all = Object.values(state.assets.manifest).every((f) => state.assets.uploaded.includes(f.hash));
        return ok(all ? { jwt: "mock-complete-jwt" } : {}, all ? 201 : 200);
      }
      if (m == "PUT" && (r = /^\/workers\/scripts\/([^/]+)$/.exec(rest))) {
        const form = await req.formData();
        const meta = JSON.parse(await (form.get("metadata") as File).text());
        if (meta.assets && meta.assets.jwt != "mock-complete-jwt") return fail(400, 10021, "assets jwt isn't a completion token");
        const modules = [...form.keys()].filter((k) => k != "metadata");
        if (!modules.includes(meta.main_module)) return fail(400, 10021, "No such module: main_module");
        const prev = state.scripts[r[1]];
        if (meta.migrations && prev?.migrationTag && meta.migrations.old_tag != prev.migrationTag) return fail(400, 10079, "migration tag precondition failed");
        state.scripts[r[1]] = { metadata: redact(meta), modules, workersDev: prev?.workersDev ?? false, migrationTag: meta.migrations?.new_tag ?? prev?.migrationTag };
        return ok({ id: r[1] });
      }
      if (m == "POST" && (r = /^\/workers\/scripts\/([^/]+)\/subdomain$/.exec(rest))) {
        if (!state.scripts[r[1]]) return fail(404, 10007, "script not found");
        state.scripts[r[1]].workersDev = !!(await body()).enabled;
        return ok({ enabled: state.scripts[r[1]].workersDev });
      }
      if (m == "PUT" && rest == "/workers/domains") {
        const d = await body();
        if (!state.zones.some((z) => z.id == d.zone_id)) return fail(400, 100117, "zone not found");
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
  function d1Query(db: MockState["databases"][number], { sql, params = [] }: { sql: string; params?: unknown[] }): Record<string, unknown>[] {
    db.statements.push(sql.slice(0, 200));
    if (/^SELECT name FROM d1_migrations/i.test(sql.trim())) return db.migrations.map((name) => ({ name }));
    for (const m of sql.matchAll(/INSERT INTO d1_migrations \(name\) VALUES \('([^']+)'\)/g)) db.migrations.push(m[1]);
    if (/^INSERT INTO agent_tokens/i.test(sql.trim())) db.tokens.push({ id: String(params[0]), hash: String(params[1]), login: String(params[2]) });
    if (/^DELETE FROM agent_tokens/i.test(sql.trim())) db.tokens = db.tokens.filter((t) => !params.includes(t.id));
    return [];
  }

  /** The new server, once deployed: its files, and enough of Erga's API to publish the front page. */
  async function site(req: Request, url: URL): Promise<Response | null> {
    const host = url.hostname;
    const script = Object.entries(state.scripts).find(([name, s]) =>
      (s.workersDev && state.subdomain && host == `${name}.${state.subdomain}.workers.dev`) || state.domains.some((d) => d.hostname == host && d.service == name));
    if (!script || script[0].endsWith("-pages")) return null;
    if (url.pathname == "/style.css") return new Response("/* mock */", { headers: { "Content-Type": "text/css" } });
    const db = state.databases.find((d) => d.uuid == script[1].metadata.bindings?.find((b: any) => b.type == "d1")?.id);
    const bearer = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))), (b) => b.toString(16).padStart(2, "0")).join("");
    const who = db?.tokens.find((t) => t.hash == hash);
    if (!who) return Response.json({ ok: false, error: "Missing or unknown token" }, { status: 401 });
    const tool = (v: unknown) => Response.json({ ok: true, content: [{ type: "text", text: JSON.stringify(v) }] });
    const body = await req.json().catch(() => ({})) as any;
    if (url.pathname == "/api/ext/tools/list_settings") return tool([{ key: "landing_document", value: state.published.find((p) => p.landing) ? "mockdoc1" : null, locked: false }]);
    if (url.pathname == "/api/ext/tools/whoami") return tool({ login: who.login });
    if (url.pathname == "/api/ext/tools/set_setting") { const p = state.published.at(-1); if (p) p.landing = body.value == "mockdoc1"; return tool({ ok: true }); }
    if (url.pathname == "/api/publish") {
      if (body.document) return Response.json({ ok: false, error: "No such document" }, { status: 404 });
      state.published.push({ slug: body.slug, files: Object.keys(body.files ?? {}), landing: false });
      return Response.json({ ok: true, id: "mockdoc1", url: `${url.origin}/${who.login}/${body.slug}`, address: `/${who.login}/${body.slug}` });
    }
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

/** Which deploy step a call belongs to (for mock-fail-<step>). */
function stepOf(method: string, path: string): string {
  if (/^\/accounts\/[^/]+$/.test(path)) return "account";
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

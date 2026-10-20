// Publishing a document to a domain in the person's own Cloudflare account:
// the consent (its start, its callback, a refused scope), the grant kept
// sealed and bound to its person, its refresh and revoke, hostnames checked
// against their zones, the site's files, and a deploy and a take-down against
// the pretend Cloudflare.
// In the browser: e2e/full/versions/site.e2e.ts.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Cloudflare } from "../deploy/pipeline.ts";
import { mockCloudflare, mockSite } from "../deploy/mock-cloudflare.ts";
import { Directory, type Param, type Sql } from "../server/directory/index.ts";
import type { Platform } from "../server/platform.ts";
import { type CfZone, checkHostname, cloudflareAuth, deploySite, listAccounts, listZones, removeSite, scriptName, siteCloudflare, SITE_OAUTH_SCOPES, SiteError, siteFiles, type SiteOAuth, type SiteOps, type SiteRow } from "../server/sites/index.ts";

const MIGRATIONS = new URL("../server/migrations/", import.meta.url).pathname;
const TOKEN = "mock-" + "t".repeat(36) + "Cf12";

function fresh(secret: string | null = "the factory key") {
  const db = new Database(":memory:", { strict: true });
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  const sql: Sql = {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
  return { db, dir: new Directory(sql, { admins: ["ada"], credentialSecret: secret }) };
}

const ORIGIN = "https://erga.test";
/** Why the callback didn't connect, as it tells the page it goes back to. */
const errorOf = (r: Response) => new URL(r.headers.get("location")!, ORIGIN).searchParams.get("cloudflare_error") ?? "";

/** A server with the pretend Cloudflare: the directory, the site ops, and who's signed in (a header says). */
function server(secret: string | null = "the factory key") {
  const { db, dir } = fresh(secret);
  const cf = mockCloudflare();
  cf.state.oauthScopes = SITE_OAUTH_SCOPES;
  const oauth: SiteOAuth = { clientId: "mock", net: cf.fetch, authorize: `${ORIGIN}/auth/cloudflare/mock/consent` };
  const ops: SiteOps = { net: () => cf.fetch, oauth, status: async () => ({ state: "idle", at: null, scheduledFor: null, version: null, error: null, by: null }), deploy: async () => { throw new Error("no deploys here"); }, remove: async () => null };
  const platform = {
    directory: dir,
    sites: () => ops,
    sessionOf: async (r: Request) => { const login = r.headers.get("x-login"); return login ? { login, name: login } : null; },
  } as unknown as Platform;
  /** A request as `login`'s browser sends it, with the cookies it holds. */
  const jar: Record<string, string> = {};
  const get = async (path: string, login = "ada") => {
    const r = await cloudflareAuth(new Request(ORIGIN + path, { headers: { "x-login": login, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") } }), platform);
    for (const c of r.headers.getSetCookie()) { const [kv, ...attrs] = c.split("; "); const [k, v] = kv.split("="); if (attrs.some((a) => a == "Max-Age=0")) delete jar[k]; else jar[k] = v; }
    return r;
  };
  /** The consent, through to the callback: Cloudflare's answer is `answer` (code=mock-code, or error=...). */
  const consent = async (answer: Record<string, string> = { code: "mock-code" }, start = "/auth/cloudflare/start?return=%2Fada%2Fnotes%23edit") => {
    const to = new URL((await get(start)).headers.get("location")!);
    return get(`/auth/cloudflare/callback?${new URLSearchParams({ ...answer, state: to.searchParams.get("state")! })}`);
  };
  return { db, dir, cf, oauth, ops, platform, get, jar, consent };
}

test("Connect Cloudflare goes to Cloudflare's consent page: Erga's client, PKCE (S256), a site's scopes only, and the state in a short cookie", async () => {
  const s = server();
  const r = await s.get("/auth/cloudflare/start?return=%2Fada%2Fnotes%23edit&popup=1");
  expect(r.status).toBe(302);
  const to = new URL(r.headers.get("location")!);
  expect(to.origin + to.pathname).toBe(`${ORIGIN}/auth/cloudflare/mock/consent`);
  expect(Object.fromEntries(to.searchParams)).toMatchObject({ response_type: "code", client_id: "mock", redirect_uri: `${ORIGIN}/auth/cloudflare/callback`, scope: SITE_OAUTH_SCOPES, code_challenge_method: "S256" });
  expect(SITE_OAUTH_SCOPES.split(" ").sort()).toEqual(["account-settings.read", "offline_access", "workers-routes.write", "workers-scripts.admin", "zone.read"]);
  expect(to.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
  expect(r.headers.get("set-cookie")).toMatch(/^erga_cf_consent=[\w-]+; Path=\/auth\/cloudflare; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
  // Not signed in: sign in first, then back here.
  const anon = await cloudflareAuth(new Request(`${ORIGIN}/auth/cloudflare/start`), s.platform);
  expect(anon.headers.get("location")).toStartWith("/auth/github?next=");
  // A return address elsewhere is not followed.
  await s.consent({ code: "mock-code" }, "/auth/cloudflare/start?return=https%3A%2F%2Fevil.example%2F");
  expect(s.cf.state.oauthGrants).toBe(1);
});

test("the callback exchanges the code, keeps the grant sealed for its person, reads the accounts, and goes back to the document", async () => {
  const s = server();
  const r = await s.consent();
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toBe("/ada/notes?cloudflare=connected#edit");
  expect(s.jar.erga_cf_consent).toBeUndefined();
  const info = await s.dir.cloudflare.info("Ada");
  expect(info).toMatchObject({ connected: true, accounts: [{ id: s.cf.state.account.id, name: "Ada's account" }], error: null, canStore: true, unreadable: false });
  const token = (await s.dir.cloudflare.token("ada", s.oauth))!;
  expect(token).toStartWith("mock-oauth-");
  // The tokens aren't in the row as they are.
  const row = JSON.stringify(s.db.query("SELECT * FROM cloudflare_grants").all());
  expect(row).not.toContain(token);
  expect(row).not.toContain(s.cf.state.refreshTokens[0]);
  // The row moved to another person doesn't open, nor under another server's key (staging's copy of production's rows).
  s.db.query(`INSERT INTO cloudflare_grants (login, "grant", accounts, updated) SELECT 'bo', "grant", accounts, updated FROM cloudflare_grants WHERE login = 'ada'`).run();
  expect(await s.dir.cloudflare.token("bo", s.oauth)).toBeNull();
  expect((await s.dir.cloudflare.info("bo")).unreadable).toBe(true);
  const other = new Directory((s.dir as unknown as { sql: Sql }).sql, { credentialSecret: "another key" });
  expect(await other.cloudflare.token("ada", s.oauth)).toBeNull();
  // The zones, with the grant.
  expect((await listZones(token, s.cf.fetch, info.accounts)).map((z) => z.name)).toEqual(["ada-example.com", "ada-pages.net"]);
});

test("in a popup, the callback's page tells the document's settings and closes", async () => {
  const s = server();
  const r = await s.consent({ code: "mock-code" }, "/auth/cloudflare/start?popup=1&return=%2Fada%2Fnotes");
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toContain(`new BroadcastChannel("erga-cloudflare").postMessage(m)`);
  expect(html).toContain(`"type":"erga-cloudflare","ok":true,"accounts":"Ada's account"`);
  expect(html).toContain("window.close()");
});

test("a refused consent, a scope taken out, or a callback that didn't start here keeps nothing", async () => {
  const s = server();
  // The person cancels on Cloudflare's page.
  let r = await s.consent({ error: "access_denied" });
  expect(errorOf(r)).toContain("You didn't authorize Erga on Cloudflare");
  // Cloudflare refuses the request itself (a scope the client doesn't allow): its words are shown.
  r = await s.consent({ error: "invalid_scope", error_description: "The requested scope is invalid: dns.edit" });
  expect(errorOf(r)).toBe("Cloudflare didn't authorize Erga: The requested scope is invalid: dns.edit");
  // The grant lacks a scope a site needs (an optional one left out): it is revoked at once, and nothing is kept.
  s.cf.state.oauthScopes = "account-settings.read workers-scripts.admin zone.read offline_access";
  const revoked = s.cf.state.revoked;
  r = await s.consent();
  expect(errorOf(r)).toContain("workers-routes.write is missing");
  expect(s.cf.state.revoked).toBe(revoked + 1);
  expect(s.cf.state.refreshTokens).toEqual([]);
  expect((await s.dir.cloudflare.info("ada")).connected).toBe(false);
  s.cf.state.oauthScopes = SITE_OAUTH_SCOPES;
  // A callback with another state, or for another person than who started it.
  await s.get("/auth/cloudflare/start");
  r = await s.get("/auth/cloudflare/callback?code=mock-code&state=forged");
  expect(errorOf(r)).toContain("didn't start here");
  const to = new URL((await s.get("/auth/cloudflare/start")).headers.get("location")!);
  r = await s.get(`/auth/cloudflare/callback?code=mock-code&state=${to.searchParams.get("state")}`, "mallory");
  expect(errorOf(r)).toContain("signed in as someone else");
  expect(s.cf.state.oauthGrants).toBe(1);
  expect(await s.dir.cloudflare.token("ada", s.oauth)).toBeNull();
});

test("the access token is refreshed before it expires (the refresh token rotated); a refused refresh is said, and Disconnect revokes", async () => {
  const s = server();
  s.cf.state.oauthExpiresIn = 60;
  await s.consent();
  const first = s.cf.state.refreshTokens[0];
  // Less than ten minutes left: two callers at once share one refresh.
  const [a, b] = await Promise.all([s.dir.cloudflare.token("ada", s.oauth), s.dir.cloudflare.token("ada", s.oauth)]);
  expect(a).toBe(b!);
  expect(s.cf.state.oauthGrants).toBe(2);
  expect(s.cf.state.refreshTokens).not.toContain(first);
  expect(s.cf.state.refreshTokens).toHaveLength(1);
  // Revoked on Cloudflare's dashboard: the next refresh is refused, and the connection says so.
  s.cf.state.refreshTokens = [];
  expect(s.dir.cloudflare.token("ada", s.oauth)).rejects.toThrow(/ada's Cloudflare connection stopped working \(400 invalid_grant/);
  await Bun.sleep(0);
  expect(await s.dir.cloudflare.info("ada")).toMatchObject({ connected: false, error: expect.stringContaining("invalid_grant") });
  // Connect again, then Disconnect: revoked on Cloudflare, and forgotten.
  await s.consent();
  const revoked = s.cf.state.revoked;
  await s.dir.cloudflare.disconnect("ada", s.oauth);
  expect(s.cf.state.revoked).toBe(revoked + 1);
  expect(s.cf.state.refreshTokens).toEqual([]);
  expect(await s.dir.cloudflare.info("ada")).toMatchObject({ connected: false, accounts: [] });
});

test("a grant without a scope publishing needs now says to connect again, and Cloudflare's refusal says the same", async () => {
  const s = server();
  await s.consent();
  // A grant made when the consent asked for workers-scripts.edit (Workers Editor: it can't create a Worker).
  s.db.query(`UPDATE cloudflare_grants SET "grant" = json_set("grant", '$.scopes', json('["account-settings.read","workers-scripts.edit","workers-routes.write","zone.read"]'))`).run();
  expect(await s.dir.cloudflare.info("ada")).toMatchObject({ connected: false, error: "it doesn't allow workers-scripts.admin, which publishing needs now" });
  const refused = (async () => Response.json({ success: false, errors: [{ code: 10000, message: "No access to the specified resource." }] }, { status: 403 })) as typeof fetch;
  const e = await siteCloudflare("mock-x", refused).call("POST", "/accounts/a/workers/scripts/w/assets-upload-session", "start uploading the site's files", {}).catch((x) => x);
  expect(e.message).toBe("Your Cloudflare connection isn't allowed to start uploading the site's files. Connect Cloudflare again, and allow everything Erga asks for. (Cloudflare said: No access to the specified resource. [code 10000])");
  expect(e.message).not.toContain("token");
});

test("a new consent revokes the person's old grant first (Cloudflare's page fails while an older one is active)", async () => {
  const s = server();
  await s.consent();
  const old = s.cf.state.refreshTokens[0];
  const revoked = s.cf.state.revoked;
  await s.get("/auth/cloudflare/start");
  expect(s.cf.state.revoked).toBe(revoked + 1);
  expect(s.cf.state.refreshTokens).not.toContain(old);
  expect((await s.dir.cloudflare.info("ada")).updated).toBeNull();
  expect((await s.consent()).headers.get("location")).toContain("cloudflare=connected");
});

test("without a FACTORY_KEY, the server keeps no grant", async () => {
  const s = server(null);
  const r = await s.consent();
  expect(errorOf(r)).toContain("no FACTORY_KEY");
  // The grant Cloudflare gave anyway is revoked at once.
  expect(s.cf.state.refreshTokens).toEqual([]);
  expect((await s.dir.cloudflare.info("ada")).canStore).toBe(false);
});

const ZONES: CfZone[] = [
  { id: "z1", name: "example.com", account: { id: "acc1", name: "Ada" } },
  { id: "z2", name: "blog.example.com", account: { id: "acc1", name: "Ada" } },
  { id: "z3", name: "ada.dev", account: { id: "acc2", name: "Ada's other" } },
];

test("a hostname is tidied and found on the longest zone that ends it", () => {
  expect(checkHostname(" https://Notes.Example.com./x ", ZONES)).toMatchObject({ hostname: "notes.example.com", zone: { id: "z1" } });
  expect(checkHostname("www.blog.example.com", ZONES).zone.id).toBe("z2");
  expect(checkHostname("ada.dev", ZONES).zone.account.id).toBe("acc2");
  expect(() => checkHostname("notes.elsewhere.org", ZONES)).toThrow(/isn't on a domain your Cloudflare connection reaches. Your domains: example.com/);
  expect(() => checkHostname("bad_name.example.com", ZONES)).toThrow(/isn't a hostname/);
  expect(() => checkHostname("", ZONES)).toThrow(/Type the address/);
  expect(() => checkHostname("x.example.com", [])).toThrow(/has no domains/);
});

test("one site for each document, and one document for each hostname", async () => {
  const { dir } = fresh();
  const site = { hostname: "notes.example.com", zoneId: "z1", zoneName: "example.com", accountId: "acc1", script: scriptName("abcd2345", "Field notes!"), login: "Ada" };
  expect(site.script).toBe("erga-field-notes-abcd2345");
  await dir.sites.add({ docId: "abcd2345", ...site });
  expect(await dir.sites.get("abcd2345")).toMatchObject({ hostname: "notes.example.com", login: "ada" });
  expect(dir.sites.add({ docId: "efgh6789", ...site })).rejects.toThrow(/already shows another document/);
  expect(dir.sites.add({ docId: "abcd2345", ...site, hostname: "other.example.com" })).rejects.toThrow(/already at notes.example.com/);
  expect((await dir.sites.list("ada")).map((s) => s.docId)).toEqual(["abcd2345"]);
  await dir.sites.remove("abcd2345");
  expect(await dir.sites.get("abcd2345")).toBeNull();
});

test("the site's files: as they are, the page also at index.html", () => {
  const html = siteFiles("home.html", { "home.html": "<h1>Hi</h1>", "style.css": "h1{}", "img/a.png": new Uint8Array([1, 2]) });
  expect(Object.keys(html).sort()).toEqual(["/home.html", "/img/a.png", "/index.html", "/style.css"]);
  expect(new TextDecoder().decode(html["/index.html"])).toBe("<h1>Hi</h1>");
  expect(() => siteFiles("gone.html", {})).toThrow(/isn't in its files/);
});

test("a deploy puts the files up as a Worker on the hostname, again only what changed, and a take-down removes both", async () => {
  const cf = mockCloudflare();
  const accounts = await listAccounts(TOKEN, cf.fetch);
  expect(accounts).toEqual([{ id: cf.state.account.id, name: "Ada's account" }]);
  const zones = await listZones(TOKEN, cf.fetch, accounts);
  expect(zones.map((z) => z.name)).toEqual(["ada-example.com", "ada-pages.net"]);
  const zone = zones[0];
  const site: SiteRow = { docId: "abcd2345", hostname: `notes.${zone.name}`, zoneId: zone.id, zoneName: zone.name, accountId: zone.account.id, script: "erga-notes-abcd2345", login: "ada", created: 0, createdVia: null };
  const api = new Cloudflare(TOKEN, cf.fetch);
  const url = await deploySite(api, site, siteFiles("index.html", { "index.html": "<h1>Draft 1</h1>", "about.html": "<p>About</p>" }), "https://erga.dev/ada/notes");
  expect(url).toBe("https://notes.ada-example.com/");
  expect(cf.state.domains).toEqual([{ hostname: site.hostname, service: site.script, zone_id: zone.id }]);
  expect(cf.state.scripts[site.script].metadata).toMatchObject({ main_module: "site.js", bindings: [{ type: "assets", name: "ASSETS" }], tags: ["erga-site"] });
  const read = (path: string) => { const f = mockSite(cf.state, site.hostname, path); return f && new TextDecoder().decode(f.bytes); };
  expect(read("/")).toBe("<h1>Draft 1</h1>");
  expect(read("/about")).toBe("<p>About</p>");
  // A new version: only the page that changed goes up.
  const before = cf.state.assets.uploaded.length;
  await deploySite(api, site, siteFiles("index.html", { "index.html": "<h1>Draft 2</h1>", "about.html": "<p>About</p>" }), "https://erga.dev/ada/notes");
  expect(cf.state.assets.uploaded.length - before).toBe(1);
  expect(read("/")).toBe("<h1>Draft 2</h1>");
  // The custom domain was put on once, by the first deploy.
  expect(cf.state.calls.filter((c) => c == "PUT /accounts/" + zone.account.id + "/workers/domains")).toHaveLength(1);
  await removeSite(api, site);
  expect(cf.state.domains).toEqual([]);
  expect(cf.state.scripts[site.script]).toBeUndefined();
  // Already gone: fine.
  await removeSite(api, site);
});

test("a hostname with a DNS record of its own is refused, saying what to do", async () => {
  const cf = mockCloudflare();
  const zone = (await listZones(TOKEN, cf.fetch, []))[0];
  (cf.state.dns[zone.id] ??= []).push({ type: "A", name: `www.${zone.name}`, content: "192.0.2.1", proxied: true });
  const site: SiteRow = { docId: "abcd2345", hostname: `www.${zone.name}`, zoneId: zone.id, zoneName: zone.name, accountId: zone.account.id, script: "erga-www-abcd2345", login: "ada", created: 0, createdVia: null };
  const e = await deploySite(new Cloudflare(TOKEN, cf.fetch), site, { "/index.html": new TextEncoder().encode("x") }, "").catch((x) => x);
  expect(e).toBeInstanceOf(SiteError);
  expect(e.message).toContain("already has a DNS record in Cloudflare");
  expect(e.message).toContain("Delete that record in Cloudflare");
});

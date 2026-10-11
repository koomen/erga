// Publishing a document to a domain in the person's own Cloudflare account:
// the token kept encrypted and bound to its
// person, hostnames checked against their zones, the site's files, and a
// deploy and a take-down against the pretend Cloudflare.
// In the browser: e2e/full/versions/site.e2e.ts.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Cloudflare } from "../deploy/pipeline.ts";
import { mockCloudflare, mockSite } from "../deploy/mock-cloudflare.ts";
import { Directory, type Param, type Sql } from "../server/directory.ts";
import { deploySite, listZones, removeSite, siteFiles, verifyToken } from "../server/site-publish.ts";
import { checkHostname, scriptName, SiteError, type CfZone, type SiteRow } from "../server/sites.ts";

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

test("a token is kept encrypted, shown only by its last four characters, and opens only for its own person", async () => {
  const { db, dir } = fresh();
  const info = await dir.cloudflare.save("Ada", TOKEN, [{ id: "acc1", name: "Ada's account" }]);
  expect(info).toMatchObject({ connected: true, last4: "Cf12", accounts: [{ id: "acc1", name: "Ada's account" }], canStore: true, unreadable: false });
  expect(JSON.stringify(db.query("SELECT * FROM cloudflare_connections").all())).not.toContain(TOKEN.slice(5, 30));
  expect(await dir.cloudflare.token("ada")).toBe(TOKEN);
  // The row moved to another person doesn't open: the login is the additional data.
  db.query("INSERT INTO cloudflare_connections (login, iv, data, last4, accounts, updated) SELECT 'bo', iv, data, last4, accounts, updated FROM cloudflare_connections WHERE login = 'ada'").run();
  expect(await dir.cloudflare.token("bo")).toBeNull();
  expect((await dir.cloudflare.info("bo")).unreadable).toBe(true);
  // Under another server's key (staging's copy of production's rows), it doesn't open either.
  const other = new Directory((dir as unknown as { sql: Sql }).sql, { credentialSecret: "another key" });
  expect(await other.cloudflare.token("ada")).toBeNull();
  await dir.cloudflare.remove("ada");
  expect((await dir.cloudflare.info("ada")).connected).toBe(false);
  // No secret to encrypt with: nothing is kept.
  expect(fresh(null).dir.cloudflare.save("ada", TOKEN, [])).rejects.toBeInstanceOf(SiteError);
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
  expect(() => checkHostname("notes.elsewhere.org", ZONES)).toThrow(/isn't on a domain your Cloudflare token reaches. Your domains: example.com/);
  expect(() => checkHostname("bad_name.example.com", ZONES)).toThrow(/isn't a hostname/);
  expect(() => checkHostname("", ZONES)).toThrow(/Type the address/);
  expect(() => checkHostname("x.example.com", [])).toThrow(/reaches no domains/);
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

test("the site's files: HTML as it is, Markdown as a readable page, the page also at index.html", async () => {
  const html = await siteFiles("home.html", { "home.html": "<h1>Hi</h1>", "style.css": "h1{}", "img/a.png": new Uint8Array([1, 2]) }, "Hi");
  expect(Object.keys(html).sort()).toEqual(["/home.html", "/img/a.png", "/index.html", "/style.css"]);
  expect(new TextDecoder().decode(html["/index.html"])).toBe("<h1>Hi</h1>");
  const md = await siteFiles("index.md", { "index.md": "# Field notes\n\nSome *words*.\n", "more/page.md": "# Page two\n" }, "My notes");
  expect(Object.keys(md).sort()).toEqual(["/index.html", "/more/page.html"]);
  const page = new TextDecoder().decode(md["/index.html"]);
  expect(page).toContain("<title>My notes</title>");
  expect(page).toContain("<em>words</em>");
  expect(page).not.toContain("data-erga-id");
  expect(new TextDecoder().decode(md["/more/page.html"])).toContain("<title>Page two</title>");
  expect(siteFiles("gone.html", {}, "x")).rejects.toThrow(/isn't in its published version/);
});

test("a deploy puts the files up as a Worker on the hostname, again only what changed, and a take-down removes both", async () => {
  const cf = mockCloudflare();
  const accounts = await verifyToken(TOKEN, cf.fetch);
  expect(accounts).toEqual([{ id: cf.state.account.id, name: "Ada's account" }]);
  const zones = await listZones(TOKEN, cf.fetch, accounts);
  expect(zones.map((z) => z.name)).toEqual(["ada-example.com", "ada-pages.net"]);
  const zone = zones[0];
  const site: SiteRow = { docId: "abcd2345", hostname: `notes.${zone.name}`, zoneId: zone.id, zoneName: zone.name, accountId: zone.account.id, script: "erga-notes-abcd2345", login: "ada", created: 0, createdVia: null };
  const api = new Cloudflare(TOKEN, cf.fetch);
  const url = await deploySite(api, site, await siteFiles("index.html", { "index.html": "<h1>Draft 1</h1>", "about.html": "<p>About</p>" }, "Notes"), "https://erga.dev/ada/notes");
  expect(url).toBe("https://notes.ada-example.com/");
  expect(cf.state.domains).toEqual([{ hostname: site.hostname, service: site.script, zone_id: zone.id }]);
  expect(cf.state.scripts[site.script].metadata).toMatchObject({ main_module: "site.js", bindings: [{ type: "assets", name: "ASSETS" }], tags: ["erga-site"] });
  const read = (path: string) => { const f = mockSite(cf.state, site.hostname, path); return f && new TextDecoder().decode(f.bytes); };
  expect(read("/")).toBe("<h1>Draft 1</h1>");
  expect(read("/about")).toBe("<p>About</p>");
  // A new published version: only the page that changed goes up.
  const before = cf.state.assets.uploaded.length;
  await deploySite(api, site, await siteFiles("index.html", { "index.html": "<h1>Draft 2</h1>", "about.html": "<p>About</p>" }, "Notes"), "https://erga.dev/ada/notes");
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

test("a token that isn't one is refused before Cloudflare is asked", async () => {
  const cf = mockCloudflare();
  expect(verifyToken("not a token", cf.fetch)).rejects.toThrow(/doesn't look like a Cloudflare API token/);
  expect(cf.state.calls).toEqual([]);
});

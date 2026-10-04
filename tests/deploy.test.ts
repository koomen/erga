// The deploy page's deploy (deploy/cloudflare.ts), against the pretend
// Cloudflare (deploy/mock.ts), with the release this checkout builds
// (deploy/release.ts, made here if there's none): every step, what it asks
// Cloudflare for, a second deploy, what it refuses, its errors, buying a
// domain, and the pieces around it (sealing the token, the token link, the
// shared pages host).

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  assetHash, checkPlan, Cloudflare, deploy, DeployError, loadRelease, registerDomain, searchDomains, STEPS, tokenTemplateUrl,
  type DeployPlan, type Release,
} from "../deploy/cloudflare";
import { mockCloudflare } from "../deploy/mock";
import { open, seal } from "../deploy/seal";
import { pagesHost, pagesOrigin, pagesToken, type Platform } from "../front";

const ROOT = new URL("..", import.meta.url).pathname;
const ACC = "0123456789abcdef0123456789abcdef";
let release: Release;

beforeAll(async () => {
  const dir = join(ROOT, ".site/release");
  if (!existsSync(join(dir, "release.json"))) {
    if (!existsSync(join(ROOT, ".site/page.js"))) expect(Bun.spawnSync([join(ROOT, "site.sh")], { cwd: ROOT }).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", join(ROOT, "deploy/release.ts")], { cwd: ROOT }).exitCode).toBe(0);
  }
  release = (await loadRelease(async (p) => (existsSync(join(dir, p)) ? new Uint8Array(readFileSync(join(dir, p))) : null)))!;
}, 120_000);

const plan = (over: Partial<DeployPlan> = {}): DeployPlan => ({
  accountId: ACC, workerName: "erga", subdomain: "ada-mock", app: { kind: "workers.dev" }, pages: { kind: "shared" },
  admin: "Ada", githubClientId: "Ov23liMockClientId", githubClientSecret: "0123456789abcdef0123456789abcdef01234567", ...over,
});

async function run(token: string, p: DeployPlan, mock = mockCloudflare()) {
  const steps: string[] = [];
  const result = await deploy(new Cloudflare(token, mock.fetch), release, p, {
    sessionSecret: "a-secret-for-the-new-server-0123456789", site: mock.fetch, sleep: async () => {}, waitMs: 1000,
    report: (id, status, detail) => steps.push(`${id}:${status}${detail ? ` ${detail}` : ""}`),
  });
  return { result, steps, state: mock.state, mock };
}

describe("deploying", () => {
  test("the release is erga.dev's own build", () => {
    expect(release.worker.name).toBe("erga");
    expect(release.modules[release.mainModule]).toBeDefined();
    expect(Object.keys(release.assets)).toContain("/page.js");
    expect(Object.keys(release.assets)).toContain("/editor.html");
    expect(Object.keys(release.assets).some((p) => p.startsWith("/release"))).toBe(false);
    expect(Object.keys(release.migrations)[0]).toBe("0001_erga.sql");
  });

  test("to workers.dev, with the shared pages host: every step, and what Cloudflare was asked for", async () => {
    const { result, steps, state } = await run("mock-token", plan());
    expect(steps.filter((s) => s.endsWith(":running")).map((s) => s.split(":")[0])).toEqual(STEPS.map((s) => s.id));
    expect(steps.filter((s) => /:(done|skipped)/.test(s)).length).toBe(STEPS.length);
    expect(result.url).toBe("https://erga.ada-mock.workers.dev");
    expect(result.pages).toBe("erga-pages.ada-mock.workers.dev");

    const [db] = state.databases;
    expect(db.name).toBe("erga");
    expect(db.migrations).toEqual(Object.keys(release.migrations).sort());
    expect(Object.keys(state.assets.manifest).sort()).toEqual(Object.keys(release.assets).sort());
    expect(new Set(state.assets.uploaded).size).toBe(new Set(Object.values(state.assets.manifest).map((f) => f.hash)).size);

    const worker = state.scripts.erga;
    expect(worker.workersDev).toBe(true);
    expect(worker.modules.sort()).toEqual(Object.keys(release.modules).sort());
    const b = Object.fromEntries(worker.metadata.bindings.map((x: any) => [x.name, x]));
    expect(b.DOCS).toMatchObject({ type: "durable_object_namespace", class_name: "DocHost" });
    expect(b.DEPLOYS).toMatchObject({ type: "durable_object_namespace", class_name: "Deployer" });
    expect(b.HOME).toMatchObject({ type: "durable_object_namespace", class_name: "Home" });
    expect(b.DB).toMatchObject({ type: "d1", database_id: db.uuid });
    expect(b.ASSETS.type).toBe("assets");
    expect(b.ADMINS).toMatchObject({ type: "plain_text", text: "ada" });
    expect(b.GITHUB_CLIENT_ID.text).toBe("Ov23liMockClientId");
    expect(b.SERVER_CONFIG.text).toBe("{}");
    expect(b.SESSION_SECRET.type).toBe("secret_text");
    expect(b.GITHUB_CLIENT_SECRET.type).toBe("secret_text");
    expect(b.ANTHROPIC_API_KEY).toBeUndefined();
    expect(b.PAGES_HOST.text).toBe("erga-pages.ada-mock.workers.dev");
    // Durable Objects as declarative exports (as cf deploy sends them), never migrations; erga.dev's DocList tombstone left out.
    expect(worker.metadata.exports).toEqual({ DocHost: { type: "durable-object", storage: "sqlite" }, Deployer: { type: "durable-object", storage: "sqlite" }, Pipeline: { type: "durable-object", storage: "sqlite" }, Home: { type: "durable-object", storage: "sqlite" } });
    // Not one of Erga's own branch-deploy targets, and no secrets kept from before: its own, new.
    expect(b.DEPLOY_TARGET.text).toBe("");
    expect(worker.metadata.keep_bindings).toBeUndefined();
    expect(worker.metadata.migrations).toBeUndefined();
    expect(worker.tags).toEqual(["erga-deploy"]);
    expect(worker.metadata.assets.config).toEqual({ html_handling: "none", not_found_handling: "none", run_worker_first: true });
    expect(worker.metadata.compatibility_flags).toContain("nodejs_compat");

    expect(state.scripts["erga-pages"].workersDev).toBe(true);
    expect(state.scripts["erga-pages"].metadata.bindings).toEqual([{ type: "service", name: "APP", service: "erga" }]);
  });

  test("to a domain of yours, with documents' pages on a second one", async () => {
    const { result, state } = await run("mock-token", plan({
      app: { kind: "domain", zoneId: "zone0000000000000000000000000001", zoneName: "ada-example.com", hostname: "erga.ada-example.com" },
      pages: { kind: "zone", zoneId: "zone0000000000000000000000000002", zoneName: "ada-pages.net" },
      anthropicKey: "sk-ant-mock",
    }));
    expect(result.url).toBe("https://erga.ada-example.com");
    expect(state.domains).toEqual([{ hostname: "erga.ada-example.com", service: "erga", zone_id: "zone0000000000000000000000000001" }]);
    expect(state.dns.zone0000000000000000000000000002).toEqual([{ type: "AAAA", name: "*.ada-pages.net", content: "100::", proxied: true }]);
    expect(state.routes.zone0000000000000000000000000002).toEqual([{ pattern: "*.ada-pages.net/*", script: "erga" }]);
    const b = Object.fromEntries(state.scripts.erga.metadata.bindings.map((x: any) => [x.name, x]));
    expect(b.PAGES_DOMAIN.text).toBe("ada-pages.net");
    expect(b.PAGES_HOST).toBeUndefined();
    expect(b.ANTHROPIC_API_KEY.type).toBe("secret_text");
    expect(state.scripts.erga.workersDev).toBe(false);
    expect(state.scripts["erga-pages"]).toBeUndefined();
  });

  test("again: the same database, nothing to migrate, no Durable Object migration, no files re-sent", async () => {
    const mock = mockCloudflare();
    await run("mock-token", plan(), mock);
    const uploaded = mock.state.assets.uploaded.length;
    const { steps, state } = await run("mock-token", plan(), mock);
    expect(state.databases.length).toBe(1);
    expect(steps).toContain("migrations:done already up to date");
    expect(steps.find((s) => s.startsWith("database:done"))).toContain("from before");
    expect(state.scripts.erga.metadata.exports.DocHost).toEqual({ type: "durable-object", storage: "sqlite" });
    expect(state.assets.uploaded.length).toBe(uploaded);
  });

  test("makes the workers.dev subdomain when the account has none", async () => {
    const { state, result } = await run("mock-nosub", plan({ subdomain: "ada-new", createSubdomain: true }));
    expect(state.subdomain).toBe("ada-new");
    expect(result.url).toBe("https://erga.ada-new.workers.dev");
  });

  test("refuses to touch a database called erga that isn't Erga's", async () => {
    const mock = mockCloudflare();
    mock.state.databases.push({ uuid: "11111111-2222-3333-4444-555555555555", name: "erga", statements: [], migrations: [], tables: ["notes"] });
    await expect(run("mock-token", plan(), mock)).rejects.toThrow(/already has a D1 database called "erga" that isn't Erga's/);
    expect(mock.state.scripts.erga).toBeUndefined();
  });

  test("refuses to overwrite a Worker called erga that isn't Erga", async () => {
    const mock = mockCloudflare();
    mock.state.scripts.erga = { metadata: {}, modules: ["index.js"], workersDev: true, tags: [], namespaces: [] };
    await expect(run("mock-token", plan(), mock)).rejects.toThrow(/already has a Worker called erga that isn't Erga/);
  });

  test("a deploy that stopped part way runs again from the top, and finishes", async () => {
    const mock = mockCloudflare();
    // Stopped after making the database, before its tables (a run whose migration failed): the empty database is reused.
    mock.state.databases.push({ uuid: "11111111-2222-3333-4444-555555555555", name: "erga", statements: [], migrations: [], tables: [] });
    await expect(run("mock-fail-worker", plan(), mock)).rejects.toThrow(/Cloudflare had a problem on its side while we tried to upload the Worker \(Cloudflare said: An unknown error has occurred \[code 10013\]\)/);
    const { result, state } = await run("mock-token", plan(), mock);
    expect(result.url).toBe("https://erga.ada-mock.workers.dev");
    expect(state.databases.length).toBe(1);
    expect(state.databases[0].migrations).toEqual(Object.keys(release.migrations).sort());
    // And once more, over the finished one: nothing breaks.
    await run("mock-token", plan(), mock);
  });

  test("a failed asset upload is tried again", async () => {
    const { state } = await run("mock-flaky", plan());
    expect(state.scripts.erga).toBeDefined();
  }, 20_000);

  test("assets one by one, when the upload token asks for it", async () => {
    const { state } = await run("mock-token", plan(), mockCloudflare({ singleAssetUploads: true }));
    expect(new Set(state.assets.uploaded).size).toBe(new Set(Object.values(state.assets.manifest).map((f) => f.hash)).size);
    expect(state.calls.some((c) => /\/workers\/assets\/upload\/[0-9a-f]{32}$/.test(c))).toBe(true);
  });

  test("says what went wrong, plainly", async () => {
    await expect(run("not-a-mock-token", plan())).rejects.toThrow(/didn't accept the token when we tried to read your account/);
    await expect(run("mock-noperm", plan())).rejects.toThrow(/isn't allowed to list your D1 databases\. Make a new token with the link.*Authentication error \[code 10000\]/);
    await expect(run("mock-fail-assets", plan())).rejects.toThrow(/Cloudflare had a problem on its side while we tried to start uploading the editor's files \(Cloudflare said: An unknown error has occurred \[code 10013\]\)/);
    await expect(run("mock-token", plan({ subdomain: "someone-else" }))).rejects.toThrow(/Your workers.dev subdomain is ada-mock/);
  });

  test("checks a plan before it starts", () => {
    expect(checkPlan(plan())).toBeNull();
    expect(checkPlan(plan({ githubClientSecret: "short" }))).toMatch(/client secret/);
    expect(checkPlan(plan({ app: { kind: "domain", zoneId: "z1", zoneName: "a.com", hostname: "erga.b.com" } }))).toMatch(/must be a.com or a name under it/);
    expect(checkPlan(plan({ app: { kind: "domain", zoneId: "z1", zoneName: "a.com", hostname: "a.com" }, pages: { kind: "zone", zoneId: "z1", zoneName: "a.com" } }))).toMatch(/different domain/);
    expect(checkPlan(plan({ anthropicKey: "nope" }))).toMatch(/starts with sk-/);
  });
});

describe("buying a domain", () => {
  test("search gives availability and prices; buying needs the price confirmed", async () => {
    const mock = mockCloudflare();
    const cf = new Cloudflare("mock-token", mock.fetch);
    const offers = await searchDomains(cf, ACC, "myerga");
    expect(offers.map((o) => o.name)).toEqual(["myerga.com", "myerga.dev", "myerga.app", "myerga.xyz"]);
    expect(offers[0]).toMatchObject({ registrable: true, price: "10.44", renewal: "10.44", currency: "USD" });
    expect(offers[3]).toMatchObject({ registrable: false, reason: expect.stringContaining("can't be registered through the API") });
    await expect(registerDomain(cf, ACC, "myerga.dev", { price: "10.44", currency: "USD" })).rejects.toThrow(/now costs 12.18 USD, not the 10.44 USD you confirmed\. Nothing was bought/);
    expect(mock.state.registrations).toEqual([]);
    await expect(registerDomain(cf, ACC, "taken.com", { price: "10.44", currency: "USD" })).rejects.toThrow(/can't be registered now: already taken/);
    expect(await registerDomain(cf, ACC, "myerga.dev", { price: "12.18", currency: "USD" })).toEqual({ state: "succeeded", completed: true });
    expect(mock.state.registrations).toEqual([{ domain: "myerga.dev", price: "12.18" }]);
    expect(mock.state.zones.some((z) => z.name == "myerga.dev")).toBe(true);
    // Cloudflare's own refusal, in its words.
    await expect(registerDomain(new Cloudflare("mock-fail-registration", mock.fetch), ACC, "other.com", { price: "10.44", currency: "USD" })).rejects.toThrow(/Cloudflare refused to register other.com: Your account has no default payment method \[code 10500\]/);
  });
});

describe("around it", () => {
  test("the token is sealed, and only its key opens it", async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const other = key.slice(0, -2) + (key.endsWith("AA") ? "BB" : "AA");
    const sealed = await seal("cf-token-secret", key);
    expect(JSON.stringify(sealed)).not.toContain("cf-token-secret");
    expect(await open(sealed, key)).toBe("cf-token-secret");
    await expect(open(sealed, other)).rejects.toThrow();
  });

  test("the token link asks for exactly the deploy's permissions", () => {
    const url = new URL(tokenTemplateUrl(false));
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys")!)).toEqual([
      { key: "account_settings", type: "read" }, { key: "workers_scripts", type: "edit" }, { key: "d1", type: "edit" },
      { key: "workers_routes", type: "edit" }, { key: "zone", type: "read" }, { key: "dns", type: "edit" },
    ]);
    expect(url.searchParams.get("accountId")).toBe("*");
    expect(JSON.parse(new URL(tokenTemplateUrl(true)).searchParams.get("permissionGroupKeys")!).at(-1)).toEqual({ key: "registrar_domains", type: "edit" });
  });

  test("assets are hashed as Cloudflare's direct upload takes them", async () => {
    const h = await assetHash("/a.css", new TextEncoder().encode("body{}"));
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    const expected = new Bun.CryptoHasher("sha256").update(btoa("body{}") + "css").digest("hex").slice(0, 32);
    expect(h).toBe(expected);
  });

  test("a shared pages host finds the document by its token", async () => {
    const platform = { pagesDomain: () => "erga-pages.dev", pagesShared: () => "erga-pages.ada.workers.dev" } as unknown as Platform;
    const app = new URL("https://erga.ada.workers.dev/ada/notes#edit");
    expect(pagesOrigin("Ada", "abcd2345", app, platform)).toBe("https://erga-pages.ada.workers.dev");
    const token = await pagesToken("secret", "Ada", "abcd2345", app.origin);
    expect(pagesHost(new URL(`https://erga-pages.ada.workers.dev/t/${token}/doc/index.html`), platform)).toEqual({ owner: "ada", id: "abcd2345" });
    expect(pagesHost(new URL("https://erga-pages.ada.workers.dev/t/garbage/"), platform)).toBeNull();
    expect(pagesHost(new URL(`https://erga.ada.workers.dev/t/${token}/`), platform)).toBeNull();
    // Without a shared host, as erga.dev: an origin each.
    const own = { pagesDomain: () => "erga-pages.dev" } as unknown as Platform;
    expect(pagesOrigin("Ada", "abcd2345", app, own)).toBe("https://abcd2345-ada.erga-pages.dev");
    expect(pagesHost(new URL("https://abcd2345-ada.erga-pages.dev/t/x/"), own)).toEqual({ owner: "ada", id: "abcd2345" });
  });

  test("DeployError carries Cloudflare's status", () => {
    expect(new DeployError("x", 403).status).toBe(403);
  });
});

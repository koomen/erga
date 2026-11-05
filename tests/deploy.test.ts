// The deploy pipeline on a new server in someone's own account (as `bun erga own` deploys one), against the pretend
// Cloudflare, with the release this checkout builds (deploy/release.ts, made here if there's none): every step, what
// it asks Cloudflare for, a second deploy, what it refuses, its errors, and the pieces around it (the assets' hash,
// the shared pages host).

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { assetHash, HEADERS_FILE } from "../deploy/pipeline/account";
import { Cloudflare, DeployError } from "../deploy/pipeline/cloudflare-api";
import { runPipeline, STEPS, type Target } from "../deploy/pipeline/pipeline";
import { loadRelease, type Release } from "../deploy/pipeline/release-format";
import { mockCloudflare } from "../dev/mock-cloudflare";
import { HEADERS } from "../client/build.ts";
import { ASSET_PREFIX, type AssetManifest } from "../shared/assets.ts";
import { pagesHost, pagesOrigin, pagesToken } from "../server/documents/index.ts";
import type { Platform } from "../server/platform";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const ROOT = new URL("..", import.meta.url).pathname;
const ACC = "0123456789abcdef0123456789abcdef";
let release: Release;

/**
 * Whether .build/release is this checkout's: built from HEAD, with no edits since to what this test checks (the Worker's
 * config and Durable Objects, the migrations). One left from before a rebase or a commit is not.
 */
function current(dir: string): boolean {
  if (!existsSync(join(dir, "release.json"))) return false;
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: ROOT })
      .stdout.toString()
      .trim();
  const built = (JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as { version: string }).version;
  return (
    built == git("rev-parse", "--short", "HEAD").slice(0, 12) &&
    !git("status", "--porcelain", "--", "cloudflare.config.ts", "cloudflare", "server/migrations", "deploy")
  );
}

beforeAll(async () => {
  const dir = join(ROOT, ".build/release");
  if (!current(dir)) {
    if (!existsSync(join(ROOT, ".build/manifest.json"))) expect(Bun.spawnSync(["bun", join(ROOT, "client/build.ts")], { cwd: ROOT }).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", join(ROOT, "deploy/release.ts")], { cwd: ROOT }).exitCode).toBe(0);
  }
  release = (await loadRelease(async (p) => (existsSync(join(dir, p)) ? new Uint8Array(readFileSync(join(dir, p))) : null)))!;
}, 120_000);

/** A new server in the account: on workers.dev, its pages on the shared host, Ada its admin, its own new secret. */
const plan = (over: Partial<Target> = {}): Target => ({
  label: ACC,
  accountId: ACC,
  workerName: "erga",
  databaseName: "erga",
  subdomain: "ada-mock",
  app: { kind: "workers.dev" },
  pages: { kind: "shared" },
  vars: { GITHUB_CLIENT_ID: "", SERVER_CONFIG: "{}", DEPLOY_TARGET: "" },
  secrets: { SESSION_SECRET: "a-secret-for-the-new-server-0123456789" },
  ...over,
});

async function run(token: string, t: Target, mock = mockCloudflare()) {
  const steps: string[] = [];
  const result = await runPipeline(new Cloudflare(token, mock.fetch), release, t, {
    site: mock.fetch,
    sleep: async () => {},
    waitMs: 1000,
    report: (id, status, detail) => steps.push(`${id}:${status}${detail ? ` ${detail}` : ""}`),
  });
  return { result, steps, state: mock.state, mock };
}

describe("deploying", () => {
  test("the release is erga.dev's own build", () => {
    expect(release.worker.name).toBe("erga");
    expect(release.modules[release.mainModule]).toBeDefined();
    // The client's build (client/build.ts): its files by their hashes, the list of them, and their headers.
    expect(Object.keys(release.assets)).toContain("/manifest.json");
    expect(Object.keys(release.assets)).toContain(HEADERS_FILE);
    const built = JSON.parse(new TextDecoder().decode(release.assets["/manifest.json"])) as AssetManifest;
    for (const name of ["page.js", "frame.js", "editor.html", "style.css"]) expect(Object.keys(release.assets)).toContain(built.files[name]);
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
    // Every file, but the headers, which go in the Worker's config.
    expect(Object.keys(state.assets.manifest).sort()).toEqual(Object.keys(release.assets).filter((p) => p != HEADERS_FILE).sort());
    expect(new Set(state.assets.uploaded).size).toBe(new Set(Object.values(state.assets.manifest).map((f) => f.hash)).size);

    const worker = state.scripts.erga;
    expect(worker.workersDev).toBe(true);
    expect(worker.modules.sort()).toEqual(Object.keys(release.modules).sort());
    const b = Object.fromEntries(worker.metadata.bindings.map((x: any) => [x.name, x]));
    expect(b.DOCUMENTS).toMatchObject({ type: "durable_object_namespace", class_name: "DocumentObject" });
    expect(b.HOME).toMatchObject({ type: "durable_object_namespace", class_name: "Home" });
    expect(b.DB).toMatchObject({ type: "d1", database_id: db.uuid });
    expect(b.ASSETS.type).toBe("assets");
    expect(b.GITHUB_CLIENT_ID.text).toBe("");
    expect(b.SERVER_CONFIG.text).toBe("{}");
    expect(b.SESSION_SECRET.type).toBe("secret_text");
    expect(b.GITHUB_CLIENT_SECRET).toBeUndefined();
    expect(b.ANTHROPIC_API_KEY).toBeUndefined();
    expect(b.PAGES_HOST.text).toBe("erga-pages.ada-mock.workers.dev");
    // Durable Objects as declarative exports (as cf deploy sends them), never migrations; erga.dev's tombstones (DocList, Factory,
    // FactoryVm, SiteHost, Deployer, SourceHost and Pipeline) left out.
    expect(worker.metadata.exports).toEqual({
      DocumentObject: { type: "durable-object", storage: "sqlite" },
      OwnStorage: { type: "durable-object", storage: "sqlite" },
      NewsHub: { type: "durable-object", storage: "sqlite" },
      Home: { type: "durable-object", storage: "sqlite" },
      PersonAgent: { type: "durable-object", storage: "sqlite" },
    });
    // Not one of Erga's own branch-deploy targets, and no secrets kept from before: its own, new.
    expect(b.DEPLOY_TARGET.text).toBe("");
    expect(worker.metadata.keep_bindings).toBeUndefined();
    expect(worker.metadata.migrations).toBeUndefined();
    expect(worker.tags).toEqual(["erga-deploy"]);
    // The Worker runs first for everything but the hashed files, which Cloudflare serves with the build's headers.
    expect(worker.metadata.assets.config).toEqual({ html_handling: "none", not_found_handling: "none", run_worker_first: ["/*", `!${ASSET_PREFIX}*`], _headers: HEADERS });
    expect(worker.metadata.compatibility_flags).toContain("nodejs_compat");

    expect(state.scripts["erga-pages"].workersDev).toBe(true);
    expect(state.scripts["erga-pages"].metadata.bindings).toEqual([{ type: "service", name: "APP", service: "erga" }]);
  });

  test("to a domain of yours, with documents' pages on a second one", async () => {
    const { result, state } = await run("mock-token", plan({
      app: { kind: "domain", zoneId: "zone0000000000000000000000000001", zoneName: "ada-example.com", hostname: "erga.ada-example.com" },
      pages: { kind: "zone", zoneId: "zone0000000000000000000000000002", zoneName: "ada-pages.net" },
      secrets: { SESSION_SECRET: "a-secret-for-the-new-server-0123456789", ANTHROPIC_API_KEY: "sk-ant-mock" },
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
    expect(steps.find((s) => s.startsWith("migrations:done"))).toMatch(/^migrations:done already up to date; restore point: version [0-9a-f]{8} \(release \w+\), database bookmark \S+$/);
    expect(steps.find((s) => s.startsWith("database:done"))).toContain("from before");
    expect(state.scripts.erga.metadata.exports.DocumentObject).toEqual({ type: "durable-object", storage: "sqlite" });
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
    await expect(run("not-a-mock-token", plan())).rejects.toThrow(/didn't accept the credential when it tried to read your account/);
    await expect(run("mock-noperm", plan())).rejects.toThrow(
      /isn't allowed to list your D1 databases: the token doesn't have that permission\..*Authentication error \[code 10000\]/
    );
    await expect(run("mock-fail-assets", plan())).rejects.toThrow(
      /Cloudflare had a problem on its side while we tried to start uploading the editor's files \(Cloudflare said: An unknown error has occurred \[code 10013\]\)/
    );
    await expect(run("mock-token", plan({ subdomain: "someone-else" }))).rejects.toThrow(/Your workers.dev subdomain is ada-mock/);
  });

});

describe("around it", () => {
  test("assets are hashed as Cloudflare's direct upload takes them", async () => {
    const h = await assetHash("/a.css", new TextEncoder().encode("body{}"));
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    const expected = new Bun.CryptoHasher("sha256").update(btoa("body{}") + "css").digest("hex").slice(0, 32);
    expect(h).toBe(expected);
  });

  test("a shared pages host finds the document by its token", async () => {
    const platform = { pagesDomain: () => "erga-pages.dev", pagesShared: () => "erga-pages.ada.workers.dev" } as unknown as Platform;
    const app = new URL("https://erga.ada.workers.dev/ada/notes?edit");
    expect(pagesOrigin("Ada", "abcd2345", app, platform)).toBe("https://erga-pages.ada.workers.dev");
    const token = await pagesToken("secret", "Ada", "abcd2345", app.origin);
    expect(pagesHost(new URL(`https://erga-pages.ada.workers.dev/t/${token}/doc/index.html`), platform)).toEqual({ owner: "ada", id: "abcd2345" });
    expect(pagesHost(new URL("https://erga-pages.ada.workers.dev/t/garbage/"), platform)).toBeNull();
    expect(pagesHost(new URL(`https://erga.ada.workers.dev/t/${token}/`), platform)).toBeNull();
    // Without a shared host, as erga.dev: an origin each.
    const own = { pagesDomain: () => "erga-pages.dev" } as unknown as Platform;
    expect(pagesOrigin("Ada", "abcd2345", app, own)).toBe("https://abcd2345-ada.erga-pages.dev");
    expect(pagesHost(new URL("https://abcd2345-ada.erga-pages.dev/t/x/"), own)).toEqual({ owner: "ada", id: "abcd2345" });
    // As staging.erga.dev: an origin each on its own pages zone, one level down (its Universal SSL certificate covers it).
    const staging = { pagesDomain: () => "erga-pages-staging.dev" } as unknown as Platform;
    expect(pagesOrigin("Ada", "abcd2345", new URL("https://staging.erga.dev/ada/notes"), staging)).toBe("https://abcd2345-ada.erga-pages-staging.dev");
    expect(pagesHost(new URL("https://abcd2345-ada.erga-pages-staging.dev/t/x/"), staging)).toEqual({ owner: "ada", id: "abcd2345" });
    expect(pagesHost(new URL("https://abcd2345-ada.erga-pages.dev/t/x/"), staging)).toBeNull();
    expect(pagesHost(new URL("https://abcd2345-ada.staging.erga-pages-staging.dev/t/x/"), staging)).toBeNull();
  });

  test("DeployError carries Cloudflare's status", () => {
    expect(new DeployError({ message: "x", status: 403 }).status).toBe(403);
  });
});

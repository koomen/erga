// The one deploy pipeline on Erga's own
// targets, and branches deploying themselves, against
// the mock Cloudflare's copy of Erga's account:
// production as cf deploy left it, with data in its database and documents
// in its Durable Objects. Nothing real is touched: no Cloudflare, no
// credentials, no production data.
//
// Staging: every step, its own Worker, database, Durable Objects, secrets
// and pages origin, a copy of production's database and documents (frozen:
// copied again only when asked), and nothing written to production. Production: its Worker
// replaced in place, its secrets kept. The guards. Failure and retry.
// Branch pushes: the hook, the queue, passing a push on to staging, the
// status and its events. Rollbacks, by hand and by itself.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ATTEMPTS, BranchDeploys, HISTORY_KEEP, RESUME_MS, targetOf, type DeployEnv, type DeployRecord, type Deps, type LogLine, type TargetStatus } from "../deploy/branches";
import { fromBase64, unpackRelease } from "../deploy/bundle";
import { packRelease } from "../control/builder/build";
import { handle as builderServer } from "../control/builder/server";
import { containerBuilder, ndjsonLines } from "../control/builder/client";
import { CACHE_KEEP, CHUNK, cachedBuild, releaseKey, storageStore, toolchainKey } from "../control/builder/cache";
import { ALL_STEPS, Cloudflare, copyName, copyReason, guardTarget, loadRelease, runPipeline, type Release, type Target } from "../deploy/pipeline";
import { FLEET_ACCOUNT, MOCK_HOOK_SECRET, MOCK_SNAPSHOT_TOKEN, mockBuilder, mockCloudflare, namespaceId, PROD_DB, PROD_DOCS, scriptTag, type MockState } from "../deploy/mock-cloudflare";
import { memoryStore, snapshotDoor } from "../deploy/snapshot";
import { TARGETS } from "../deploy/targets";

const ROOT = new URL("..", import.meta.url).pathname;
let release: Release;

beforeAll(async () => {
  const dir = join(ROOT, ".build/release");
  if (!existsSync(join(dir, "release.json"))) {
    if (!existsSync(join(ROOT, ".build/page.js"))) expect(Bun.spawnSync([join(ROOT, "client/build.sh")], { cwd: ROOT }).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", join(ROOT, "deploy/release.ts")], { cwd: ROOT }).exitCode).toBe(0);
  }
  release = (await loadRelease(async (p) => (existsSync(join(dir, p)) ? new Uint8Array(readFileSync(join(dir, p))) : null)))!;
}, 120_000);

const SHA1 = "1111111111111111111111111111111111111111", SHA2 = "2222222222222222222222222222222222222222", SHA3 = "3333333333333333333333333333333333333333";
const quick = { sleep: async () => {}, waitMs: 2000 };
const env = (over: DeployEnv = {}): DeployEnv => ({ CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT, CLOUDFLARE_DEPLOY_TOKEN: "mock-deploy-token", SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN, ...over });
/** Staging's secrets, as deploy/setup.ts gives them to its first deploy. */
const stagingSecrets = { SESSION_SECRET: "staging-session-secret-0123456789", GITHUB_CLIENT_SECRET: "staging-github-secret-0123456789", SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: MOCK_HOOK_SECRET, CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" };
const staging = (over: Partial<Target> = {}): Target => ({ ...targetOf(TARGETS.staging, env()), ...over });
/** The target with a fresh copy of production's data asked for (a Redeploy with a fresh copy): staging's copy is frozen otherwise. */
const afresh = (t: Target): Target => ({ ...t, snapshot: { ...t.snapshot!, fresh: true } });

async function deployTo(target: Target, mock: ReturnType<typeof mockCloudflare>, rel: Release = release) {
  const steps: string[] = [];
  const result = await runPipeline(new Cloudflare("mock-deploy-token", mock.fetch), rel, target, { ...quick, site: mock.fetch, report: (id, status, detail) => steps.push(`${id}:${status}${detail ? ` ${detail}` : ""}`) });
  return { result, steps };
}

const bindingsOf = (state: MockState, script: string) => Object.fromEntries((state.scripts[script].metadata.bindings as any[]).map((b) => [b.name, b]));
/** Staging's database: the copy its Worker is bound to (each copy has a name of its own: deploy/pipeline.ts, copyName). */
const stagingDbOf = (state: MockState) => state.databases.find((d) => d.uuid == bindingsOf(state, "erga-staging").DB.database_id)!;
/** Staging's copies of production's data, by name. */
const stagingCopies = (state: MockState) => state.databases.filter((d) => d.name.startsWith("erga-staging")).map((d) => d.name);
/** Production as the fleet mock starts it, to compare against after. */
const productionOf = (state: MockState) => JSON.stringify({
  script: state.scripts.erga, secrets: state.secrets.erga, versions: state.versions.erga,
  db: state.databases.find((d) => d.uuid == PROD_DB), docs: [...state.docs.erga.docs].map(([id, d]) => [id, [...d.entries], d.alarm]),
  domains: state.domains.filter((d) => d.service == "erga"), routes: Object.values(state.routes).flat().filter((r) => r.script == "erga"),
});
/** Every call that would write to production: its Worker or its secrets, its database (anything but the export). (Its domain and route: productionOf.) */
const writesToProduction = (state: MockState) => state.calls.filter((c) =>
  (c.includes(`/d1/database/${PROD_DB}`) && !c.endsWith("/export")) || /^(PUT|POST|DELETE|PATCH) .*\/workers\/scripts\/erga(\/|$)/.test(c));

describe("staging", () => {
  test("its own Worker, database, Durable Objects and pages origin, and a copy of production's data; production untouched", async () => {
    const mock = mockCloudflare({ fleet: true });
    const before = productionOf(mock.state);
    const { result, steps } = await deployTo(staging({ secrets: stagingSecrets }), mock);
    expect(steps.filter((s) => s.endsWith(":running")).map((s) => s.split(":")[0])).toEqual(ALL_STEPS.map((s) => s.id));
    expect(result.url).toBe("https://staging.erga.dev");
    expect(result.pages).toBe("*.erga-pages-staging.dev");

    // Its own database: a new one, with production's rows and migrations, then the migrations production hasn't had yet
    // (the mock's production stops at 0110_admin_keys.sql; staging runs ahead of it with the newer ones).
    const db = stagingDbOf(mock.state);
    const prod = mock.state.databases.find((d) => d.uuid == PROD_DB)!;
    expect(db.uuid).not.toBe(PROD_DB);
    expect(db.rows).toEqual(prod.rows!);
    const all = Object.keys(release.migrations).sort(), newer = all.filter((n) => !prod.migrations.includes(n));
    expect(db.migrations).toEqual([...prod.migrations, ...newer]);
    expect(db.migrations).toEqual(all);
    // The restore point is recorded first (staging's Worker is new here: no version to go back to; the copy's bookmark).
    expect(steps.find((s) => s.startsWith("migrations:done"))).toMatch(new RegExp(`^${newer.length ? `migrations:done applied ${newer.join(", ")}` : "migrations:done already up to date"}; restore point: no version, database bookmark \\S+; no API keys of its own to keep$`));

    // Its own Worker: bound to its database, its settings, its secrets, the builder; Durable Objects of its own (a new Worker: no tombstone).
    const b = bindingsOf(mock.state, "erga-staging");
    expect(b.DB.database_id).toBe(db.uuid);
    expect(b.DOCUMENTS).toMatchObject({ type: "durable_object_namespace", class_name: "DocumentObject" });
    expect(b.DOCUMENTS.script_name).toBeUndefined();
    expect(b.DEPLOY_TARGET.text).toBe("staging");
    expect(b.SNAPSHOT_IMPORT.text).toBe("1");
    expect(b.PAGES_DOMAIN.text).toBe("erga-pages-staging.dev");
    expect(b.ERGA_VERSION.text).toBe(release.version);
    expect(b.CLOUDFLARE_ACCOUNT_ID.text).toBe(FLEET_ACCOUNT);
    expect(b.CONTROL).toEqual({ type: "service", name: "CONTROL", service: "erga-control", entrypoint: "App" });
    expect(b.CONTROL_URL).toEqual({ type: "plain_text", name: "CONTROL_URL", text: "https://ops.erga.dev" });
    expect(b.ARTIFACTS).toBeUndefined();
    expect(b.ADMINS.text).toBe("koomen,dsiroker");
    expect(mock.state.secrets["erga-staging"].SESSION_SECRET).toBe(stagingSecrets.SESSION_SECRET);
    expect(mock.state.secrets["erga-staging"].SESSION_SECRET).not.toBe(mock.state.secrets.erga.SESSION_SECRET);
    const meta = mock.state.scripts["erga-staging"].metadata;
    expect(meta.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(meta.exports.DocList).toBeUndefined();
    expect(Object.keys(meta.exports).sort()).toEqual(Object.entries(release.worker.exports!).filter(([, e]) => e.state != "deleted").map(([n]) => n).sort());
    expect(mock.state.scripts["erga-staging"].namespaces.sort()).toEqual(Object.keys(meta.exports).sort());

    // Its addresses: staging.erga.dev, and documents' pages on a zone of their own (erga-pages-staging.dev: its Universal SSL covers them).
    expect(mock.state.domains).toContainEqual({ hostname: "staging.erga.dev", service: "erga-staging", zone_id: "zone00000000000000000000000e7ga1" });
    const pagesZone = "zone00000000000000000000000e7ga3";
    expect(mock.state.routes[pagesZone]).toEqual([{ pattern: "*.erga-pages-staging.dev/*", script: "erga-staging" }]);
    expect(mock.state.dns[pagesZone].map((r) => r.name)).toEqual(["*.erga-pages-staging.dev"]);
    // Production's pages zone: nothing of staging's.
    expect(mock.state.routes["zone00000000000000000000000e7ga2"]).toEqual([{ pattern: "*.erga-pages.dev/*", script: "erga" }]);
    expect(mock.state.dns["zone00000000000000000000000e7ga2"].map((r) => r.name)).toEqual(["*.erga-pages.dev"]);

    // Production's documents, every key and alarm, in staging's Durable Objects.
    const ours = mock.state.docs["erga-staging"].docs, theirs = mock.state.docs.erga.docs;
    expect([...ours.keys()].sort()).toEqual([...PROD_DOCS].sort());
    for (const id of PROD_DOCS) {
      expect([...ours.get(id)!.entries].sort()).toEqual([...theirs.get(id)!.entries].sort());
      expect(ours.get(id)!.alarm).toBe(theirs.get(id)!.alarm);
    }
    expect(steps.find((s) => s.startsWith("documents:done"))).toContain("3 documents copied");

    // Production: read (its database's export, its snapshot endpoint), never written.
    expect(writesToProduction(mock.state)).toEqual([]);
    expect(mock.state.calls.filter((c) => c.includes(PROD_DB))).toEqual([`POST /accounts/${FLEET_ACCOUNT}/d1/database/${PROD_DB}/export`, `POST /accounts/${FLEET_ACCOUNT}/d1/database/${PROD_DB}/export`]);
    expect(productionOf(mock.state)).toBe(before);
  });

  test("again, with a fresh copy asked for: a fresh snapshot (staging's old copy gone, its own documents emptied), its secrets and API keys kept", async () => {
    const mock = mockCloudflare({ fleet: true });
    await deployTo(staging({ secrets: stagingSecrets }), mock);
    // Each server stored its own Anthropic key, under its own FACTORY_KEY.
    const key = (who: string) => `INSERT INTO credentials (name, iv, data, last4, updated, updated_by, updated_via) VALUES ('anthropic', 'iv-${who}', 'data-${who}', '${who.slice(0, 4)}', 1, 'koomen', NULL);`;
    stagingDbOf(mock.state).rows!.push(key("staging"));
    const prodDb = mock.state.databases.find((d) => d.uuid == PROD_DB)!;
    prodDb.tables.push("credentials");
    prodDb.rows!.push(key("production"));
    // Things happen on both: someone makes a document on staging, and one on production.
    const stagingDb = stagingDbOf(mock.state);
    stagingDb.rows!.push("INSERT INTO documents (id, owner, slug, title) VALUES ('zzzz9999', 'bo', 'scratch', 'Scratch');");
    mock.state.docs["erga-staging"].docs.set("zzzz9999", { entries: new Map([["meta", { id: "zzzz9999" }]]), alarm: null });
    mock.state.docs["erga-staging"].docs.get(PROD_DOCS[0])!.entries.set("file:index.html", new TextEncoder().encode("edited on staging"));
    mock.state.databases.find((d) => d.uuid == PROD_DB)!.rows!.push("INSERT INTO documents (id, owner, slug, title) VALUES ('newp4567', 'ada', 'new', 'New');");
    mock.state.docs.erga.docs.set("newp4567", { entries: new Map<string, unknown>([["meta", { id: "newp4567" }], ["file:index.html", new TextEncoder().encode("new on production")]]), alarm: null });
    const before = productionOf(mock.state);

    const { steps } = await deployTo(afresh(staging()), mock);
    expect(mock.state.deletedDatabases).toEqual([stagingDb.name]);
    const db = stagingDbOf(mock.state);
    expect(db.uuid).not.toBe(stagingDb.uuid);
    // Staging's own key, not production's (which doesn't open on staging).
    expect(db.rows!.filter((r) => r.startsWith("INSERT INTO credentials"))).toEqual([key("staging")]);
    expect(steps.find((s) => s.startsWith("migrations:done"))).toContain("its own API keys kept (anthropic)");
    expect(db.rows!.some((r) => r.includes("zzzz9999"))).toBe(false);
    expect(db.rows!.some((r) => r.includes("newp4567"))).toBe(true);
    const docs = mock.state.docs["erga-staging"].docs;
    expect([...docs.keys()].sort()).toEqual([...PROD_DOCS, "newp4567"].sort());
    expect(new TextDecoder().decode(docs.get(PROD_DOCS[0])!.entries.get("file:index.html") as Uint8Array)).toContain("production's words");
    expect(steps.find((s) => s.startsWith("documents:done"))).toContain("1 old ones emptied");
    // The secrets setup gave it stay (this deploy sent none).
    expect(mock.state.secrets["erga-staging"]).toEqual(stagingSecrets);
    expect(writesToProduction(mock.state)).toEqual([]);
    expect(productionOf(mock.state)).toBe(before);
  });

  test("a step that fails stops the deploy; run again, it finishes, and still empties what it should", async () => {
    const mock = mockCloudflare({ fleet: true });
    await deployTo(staging({ secrets: stagingSecrets }), mock);
    mock.state.docs["erga-staging"].docs.set("zzzz9999", { entries: new Map([["meta", { id: "zzzz9999" }]]), alarm: null });
    stagingDbOf(mock.state).rows!.push("INSERT INTO documents (id, owner, slug, title) VALUES ('zzzz9999', 'bo', 's', 'S');");
    // Copying the database fails after the old one is deleted: what it had is carried to the next run.
    mock.state.failNext = "data";
    const carry: { oldDocs?: string[] } = {};
    const cf = new Cloudflare("mock-deploy-token", mock.fetch);
    await expect(runPipeline(cf, release, afresh(staging()), { ...quick, site: mock.fetch, carry, report: () => {} })).rejects.toThrow(/Cloudflare had a problem on its side while we tried to export erga \(read-only\)/);
    expect(carry.oldDocs).toContain("zzzz9999");
    const steps: string[] = [];
    await runPipeline(cf, release, afresh(staging()), { ...quick, site: mock.fetch, carry, report: (id, st, d) => steps.push(`${id}:${st} ${d ?? ""}`) });
    expect(mock.state.docs["erga-staging"].docs.has("zzzz9999")).toBe(false);
    expect(steps.find((s) => s.startsWith("documents:done"))).toContain("1 old ones emptied");
    // A failed Worker upload, then a retry: the same deploy.
    mock.state.failNext = "worker";
    await expect(deployTo(afresh(staging()), mock)).rejects.toThrow(/upload the Worker/);
    await deployTo(afresh(staging()), mock);
    expect(writesToProduction(mock.state)).toEqual([]);
  });

  test("before production serves snapshots, documents are skipped (and said so), not failed", async () => {
    const mock = mockCloudflare({ fleet: true });
    delete mock.state.secrets.erga.SNAPSHOT_TOKEN;
    const { steps } = await deployTo(staging({ secrets: stagingSecrets }), mock);
    expect(steps.find((s) => s.startsWith("documents:skipped"))).toContain("doesn't serve snapshots yet");
    expect(stagingDbOf(mock.state).rows!.length).toBeGreaterThan(0);
  });
});

describe("production", () => {
  test("its Worker replaced in place: the same database and domain, its secrets kept, its tombstone sent, no copying", async () => {
    const mock = mockCloudflare({ fleet: true });
    const secrets = { ...mock.state.secrets.erga };
    const { steps } = await deployTo(targetOf(TARGETS.production, env()), mock);
    expect(steps.filter((s) => s.endsWith(":running")).map((s) => s.split(":")[0])).toEqual(["account", "database", "migrations", "assets", "worker", "address", "pages", "live"]);
    expect(steps).toContain("database:done using Erga's database from before (" + PROD_DB + ")");
    expect(mock.state.databases.length).toBe(1);
    expect(mock.state.deletedDatabases).toEqual([]);
    expect(mock.state.versions.erga).toBe(2);
    expect(mock.state.secrets.erga).toEqual(secrets);
    const b = bindingsOf(mock.state, "erga");
    expect(b.DB.database_id).toBe(PROD_DB);
    expect(b.DEPLOY_TARGET.text).toBe("production");
    expect(b.SNAPSHOT_IMPORT.text).toBe("");
    expect(b.PAGES_DOMAIN.text).toBe("erga-pages.dev");
    expect(b.GITHUB_CLIENT_ID.text).toBe(TARGETS.production.vars.GITHUB_CLIENT_ID);
    expect(mock.state.scripts.erga.metadata.exports.DocList).toEqual({ type: "durable-object", state: "deleted" });
    expect(mock.state.domains.filter((d) => d.hostname == "erga.dev")).toEqual([{ hostname: "erga.dev", service: "erga", zone_id: "zone00000000000000000000000e7ga1" }]);
    expect(mock.state.routes["zone00000000000000000000000e7ga2"]).toEqual([{ pattern: "*.erga-pages.dev/*", script: "erga" }]);
  });

  test("guards: nothing but production may use production's names, and a snapshot never goes into its source", () => {
    const g = staging();
    expect(guardTarget(g)).toBeNull();
    expect(guardTarget({ ...g, workerName: "erga" })).toMatch(/replace production's Worker/);
    expect(guardTarget({ ...g, databaseName: "erga" })).toMatch(/production's database/);
    expect(guardTarget({ ...g, app: { kind: "domain", zoneName: "erga.dev", hostname: "erga.dev" } })).toMatch(/production's address/);
    expect(guardTarget({ ...g, pages: { kind: "zone", zoneName: "erga-pages.dev" } })).toMatch(/production's address/);
    expect(guardTarget({ ...g, pages: { kind: "zone", zoneName: "erga-pages.dev", domain: "staging.erga-pages.dev" } })).toMatch(/under production's pages domain/);
    expect(guardTarget({ ...g, pages: { kind: "zone", zoneName: "erga-pages.dev", domain: "a.b.ERGA-PAGES.dev" } })).toMatch(/under production's pages domain/);
    // Not under it: a name that only ends the same way.
    expect(guardTarget({ ...g, pages: { kind: "zone", zoneName: "my-erga-pages.dev" } })).toBeNull();
    expect(g.pages).toEqual({ kind: "zone", zoneName: "erga-pages-staging.dev", domain: "erga-pages-staging.dev" });
    expect(guardTarget({ ...g, snapshot: { ...g.snapshot!, databaseName: "erga-staging" } })).toMatch(/can't go into the database it's copied from/);
    expect(guardTarget({ ...targetOf(TARGETS.production, env()), snapshot: g.snapshot })).toMatch(/Production never takes a copy/);
    // A server /deploy made in someone else's account may be called erga: the guard is production's account's.
    expect(guardTarget({ ...g, snapshot: undefined, workerName: "erga", databaseName: "erga", accountId: "f".repeat(32) })).toBeNull();
  });

  test("a guarded deploy stops before it asks Cloudflare anything", async () => {
    const mock = mockCloudflare({ fleet: true });
    await expect(deployTo(staging({ databaseName: "erga" }), mock)).rejects.toThrow(/production's database/);
    expect(mock.state.calls).toEqual([]);
  });
});

describe("the snapshot endpoints", () => {
  test("export needs the token and only reads; import only where it's allowed", async () => {
    const store = memoryStore();
    store.docs.set("abcd2345", { entries: new Map<string, unknown>([["meta", { id: "abcd2345" }], ["state", new Uint8Array([9, 8])]]), alarm: 5 });
    const req = (path: string, body: unknown, token = MOCK_SNAPSHOT_TOKEN) => new Request(`https://x${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const door = (r: Request, importAllowed = false, token: string | undefined = MOCK_SNAPSHOT_TOKEN) => snapshotDoor(r, { token, importAllowed, store });
    expect((await door(req("/api/snapshot/docs", { ids: ["abcd2345"] }), false, ""))!.status).toBe(404);
    expect((await door(req("/api/snapshot/docs", { ids: ["abcd2345"] }, "wrong-token-wrong-token-wrong-token-xx")))!.status).toBe(403);
    const r = await door(req("/api/snapshot/docs", { ids: ["abcd2345", "nope0000"] }));
    const { docs } = await r!.json() as any;
    expect(docs).toEqual([{ id: "abcd2345", entries: [["meta", { j: { id: "abcd2345" } }], ["state", { b: btoa("\x09\x08") }]], alarm: 5 }]);
    expect((await door(req("/api/snapshot/docs/import", { docs })))!.status).toBe(404);
    expect((await door(req("/api/snapshot/docs/import", { docs: [{ ...docs[0], id: "efgh6789" }], wipe: ["abcd2345"] }), true))!.status).toBe(200);
    expect([...store.docs.keys()]).toEqual(["efgh6789"]);
    expect(store.docs.get("efgh6789")!.entries.get("state")).toEqual(new Uint8Array([9, 8]));
    expect(await door(new Request("https://x/api/other"))).toBeNull();
  });

  test("an answer carries at most its budget: a document in parts, continued after its last key", async () => {
    const store = memoryStore();
    const bytes = (n: number) => new Uint8Array(n).fill(7);
    store.docs.set("abcd2345", { entries: new Map<string, unknown>([["meta", { id: "abcd2345" }], ["b:1", bytes(300)], ["b:2", bytes(300)], ["b:3", bytes(300)]]), alarm: 5 });
    store.docs.set("efgh6789", { entries: new Map<string, unknown>([["meta", { id: "efgh6789" }]]), alarm: null });
    const ask = async (body: unknown) => (await (await snapshotDoor(new Request("https://x/api/snapshot/docs", { method: "POST", headers: { Authorization: `Bearer ${MOCK_SNAPSHOT_TOKEN}` }, body: JSON.stringify(body) }), { token: MOCK_SNAPSHOT_TOKEN, importAllowed: false, store, budget: 500 }))!.json()) as any;
    const keys = (a: any) => a.docs.map((d: any) => [d.id, d.entries.map(([k]: [string]) => k), d.more]);
    // Each part stops at the entry that reaches the budget (400 characters of base64 each), in the order of the keys.
    let a = await ask({ ids: ["abcd2345", "efgh6789"] });
    expect([keys(a), a.done]).toEqual([[["abcd2345", ["b:1", "b:2"], "b:2"]], 0]);
    a = await ask({ ids: ["abcd2345", "efgh6789"], after: "b:2" });
    expect([keys(a), a.done]).toEqual([[["abcd2345", ["b:3", "meta"], undefined], ["efgh6789", ["meta"], undefined]], 2]);
    expect(a.failed).toEqual([]);
  });

  test("a document larger than one Durable Object call carries is copied whole, in parts", async () => {
    const mock = mockCloudflare({ fleet: true });
    // The real limits scaled down: 32 MiB per RPC, 8 MiB per answer, here 64 KB and 16 KB.
    mock.state.snapshotBudget = 16_000;
    mock.state.docs.erga.rpcLimit = 64_000;
    mock.state.docs["erga-staging"] = Object.assign(memoryStore(), { rpcLimit: 64_000 });
    // Production's first document has 40 versions' blobs of 8 KB: about 430 KB as base64.
    const big = mock.state.docs.erga.docs.get(PROD_DOCS[0])!;
    for (let i = 0; i < 40; i++) big.entries.set(`b:${String(i).padStart(4, "0")}`, crypto.getRandomValues(new Uint8Array(8_000)));
    const { steps } = await deployTo(staging({ secrets: stagingSecrets }), mock);
    expect(steps.find((s) => s.startsWith("documents:") && s != "documents:running")).toBe("documents:done 3 documents copied");
    const ours = mock.state.docs["erga-staging"].docs, theirs = mock.state.docs.erga.docs;
    for (const id of PROD_DOCS) {
      expect([...ours.get(id)!.entries].sort()).toEqual([...theirs.get(id)!.entries].sort());
      expect(ours.get(id)!.alarm).toBe(theirs.get(id)!.alarm);
    }
  });

  test("a document production can't read is left empty, and the others are copied", async () => {
    const mock = mockCloudflare({ fleet: true });
    const prod = mock.state.docs.erga, read = prod.export.bind(prod);
    prod.export = async (id, page) => { if (id == PROD_DOCS[1]) throw new Error("storage unreadable"); return read(id, page); };
    // Staging has an older copy of it: emptied, not left as it was.
    mock.state.docs["erga-staging"] = memoryStore(new Map([[PROD_DOCS[1], { entries: new Map<string, unknown>([["meta", { id: PROD_DOCS[1] }]]), alarm: null }]]));
    const { steps } = await deployTo(staging({ secrets: stagingSecrets }), mock);
    expect(steps.find((s) => s.startsWith("documents:") && s != "documents:running")).toBe(`documents:done 2 documents copied; 1 couldn't be read, and are empty here: ${PROD_DOCS[1]} (storage unreadable)`);
    expect([...mock.state.docs["erga-staging"].docs.keys()].sort()).toEqual([PROD_DOCS[0], PROD_DOCS[2]].sort());
  });
});

/** A server of Erga's in the mock: its branch deploys over storage that outlives it, until its Worker is replaced ("restarted"). */
class Server {
  storage = new Map<string, unknown>();
  instance!: BranchDeploys;
  alive = { on: true };
  events = 0;
  /** The {type: "deploy-log"} events it sent. */
  logs: { deployId: string; lines: LogLine[] }[] = [];
  scheduled: number[] = [];
  constructor(readonly mock: ReturnType<typeof mockCloudflare>, readonly builder: ReturnType<typeof mockBuilder>, readonly script: string, readonly fixedEnv?: DeployEnv, readonly extra: Partial<Deps> = {}) { this.start(); }
  /** Its settings and secrets as the mock has them for its Worker (what the last deploy gave it), unless fixed. */
  envOf(): DeployEnv {
    if (this.fixedEnv) return this.fixedEnv;
    const b = bindingsOf(this.mock.state, this.script);
    const s = this.mock.state.secrets[this.script] ?? {};
    return { CLOUDFLARE_ACCOUNT_ID: b.CLOUDFLARE_ACCOUNT_ID?.text, CLOUDFLARE_DEPLOY_TOKEN: s.CLOUDFLARE_DEPLOY_TOKEN, SNAPSHOT_TOKEN: s.SNAPSHOT_TOKEN };
  }
  /** A new version starts: a new object over the same storage. The old one, if running, can't reach anything any more. */
  start() {
    this.alive.on = false;
    const alive = (this.alive = { on: true });
    const storage = this.storage;
    this.instance = new BranchDeploys({
      storage: { get: async (k) => structuredClone(storage.get(k)) as any, put: async (k, v) => { if (alive.on) storage.set(k, structuredClone(v)); }, delete: async (k) => { if (alive.on) storage.delete(k); } },
      env: this.envOf(),
      net: async (input, init) => { if (!alive.on) throw new Error("Durable Object reset because its code was updated."); return this.mock.fetch(input, init); },
      builder: this.builder,
      schedule: (ms) => { if (alive.on) this.scheduled.push(ms); },
      changed: () => { if (alive.on) this.events++; },
      logged: (e) => { if (alive.on) this.logs.push({ deployId: e.deployId, lines: e.lines }); },
      ...quick,
      ...this.extra,
    });
  }
  version() { return bindingsOf(this.mock.state, this.script).ERGA_VERSION?.text; }
  async status(name: string): Promise<TargetStatus> { return (await this.instance.status()).targets.find((t) => t.name == name)!; }
  /** Wake it, as its alarm would, until nothing's scheduled. */
  async settle() { for (let i = 0; i < 10 && this.scheduled.length; i++) { this.scheduled = []; await this.instance.alarm(); } }
}

/** The first staging deploy, from a machine: staging's Worker, with its secrets. */
async function bootstrap(mock: ReturnType<typeof mockCloudflare>) {
  await runPipeline(new Cloudflare("mock-setup-token", mock.fetch), { ...release, version: SHA1.slice(0, 12) }, staging({ secrets: stagingSecrets }), { ...quick, site: mock.fetch, report: () => {} });
}

describe("branches deploy themselves", () => {
  test("not set up (no deploy token): a push is noted, nothing deployed", async () => {
    const mock = mockCloudflare({ fleet: true });
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga", { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT });
    await server.instance.hook("main", SHA1);
    await server.settle();
    const t = await server.status("production");
    expect(t).toMatchObject({ name: "production", host: "erga.dev", branch: "main", state: "idle", commit: SHA1, error: null });
    expect(t.log.at(-1)).toContain("no CLOUDFLARE_DEPLOY_TOKEN");
    expect(builder.built).toEqual([]);
    expect(mock.state.calls).toEqual([]);
  });

  test("a push to staging, on staging: built, deployed, its frozen data kept; the status and its events; failure and retry; pushes while it runs", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-staging", env({ CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" }));
    const before = productionOf(mock.state);

    await server.instance.hook("staging", SHA2);
    expect(server.scheduled).toEqual([0]);
    expect((await server.status("staging")).pending).toBe(SHA2);
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ name: "staging", host: "staging.erga.dev", branch: "staging", state: "deployed", commit: SHA2, deployed: SHA2, error: null, pending: null });
    expect(Object.keys(t).sort()).toEqual(expect.arrayContaining(["name", "host", "branch", "state", "commit", "at", "error", "log"]));
    expect(t.steps.map((s) => `${s.id}:${s.status}`)).toEqual(["build:done", ...ALL_STEPS.map((s) => `${s.id}:${s.id == "data" || s.id == "documents" ? "skipped" : "done"}`)]);
    expect(t.log.some((l) => l.includes("build: $ bun install --frozen-lockfile"))).toBe(true);
    expect(t.log.at(-1)).toContain(`deployed ${SHA2.slice(0, 12)}`);
    expect(builder.built).toEqual([SHA2]);
    expect(server.version()).toBe(SHA2.slice(0, 12));
    expect(server.events).toBeGreaterThan(5);
    // The deploy's whole log: each line with its time and step, and the same lines as they came, in events.
    const log = (await server.instance.logOf("staging"))!;
    expect(log).toMatchObject({ commit: SHA2, state: "deployed", deployId: expect.stringContaining(SHA2.slice(0, 7)) });
    expect(log.lines.some((l) => l.step == "build" && l.text == "$ bun install --frozen-lockfile")).toBe(true);
    expect(new Set(log.lines.map((l) => l.step).filter(Boolean))).toEqual(new Set(["build", ...ALL_STEPS.map((x) => x.id)]));
    expect(log.lines.every((l, i) => typeof l.at == "number" && (i == 0 || l.at >= log.lines[i - 1].at))).toBe(true);
    expect(log.lines.at(-1)!.text).toContain(`deployed ${SHA2.slice(0, 12)}`);
    expect(server.logs.map((e) => e.deployId)).toEqual(server.logs.map(() => log.deployId as string));
    expect(server.logs.length).toBeGreaterThan(5);
    expect(server.logs.flatMap((e) => e.lines)).toEqual(log.lines);

    // The build fails: the status says where and why; Redeploy runs it again.
    builder.failNext = "bun install: lockfile changed";
    await server.instance.hook("staging", SHA3);
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "failed", commit: SHA3, deployed: SHA2, error: "Stopped at “Build the commit”. Something went wrong: bun install: lockfile changed" });
    // The log is the latest deploy's: the failed one now, with the failure on the build step.
    const failedLog = (await server.instance.logOf("staging"))!;
    expect(failedLog).toMatchObject({ commit: SHA3, state: "failed" });
    expect(failedLog.deployId).not.toBe(log.deployId);
    expect(failedLog.lines.at(-1)).toMatchObject({ step: "build", text: expect.stringContaining("failed: Something went wrong: bun install: lockfile changed") });
    expect(server.version()).toBe(SHA2.slice(0, 12));
    const again = await server.instance.redeploy("staging");
    expect(again.ok).toBe(true);
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", commit: SHA3, deployed: SHA3 });

    // Two pushes while a deploy builds: the running one is cancelled (its build stopped), and only the newest is deployed after it.
    const slow = mockBuilder(async () => release, { delayMs: 30 });
    const busy = new Server(mock, slow, "erga-staging", env({ CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" }));
    await busy.instance.hook("staging", SHA1, "push by ada");
    busy.scheduled = [];
    const running = busy.instance.alarm();
    await new Promise((r) => setTimeout(r, 20));
    await busy.instance.hook("staging", SHA2, "push by bo");
    await busy.instance.hook("staging", SHA3, "push by cy");
    await running;
    expect(await busy.status("staging")).toMatchObject({ state: "cancelled", commit: SHA1, pending: SHA3 });
    await busy.settle();
    expect(slow.stopped).toEqual([SHA1]);
    expect(slow.built).toEqual([SHA3]);
    expect(await busy.status("staging")).toMatchObject({ state: "deployed", deployed: SHA3, pending: null });
    const [last, cancelled] = (await busy.instance.historyOf("staging"))!;
    expect(last).toMatchObject({ commit: SHA3, state: "deployed", trigger: "push by cy", live: true });
    expect(cancelled).toMatchObject({ commit: SHA1, state: "cancelled", trigger: "push by ada", supersededBy: SHA3, replacedBy: last.id, live: false });
    expect(cancelled.error).toContain(`Cancelled: ${SHA3.slice(0, 12)} came (push by cy)`);
    expect(cancelled.ended).toBeGreaterThanOrEqual(cancelled.started);
    const cancelledLog = (await busy.instance.logOf("staging", cancelled.id))!;
    expect(cancelledLog).toMatchObject({ deployId: cancelled.id, commit: SHA1, state: "cancelled", trigger: "push by ada" });
    expect(cancelledLog.lines.some((l) => l.text.includes("the build was stopped"))).toBe(true);
    expect(cancelledLog.lines.some((l) => l.text.includes("Nothing went up: staging.erga.dev stays on"))).toBe(true);
    expect(cancelledLog.lines.at(-1)!.text).toBe(`replaced by deploy ${last.id} (${SHA3.slice(0, 12)}, push by cy)`);

    // Redeploying a target this server doesn't deploy, or one that isn't: refused.
    // Production too, from the same place; nothing of main has come yet.
    expect(await server.instance.redeploy("production")).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("No commit of main") });
    expect(await server.instance.redeploy("nope")).toMatchObject({ ok: false, status: 404 });
    expect(writesToProduction(mock.state)).toEqual([]);
    expect(productionOf(mock.state)).toBe(before);
  });

  test("a rollback: the version before the live deploy serves again, in one call; recorded as a live deploy of its own, which a second rollback undoes", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-staging", env({ CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" }));
    // Nothing live yet (the first deploy came from a machine): nothing to roll back from.
    expect(await server.instance.rollback("staging")).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("no live deploy") });
    await server.instance.hook("staging", SHA2, "push by ada");
    await server.settle();
    await server.instance.hook("staging", SHA3, "push by bo");
    await server.settle();
    expect(server.version()).toBe(SHA3.slice(0, 12));
    const [third, second] = (await server.instance.historyOf("staging"))!;
    // Each deploy's restore point: the Worker version and release before it, and the database's bookmark.
    expect(second.restore).toMatchObject({ versionId: expect.stringMatching(/^[0-9a-f-]{36}$/), version: SHA1.slice(0, 12), bookmark: expect.stringMatching(/\S+/), commit: null });
    expect(third.restore).toMatchObject({ versionId: expect.stringMatching(/^[0-9a-f-]{36}$/), version: SHA2.slice(0, 12), commit: SHA2 });
    const calls = mock.state.calls.length;

    const back = await server.instance.rollback("staging", "rollback by cy");
    expect(back.ok).toBe(true);
    // One call to Cloudflare (a deployment of the older version), no build: the older release answers.
    expect(mock.state.calls.slice(calls).filter((c) => c.startsWith("POST"))).toEqual([`POST /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-staging/deployments?force=true`]);
    expect(builder.built).toEqual([SHA2, SHA3]);
    expect(server.version()).toBe(SHA2.slice(0, 12));
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "deployed", deployed: SHA2, commit: SHA2, error: null });
    expect(t.steps.map((x) => `${x.id}:${x.status}`)).toEqual(["rollback:done"]);
    const [rollback, undone] = (await server.instance.historyOf("staging"))!;
    expect(rollback).toMatchObject({ id: expect.stringContaining("-rollback"), commit: SHA2, state: "deployed", live: true, rollbackOf: third.id, trigger: expect.stringContaining("rollback by cy: back to " + SHA2.slice(0, 12)) });
    expect(undone).toMatchObject({ id: third.id, state: "rolled-back", rolledBackBy: rollback.id, live: false });
    expect(rollback.restore).toMatchObject({ versionId: expect.stringMatching(/^[0-9a-f-]{36}$/), version: SHA3.slice(0, 12), commit: SHA3 });
    const log = (await server.instance.logOf("staging"))!;
    expect(log).toMatchObject({ deployId: rollback.id, state: "deployed", live: true, rollbackOf: third.id });
    expect(log.lines.map((l) => l.step)).toEqual(log.lines.map(() => "rollback"));
    expect(log.lines.at(-1)!.text).toContain(`rolled back: https://staging.erga.dev serves ${SHA2.slice(0, 12)}`);

    // The rollback's own restore point is the version it undid: a second rollback rolls forward.
    expect((await server.instance.rollback("staging", "rollback by cy")).ok).toBe(true);
    expect(server.version()).toBe(SHA3.slice(0, 12));
    expect((await server.status("staging")).deployed).toBe(SHA3);
    // Refused: a target this server doesn't deploy, no such target, and while a deploy runs.
    expect(await server.instance.rollback("production")).toMatchObject({ ok: false, status: 409 });
    expect(await server.instance.rollback("nope")).toMatchObject({ ok: false, status: 404 });
    const slow = mockBuilder(async () => release, { delayMs: 30 });
    const busy = new Server(mock, slow, "erga-staging", env({ CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" }));
    await busy.instance.hook("staging", SHA1, "push by ada");
    const running = busy.instance.alarm();
    await new Promise((r) => setTimeout(r, 10));
    expect(await busy.instance.rollback("staging")).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("is running") });
    await running;
    await busy.settle();
  });

  test("a release that answers its version but fails its health check: the deploy fails at the live step, and says what failed", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-staging", env({ CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" }));
    await server.instance.hook("staging", SHA2);
    await server.settle();
    expect((await server.status("staging")).steps.find((x) => x.id == "live")!.detail).toMatch(/healthy \(db ok 1 ms, documents ok 2 ms\)$/);
    mock.state.unhealthy = [SHA3.slice(0, 12)];
    await server.instance.hook("staging", SHA3);
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "failed", commit: SHA3, deployed: SHA2 });
    expect(t.error).toContain("Stopped at “Wait for it to answer”.");
    expect(t.error).toContain(`Release ${SHA3.slice(0, 12)} is up at https://staging.erga.dev, but its health check fails: documents: a document didn't open`);
    expect(t.steps.find((x) => x.id == "live")!.status).toBe("failed");
  });

  test("an unhealthy release is rolled back by itself: the version before it serves again, the deploy stays failed and says so", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-staging", env({ CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" }));
    await server.instance.hook("staging", SHA2);
    await server.settle();
    const [good] = (await server.instance.historyOf("staging"))!;
    mock.state.unhealthy = [SHA3.slice(0, 12)];
    const calls = mock.state.calls.length;
    await server.instance.hook("staging", SHA3);
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "failed", commit: SHA3, deployed: SHA2, liveDeploy: good.id });
    expect(t.error).toContain("its health check fails: documents: a document didn't open");
    expect(t.error).toContain(`Rolled back to release ${SHA2.slice(0, 12)} by itself.`);
    expect(t.steps.find((x) => x.id == "live")!.status).toBe("failed");
    expect(t.steps.at(-1)).toMatchObject({ id: "rollback", status: "done", title: `Roll back to release ${SHA2.slice(0, 12)}` });
    // The older release answers again: one deployment of its version, after the health check's three tries.
    expect(server.version()).toBe(SHA2.slice(0, 12));
    expect(mock.state.calls.slice(calls).filter((c) => c.includes("/deployments") && c.startsWith("POST"))).toEqual([`POST /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-staging/deployments?force=true`]);
    const [failed, live] = (await server.instance.historyOf("staging"))!;
    expect(failed).toMatchObject({ commit: SHA3, state: "failed", live: false, error: expect.stringContaining("Rolled back to release") });
    expect(live).toMatchObject({ id: good.id, state: "deployed", live: true });
    const log = (await server.instance.logOf("staging", failed.id))!;
    expect(log.lines.filter((l) => l.step == "rollback").map((l) => l.text)).toEqual([`unhealthy: rolling staging.erga.dev back to release ${SHA2.slice(0, 12)} (what it ran before this deploy)`]);
    // Healthy again at the next push: deployed as usual.
    mock.state.unhealthy = [];
    await server.instance.hook("staging", SHA1);
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA1 });
  });

  test("interrupted before the upload (the object reset, as on 2026-10-05): it runs again by itself, with nobody to press Redeploy", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-staging");
    const s = server;
    // The server restarts (for any reason) right after the build, at "Check your Cloudflare account".
    const seen = mock.state.calls.length;
    const watch = setInterval(() => { if (mock.state.calls.slice(seen).some((c) => /\/workers\/scripts(\?|$)/.test(c))) s.alive.on = false; }, 0);
    await s.instance.hook("staging", SHA2, "push from the task queue");
    s.scheduled = [];
    await s.instance.alarm().catch(() => {});
    clearInterval(watch);
    // The alarm that the reset threw out of runs again (Cloudflare retries it) on the new object.
    server.start();
    await server.instance.alarm();
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(server.version()).toBe(SHA2.slice(0, 12));
    const history = (await server.instance.historyOf("staging"))!;
    expect(history.map((r) => r.state)).toEqual(["deployed", "failed"]);
    expect(history[1].error).toContain("It runs again by itself");
    expect(history[0].trigger).toBe("push from the task queue, again after a restart");
    expect((await server.instance.logOf("staging"))!.lines.map((l) => l.text)).toContainEqual(expect.stringContaining("(attempt 2 of 3)"));
    expect(builder.built).toEqual([SHA2, SHA2]);
  });

  test(`interrupted before the upload ${ATTEMPTS} times: it stops trying, says so, and Redeploy finishes it`, async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-staging");
    await server.instance.hook("staging", SHA2);
    for (let i = 0; i < ATTEMPTS; i++) {
      // The server restarts after the build, every time.
      const seen = mock.state.calls.length;
      const s = server;
      const watch = setInterval(() => { if (mock.state.calls.slice(seen).some((c) => /\/workers\/scripts(\?|$)/.test(c))) s.alive.on = false; }, 0);
      server.scheduled = [];
      await server.instance.alarm().catch(() => {});
      clearInterval(watch);
      server.start();
    }
    await server.instance.alarm();
    expect(await server.status("staging")).toMatchObject({ state: "failed", pending: null, error: expect.stringContaining(`tried ${ATTEMPTS} times: Redeploy`) });
    expect(builder.built).toEqual(Array(ATTEMPTS).fill(SHA2));
    expect(server.version()).toBe(SHA1.slice(0, 12));
    await server.instance.redeploy("staging");
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA2 });
  });

});

describe("a newer deploy cancels the running one", () => {
  const stagingEnv = () => env({ CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" });

  test("before the upload: it stops before its next step, nothing goes up, and the newer one deploys", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-staging", stagingEnv());
    const uploads = mock.state.versions["erga-staging"];
    await server.instance.hook("staging", SHA2, "push by ada");
    server.scheduled = [];
    // A push comes while the database is being made afresh.
    let pushed: Promise<void> | null = null;
    const watch = setInterval(() => { if (!pushed && mock.state.calls.some((c) => c.startsWith("POST") && c.endsWith("/d1/database"))) pushed = server.instance.hook("staging", SHA3, "push by bo"); }, 0);
    await server.instance.alarm();
    clearInterval(watch);
    await pushed;
    const mid = await server.status("staging");
    expect(mid).toMatchObject({ state: "cancelled", commit: SHA2, pending: SHA3, deployed: null });
    expect(mid.steps.find((x) => x.id == "worker")!.status).toBe("cancelled");
    expect(mock.state.versions["erga-staging"]).toBe(uploads);
    expect(server.version()).toBe(SHA1.slice(0, 12));
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA3 });
    expect(server.version()).toBe(SHA3.slice(0, 12));
    expect(mock.state.versions["erga-staging"]).toBe(uploads + 1);
    const [now, was] = (await server.instance.historyOf("staging"))!;
    expect([now.state, now.commit, was.state, was.commit, was.replacedBy]).toEqual(["deployed", SHA3, "cancelled", SHA2, now.id]);
    expect((await server.instance.logOf("staging", was.id))!.lines.some((l) => l.text.includes("Nothing went up: staging.erga.dev stays on what it had"))).toBe(true);
  });

  test("after the upload (a server that isn't restarted by it): stopped there, and the newer one replaces it", async () => {
    let server: Server | null = null;
    let pushed: Promise<void> | null = null;
    const mock = mockCloudflare({ fleet: true, onUpload: (script, meta) => {
      const v = (meta.bindings ?? []).find((b: any) => b.name == "ERGA_VERSION")?.text;
      if (script == "erga-staging" && server && v == SHA2.slice(0, 12)) pushed = server.instance.hook("staging", SHA3, "push by bo");
    } });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    server = new Server(mock, builder, "erga-staging", stagingEnv());
    await server.instance.hook("staging", SHA2);
    server.scheduled = [];
    await server.instance.alarm();
    await pushed;
    const mid = await server.status("staging");
    expect(mid).toMatchObject({ state: "cancelled", commit: SHA2, pending: SHA3 });
    expect(mid.log.some((l) => l.includes("This version was already up; the next deploy replaces it."))).toBe(true);
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA3 });
    expect(server.version()).toBe(SHA3.slice(0, 12));
  });

  test("interrupted before the upload with a newer one waiting: cancelled (not failed), and the newer one deploys", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-staging");
    const s = server;
    const watch = setInterval(() => { if (mock.state.calls.some((c) => c.includes("assets-upload-session"))) s.alive.on = false; }, 0);
    await s.instance.hook("staging", SHA2);
    s.scheduled = [];
    await s.instance.alarm();
    clearInterval(watch);
    server.start();
    await server.instance.hook("staging", SHA3);
    await server.instance.alarm();
    const list = (await server.instance.historyOf("staging"))!;
    expect(list.find((r) => r.commit == SHA2)).toMatchObject({ state: "cancelled" });
    expect(list.find((r) => r.commit == SHA3)).toBeTruthy();
  });

  test("the history keeps the last HISTORY_KEEP deploys of each target, and their logs; older logs are deleted", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const server = new Server(mock, mockBuilder(async () => release), "erga-staging", stagingEnv());
    const old: DeployRecord[] = Array.from({ length: HISTORY_KEEP }, (_, i) => ({ id: `old-${i}`, target: "staging", commit: SHA1, state: "deployed", started: i, ended: i, trigger: "push", error: null }));
    old.reverse();
    server.storage.set("history:staging", old);
    for (const r of old) server.storage.set(`log:staging:${r.id}`, { deployId: r.id, commit: SHA1, lines: [{ at: 0, text: r.id }] });
    await server.instance.hook("staging", SHA2);
    await server.settle();
    const list = (await server.instance.historyOf("staging", 1000))!;
    expect(list.length).toBe(HISTORY_KEEP);
    expect(list[0]).toMatchObject({ commit: SHA2, state: "deployed" });
    expect(list.at(-1)!.id).toBe("old-1");
    expect(server.storage.has("log:staging:old-0")).toBe(false);
    expect(server.storage.has("log:staging:old-1")).toBe(true);
    expect((await server.instance.logOf("staging", "old-50"))!.lines[0].text).toBe("old-50");
    expect(await server.instance.logOf("staging", "nope")).toBeNull();
    expect((await server.instance.historyOf("staging"))!.length).toBe(20);
  });
});

describe("the builder", () => {
  test("the container's server streams the build and hands back the release; the pipeline's client reads it", async () => {
    const bundle = packRelease(join(ROOT, ".build/release"));
    const fake = async (o: { log: (l: string) => void; commit: string }) => { o.log(`$ bun install (${o.commit.slice(0, 7)})`); o.log("$ bun run build"); return bundle; };
    const fetcher = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => builderServer(new Request(new URL(String(input)), init), fake as never)) as typeof fetch };
    const lines: string[] = [];
    const built = await containerBuilder(fetcher).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "https://artifacts.mock/git/erga/erga.git", token: "t" } }, (l) => lines.push(l));
    expect(lines).toEqual(["$ bun install (2222222)", "$ bun run build"]);
    expect(built.version).toBe(SHA2.slice(0, 12));
    expect(Object.keys(built.modules).sort()).toEqual(Object.keys(release.modules).sort());
    expect(Object.keys(built.assets).sort()).toEqual(Object.keys(release.assets).sort());
    expect((await unpackRelease(bundle)).migrations).toEqual(release.migrations);
    // A failed build says why.
    const failing = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => builderServer(new Request(new URL(String(input)), init), (async () => { throw new Error("bun install failed (exit 1)"); }) as never)) as typeof fetch };
    await expect(containerBuilder(failing).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "x", token: "t" } }, () => {})).rejects.toThrow(/The build failed: bun install failed/);
  });

  test("the release, one line of ~15 MB in small chunks, is read in one pass (it reset the Pipeline object on 2026-10-05)", async () => {
    const bundle = packRelease(join(ROOT, ".build/release"));
    const text = `${JSON.stringify({ log: "é and ✓" })}\n${JSON.stringify({ bundle: new TextDecoder().decode(bundle) })}\n`;
    const bytes = new TextEncoder().encode(text);
    // 1 KB chunks, so a character's bytes and the newlines fall across them.
    const chunks = async function* () { for (let i = 0; i < bytes.length; i += 1021) yield bytes.subarray(i, i + 1021); };
    const t = performance.now();
    const lines: string[] = [];
    for await (const l of ndjsonLines(chunks())) lines.push(l);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).log).toBe("é and ✓");
    expect(JSON.parse(lines[1]).bundle.length).toBe(new TextDecoder().decode(bundle).length);
    // Before, each chunk joined and split the whole line so far: quadratic (seconds for this, and much more on a Worker).
    expect(performance.now() - t).toBeLessThan(2000);
    const fetcher = { fetch: (async () => new Response(new ReadableStream({ async start(c) { for await (const x of chunks()) c.enqueue(x.slice()); c.close(); } }))) as unknown as typeof fetch };
    const built = await containerBuilder(fetcher).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "x", token: "t" } }, () => {});
    for (const [n, b] of Object.entries(release.modules)) expect(built.modules[n]).toEqual(b);
    for (const [p, b] of Object.entries(release.assets)) expect(built.assets[p]).toEqual(b);
    // A last line with no newline is read too; base64 decodes the same on every path.
    const tail: string[] = [];
    for await (const l of ndjsonLines((async function* () { yield new TextEncoder().encode('{"a":1}\n{"b"'); yield new TextEncoder().encode(":2}"); })())) tail.push(l);
    expect(tail).toEqual(['{"a":1}', '{"b":2}']);
    const raw = crypto.getRandomValues(new Uint8Array(1000));
    expect(fromBase64(Buffer.from(raw).toString("base64"))).toEqual(raw);
  });

  test("a cancelled deploy stops its build: the client asks the container to cancel, and the build's commands are killed", async () => {
    let stopped = false;
    const slow = async (o: { log: (l: string) => void; signal?: AbortSignal }) => {
      o.log("$ bun install");
      await new Promise<void>((_, no) => o.signal!.addEventListener("abort", () => { stopped = true; no(o.signal!.reason); }));
      return new Uint8Array();
    };
    const fetcher = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => builderServer(new Request(new URL(String(input)), init), slow as never)) as typeof fetch };
    const abort = new AbortController();
    const lines: string[] = [];
    const build = containerBuilder(fetcher).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "x", token: "t" } }, (l) => { lines.push(l); abort.abort(new Error("superseded")); }, abort.signal);
    await expect(build).rejects.toThrow("superseded");
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(true);
    expect(lines).toEqual(["$ bun install"]);
    // The container is free again; a cancel with nothing running stops nothing.
    expect(await (await builderServer(new Request("http://builder/cancel", { method: "POST", body: "{}" }))).json()).toEqual({ stopped: false });
    // The real runner kills the command it's running.
    const { spawnRunner } = await import("../control/builder/build");
    const kill = new AbortController();
    const started = Date.now();
    setTimeout(() => kill.abort(new Error("cancelled")), 50);
    await expect(spawnRunner(["sleep", "5"], { cwd: ROOT, log: () => {}, signal: kill.signal })).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("two builds at once each get a container of their own, and both succeed; a 503 (no container free) is waited out (it failed staging's deploy on 2026-10-05)", async () => {
    const bundle = new TextDecoder().decode(packRelease(join(ROOT, ".build/release")));
    // The Worker in front, as a mock: one container per build id (each busy with one build), and the first start of one build finds none free.
    const busy = new Set<string>(), ids: string[] = [], cancels: string[] = [];
    let refused = 0, inFlight = 0, most = 0;
    const fetcher = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)), id = url.searchParams.get("id")!;
      if (url.pathname == "/cancel") { cancels.push(id); return Response.json({ stopped: busy.has(id) }); }
      ids.push(id);
      if (refused++ == 0) return Response.json({ error: "The build container didn't start." }, { status: 503 });
      if (busy.has(id)) return Response.json({ error: "A build is already running." }, { status: 409 });
      busy.add(id); most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      busy.delete(id); inFlight--;
      return new Response(`${JSON.stringify({ log: `built ${id.slice(0, 4)}` })}\n${JSON.stringify({ bundle })}\n`);
    }) as typeof fetch };
    const slept: number[] = [];
    const builder = containerBuilder(fetcher, { sleep: async (ms) => { slept.push(ms); } });
    const lines: string[][] = [[], []];
    const [a, b] = await Promise.all([0, 1].map((n) => builder.build({ commit: SHA2, branch: n ? "main" : "staging", source: { cloneUrl: "x", token: "t" } }, (l) => lines[n].push(l))));
    expect(a.version).toBe(SHA2.slice(0, 12));
    expect(b.version).toBe(SHA2.slice(0, 12));
    expect(most).toBe(2);
    expect(new Set(ids).size).toBe(2);
    expect(slept).toEqual([5000]);
    expect(lines.flat().filter((l) => l.startsWith("waiting for the builder"))).toHaveLength(1);
    // A 503 that doesn't clear gives up after ~5 minutes, with backoff, and says why.
    const down = { fetch: (async () => Response.json({ error: "The build container didn't start." }, { status: 503 })) as unknown as typeof fetch };
    const waits: number[] = [];
    await expect(containerBuilder(down, { sleep: async (ms) => { waits.push(ms); } }).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "x", token: "t" } }, () => {})).rejects.toThrow(/answered 503: .*didn't start/);
    expect(waits.slice(0, 4)).toEqual([5000, 10000, 20000, 30000]);
    expect(waits.reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(300_000);
    // A cancel reaches the build's own container.
    const abort = new AbortController();
    const hang = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname == "/cancel") { cancels.push(url.searchParams.get("id")!); return Response.json({ stopped: true }); }
      ids.push(url.searchParams.get("id")!);
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`${JSON.stringify({ log: "go" })}\n`)); } }));
    }) as typeof fetch };
    await expect(containerBuilder(hang).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "x", token: "t" } }, () => abort.abort(new Error("superseded")), abort.signal)).rejects.toThrow("superseded");
    expect(cancels).toEqual([ids.at(-1)!]);
  });
});

describe("the one-time setup", () => {
  test("deploy/setup.ts says what it will do, and (against the mock) does it: the control Worker's secrets, staging's first deploy, the deploy token", () => {
    const dry = Bun.spawnSync(["bun", join(ROOT, "deploy/setup.ts"), "--dry-run"], { cwd: ROOT, env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" } });
    const said = dry.stdout.toString();
    expect(dry.exitCode).toBe(0);
    expect(said).toContain("8. Check it");
    expect(said).toContain("Individual Workers Editor: erga, erga-staging, erga-control (nothing else)");
    expect(said).toContain("--dry-run: nothing done.");
    const run = Bun.spawnSync(["bun", join(ROOT, "deploy/setup.ts"), "--yes"], { cwd: ROOT, env: { ...process.env, ERGA_DEPLOY_MOCK: "1", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" } });
    const out = run.stdout.toString();
    expect(run.exitCode).toBe(0);
    expect(out).toContain("(the mock Cloudflare: nothing real)");
    expect(out).toContain("Set: erga-control: SESSION_SECRET, GITHUB_CLIENT_SECRET, SNAPSHOT_TOKEN; erga: SNAPSHOT_TOKEN.");
    expect(out).toContain("Copy production's documents into it: done, 3 documents copied");
    expect(out).toContain("Made and checked: it deploys erga, erga-staging, erga-control, reads erga.dev, erga-pages.dev, erga-pages-staging.dev, and can't write DNS and routes.");
    expect(out).toContain("Stored on erga-control as CLOUDFLARE_DEPLOY_TOKEN (not printed).");
    expect(out).not.toContain("mock-scoped-");
    expect(out).toContain("https://ops.erga.dev/api/health: ok true");
    expect(out).toMatch(/runs [0-9a-f]{12}; it says it's staging/);
  }, 60_000);

  test("deploy/run.ts refuses production's names for staging, and needs credentials", () => {
    const r = Bun.spawnSync(["bun", join(ROOT, "deploy/run.ts"), "nowhere"], { cwd: ROOT });
    expect(r.exitCode).toBe(2);
    const noCreds = Bun.spawnSync(["bun", join(ROOT, "deploy/run.ts"), "staging", "--yes"], { cwd: ROOT, env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" } });
    expect(noCreds.exitCode).toBe(1);
    expect(noCreds.stderr.toString()).toContain("Set CLOUDFLARE_ACCOUNT_ID");
  });
});

describe("staging's data copy (a Redeploy with a fresh copy) runs while the commit builds", () => {
  const stagingEnv = () => env({ CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" });
  /** A push of `commit` to staging, and a fresh copy asked for before its deploy starts. */
  const pushFresh = async (server: Server, commit: string, trigger?: string) => {
    await server.instance.hook("staging", commit, trigger);
    expect(await server.instance.redeploy("staging", "redeploy by ada", { fresh: true })).toMatchObject({ ok: true });
  };
  const imported = (mock: ReturnType<typeof mockCloudflare>) => mock.state.calls.some((c) => c.includes("/import"));
  /** A builder that ends only once the database copy is done (it never would if the copy waited for the build), or fails when told. */
  const waitsForCopy = (mock: ReturnType<typeof mockCloudflare>, o: { fail?: string; hang?: boolean } = {}) => {
    const b = {
      built: [] as string[], stopped: [] as string[], sawCopy: false,
      async build({ commit }: { commit: string }, log: (l: string) => void, signal?: AbortSignal): Promise<Release> {
        log("$ bun install --frozen-lockfile");
        if (o.fail) throw new Error(o.fail);
        for (let i = 0; i < 400 && (o.hang || !imported(mock)); i++) {
          if (signal?.aborted) { b.stopped.push(commit); throw signal.reason; }
          await new Promise((r) => setTimeout(r, 5));
        }
        b.sawCopy = imported(mock);
        b.built.push(commit);
        return { ...release, version: commit.slice(0, 12) };
      },
    };
    return b;
  };

  test("the account, database and data steps run during the build; the rest after it, on the copy's database", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = waitsForCopy(mock);
    const server = new Server(mock, builder as never, "erga-staging", stagingEnv());
    const before = productionOf(mock.state);
    await pushFresh(server, SHA2);
    await server.settle();
    expect(builder.sawCopy).toBe(true);
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "deployed", deployed: SHA2, error: null });
    expect(t.steps.map((x) => `${x.id}:${x.status}`)).toEqual(["build:done", ...ALL_STEPS.map((s) => `${s.id}:done`)]);
    // The copy's steps ended before the build did; the migrations started only after it.
    const lines = (await server.instance.logOf("staging"))!.lines;
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l.text));
    expect(at(/^Copy production's database into it: done/)).toBeGreaterThan(-1);
    expect(at(/^Copy production's database into it: done/)).toBeLessThan(at(/^built release/));
    expect(at(/^Set up the database's tables…/)).toBeGreaterThan(at(/^built release/));
    // The Worker went up on the copy's database, with the tombstone (the Worker was there: the account step's answer, carried over).
    const db = stagingDbOf(mock.state);
    expect(bindingsOf(mock.state, "erga-staging").DB.database_id).toBe(db.uuid);
    expect(db.rows).toEqual(mock.state.databases.find((d) => d.uuid == PROD_DB)!.rows!);
    expect(mock.state.scripts["erga-staging"].metadata.exports.DocList).toEqual({ type: "durable-object", state: "deleted" });
    expect(writesToProduction(mock.state)).toEqual([]);
    expect(productionOf(mock.state)).toBe(before);
  });

  test("production copies nothing: no step runs before its build ends", async () => {
    const mock = mockCloudflare({ fleet: true });
    const inner = mockBuilder(async () => release);
    const seen: string[] = [];
    const builder = { ...inner, build: async (o: any, log: any, signal: any) => { const r = await inner.build(o, log, signal); seen.push(...mock.state.calls); return r; } };
    const server = new Server(mock, builder as never, "erga", env());
    await server.instance.hook("main", SHA2);
    await server.settle();
    expect(await server.status("production")).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(seen.filter((c) => !c.includes("/artifacts/"))).toEqual([]); // only the source's read token, for the build
  });

  test("the build fails: the copy stops after its step, the deploy fails at the build, nothing goes up", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const uploads = mock.state.versions["erga-staging"];
    const server = new Server(mock, waitsForCopy(mock, { fail: "bun install: lockfile changed" }) as never, "erga-staging", stagingEnv());
    await server.instance.hook("staging", SHA2);
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "failed", error: "Stopped at “Build the commit”. Something went wrong: bun install: lockfile changed" });
    expect(t.steps.filter((x) => x.status == "failed").map((x) => x.id)).toEqual(["build"]);
    expect(t.steps.find((x) => x.id == "worker")!.status).toBe("pending");
    expect(mock.state.versions["erga-staging"]).toBe(uploads);
    expect(server.version()).toBe(SHA1.slice(0, 12));
  });

  test("the copy fails: the build is stopped, and the deploy fails at the copy's step; Redeploy finishes it", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = waitsForCopy(mock, { hang: true });
    const server = new Server(mock, builder as never, "erga-staging", stagingEnv());
    mock.state.failNext = "data";
    await pushFresh(server, SHA2);
    await server.settle();
    const t = await server.status("staging");
    expect(t.state).toBe("failed");
    expect(t.error).toContain("Stopped at “Copy production's database into it”.");
    expect(t.steps.find((x) => x.id == "build")!.status).toBe("cancelled");
    expect(t.steps.filter((x) => x.status == "failed").map((x) => x.id)).toEqual(["data"]);
    expect(builder.stopped).toEqual([SHA2]);
    expect(server.version()).toBe(SHA1.slice(0, 12));
    const again = new Server(mock, waitsForCopy(mock) as never, "erga-staging", stagingEnv());
    again.storage = server.storage;
    again.start();
    expect((await again.instance.redeploy("staging", "redeploy by ada", { fresh: true })).ok).toBe(true);
    await again.settle();
    expect(await again.status("staging")).toMatchObject({ state: "deployed", deployed: SHA2 });
  });

  test("a newer push during the copy cancels both sides; the newer one deploys", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = waitsForCopy(mock, { hang: true });
    const server = new Server(mock, builder as never, "erga-staging", stagingEnv());
    await pushFresh(server, SHA2, "push by ada");
    server.scheduled = [];
    let pushed: Promise<void> | null = null;
    const watch = setInterval(() => { if (!pushed && mock.state.calls.some((c) => c.startsWith("POST") && c.endsWith("/d1/database"))) pushed = server.instance.hook("staging", SHA3, "push by bo"); }, 0);
    await server.instance.alarm();
    clearInterval(watch);
    await pushed;
    const mid = await server.status("staging");
    expect(mid).toMatchObject({ state: "cancelled", commit: SHA2, pending: SHA3 });
    expect(builder.stopped).toEqual([SHA2]);
    expect(mid.steps.find((x) => x.id == "build")!.status).toBe("cancelled");
    expect(mid.steps.find((x) => x.id == "migrations")!.status).toBe("cancelled");
    // The copy it made is deleted; staging stays on its database.
    expect((await server.instance.logOf("staging"))!.lines.map((l) => l.text)).toContainEqual(expect.stringContaining("deleted the copy this deploy made, which nothing uses"));
    expect(stagingCopies(mock.state)).toEqual([stagingDbOf(mock.state).name]);
    const next = new Server(mock, waitsForCopy(mock) as never, "erga-staging", stagingEnv());
    next.storage = server.storage;
    next.start();
    next.scheduled = [0];
    await next.settle();
    expect(await next.status("staging")).toMatchObject({ state: "deployed", deployed: SHA3 });
    expect(next.version()).toBe(SHA3.slice(0, 12));
  });

  test("a restart during the copy (before the upload): it runs again from the top by itself", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const server = new Server(mock, waitsForCopy(mock) as never, "erga-staging", stagingEnv());
    const s = server;
    const watch = setInterval(() => { if (mock.state.calls.some((c) => c.endsWith("/export"))) s.alive.on = false; }, 0);
    await pushFresh(s, SHA2, "push by ada");
    s.scheduled = [];
    await s.instance.alarm().catch(() => {});
    clearInterval(watch);
    server.start();
    await server.instance.alarm();
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA2 });
    const history = (await server.instance.historyOf("staging"))!;
    expect(history.map((r) => r.state)).toEqual(["deployed", "failed"]);
    // Run again with the fresh copy still asked for.
    expect(history[0].trigger).toBe("redeploy by ada, again after a restart");
    expect(history[1].trigger).toBe("redeploy by ada");
    expect(stagingDbOf(mock.state).rows).toEqual(mock.state.databases.find((d) => d.uuid == PROD_DB)!.rows!);
    expect(bindingsOf(mock.state, "erga-staging").DB.database_id).toBe(stagingDbOf(mock.state).uuid);
  });
});

describe("staging's copy of production's data: frozen, a database of its own each time it's copied, only when asked", () => {
  const stagingEnv = () => env({ CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" });
  /** Deploys `commit` (kept data), then redeploys it with a fresh copy of production's data. */
  const freshly = async (server: Server, commit: string) => {
    await server.instance.hook("staging", commit);
    await server.settle();
    expect(await server.instance.redeploy("staging", "redeploy by ada", { fresh: true })).toMatchObject({ ok: true });
  };
  const stepOf = (t: TargetStatus, id: string) => t.steps.find((x) => x.id == id)!;
  const exports = (mock: ReturnType<typeof mockCloudflare>) => mock.state.calls.filter((c) => c.endsWith(`/d1/database/${PROD_DB}/export`)).length;
  /** Makes staging's copy look `hours` old (the age is in its name). */
  const age = (mock: ReturnType<typeof mockCloudflare>, hours: number) => { const db = stagingDbOf(mock.state); db.name = copyName("erga-staging", Date.now() - hours * 3600_000); return db; };

  test("no downtime: staging's Worker is never on a missing database; the old copy goes only after the new version answers", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const old = stagingDbOf(mock.state);
    const server = new Server(mock, mockBuilder(async () => release, { delayMs: 20 }), "erga-staging", stagingEnv());
    // Every few ms of the deploys: the database staging's Worker is bound to is there.
    const missing: string[] = [];
    const watch = setInterval(() => { const id = bindingsOf(mock.state, "erga-staging").DB.database_id; if (!mock.state.databases.some((d) => d.uuid == id)) missing.push(id); }, 1);
    await freshly(server, SHA2);
    await server.settle();
    clearInterval(watch);
    expect(missing).toEqual([]);
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "deployed", deployed: SHA2 });
    const now = stagingDbOf(mock.state);
    expect(now.uuid).not.toBe(old.uuid);
    expect(now.name).toMatch(/^erga-staging-[0-9a-z]{8,10}$/);
    expect(mock.state.deletedDatabases).toEqual([old.name]);
    expect(stagingCopies(mock.state)).toEqual([now.name]);
    expect(stepOf(t, "cleanup")).toMatchObject({ status: "done", detail: `deleted ${old.name}` });
    // In the log: the new version answered before the old copy went.
    const lines = (await server.instance.logOf("staging"))!.lines.map((l) => l.text);
    expect(lines.findIndex((l) => l.startsWith("Wait for it to answer: done"))).toBeLessThan(lines.findIndex((l) => l.startsWith("Delete the old copies of the database: done")));
    expect(writesToProduction(mock.state)).toEqual([]);
  });

  test("a failed build: staging stays on its version and its database, and the copy made beside it is deleted", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const old = stagingDbOf(mock.state), rows = [...old.rows!];
    const builder = mockBuilder(async () => release, { delayMs: 20 });
    const server = new Server(mock, builder, "erga-staging", stagingEnv());
    await server.instance.hook("staging", SHA2);
    await server.settle();
    builder.failNext = "bun install: lockfile changed";
    expect(await server.instance.redeploy("staging", "redeploy by ada", { fresh: true })).toMatchObject({ ok: true });
    await server.settle();
    const t = await server.status("staging");
    expect(t.state).toBe("failed");
    expect(stepOf(t, "database").status).toBe("done");
    expect(server.version()).toBe(SHA2.slice(0, 12));
    expect(stagingDbOf(mock.state).uuid).toBe(old.uuid);
    expect(stagingDbOf(mock.state).rows).toEqual(rows);
    expect(stagingCopies(mock.state)).toEqual([old.name]);
    expect(mock.state.deletedDatabases).toHaveLength(1);
    expect(mock.state.deletedDatabases[0]).not.toBe(old.name);
    expect((await server.instance.logOf("staging"))!.lines.map((l) => l.text)).toContainEqual(expect.stringContaining("deleted the copy this deploy made, which nothing uses"));
  });

  test("cleanup: a copy a stopped deploy left is deleted by the next one, never the one staging is on, nor production's", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const old = stagingDbOf(mock.state);
    // A deploy that died half way (its server gone before it could tidy up) left a copy; another project's database is there too.
    const stray = copyName("erga-staging", Date.now() - 60_000);
    mock.state.databases.push({ uuid: "dead0000-0000-4000-8000-000000000001", name: stray, statements: [], migrations: [], tables: [] } as never);
    mock.state.databases.push({ uuid: "dead0000-0000-4000-8000-000000000002", name: "erga-staging-notes", statements: [], migrations: [], tables: [] } as never);
    const server = new Server(mock, mockBuilder(async () => release), "erga-staging", stagingEnv());
    await server.instance.hook("staging", SHA2);
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(stepOf(t, "database").detail).toContain(`1 left by an earlier deploy deleted (${stray})`);
    expect(mock.state.deletedDatabases).toEqual([stray]);
    expect(stagingDbOf(mock.state).uuid).toBe(old.uuid);
    expect(mock.state.databases.map((d) => d.name)).toEqual(expect.arrayContaining(["erga", "erga-staging-notes", old.name]));
    expect(stepOf(t, "cleanup").detail).toBe("none to delete");
    // Production's database can't take a name like a copy's: the guard stops such a deploy before anything.
    expect(guardTarget({ ...staging(), guard: { ...staging().guard!, database: copyName("erga-staging", Date.now()) } })).toMatch(/name like a copy/);
  });

  test("a commit with a new migration, and a copy days old: staging keeps its database and documents, and the migration runs on them", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    // The copy is 3 days old, and staging has an edit of its own.
    const old = stagingDbOf(mock.state);
    old.name = copyName("erga-staging", Date.now() - 72 * 3600_000);
    mock.state.docs["erga-staging"].docs.get(PROD_DOCS[0])!.entries.set("file:index.html", new TextEncoder().encode("edited on staging"));
    const rows = [...old.rows!];
    const seen = exports(mock);
    // The commit adds a migration staging's database hasn't had.
    const migrated = { ...release, version: SHA2.slice(0, 12), migrations: { ...release.migrations, "0999_new_table.sql": "CREATE TABLE new_table (id TEXT PRIMARY KEY);" } };
    const server = new Server(mock, mockBuilder(async () => migrated), "erga-staging", stagingEnv());
    await server.instance.hook("staging", SHA2);
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(stepOf(t, "database").detail).toMatch(new RegExp(`^kept "${old.name}" .*frozen`));
    expect(stepOf(t, "data")).toMatchObject({ status: "skipped" });
    expect(stepOf(t, "documents")).toMatchObject({ status: "skipped" });
    expect(stepOf(t, "migrations")).toMatchObject({ status: "done", detail: expect.stringMatching(/^applied 0999_new_table.sql; restore point: version [0-9a-f]{8} \(release \w+\), database bookmark \S+$/) });
    expect(exports(mock)).toBe(seen);
    // The same database, its rows kept, the migration applied and recorded; staging's own edit kept.
    const db = stagingDbOf(mock.state);
    expect(db.uuid).toBe(old.uuid);
    expect(db.rows).toEqual(rows);
    expect(db.migrations).toContain("0999_new_table.sql");
    expect(db.statements.some((q) => q.includes("CREATE TABLE new_table"))).toBe(true);
    expect(mock.state.deletedDatabases).toEqual([]);
    expect(new TextDecoder().decode(mock.state.docs["erga-staging"].docs.get(PROD_DOCS[0])!.entries.get("file:index.html") as Uint8Array)).toBe("edited on staging");
    expect(server.version()).toBe(SHA2.slice(0, 12));
    expect(writesToProduction(mock.state)).toEqual([]);
  });

  test("Redeploy with a fresh copy: copied however new the copy is; production refuses it; a newer push keeps it asked for", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const old = stagingDbOf(mock.state);
    const server = new Server(mock, mockBuilder(async () => release), "erga-staging", stagingEnv());
    await server.instance.hook("staging", SHA2);
    await server.settle();
    expect(stepOf(await server.status("staging"), "data").status).toBe("skipped");
    expect(await server.instance.redeploy("staging", "redeploy by ada", { fresh: true })).toMatchObject({ ok: true });
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(stepOf(t, "database").detail).toContain("a fresh copy was asked for");
    expect(stepOf(t, "data").status).toBe("done");
    expect(stagingDbOf(mock.state).uuid).not.toBe(old.uuid);
    expect(t.log.some((l) => l.includes("asked for (redeploy by ada), with a fresh copy of production's data"))).toBe(true);
    // The next deploy, not asked: kept again.
    await server.instance.hook("staging", SHA3);
    await server.settle();
    expect(stepOf(await server.status("staging"), "data").status).toBe("skipped");
    // Asked for, then a push comes before it runs: the push's deploy copies afresh.
    await server.instance.redeploy("staging", "redeploy by ada", { fresh: true });
    await server.instance.hook("staging", SHA1, "push by bo");
    await server.settle();
    expect(stepOf(await server.status("staging"), "database").detail).toContain("a fresh copy was asked for");
    // Production takes no copy: refused.
    const prod = new Server(mock, mockBuilder(async () => release), "erga", env());
    expect(await prod.instance.redeploy("production", "redeploy by ada", { fresh: true })).toMatchObject({ ok: false, status: 400 });
    // The rule itself.
    const live = { made: Date.now() - 30 * 24 * 3600_000 };
    expect(copyReason({ live })).toBeNull();
    expect(copyReason({ live: { made: null } })).toBeNull();
    expect(copyReason({ fresh: true, live })).toBe("a fresh copy was asked for");
    expect(copyReason({ live: null })).toBe("there's no copy yet");
  });
});

describe("the release cache", () => {
  const memStore = () => {
    const m = new Map<string, { line: string; at: number; branch?: string }>();
    return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, line: string, meta: { at: number; branch?: string }) => { m.set(k, { line, ...meta }); } };
  };
  const body = (commit: string, branch: string) => JSON.stringify({ source: { cloneUrl: "x", token: "t" }, commit, branch });
  const src = { cloneUrl: "x", token: "t" };

  test("a commit built for staging is reused by production's build of it: no second build, the same release; a new toolchain builds again", async () => {
    const bundle = packRelease(join(ROOT, ".build/release"));
    let builds = 0;
    const fake = async (o: { log: (l: string) => void }) => { builds++; o.log("$ bun install"); return bundle; };
    const store = memStore();
    const toolchain = await toolchainKey({ bun: "1.4.2", builderVersion: "v-1" });
    const kept: Promise<unknown>[] = [];
    // The builder Worker, as worker.ts has it: the cache in front of the container's server.
    const worker = (tc: string | null) => ({ fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(new URL(String(input)), init);
      if (new URL(req.url).pathname != "/build") return builderServer(req, fake as never);
      return cachedBuild(await req.text(), { store, toolchain: tc, keep: (p) => kept.push(p), build: (b) => builderServer(new Request(req.url, { method: "POST", body: b }), fake as never) });
    }) as typeof fetch });
    const first = await containerBuilder(worker(toolchain)).build({ commit: SHA2, branch: "staging", source: src }, () => {});
    await Promise.all(kept);
    expect(builds).toBe(1);
    expect([...store.m.values()].map((v) => v.branch)).toEqual(["staging"]);
    const again: string[] = [];
    const second = await containerBuilder(worker(toolchain)).build({ commit: SHA2, branch: "main", source: src }, (l) => again.push(l));
    expect(builds).toBe(1);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatch(/^release cache: 222222222222 was built at .* \(for staging\) by this builder: that release is reused/);
    expect(second.version).toBe(first.version);
    expect(second.worker).toEqual(first.worker);
    for (const [n, b] of Object.entries(first.modules)) expect(second.modules[n]).toEqual(b);
    for (const [p, b] of Object.entries(first.assets)) expect(second.assets[p]).toEqual(b);

    // A new toolchain (the builder deployed again: a new image; a new Bun): a miss, and a build.
    const other = await toolchainKey({ bun: "1.4.2", builderVersion: "v-2" });
    expect(other).not.toBe(toolchain);
    expect(await toolchainKey({ bun: "1.5.0", builderVersion: "v-1" })).not.toBe(toolchain);
    await containerBuilder(worker(other)).build({ commit: SHA2, branch: "main", source: src }, () => {});
    await Promise.all(kept);
    expect(builds).toBe(2);
    expect(store.m.size).toBe(2);
    // No builder version (so no toolchain), or a short commit id: nothing kept or reused.
    expect(await toolchainKey({ bun: "1.4.2", builderVersion: undefined })).toBeNull();
    expect(releaseKey(SHA2.slice(0, 12), toolchain)).toBeNull();
    expect(releaseKey(SHA2, null)).toBeNull();
    await containerBuilder(worker(null)).build({ commit: SHA2, branch: "main", source: src }, () => {});
    await containerBuilder(worker(toolchain)).build({ commit: SHA2.slice(0, 12), branch: "main", source: src }, () => {});
    await Promise.all(kept);
    expect(builds).toBe(4);
    expect(store.m.size).toBe(2);
  });

  test("only a release the build ended with is kept: not a failed build, a log line, or a cancelled build", async () => {
    const store = memStore();
    const toolchain = await toolchainKey({ bun: "1.4.2", builderVersion: "v-1" });
    const kept: Promise<unknown>[] = [];
    const o = (build: () => Promise<Response>) => ({ store, toolchain, keep: (p: Promise<unknown>) => kept.push(p), build });
    await (await cachedBuild(body(SHA3, "staging"), o(async () => new Response(`${JSON.stringify({ log: "x" })}\n${JSON.stringify({ error: "bun install failed" })}\n`)))).text();
    await (await cachedBuild(body(SHA3, "staging"), o(async () => new Response(`${JSON.stringify({ log: '{"bundle":"no"}' })}\n`)))).text();
    const cancelled = await cachedBuild(body(SHA3, "staging"), o(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`${JSON.stringify({ bundle: "{}" })}\n`)); } }))));
    const reader = cancelled.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.all(kept);
    expect(store.m.size).toBe(0);
    // A refused build (409, 503) is passed on as it is.
    expect((await cachedBuild(body(SHA3, "staging"), o(async () => Response.json({ error: "busy" }, { status: 409 })))).status).toBe(409);
  });

  test("the same kept release on two targets: each gets its own settings, names, database and secrets at the upload", async () => {
    const store = memStore();
    const toolchain = await toolchainKey({ bun: "1.4.2", builderVersion: "v-1" });
    const bundle = new TextDecoder().decode(packRelease(join(ROOT, ".build/release")));
    const kept: Promise<unknown>[] = [];
    await (await cachedBuild(body(SHA2, "staging"), { store, toolchain, keep: (p) => kept.push(p), build: async () => new Response(`${JSON.stringify({ bundle })}\n`) })).text();
    await Promise.all(kept);
    const hit = await cachedBuild(body(SHA2, "main"), { store, toolchain, build: async () => { throw new Error("no build on a hit"); } });
    const line = (await hit.text()).trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.bundle)!;
    expect(line.bundle).toBe(bundle);
    const reused = await unpackRelease(line.bundle, SHA2.slice(0, 12));
    const mock = mockCloudflare({ fleet: true });
    await deployTo(staging({ secrets: stagingSecrets }), mock, reused);
    await deployTo(targetOf(TARGETS.production, env()), mock, await unpackRelease(line.bundle, SHA2.slice(0, 12)));
    const s = bindingsOf(mock.state, "erga-staging"), p = bindingsOf(mock.state, "erga");
    expect([s.DEPLOY_TARGET.text, p.DEPLOY_TARGET.text]).toEqual(["staging", "production"]);
    expect([s.SNAPSHOT_IMPORT.text, p.SNAPSHOT_IMPORT.text]).toEqual(["1", ""]);
    expect([s.PAGES_DOMAIN.text, p.PAGES_DOMAIN.text]).toEqual(["erga-pages-staging.dev", "erga-pages.dev"]);
    expect(p.DB.database_id).toBe(PROD_DB);
    expect(s.DB.database_id).not.toBe(PROD_DB);
    expect(s.GITHUB_CLIENT_ID.text).toBe(TARGETS.staging.vars.GITHUB_CLIENT_ID);
    expect(p.GITHUB_CLIENT_ID.text).toBe(TARGETS.production.vars.GITHUB_CLIENT_ID);
    expect(mock.state.secrets["erga-staging"].SESSION_SECRET).not.toBe(mock.state.secrets.erga.SESSION_SECRET);
    expect([s.ERGA_VERSION.text, p.ERGA_VERSION.text]).toEqual([SHA2.slice(0, 12), SHA2.slice(0, 12)]);
    expect(mock.state.domains.filter((d) => d.service == "erga-staging").map((d) => d.hostname)).toEqual(["staging.erga.dev"]);
  });

  test("kept in a Durable Object's storage in parts, the newest CACHE_KEEP only; a release with a part missing is a miss", async () => {
    const m = new Map<string, unknown>();
    const store = storageStore({
      get: (async (k: string | string[]) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k))) as never,
      put: async (e: Record<string, unknown>) => { for (const [k, v] of Object.entries(e)) m.set(k, v); },
      delete: async (ks: string[]) => ks.filter((k) => m.delete(k)).length,
    });
    const big = "x".repeat(CHUNK * 2 + 10);
    await store.put("a", big, { at: 1, branch: "staging" });
    expect([...m.keys()].filter((k) => k.startsWith("release:a:"))).toHaveLength(3);
    expect(await store.get("a")).toEqual({ line: big, at: 1, branch: "staging" });
    expect(await store.get("b")).toBeNull();
    for (let i = 0; i < CACHE_KEEP; i++) await store.put(`k${i}`, `line ${i}`, { at: 2 + i });
    expect(await store.get("a")).toBeNull();
    expect([...m.keys()].some((k) => k.startsWith("release:a"))).toBe(false);
    expect(await store.get("k0")).toMatchObject({ line: "line 0" });
    m.delete("release:k1:0");
    expect(await store.get("k1")).toBeNull();
  });

  test("the Bun in the cache's key is the image's, and the builder knows its own version", () => {
    const docker = readFileSync(join(ROOT, "control/builder/Dockerfile"), "utf8").match(/^FROM oven\/bun:([\d.]+)/m)?.[1];
    const worker = readFileSync(join(ROOT, "control/builder/worker.ts"), "utf8").match(/BUILDER_BUN = "([\d.]+)"/)?.[1];
    expect(worker).toBe(docker!);
    expect(readFileSync(join(ROOT, "control/wrangler.jsonc"), "utf8")).toContain('"version_metadata": { "binding": "CF_VERSION_METADATA" }');
  });
});

describe("the builder fetches only the commit", () => {
  const sh = (cwd: string, ...cmd: string[]) => {
    const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.exitCode != 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };

  test("depth 1: by its id, else the branch's head; the branch's history only when the commit is further back", async () => {
    const { buildCommit, spawnRunner } = await import("../control/builder/build");
    const tmp = mkdtempSync(join(tmpdir(), "erga-fetch-"));
    try {
      const repo = join(tmp, "repo");
      sh(tmp, "git", "init", "-q", "-b", "staging", repo);
      const commits: string[] = [];
      for (const n of [1, 2, 3]) { writeFileSync(join(repo, "f.txt"), `${n}\n`); sh(repo, "git", "add", "."); sh(repo, "git", "commit", "-qm", `c${n}`); commits.push(sh(repo, "git", "rev-parse", "HEAD")); }
      const url = `file://${repo}`;
      const build = async (commit: string, o: { byId?: boolean } = {}) => {
        const dir = join(tmp, `w-${commit.slice(0, 7)}-${o.byId === false ? "branch" : "id"}`), cmds: string[] = [], log: string[] = [];
        // Real git (a server that won't fetch by id refuses it here); the build's other steps are stubbed.
        const run = async (cmd: string[], x: Parameters<typeof spawnRunner>[1]) => {
          cmds.push(cmd.join(" "));
          if (cmd[0] == "git") {
            if (o.byId === false && cmd[1] == "fetch" && cmd.at(-1) == commit) throw new Error("not our ref");
            return spawnRunner(cmd, x);
          }
          if (cmd.join(" ") == "bun run release") { mkdirSync(join(dir, ".build/release"), { recursive: true }); writeFileSync(join(dir, ".build/release/release.json"), "{}"); }
        };
        await buildCommit({ source: { cloneUrl: url }, commit, branch: "staging", dir, log: (l) => log.push(l), run });
        return { dir, cmds, log, depth: Number(sh(dir, "git", "rev-list", "--count", "HEAD")), head: sh(dir, "git", "rev-parse", "HEAD") };
      };
      // The head, by its id: one commit of history.
      const head = await build(commits[2]);
      expect(head.head).toBe(commits[2]);
      expect(head.depth).toBe(1);
      expect(head.cmds.filter((c) => c.startsWith("git fetch"))).toEqual([`git fetch -q --no-tags --depth 1 ${url} ${commits[2]}`]);
      expect(sh(head.dir, "git", "rev-parse", "--is-shallow-repository")).toBe("true");
      expect(head.cmds.slice(-3)).toEqual(["bun install --frozen-lockfile", "bun run build", "bun run release"]);
      // A server that won't fetch by id: the branch's head, depth 1.
      const byBranch = await build(commits[2], { byId: false });
      expect(byBranch.head).toBe(commits[2]);
      expect(byBranch.depth).toBe(1);
      expect(byBranch.log).toContain("the source doesn't serve a commit by its id: fetching staging's head");
      // The branch moved on since: its history, and the commit checked out.
      const older = await build(commits[0], { byId: false });
      expect(older.head).toBe(commits[0]);
      expect(older.log).toContain(`staging has moved on from ${commits[0].slice(0, 12)}: fetching its history`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

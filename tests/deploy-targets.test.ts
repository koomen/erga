// The one deploy pipeline on Erga's own targets, against the mock Cloudflare's
// copy of Erga's account: production as cf deploy left it, with data in its
// database and documents in its Durable Objects. Nothing real is touched: no
// Cloudflare, no credentials, no production data.
//
// Staging: every step, its own Worker, database, Durable Objects, secrets and
// pages origin, a copy of production's database and documents, and nothing
// written to production. Production: its Worker replaced in place, its secrets
// kept. The guards. The snapshot endpoints, the documents' bucket, the config.

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { targetOf } from "../control/deploys/branches";
import { artifactsNamespace } from "../control/builder/build";
import { ALL_STEPS, guardTarget, runPipeline, targetOfPlan } from "../control/deploys/pipeline";
import { bucketName, workerMetadata } from "../control/deploys/account";
import { Cloudflare } from "../control/deploys/cloudflare-api";
import type { Release } from "../control/deploys/release-format";
import { FLEET_ACCOUNT, MOCK_SNAPSHOT_TOKEN, mockCloudflare, PROD_DB, PROD_DOCS } from "../dev/mock-cloudflare";
import { memoryStore, snapshotRoutes } from "../document/snapshot";
import { ACCOUNT, ADMINS, CONTROL, SOURCE, TARGETS } from "../deploy/targets";
import { controlConfig, controlWranglerConfig } from "../deploy/release";
import {
  prepareRelease,
  release,
  quick,
  env,
  stagingSecrets,
  staging,
  afresh,
  deployTo,
  bindingsOf,
  stagingDbOf,
  productionOf,
  writesToProduction,
  ROOT,
} from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

beforeAll(prepareRelease, 120_000);

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
    expect(b.ERGA_DEPLOYED).toBeUndefined();
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
    store.docs.set("abcd2345", {
      entries: new Map<string, unknown>([
        ["meta", { id: "abcd2345" }],
        ["state", new Uint8Array([9, 8])],
      ]),
      alarm: 5,
    });
    const req = (path: string, body: unknown, token = MOCK_SNAPSHOT_TOKEN) =>
      new Request(`https://x${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const routes = (r: Request, importAllowed = false, token: string | undefined = MOCK_SNAPSHOT_TOKEN) =>
      snapshotRoutes(r, { token, importAllowed, store });
    expect((await routes(req("/api/snapshot/docs", { ids: ["abcd2345"] }), false, ""))!.status).toBe(404);
    expect((await routes(req("/api/snapshot/docs", { ids: ["abcd2345"] }, "wrong-token-wrong-token-wrong-token-xx")))!.status).toBe(403);
    const r = await routes(req("/api/snapshot/docs", { ids: ["abcd2345", "nope0000"] }));
    const { docs } = await r!.json() as any;
    expect(docs).toEqual([{ id: "abcd2345", entries: [["meta", { j: { id: "abcd2345" } }], ["state", { b: btoa("\x09\x08") }]], alarm: 5 }]);
    expect((await routes(req("/api/snapshot/docs/import", { docs })))!.status).toBe(404);
    expect(
      (await routes(req("/api/snapshot/docs/import", { docs: [{ ...docs[0], id: "efgh6789" }], wipe: ["abcd2345"] }), true))!.status
    ).toBe(200);
    expect([...store.docs.keys()]).toEqual(["efgh6789"]);
    expect(store.docs.get("efgh6789")!.entries.get("state")).toEqual(new Uint8Array([9, 8]));
    expect(await routes(new Request("https://x/api/other"))).toBeNull();
  });

  test("an answer carries at most its budget: a document in parts, continued after its last key", async () => {
    const store = memoryStore();
    const bytes = (n: number) => new Uint8Array(n).fill(7);
    store.docs.set("abcd2345", { entries: new Map<string, unknown>([["meta", { id: "abcd2345" }], ["b:1", bytes(300)], ["b:2", bytes(300)], ["b:3", bytes(300)]]), alarm: 5 });
    store.docs.set("efgh6789", { entries: new Map<string, unknown>([["meta", { id: "efgh6789" }]]), alarm: null });
    const ask = async (body: unknown) =>
      (await (await snapshotRoutes(
        new Request("https://x/api/snapshot/docs", {
          method: "POST",
          headers: { Authorization: `Bearer ${MOCK_SNAPSHOT_TOKEN}` },
          body: JSON.stringify(body),
        }),
        { token: MOCK_SNAPSHOT_TOKEN, importAllowed: false, store, budget: 500 }
      ))!.json()) as any;
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

describe("one config file names the deployment (docs/self-host.md)", () => {
  test("control/wrangler.jsonc names nothing of the deployment: deploy/targets.json fills it in", () => {
    const wrangler = readFileSync(join(ROOT, "control/wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    for (const v of [ACCOUNT, ADMINS, CONTROL.host, CONTROL.worker, CONTROL.releases, ...Object.values(CONTROL.vars)]) expect(wrangler).not.toContain(v);
    const w = controlWranglerConfig("db-id") as { name: string; routes: unknown; d1_databases: unknown; artifacts: unknown; r2_buckets: unknown; vars: Record<string, string> };
    expect(w.name).toBe(CONTROL.worker);
    expect(w.routes).toEqual([{ pattern: CONTROL.host, custom_domain: true }]);
    expect(w.d1_databases).toEqual([{ binding: "DB", database_name: TARGETS.production.database, database_id: "db-id" }]);
    expect(w.artifacts).toEqual([{ binding: "ARTIFACTS", namespace: SOURCE.namespace }]);
    expect(w.r2_buckets).toEqual([{ binding: "RELEASES", bucket_name: CONTROL.releases }]);
    expect(w.vars).toEqual({ ADMINS, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, APP_URL: `https://${TARGETS.production.host}`, ...CONTROL.vars });
    // The release's copy of it has no database id: the pipeline finds the database by name.
    expect(controlConfig(controlWranglerConfig()).d1).toEqual([{ name: "DB", databaseName: TARGETS.production.database }]);
  });
});

describe("documents' files: an R2 bucket of each target's own", () => {
  test("the pipeline makes the bucket a release binds, once, and binds it by the target's Worker's name", async () => {
    const rel: Release = { ...release, worker: { ...release.worker, env: { ...release.worker.env, FILES: { type: "r2", name: "erga-files" } } } };
    const mock = mockCloudflare({ fleet: true });
    await deployTo(staging({ secrets: stagingSecrets }), mock, rel);
    expect(mock.state.buckets).toContain("erga-staging-files");
    expect(bindingsOf(mock.state, "erga-staging").FILES).toEqual({ type: "r2_bucket", name: "FILES", bucket_name: "erga-staging-files" });
    // Again: the bucket is there, so none is made.
    const made = () => mock.state.calls.filter((c) => c.startsWith("POST ") && c.endsWith("/r2/buckets")).length;
    const before = made();
    await deployTo(staging({ secrets: stagingSecrets }), mock, rel);
    expect(made()).toBe(before);
    expect(bucketName({ workerName: "erga" }, "FILES")).toBe("erga-files");
  });
});

describe("Erga's source on its own servers", () => {
  test("a release's Artifacts binding goes to no app Worker (the control Worker holds the repository); a target that names the namespace gets it", () => {
    const rel: Release = { ...release, worker: { ...release.worker, env: { ...release.worker.env, ARTIFACTS: { type: "artifacts", namespace: "erga" } } } };
    const meta = (t: Parameters<typeof workerMetadata>[1]) => workerMetadata(rel, t, { dbId: "db", assetsJwt: "jwt", pagesHost: null }).bindings as any[];
    expect(meta(targetOf(TARGETS.staging, { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT })).find((b) => b.name == "ARTIFACTS")).toBeUndefined();
    expect(meta({ ...targetOf(TARGETS.staging, { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT }), artifacts: "erga" }).find((b) => b.name == "ARTIFACTS")).toEqual({ type: "artifacts", name: "ARTIFACTS", namespace: "erga" });
    const plan = { accountId: FLEET_ACCOUNT, workerName: "erga", subdomain: "ada", createSubdomain: false, app: { kind: "workers.dev" as const }, pages: { kind: "shared" as const }, admin: "ada" } as any;
    expect(meta(targetOfPlan(plan, "s".repeat(32))).find((b) => b.name == "ARTIFACTS")).toBeUndefined();
  });

  test("a branch build binds the namespace the commit's own deploy/targets.json names", () => {
    expect(artifactsNamespace(ROOT)).toBe("erga");
    expect(artifactsNamespace("/nonexistent")).toBeNull();
  });
});

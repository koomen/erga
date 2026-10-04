// The one deploy pipeline (deploy/cloudflare.ts, runPipeline) on Erga's own
// targets, and branches deploying themselves (deploy/branches.ts), against
// the mock Cloudflare's copy of Erga's account (deploy/mock.ts, fleet):
// production as cf deploy left it, with data in its database and documents
// in its Durable Objects. Nothing real is touched: no Cloudflare, no
// credentials, no production data.
//
// Staging: every step, its own Worker, database, Durable Objects, secrets
// and pages origin, a fresh copy of production's database and documents
// each time, and nothing written to production. Production: its Worker
// replaced in place, its secrets kept. The guards. Failure and retry.
// Branch pushes: the hook, the queue, passing a push on to staging, the
// status and its events. And staging deploying itself: its own pipeline,
// in the server the previous deploy made, restarted by its own upload half
// way, the new version finishing the deploy.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { BranchDeploys, RESUME_MS, targetOf, type DeployEnv, type TargetStatus } from "../deploy/branches";
import { unpackRelease } from "../deploy/bundle";
import { packRelease } from "../deploy/builder/build";
import { handle as builderServer } from "../deploy/builder/server";
import { containerBuilder } from "../deploy/builder/client";
import { ALL_STEPS, Cloudflare, guardTarget, loadRelease, runPipeline, type Release, type Target } from "../deploy/cloudflare";
import { FLEET_ACCOUNT, MOCK_HOOK_SECRET, MOCK_SNAPSHOT_TOKEN, mockBuilder, mockCloudflare, PROD_DB, PROD_DOCS, type MockState } from "../deploy/mock";
import { memoryStore, snapshotDoor } from "../deploy/snapshot";
import { TARGETS } from "../deploy/targets";

const ROOT = new URL("..", import.meta.url).pathname;
let release: Release;

beforeAll(async () => {
  const dir = join(ROOT, ".site/release");
  if (!existsSync(join(dir, "release.json"))) {
    if (!existsSync(join(ROOT, ".site/page.js"))) expect(Bun.spawnSync([join(ROOT, "site.sh")], { cwd: ROOT }).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", join(ROOT, "deploy/release.ts")], { cwd: ROOT }).exitCode).toBe(0);
  }
  release = (await loadRelease(async (p) => (existsSync(join(dir, p)) ? new Uint8Array(readFileSync(join(dir, p))) : null)))!;
}, 120_000);

const SHA1 = "1111111111111111111111111111111111111111", SHA2 = "2222222222222222222222222222222222222222", SHA3 = "3333333333333333333333333333333333333333";
const quick = { sleep: async () => {}, waitMs: 2000 };
const env = (over: DeployEnv = {}): DeployEnv => ({ CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT, CLOUDFLARE_DEPLOY_TOKEN: "mock-deploy-token", SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: MOCK_HOOK_SECRET, ...over });
/** Staging's secrets, as deploy/setup.ts gives them to its first deploy. */
const stagingSecrets = { SESSION_SECRET: "staging-session-secret-0123456789", GITHUB_CLIENT_SECRET: "staging-github-secret-0123456789", SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: MOCK_HOOK_SECRET, CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" };
const staging = (over: Partial<Target> = {}): Target => ({ ...targetOf(TARGETS.staging, env()), ...over });

async function deployTo(target: Target, mock: ReturnType<typeof mockCloudflare>, rel: Release = release) {
  const steps: string[] = [];
  const result = await runPipeline(new Cloudflare("mock-deploy-token", mock.fetch), rel, target, { ...quick, site: mock.fetch, report: (id, status, detail) => steps.push(`${id}:${status}${detail ? ` ${detail}` : ""}`) });
  return { result, steps };
}

const bindingsOf = (state: MockState, script: string) => Object.fromEntries((state.scripts[script].metadata.bindings as any[]).map((b) => [b.name, b]));
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
    expect(result.pages).toBe("*.staging.erga-pages.dev");

    // Its own database: a new one, with production's rows and migrations.
    const db = mock.state.databases.find((d) => d.name == "erga-staging")!;
    const prod = mock.state.databases.find((d) => d.uuid == PROD_DB)!;
    expect(db.uuid).not.toBe(PROD_DB);
    expect(db.rows).toEqual(prod.rows!);
    expect(db.migrations).toEqual(prod.migrations);
    expect(steps).toContain("migrations:done already up to date");

    // Its own Worker: bound to its database, its settings, its secrets, the builder; Durable Objects of its own (a new Worker: no tombstone).
    const b = bindingsOf(mock.state, "erga-staging");
    expect(b.DB.database_id).toBe(db.uuid);
    expect(b.DOCS).toMatchObject({ type: "durable_object_namespace", class_name: "DocHost" });
    expect(b.DOCS.script_name).toBeUndefined();
    expect(b.DEPLOY_TARGET.text).toBe("staging");
    expect(b.SNAPSHOT_IMPORT.text).toBe("1");
    expect(b.PAGES_DOMAIN.text).toBe("staging.erga-pages.dev");
    expect(b.ERGA_VERSION.text).toBe(release.version);
    expect(b.CLOUDFLARE_ACCOUNT_ID.text).toBe(FLEET_ACCOUNT);
    expect(b.BUILDER).toEqual({ type: "service", name: "BUILDER", service: "erga-builder" });
    expect(b.ADMINS.text).toBe("koomen,dsiroker");
    expect(mock.state.secrets["erga-staging"].SESSION_SECRET).toBe(stagingSecrets.SESSION_SECRET);
    expect(mock.state.secrets["erga-staging"].SESSION_SECRET).not.toBe(mock.state.secrets.erga.SESSION_SECRET);
    const meta = mock.state.scripts["erga-staging"].metadata;
    expect(meta.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(meta.exports.DocList).toBeUndefined();
    expect(Object.keys(meta.exports).sort()).toEqual(Object.entries(release.worker.exports!).filter(([, e]) => e.state != "deleted").map(([n]) => n).sort());
    expect(mock.state.scripts["erga-staging"].namespaces.sort()).toEqual(Object.keys(meta.exports).sort());

    // Its addresses: staging.erga.dev, and documents' pages one level down on erga-pages.dev, routed ahead of production's wildcard.
    expect(mock.state.domains).toContainEqual({ hostname: "staging.erga.dev", service: "erga-staging", zone_id: "zone00000000000000000000000e7ga1" });
    const pagesZone = "zone00000000000000000000000e7ga2";
    expect(mock.state.routes[pagesZone]).toEqual([{ pattern: "*.erga-pages.dev/*", script: "erga" }, { pattern: "*.staging.erga-pages.dev/*", script: "erga-staging" }]);
    expect(mock.state.dns[pagesZone].map((r) => r.name)).toEqual(["*.erga-pages.dev", "*.staging.erga-pages.dev"]);

    // Production's documents, every key and alarm, in staging's Durable Objects.
    const ours = mock.state.docs["erga-staging"].docs, theirs = mock.state.docs.erga.docs;
    expect([...ours.keys()].sort()).toEqual([...PROD_DOCS].sort());
    for (const id of PROD_DOCS) {
      expect([...ours.get(id)!.entries]).toEqual([...theirs.get(id)!.entries]);
      expect(ours.get(id)!.alarm).toBe(theirs.get(id)!.alarm);
    }
    expect(steps.find((s) => s.startsWith("documents:done"))).toContain("3 documents copied");

    // Production: read (its database's export, its snapshot endpoint), never written.
    expect(writesToProduction(mock.state)).toEqual([]);
    expect(mock.state.calls.filter((c) => c.includes(PROD_DB))).toEqual([`POST /accounts/${FLEET_ACCOUNT}/d1/database/${PROD_DB}/export`, `POST /accounts/${FLEET_ACCOUNT}/d1/database/${PROD_DB}/export`]);
    expect(productionOf(mock.state)).toBe(before);
  });

  test("again: a fresh snapshot each time (staging's old copy gone, its own documents emptied), its secrets kept", async () => {
    const mock = mockCloudflare({ fleet: true });
    await deployTo(staging({ secrets: stagingSecrets }), mock);
    // Things happen on both: someone makes a document on staging, and one on production.
    const stagingDb = mock.state.databases.find((d) => d.name == "erga-staging")!;
    stagingDb.rows!.push("INSERT INTO documents (id, owner, slug, title) VALUES ('zzzz9999', 'bo', 'scratch', 'Scratch');");
    mock.state.docs["erga-staging"].docs.set("zzzz9999", { entries: new Map([["meta", { id: "zzzz9999" }]]), alarm: null });
    mock.state.docs["erga-staging"].docs.get(PROD_DOCS[0])!.entries.set("file:index.html", new TextEncoder().encode("edited on staging"));
    mock.state.databases.find((d) => d.uuid == PROD_DB)!.rows!.push("INSERT INTO documents (id, owner, slug, title) VALUES ('newp4567', 'ada', 'new', 'New');");
    mock.state.docs.erga.docs.set("newp4567", { entries: new Map<string, unknown>([["meta", { id: "newp4567" }], ["file:index.html", new TextEncoder().encode("new on production")]]), alarm: null });
    const before = productionOf(mock.state);

    const { steps } = await deployTo(staging(), mock);
    expect(mock.state.deletedDatabases).toEqual(["erga-staging"]);
    const db = mock.state.databases.find((d) => d.name == "erga-staging")!;
    expect(db.uuid).not.toBe(stagingDb.uuid);
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
    mock.state.databases.find((d) => d.name == "erga-staging")!.rows!.push("INSERT INTO documents (id, owner, slug, title) VALUES ('zzzz9999', 'bo', 's', 'S');");
    // Copying the database fails after the old one is deleted: what it had is carried to the next run.
    mock.state.failNext = "data";
    const carry: { oldDocs?: string[] } = {};
    const cf = new Cloudflare("mock-deploy-token", mock.fetch);
    await expect(runPipeline(cf, release, staging(), { ...quick, site: mock.fetch, carry, report: () => {} })).rejects.toThrow(/Cloudflare had a problem on its side while we tried to export erga \(read-only\)/);
    expect(carry.oldDocs).toContain("zzzz9999");
    const steps: string[] = [];
    await runPipeline(cf, release, staging(), { ...quick, site: mock.fetch, carry, report: (id, st, d) => steps.push(`${id}:${st} ${d ?? ""}`) });
    expect(mock.state.docs["erga-staging"].docs.has("zzzz9999")).toBe(false);
    expect(steps.find((s) => s.startsWith("documents:done"))).toContain("1 old ones emptied");
    // A failed Worker upload, then a retry: the same deploy.
    mock.state.failNext = "worker";
    await expect(deployTo(staging(), mock)).rejects.toThrow(/upload the Worker/);
    await deployTo(staging(), mock);
    expect(writesToProduction(mock.state)).toEqual([]);
  });

  test("before production serves snapshots, documents are skipped (and said so), not failed", async () => {
    const mock = mockCloudflare({ fleet: true });
    delete mock.state.secrets.erga.SNAPSHOT_TOKEN;
    const { steps } = await deployTo(staging({ secrets: stagingSecrets }), mock);
    expect(steps.find((s) => s.startsWith("documents:skipped"))).toContain("doesn't serve snapshots yet");
    expect(mock.state.databases.find((d) => d.name == "erga-staging")!.rows!.length).toBeGreaterThan(0);
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
});

/** A server of Erga's in the mock: its branch deploys over storage that outlives it, until its Worker is replaced ("restarted"). */
class Server {
  storage = new Map<string, unknown>();
  instance!: BranchDeploys;
  alive = { on: true };
  events = 0;
  scheduled: number[] = [];
  constructor(readonly mock: ReturnType<typeof mockCloudflare>, readonly builder: ReturnType<typeof mockBuilder>, readonly script: string, readonly fixedEnv?: DeployEnv) { this.start(); }
  /** Its settings and secrets as the mock has them for its Worker (what the last deploy gave it), unless fixed. */
  envOf(): DeployEnv {
    if (this.fixedEnv) return this.fixedEnv;
    const b = bindingsOf(this.mock.state, this.script);
    const s = this.mock.state.secrets[this.script] ?? {};
    return { DEPLOY_TARGET: b.DEPLOY_TARGET?.text, CLOUDFLARE_ACCOUNT_ID: b.CLOUDFLARE_ACCOUNT_ID?.text, CLOUDFLARE_DEPLOY_TOKEN: s.CLOUDFLARE_DEPLOY_TOKEN, SNAPSHOT_TOKEN: s.SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: s.DEPLOY_HOOK_SECRET };
  }
  /** A new version starts: a new object over the same storage. The old one, if running, can't reach anything any more. */
  start() {
    this.alive.on = false;
    const alive = (this.alive = { on: true });
    const storage = this.storage;
    this.instance = new BranchDeploys({
      storage: { get: async (k) => structuredClone(storage.get(k)) as any, put: async (k, v) => { if (alive.on) storage.set(k, structuredClone(v)); } },
      env: this.envOf(),
      net: async (input, init) => { if (!alive.on) throw new Error("Durable Object reset because its code was updated."); return this.mock.fetch(input, init); },
      builder: this.builder,
      schedule: (ms) => { if (alive.on) this.scheduled.push(ms); },
      changed: () => { if (alive.on) this.events++; },
      ...quick,
    });
  }
  version() { return bindingsOf(this.mock.state, this.script).ERGA_VERSION?.text; }
  async status(name: string): Promise<TargetStatus> { return (await this.instance.status({ remote: false })).targets.find((t) => t.name == name)!; }
  /** Wake it, as its alarm would, until nothing's scheduled. */
  async settle() { for (let i = 0; i < 10 && this.scheduled.length; i++) { this.scheduled = []; await this.instance.alarm(); } }
}

/** The first staging deploy, from a machine (deploy/run.ts, deploy/setup.ts): staging's Worker, with its secrets. */
async function bootstrap(mock: ReturnType<typeof mockCloudflare>) {
  await runPipeline(new Cloudflare("mock-setup-token", mock.fetch), { ...release, version: SHA1.slice(0, 12) }, staging({ secrets: stagingSecrets }), { ...quick, site: mock.fetch, report: () => {} });
}

describe("branches deploy themselves", () => {
  test("not set up (no deploy token): a push is noted, nothing deployed", async () => {
    const mock = mockCloudflare({ fleet: true });
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga", { DEPLOY_TARGET: "production", CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT });
    await server.instance.hook("main", SHA1);
    await server.settle();
    const t = await server.status("production");
    expect(t).toMatchObject({ name: "production", host: "erga.dev", branch: "main", state: "idle", commit: SHA1, error: null });
    expect(t.log.at(-1)).toContain("no CLOUDFLARE_DEPLOY_TOKEN");
    expect(builder.built).toEqual([]);
    expect(mock.state.calls).toEqual([]);
  });

  test("a push to staging, on staging: built, deployed, copied; the status and its events; failure and retry; pushes while it runs", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-staging", env({ DEPLOY_TARGET: "staging", CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" }));
    const before = productionOf(mock.state);

    await server.instance.hook("main", SHA2); // main isn't staging's: nothing
    expect(server.scheduled).toEqual([]);
    await server.instance.hook("staging", SHA2);
    expect(server.scheduled).toEqual([0]);
    expect((await server.status("staging")).pending).toBe(SHA2);
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ name: "staging", host: "staging.erga.dev", branch: "staging", state: "deployed", commit: SHA2, deployed: SHA2, error: null, pending: null, self: true });
    expect(Object.keys(t).sort()).toEqual(expect.arrayContaining(["name", "host", "branch", "state", "commit", "at", "error", "log"]));
    expect(t.steps.map((s) => `${s.id}:${s.status}`)).toEqual(["build:done", ...ALL_STEPS.map((s) => `${s.id}:done`)]);
    expect(t.log.some((l) => l.includes("build: $ bun install --frozen-lockfile"))).toBe(true);
    expect(t.log.at(-1)).toContain(`deployed ${SHA2.slice(0, 12)}`);
    expect(builder.built).toEqual([SHA2]);
    expect(server.version()).toBe(SHA2.slice(0, 12));
    expect(server.events).toBeGreaterThan(5);
    // Production, as the status says it: another server's.
    expect((await server.instance.status({ remote: false })).targets.map((x) => [x.name, x.self])).toEqual([["production", false], ["staging", true]]);

    // The build fails: the status says where and why; Redeploy runs it again.
    builder.failNext = "bun install: lockfile changed";
    await server.instance.hook("staging", SHA3);
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "failed", commit: SHA3, deployed: SHA2, error: "Stopped at “Build the commit”. Something went wrong: bun install: lockfile changed" });
    expect(server.version()).toBe(SHA2.slice(0, 12));
    const again = await server.instance.redeploy("staging");
    expect(again.ok).toBe(true);
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", commit: SHA3, deployed: SHA3 });

    // Two pushes while a deploy runs: the newest is deployed after it, once.
    const slow = mockBuilder(async () => release, { delayMs: 30 });
    const busy = new Server(mock, slow, "erga-staging", env({ DEPLOY_TARGET: "staging", CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" }));
    await busy.instance.hook("staging", SHA1);
    busy.scheduled = [];
    const running = busy.instance.alarm();
    await new Promise((r) => setTimeout(r, 20));
    await busy.instance.hook("staging", SHA2);
    await busy.instance.hook("staging", SHA3);
    await running;
    await busy.settle();
    expect(slow.built).toEqual([SHA1, SHA3]);
    expect(await busy.status("staging")).toMatchObject({ state: "deployed", deployed: SHA3, pending: null });

    // Redeploying a target this server doesn't deploy, or one that isn't: refused.
    expect(await server.instance.redeploy("production")).toMatchObject({ ok: false, error: expect.stringContaining("deploys itself") });
    expect(await server.instance.redeploy("nope")).toMatchObject({ ok: false, status: 404 });
    expect(writesToProduction(mock.state)).toEqual([]);
    expect(productionOf(mock.state)).toBe(before);
  });

  test("staging deploys itself: its own pipeline, restarted by its own upload, finished by the new version", async () => {
    let server: Server | null = null;
    // Uploading staging's Worker restarts staging's server: Cloudflare resets its Durable Objects, and the old one reaches nothing more.
    const mock = mockCloudflare({ fleet: true, onUpload: (script) => { if (script == "erga-staging" && server) server.alive.on = false; } });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    server = new Server(mock, builder, "erga-staging");
    expect(server.envOf()).toMatchObject({ DEPLOY_TARGET: "staging", CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token", CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT });
    expect(server.version()).toBe(SHA1.slice(0, 12));
    const before = productionOf(mock.state);

    for (const [i, sha] of [SHA2, SHA3].entries()) {
      // Staging's own server hears its branch moved and runs the deploy, until its own upload restarts it.
      await server.instance.hook("staging", sha);
      server.scheduled = [];
      await server.instance.alarm();
      expect(server.alive.on).toBe(false);
      // An alarm was set for the new version before the upload; the old one's record stops there.
      expect(server.scheduled).toContain(RESUME_MS);
      const mid = server.storage.get("target:staging") as any;
      expect(mid.status.state).toBe("deploying");
      expect(mid.run.cursor).toBe("worker");
      expect(server.version()).toBe(sha.slice(0, 12));

      // The new version (its settings from the Worker the old one uploaded) wakes up, sees its upload went up, and finishes the deploy.
      server.start();
      server.scheduled = [];
      await server.instance.alarm();
      const t = await server.status("staging");
      expect(t).toMatchObject({ state: "deployed", commit: sha, deployed: sha, error: null });
      expect(t.log.some((l) => l.includes("the new version is up and running this"))).toBe(true);
      expect(t.steps.map((x) => x.status)).toEqual(Array(ALL_STEPS.length + 1).fill("done"));
      expect([...mock.state.docs["erga-staging"].docs.keys()].sort()).toEqual([...PROD_DOCS].sort());
      expect(mock.state.versions["erga-staging"]).toBe(2 + i);
    }
    expect(builder.built).toEqual([SHA2, SHA3]);
    expect(writesToProduction(mock.state)).toEqual([]);
    expect(productionOf(mock.state)).toBe(before);
  });

  test("interrupted before the upload: marked failed (nothing changed), and Redeploy finishes it", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-staging");
    const s = server;
    // The server restarts (for any reason) while the assets go up.
    const calls = mock.state.calls;
    const watch = setInterval(() => { if (calls.some((c) => c.includes("assets-upload-session"))) s.alive.on = false; }, 0);
    await s.instance.hook("staging", SHA2);
    s.scheduled = [];
    await s.instance.alarm();
    clearInterval(watch);
    server.start();
    await server.instance.alarm();
    expect(await server.status("staging")).toMatchObject({ state: "failed", error: expect.stringContaining("interrupted before the new version went up") });
    expect(server.version()).toBe(SHA1.slice(0, 12));
    await server.instance.redeploy("staging");
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA2 });
  });

  test("production hears a push to staging and passes it on; staging deploys itself", async () => {
    const mock = mockCloudflare({
      fleet: true,
      sites: async (req, script) => {
        const url = new URL(req.url);
        if (script != "erga-staging" || !url.pathname.startsWith("/api/deploys/") || url.pathname == "/api/deploys/version") return null;
        if (req.headers.get("authorization") != `Bearer ${MOCK_HOOK_SECRET}`) return new Response("no", { status: 404 });
        if (url.pathname == "/api/deploys/status") return Response.json({ target: await staging.instance.own() });
        const r = await staging.instance.remoteHook("staging", await req.json() as any);
        return Response.json(r, { status: r.ok ? 200 : 400 });
      },
    });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const staging = new Server(mock, builder, "erga-staging");
    // Production's server, set up for branch deploys: it deploys main itself, and tells staging of staging's.
    const production = new Server(mock, builder, "erga", env({ DEPLOY_TARGET: "production" }));
    const before = productionOf(mock.state);
    await production.instance.hook("staging", SHA2);
    expect(production.scheduled).toEqual([]);
    expect(staging.scheduled).toEqual([0]);
    await staging.settle();
    expect(await staging.status("staging")).toMatchObject({ state: "deployed", deployed: SHA2 });
    // Production's status shows staging's, from staging itself.
    const seen = (await production.instance.status()).targets.find((t) => t.name == "staging")!;
    expect(seen).toMatchObject({ state: "deployed", deployed: SHA2, remote: true, self: false });
    expect((await production.status("staging")).log.at(-1)).toContain("passed on to staging.erga.dev");
    // A redeploy of staging asked on production goes to staging too.
    expect((await production.instance.redeploy("staging")).ok).toBe(true);
    expect(staging.scheduled).toEqual([0]);
    expect(builder.built).toEqual([SHA2]);
    expect(productionOf(mock.state)).toBe(before);
    // Staging never tells production anything: a push to main heard on staging stays there.
    await staging.instance.hook("main", SHA3);
    expect(production.scheduled).toEqual([]);
  });
});

describe("the builder", () => {
  test("the container's server streams the build and hands back the release; the pipeline's client reads it", async () => {
    const bundle = packRelease(join(ROOT, ".site/release"));
    const fake = async (o: { log: (l: string) => void; commit: string }) => { o.log(`$ bun install (${o.commit.slice(0, 7)})`); o.log("$ ./site.sh"); return bundle; };
    const fetcher = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => builderServer(new Request(new URL(String(input)), init), fake as never)) as typeof fetch };
    const lines: string[] = [];
    const built = await containerBuilder(fetcher).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "https://artifacts.mock/git/erga/erga.git", token: "t" } }, (l) => lines.push(l));
    expect(lines).toEqual(["$ bun install (2222222)", "$ ./site.sh"]);
    expect(built.version).toBe(SHA2.slice(0, 12));
    expect(Object.keys(built.modules).sort()).toEqual(Object.keys(release.modules).sort());
    expect(Object.keys(built.assets).sort()).toEqual(Object.keys(release.assets).sort());
    expect((await unpackRelease(bundle)).migrations).toEqual(release.migrations);
    // A failed build says why.
    const failing = { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => builderServer(new Request(new URL(String(input)), init), (async () => { throw new Error("bun install failed (exit 1)"); }) as never)) as typeof fetch };
    await expect(containerBuilder(failing).build({ commit: SHA2, branch: "staging", source: { cloneUrl: "x", token: "t" } }, () => {})).rejects.toThrow(/The build failed: bun install failed/);
  });
});

describe("the one-time setup", () => {
  test("deploy/setup.ts says what it will do, and (against the mock) does it: production's two secrets, staging's first deploy", () => {
    const dry = Bun.spawnSync(["bun", join(ROOT, "deploy/setup.ts"), "--dry-run"], { cwd: ROOT, env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" } });
    const said = dry.stdout.toString();
    expect(dry.exitCode).toBe(0);
    expect(said).toContain("8. Check it");
    expect(said).toContain("--dry-run: nothing done.");
    const run = Bun.spawnSync(["bun", join(ROOT, "deploy/setup.ts"), "--yes"], { cwd: ROOT, env: { ...process.env, ERGA_DEPLOY_MOCK: "1", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" } });
    const out = run.stdout.toString();
    expect(run.exitCode).toBe(0);
    expect(out).toContain("(the mock Cloudflare: nothing real)");
    expect(out).toContain("secrets set: SESSION_SECRET, GITHUB_CLIENT_SECRET, CLOUDFLARE_DEPLOY_TOKEN, SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET\n");
    expect(out).toContain("Copy production's documents into it: done, 3 documents copied");
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

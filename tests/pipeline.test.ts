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
import { ATTEMPTS, BranchDeploys, HISTORY_KEEP, RESUME_MS, targetOf, type DeployEnv, type DeployRecord, type Deps, type LogLine, type TargetStatus } from "../deploy/branches";
import { fromBase64, unpackRelease } from "../deploy/bundle";
import { packRelease } from "../deploy/builder/build";
import { handle as builderServer } from "../deploy/builder/server";
import { containerBuilder, ndjsonLines } from "../deploy/builder/client";
import { ALL_STEPS, Cloudflare, guardTarget, loadRelease, runPipeline, type Release, type Target } from "../deploy/cloudflare";
import { FLEET_ACCOUNT, MOCK_HOOK_SECRET, MOCK_SNAPSHOT_TOKEN, mockBuilder, mockCloudflare, namespaceId, PROD_DB, PROD_DOCS, scriptTag, type MockState } from "../deploy/mock";
import { memoryStore, snapshotDoor } from "../deploy/snapshot";
import { FACTORY, TARGETS } from "../deploy/targets";
import { imageTag } from "../factory/vm/build";

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
    expect(result.pages).toBe("*.erga-pages-staging.dev");

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
    expect(b.PAGES_DOMAIN.text).toBe("erga-pages-staging.dev");
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
    expect(steps.filter((s) => s.endsWith(":running")).map((s) => s.split(":")[0])).toEqual(["account", "database", "migrations", "assets", "image", "worker", "vms", "address", "pages", "live"]);
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
    return { DEPLOY_TARGET: b.DEPLOY_TARGET?.text, CLOUDFLARE_ACCOUNT_ID: b.CLOUDFLARE_ACCOUNT_ID?.text, CLOUDFLARE_DEPLOY_TOKEN: s.CLOUDFLARE_DEPLOY_TOKEN, SNAPSHOT_TOKEN: s.SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: s.DEPLOY_HOOK_SECRET };
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
    // Production, as the status says it: another server's.
    expect((await server.instance.status({ remote: false })).targets.map((x) => [x.name, x.self])).toEqual([["production", false], ["staging", true]]);

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
    const busy = new Server(mock, slow, "erga-staging", env({ DEPLOY_TARGET: "staging", CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" }));
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
      // Its log so far is kept, up to the upload.
      const kept = server.storage.get(`log:staging:${mid.run.deployId}`) as any;
      expect(kept.deployId).toBe(mid.run.deployId);
      expect(["assets", "image", "worker"]).toContain(kept.lines.at(-1).step);
      const before = kept.lines.length;

      // The new version (its settings from the Worker the old one uploaded) wakes up, sees its upload went up, and finishes the deploy.
      server.start();
      server.scheduled = [];
      server.logs = [];
      await server.instance.alarm();
      const t = await server.status("staging");
      expect(t).toMatchObject({ state: "deployed", commit: sha, deployed: sha, error: null });
      expect(t.log.some((l) => l.includes("the new version is up and running this"))).toBe(true);
      expect(t.steps.map((x) => x.status)).toEqual(Array(ALL_STEPS.length + 1).fill("done"));
      // One log across the restart: the old version's lines, then the new one's, under the same deploy; the new one's go out as events too.
      const log = (await server.instance.logOf("staging"))!;
      expect(log).toMatchObject({ deployId: mid.run.deployId, commit: sha, state: "deployed" });
      expect(log.lines.slice(0, before)).toEqual(kept.lines);
      const after: string[] = log.lines.slice(before).map((l) => l.step ?? "-");
      expect(after.slice(0, 2)).toEqual(["worker", "-"]);
      expect(["address", "pages", "live", "documents"].every((id) => after.includes(id))).toBe(true);
      expect(server.logs.length).toBeGreaterThan(0);
      expect(server.logs.every((e) => e.deployId == mid.run.deployId)).toBe(true);
      expect(server.logs.flatMap((e) => e.lines)).toEqual(log.lines.slice(before));
      expect([...mock.state.docs["erga-staging"].docs.keys()].sort()).toEqual([...PROD_DOCS].sort());
      expect(mock.state.versions["erga-staging"]).toBe(2 + i);
    }
    expect(builder.built).toEqual([SHA2, SHA3]);
    expect(writesToProduction(mock.state)).toEqual([]);
    expect(productionOf(mock.state)).toBe(before);
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

  test("production hears a push to staging and passes it on; staging deploys itself", async () => {
    const mock = mockCloudflare({
      fleet: true,
      sites: async (req, script) => {
        const url = new URL(req.url);
        if (script != "erga-staging" || !url.pathname.startsWith("/api/deploys/") || url.pathname == "/api/deploys/version") return null;
        if (req.headers.get("authorization") != `Bearer ${MOCK_HOOK_SECRET}`) return new Response("no", { status: 404 });
        if (url.pathname == "/api/deploys/status") return Response.json({ target: await staging.instance.own() });
        if (url.pathname == "/api/deploys/staging/log") return Response.json(await staging.instance.logOf("staging"));
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
    // And staging's log, from staging.
    expect(await production.instance.logOf("staging")).toEqual(await staging.instance.logOf("staging"));
    expect((await production.instance.logOf("staging"))!.lines.length).toBeGreaterThan(10);
    // A redeploy of staging asked on production goes to staging too.
    expect((await production.instance.redeploy("staging")).ok).toBe(true);
    expect(staging.scheduled).toEqual([0]);
    expect(builder.built).toEqual([SHA2]);
    expect(productionOf(mock.state)).toBe(before);
    // A move of main heard on staging: production isn't told what to deploy without reading its own repository.
    await staging.instance.hook("main", SHA3, "merge by ada");
    expect(production.scheduled).toEqual([]);
  });

  test("a merge to main heard on staging deploys production: production reads main's head itself", async () => {
    let main = SHA2;
    const mock = mockCloudflare({
      fleet: true,
      sites: async (req, script) => {
        const url = new URL(req.url);
        if (script != "erga" || !url.pathname.startsWith("/api/deploys/") || url.pathname == "/api/deploys/version") return null;
        if (req.headers.get("authorization") != `Bearer ${MOCK_HOOK_SECRET}`) return new Response("no", { status: 404 });
        if (url.pathname == "/api/deploys/status") return Response.json({ target: await production.instance.own(Number(url.searchParams.get("history") ?? 0)) });
        if (url.pathname == "/api/deploys/production/history") return Response.json({ target: "production", deploys: await production.instance.historyOf("production", 5) });
        if (url.pathname == "/api/deploys/production/log") return Response.json(await production.instance.logOf("production", url.searchParams.get("deploy") ?? undefined));
        const r = await production.instance.remoteHook("production", await req.json() as any);
        return Response.json(r, { status: r.ok ? 200 : 400 });
      },
    });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const staging = new Server(mock, builder, "erga-staging");
    const production = new Server(mock, builder, "erga", env({ DEPLOY_TARGET: "production" }), { headOf: async (b) => (b == "main" ? main : null) });
    // Staging names SHA3, but main's head (as production's own repository has it) is SHA2: SHA2 is deployed.
    await staging.instance.hook("main", SHA3, "merge by ada");
    expect(production.scheduled).toEqual([0]);
    await production.settle();
    expect(await production.status("production")).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(builder.built).toEqual([SHA2]);
    const [rec] = (await production.instance.historyOf("production"))!;
    expect(rec).toMatchObject({ commit: SHA2, state: "deployed", trigger: "merge by ada, passed on", live: true });
    expect((await production.status("production")).log.some((l) => l.includes(`another server said ${SHA3.slice(0, 12)}`))).toBe(true);
    // Staging's dashboard has production's history and logs, from production.
    const seen = (await staging.instance.status({ history: 5 })).targets.find((t) => t.name == "production")!;
    expect(seen).toMatchObject({ remote: true, deployed: SHA2 });
    expect(seen.history!.map((r) => r.id)).toEqual([rec.id]);
    expect(await staging.instance.historyOf("production")).toEqual([{ ...rec }]);
    expect((await staging.instance.logOf("production", rec.id))!.deployId).toBe(rec.id);
    // Without its repository, production refuses a move another server names; staging can't redeploy production.
    const blind = new Server(mock, builder, "erga", env({ DEPLOY_TARGET: "production" }));
    expect(await blind.instance.remoteHook("production", { branch: "main", commit: SHA3 })).toMatchObject({ ok: false, error: expect.stringContaining("own repository") });
    expect(await staging.instance.redeploy("production")).toMatchObject({ ok: false, status: 409 });
    main = SHA3;
  });
});

describe("a newer deploy cancels the running one", () => {
  const stagingEnv = () => env({ DEPLOY_TARGET: "staging", CLOUDFLARE_DEPLOY_TOKEN: "mock-staging-deploy-token" });

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

  test("across a restart: a deploy its own upload interrupted isn't carried on when a newer one waits", async () => {
    let server: Server | null = null;
    const mock = mockCloudflare({ fleet: true, onUpload: (script) => { if (script == "erga-staging" && server) server.alive.on = false; } });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    server = new Server(mock, builder, "erga-staging");
    await server.instance.hook("staging", SHA2, "push by ada");
    server.scheduled = [];
    await server.instance.alarm();
    expect(server.alive.on).toBe(false);
    const mid = server.storage.get("target:staging") as any;
    expect([mid.status.state, mid.run.cursor]).toEqual(["deploying", "worker"]);
    // The new version starts; before its alarm, a newer push comes.
    server.start();
    await server.instance.hook("staging", SHA3, "push by bo");
    server.scheduled = [];
    await server.instance.alarm();
    // SHA2's run was not carried on: cancelled. SHA3's own upload restarts the server again; the next version finishes SHA3.
    const old = (await server.instance.historyOf("staging"))!.find((r) => r.commit == SHA2)!;
    expect(old).toMatchObject({ state: "cancelled", supersededBy: SHA3 });
    const oldLog = (await server.instance.logOf("staging", old.id))!;
    expect(oldLog.lines.some((l) => l.text.includes("not carried on"))).toBe(true);
    expect(oldLog.lines.some((l) => l.text.includes("the new version is up and running this"))).toBe(false);
    server.start();
    await server.instance.alarm();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA3, pending: null });
    expect(builder.built).toEqual([SHA2, SHA3]);
    const [now] = (await server.instance.historyOf("staging"))!;
    expect(now).toMatchObject({ commit: SHA3, state: "deployed", live: true });
    expect((await server.instance.historyOf("staging"))!.find((r) => r.commit == SHA2)!.replacedBy).toBe(now.id);
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

describe("the factory's VMs (Containers)", () => {
  test("staging: the image prepared, named on the version for FactoryVm, the application made once, previews on the pages domain", async () => {
    const mock = mockCloudflare({ fleet: true });
    const target = staging({ secrets: stagingSecrets });
    expect(target.factory).toEqual({ image: `registry.cloudflare.com/${FLEET_ACCOUNT}/erga-factory@${FACTORY.image.split("@")[1]}`, previews: "erga-pages-staging.dev" });
    const { steps } = await deployTo(target, mock);
    expect(steps).toContain(`image:done ${target.factory!.image}, ready`);
    expect(mock.state.containers.prepared).toEqual([target.factory!.image]);
    const meta = mock.state.scripts["erga-staging"].metadata;
    expect(meta.containers).toEqual([{ name: "erga-staging-factoryvm", class_name: "FactoryVm", images: { factory: target.factory!.image } }]);
    expect(meta.exports.FactoryVm).toEqual({ type: "durable-object", storage: "sqlite" });
    const b = bindingsOf(mock.state, "erga-staging");
    expect(b.FACTORY_VM).toMatchObject({ type: "durable_object_namespace", class_name: "FactoryVm" });
    expect(b.FACTORY_PREVIEW_DOMAIN.text).toBe("erga-pages-staging.dev");
    expect(b.FACTORY_IMAGE.text).toBe(target.factory!.image);
    const ns = namespaceId("erga-staging", "FactoryVm");
    expect(mock.state.containers.apps[ns]).toEqual({ name: "erga-staging-factoryvm", scheduling_policy: "durable_object", durable_objects: { namespace_id: ns } });
    // Made after the upload, as wrangler does: one upload.
    expect(steps.find((x) => x.startsWith("vms:done"))).toContain("made");
    expect(mock.state.calls.filter((c) => c == "PUT /accounts/0123456789abcdef0123456789abcdef/workers/scripts/erga-staging").length).toBe(1);
    // Again: the same application, found, not made twice, and one upload.
    const before = mock.state.versions["erga-staging"];
    const again = await deployTo(staging({ secrets: stagingSecrets }), mock);
    expect(again.steps.find((x) => x.startsWith("vms:done"))).toContain("already there");
    expect(mock.state.versions["erga-staging"]).toBe(before + 1);
    expect(Object.keys(mock.state.containers.apps)).toEqual([ns]);
  });

  test("a deploy token that may not use Containers: the version goes up without the VMs, and the log says why", async () => {
    const mock = mockCloudflare({ fleet: true, scopedContainers: "refuse" });
    await deployTo(staging({ secrets: stagingSecrets }), mock);
    // A token made through the API, as deploy/tokens.ts makes the servers' (Editor on erga-staging, no Containers).
    const cf = new Cloudflare("mock-machine", mock.fetch);
    const made = await cf.call<{ id: string; value: string }>("POST", `/accounts/${FLEET_ACCOUNT}/tokens`, "make a token", { name: "t", policies: [
      { effect: "allow", permission_groups: [{ id: "7e79ec33834341f28dd431ab73884400" }], resources: { [`com.cloudflare.api.account.${FLEET_ACCOUNT}`]: { [`com.cloudflare.edge.worker.script.${scriptTag("erga-staging")}`]: "*" } } },
      { effect: "allow", permission_groups: [{ id: "09b2857d1c31407795e75e3fed8617a1" }], resources: { [`com.cloudflare.api.account.${FLEET_ACCOUNT}`]: "*" } },
      { effect: "allow", permission_groups: [{ id: "c8fed203ed3043cba015a93ad1616f1f" }, { id: "2072033d694d415a936eaeb94e6405b8" }, { id: "82e64a83756745bbbb1c9c2701bf816b" }], resources: Object.fromEntries(mock.state.zones.map((z) => [`com.cloudflare.api.account.zone.${z.id}`, "*"])) },
    ] });
    const steps: string[] = [];
    await runPipeline(new Cloudflare(made!.value, mock.fetch), release, staging(), { ...quick, site: mock.fetch, report: (id, status, detail) => steps.push(`${id}:${status}${detail ? ` ${detail}` : ""}`) });
    expect(steps.find((x) => x.startsWith("image:done"))).toContain("may not use Containers");
    expect(steps.find((x) => x.startsWith("worker:done"))).toContain("without the factory's VMs");
    expect(steps.find((x) => x.startsWith("vms:skipped"))).toBeTruthy();
    const meta = mock.state.scripts["erga-staging"].metadata;
    expect(meta.containers).toBeUndefined();
    expect(bindingsOf(mock.state, "erga-staging").FACTORY_PREVIEW_DOMAIN).toBeUndefined();
    // The rest of the deploy is the same: live, its release answering.
    expect(steps.find((x) => x.startsWith("live:done"))).toBeTruthy();
  });

  test("a release from before the factory's VMs (no FactoryVm): both steps skipped, nothing about Containers asked", async () => {
    const mock = mockCloudflare({ fleet: true });
    const old: Release = { ...release, worker: { ...release.worker, exports: Object.fromEntries(Object.entries(release.worker.exports!).filter(([n]) => n != "FactoryVm")), env: Object.fromEntries(Object.entries(release.worker.env).filter(([n]) => n != "FACTORY_VM")) } };
    const { steps } = await deployTo(staging({ secrets: stagingSecrets }), mock, old);
    expect(steps.find((x) => x.startsWith("image:") && !x.endsWith(":running"))).toMatch(/^image:skipped/);
    expect(steps.find((x) => x.startsWith("vms:") && !x.endsWith(":running"))).toMatch(/^vms:skipped/);
    expect(mock.state.calls.some((c) => c.includes("/containers/"))).toBe(false);
    expect(mock.state.scripts["erga-staging"].metadata.containers).toBeUndefined();
  });

  test("factory.image in deploy/targets.json is the image factory/vm/build.ts tags, pinned by its digest", () => {
    expect(FACTORY.image).toMatch(/^erga-factory:[0-9a-f]{12}@sha256:[0-9a-f]{64}$/);
    expect(FACTORY.image.split("@")[0]).toBe(imageTag());
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

  test("the release, one line of ~15 MB in small chunks, is read in one pass (it reset the Pipeline object on 2026-10-05)", async () => {
    const bundle = packRelease(join(ROOT, ".site/release"));
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
    const { spawnRunner } = await import("../deploy/builder/build");
    const kill = new AbortController();
    const started = Date.now();
    setTimeout(() => kill.abort(new Error("cancelled")), 50);
    await expect(spawnRunner(["sleep", "5"], { cwd: ROOT, log: () => {}, signal: kill.signal })).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("the one-time setup", () => {
  test("deploy/setup.ts says what it will do, and (against the mock) does it: production's two secrets, staging's first deploy, staging's deploy token", () => {
    const dry = Bun.spawnSync(["bun", join(ROOT, "deploy/setup.ts"), "--dry-run"], { cwd: ROOT, env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" } });
    const said = dry.stdout.toString();
    expect(dry.exitCode).toBe(0);
    expect(said).toContain("11. Check it");
    expect(said).toContain("Individual Workers Editor: erga-staging (nothing else)");
    expect(said).toContain("--dry-run: nothing done.");
    const run = Bun.spawnSync(["bun", join(ROOT, "deploy/setup.ts"), "--yes"], { cwd: ROOT, env: { ...process.env, ERGA_DEPLOY_MOCK: "1", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" } });
    const out = run.stdout.toString();
    expect(run.exitCode).toBe(0);
    expect(out).toContain("(the mock Cloudflare: nothing real)");
    expect(out).toContain("secrets set: SESSION_SECRET, FACTORY_KEY, SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET, GITHUB_CLIENT_SECRET\n");
    expect(out).toContain("the zone's free Universal SSL certificate covers it (it covers *.erga-pages-staging.dev).");
    expect(out).toContain("There's one already (Universal SSL).");
    expect(out).toContain("Made and checked: it deploys erga-staging, reads erga.dev and erga-pages-staging.dev, and can't reach erga or write DNS and routes.");
    expect(out).toContain("Stored on erga-staging as CLOUDFLARE_DEPLOY_TOKEN (not printed).");
    expect(out).not.toContain("mock-scoped-");
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

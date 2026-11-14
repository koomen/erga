// The one deploy pipeline on an instance that runs already and on its staging
// instance, against the mock Cloudflare's example account (the fleet): the
// instance as a deploy left it, with data in its database and documents in its
// Durable Objects. Nothing real is touched: no Cloudflare, no credentials.
//
// The staging instance: every step, its own Worker, database, Durable Objects,
// secrets and pages origin, a copy of its primary's database and documents, and
// nothing written to its primary. The instance itself: its Worker replaced in
// place, its secrets kept. The guards. The snapshot endpoints, the documents' bucket.

import { beforeAll, describe, expect, test } from "bun:test";
import { ALL_STEPS, guardTarget, runPipeline } from "../deploy/pipeline/pipeline";
import { bucketName, ownCredentials } from "../deploy/pipeline/account";
import { Cloudflare } from "../deploy/pipeline/cloudflare-api";
import type { Release } from "../deploy/pipeline/release-format";
import { FLEET_ACCOUNT, MOCK_SNAPSHOT_TOKEN, mockCloudflare, PRIMARY_DB, PRIMARY_DOCS } from "../dev/mock-cloudflare";
import { memoryStore, SNAPSHOT_MINUTES, snapshotAuth, snapshotRoutes } from "../document/snapshot";
import {
  prepareRelease,
  release,
  quick,
  primary,
  stagingSecrets,
  staging,
  afresh,
  deployTo,
  bindingsOf,
  stagingDbOf,
  primaryOf,
  writesToPrimary,
} from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

beforeAll(prepareRelease, 120_000);

describe("a staging instance", () => {
  test("its own Worker, database, Durable Objects and pages origin, and a copy of its primary's data; its primary untouched", async () => {
    const mock = mockCloudflare({ fleet: true });
    const before = primaryOf(mock.state);
    const { result, steps } = await deployTo(staging({ secrets: stagingSecrets }), mock);
    expect(steps.filter((s) => s.endsWith(":running")).map((s) => s.split(":")[0])).toEqual(ALL_STEPS.map((s) => s.id));
    expect(result.url).toBe("https://staging.example.com");
    expect(result.pages).toBe("*.example-pages-staging.com");

    // Its own database: a new one, with its primary's rows and migrations, then the migrations its primary hasn't had yet
    // (the mock's primary stops at 0110_admin_keys.sql; staging runs ahead of it with the newer ones).
    const db = stagingDbOf(mock.state);
    const prod = mock.state.databases.find((d) => d.uuid == PRIMARY_DB)!;
    expect(db.uuid).not.toBe(PRIMARY_DB);
    expect(db.rows).toEqual(prod.rows!);
    const all = Object.keys(release.migrations).sort(), newer = all.filter((n) => !prod.migrations.includes(n));
    expect(db.migrations).toEqual([...prod.migrations, ...newer]);
    expect(db.migrations).toEqual(all);
    // The restore point is recorded first (staging's Worker is new here: no version to go back to; the copy's bookmark).
    expect(steps.find((s) => s.startsWith("migrations:done"))).toMatch(
      new RegExp(
        `^${newer.length ? `migrations:done applied ${newer.join(", ")}` : "migrations:done already up to date"}; restore point: no version, database bookmark \\S+; no API keys of its own to keep; 0 of its people's own keys kept$`
      )
    );

    // Its own Worker: bound to its database, its settings, its secrets; Durable Objects of its own.
    const b = bindingsOf(mock.state, "erga-staging");
    expect(b.DB.database_id).toBe(db.uuid);
    expect(b.DOCUMENTS).toMatchObject({ type: "durable_object_namespace", class_name: "DocumentObject" });
    expect(b.DOCUMENTS.script_name).toBeUndefined();
    // One fact says that it is a staging instance: its primary's address. No other flag.
    expect(b.DEPLOY_TARGET).toBeUndefined();
    expect(b.SNAPSHOT_IMPORT).toBeUndefined();
    expect(b.PAGES_DOMAIN.text).toBe("example-pages-staging.com");
    expect(b.ERGA_VERSION.text).toBe(release.version);
    expect(b.ERGA_DEPLOYED).toBeUndefined();
    expect(b.ARTIFACTS).toBeUndefined();
    // No admin in the deploy; its primary's address, where staging reads the documents' images (as bun erga deploy sets it).
    expect(b.ADMINS).toBeUndefined();
    expect(b.SNAPSHOT_FROM.text).toBe("https://example.com");
    expect(mock.state.secrets["erga-staging"].SESSION_SECRET).toBe(stagingSecrets.SESSION_SECRET);
    expect(mock.state.secrets["erga-staging"].SESSION_SECRET).not.toBe(mock.state.secrets.erga.SESSION_SECRET);
    const meta = mock.state.scripts["erga-staging"].metadata;
    expect(meta.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(Object.keys(meta.exports).sort()).toEqual(Object.keys(release.worker.exports!).sort());
    expect(Object.values(meta.exports)).toEqual(Object.keys(meta.exports).map(() => ({ type: "durable-object", storage: "sqlite" })));
    expect(mock.state.scripts["erga-staging"].namespaces.sort()).toEqual(Object.keys(meta.exports).sort());

    // Its addresses: staging.example.com, and documents' pages on a zone of their own (example-pages-staging.com: its Universal SSL covers them).
    expect(mock.state.domains).toContainEqual({
      hostname: "staging.example.com",
      service: "erga-staging",
      zone_id: "zone00000000000000000000000e7ga1",
    });
    const pagesZone = "zone00000000000000000000000e7ga3";
    expect(mock.state.routes[pagesZone]).toEqual([{ pattern: "*.example-pages-staging.com/*", script: "erga-staging" }]);
    expect(mock.state.dns[pagesZone].map((r) => r.name)).toEqual(["*.example-pages-staging.com"]);
    // Its primary's pages zone: nothing of staging's.
    expect(mock.state.routes["zone00000000000000000000000e7ga2"]).toEqual([{ pattern: "*.example-pages.com/*", script: "erga" }]);
    expect(mock.state.dns["zone00000000000000000000000e7ga2"].map((r) => r.name)).toEqual(["*.example-pages.com"]);

    // Its primary's documents, every key and alarm, in staging's Durable Objects.
    const ours = mock.state.docs["erga-staging"].docs, theirs = mock.state.docs.erga.docs;
    expect([...ours.keys()].sort()).toEqual([...PRIMARY_DOCS].sort());
    for (const id of PRIMARY_DOCS) {
      expect([...ours.get(id)!.entries].sort()).toEqual([...theirs.get(id)!.entries].sort());
      expect(ours.get(id)!.alarm).toBe(theirs.get(id)!.alarm);
    }
    expect(steps.find((s) => s.startsWith("documents:done"))).toContain("3 documents copied");

    // Its primary: read (its database's export, its snapshot endpoint), never written.
    expect(writesToPrimary(mock.state)).toEqual([]);
    expect(mock.state.calls.filter((c) => c.includes(PRIMARY_DB))).toEqual([
      `POST /accounts/${FLEET_ACCOUNT}/d1/database/${PRIMARY_DB}/export`,
      `POST /accounts/${FLEET_ACCOUNT}/d1/database/${PRIMARY_DB}/export`,
    ]);
    expect(primaryOf(mock.state)).toBe(before);
  });

  test("again, with a fresh copy asked for: a fresh snapshot (staging's old copy gone, its own documents emptied), its secrets and API keys kept", async () => {
    const mock = mockCloudflare({ fleet: true });
    await deployTo(staging({ secrets: stagingSecrets }), mock);
    // Each server stored its own Anthropic key, under its own FACTORY_KEY.
    const key = (who: string) => `INSERT INTO credentials (name, iv, data, last4, updated, updated_by, updated_via) VALUES ('anthropic', 'iv-${who}', 'data-${who}', '${who.slice(0, 4)}', 1, 'koomen', NULL);`;
    stagingDbOf(mock.state).rows!.push(key("staging"));
    const primaryDb = mock.state.databases.find((d) => d.uuid == PRIMARY_DB)!;
    primaryDb.tables.push("credentials");
    primaryDb.rows!.push(key("primary"));
    // Things happen on both: someone makes a document on staging, and one on its primary.
    const stagingDb = stagingDbOf(mock.state);
    stagingDb.rows!.push("INSERT INTO documents (id, owner, slug, title) VALUES ('zzzz9999', 'bo', 'scratch', 'Scratch');");
    mock.state.docs["erga-staging"].docs.set("zzzz9999", { entries: new Map([["meta", { id: "zzzz9999" }]]), alarm: null });
    mock.state.docs["erga-staging"].docs
      .get(PRIMARY_DOCS[0])!
      .entries.set("file:index.html", new TextEncoder().encode("edited on staging"));
    mock.state.databases
      .find((d) => d.uuid == PRIMARY_DB)!
      .rows!.push("INSERT INTO documents (id, owner, slug, title) VALUES ('newp4567', 'ada', 'new', 'New');");
    mock.state.docs.erga.docs.set("newp4567", {
      entries: new Map<string, unknown>([
        ["meta", { id: "newp4567" }],
        ["file:index.html", new TextEncoder().encode("new on the primary")],
      ]),
      alarm: null,
    });
    const before = primaryOf(mock.state);

    const { steps } = await deployTo(afresh(staging()), mock);
    expect(mock.state.deletedDatabases).toEqual([stagingDb.name]);
    const db = stagingDbOf(mock.state);
    expect(db.uuid).not.toBe(stagingDb.uuid);
    // Staging's own key, not its primary's (which doesn't open on staging).
    expect(db.rows!.filter((r) => r.startsWith("INSERT INTO credentials"))).toEqual([key("staging")]);
    expect(steps.find((s) => s.startsWith("migrations:done"))).toContain("its own API keys kept (anthropic)");
    expect(db.rows!.some((r) => r.includes("zzzz9999"))).toBe(false);
    expect(db.rows!.some((r) => r.includes("newp4567"))).toBe(true);
    const docs = mock.state.docs["erga-staging"].docs;
    expect([...docs.keys()].sort()).toEqual([...PRIMARY_DOCS, "newp4567"].sort());
    expect(new TextDecoder().decode(docs.get(PRIMARY_DOCS[0])!.entries.get("file:index.html") as Uint8Array)).toContain(
      "the primary's words"
    );
    expect(steps.find((s) => s.startsWith("documents:done"))).toContain("1 old ones emptied");
    // The secrets setup gave it stay (this deploy sent none).
    expect(mock.state.secrets["erga-staging"]).toEqual(stagingSecrets);
    expect(writesToPrimary(mock.state)).toEqual([]);
    expect(primaryOf(mock.state)).toBe(before);
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
    expect(writesToPrimary(mock.state)).toEqual([]);
  });

  test("before its primary serves snapshots, documents are skipped (and said so), not failed", async () => {
    const mock = mockCloudflare({ fleet: true });
    delete mock.state.secrets.erga.SNAPSHOT_TOKEN;
    const { steps } = await deployTo(staging({ secrets: stagingSecrets }), mock);
    expect(steps.find((s) => s.startsWith("documents:skipped"))).toContain("doesn't serve snapshots yet");
    expect(stagingDbOf(mock.state).rows!.length).toBeGreaterThan(0);
  });
});

describe("an instance that runs already", () => {
  test("its Worker replaced in place: the same database and domain, its secrets kept, no copying", async () => {
    const mock = mockCloudflare({ fleet: true });
    const secrets = { ...mock.state.secrets.erga };
    const { steps } = await deployTo(primary(), mock);
    expect(steps.filter((s) => s.endsWith(":running")).map((s) => s.split(":")[0])).toEqual(["account", "database", "migrations", "assets", "worker", "address", "pages", "live"]);
    expect(steps).toContain("database:done using Erga's database from before (" + PRIMARY_DB + ")");
    expect(mock.state.databases.length).toBe(1);
    expect(mock.state.deletedDatabases).toEqual([]);
    expect(mock.state.versions.erga).toBe(2);
    expect(mock.state.secrets.erga).toEqual(secrets);
    const b = bindingsOf(mock.state, "erga");
    expect(b.DB.database_id).toBe(PRIMARY_DB);
    expect(b.DEPLOY_TARGET).toBeUndefined();
    expect(b.SNAPSHOT_FROM.text).toBe("");
    expect(b.PAGES_DOMAIN.text).toBe("example-pages.com");
    expect(b.GITHUB_CLIENT_ID.text).toBe("Ov23primary");
    // The same exports as its staging instance's, and as a new instance's: none is deleted.
    expect(mock.state.scripts.erga.metadata.exports).toEqual(
      Object.fromEntries(Object.keys(release.worker.exports!).map((n) => [n, { type: "durable-object", storage: "sqlite" }]))
    );
    expect(mock.state.domains.filter((d) => d.hostname == "example.com")).toEqual([
      { hostname: "example.com", service: "erga", zone_id: "zone00000000000000000000000e7ga1" },
    ]);
    expect(mock.state.routes["zone00000000000000000000000e7ga2"]).toEqual([{ pattern: "*.example-pages.com/*", script: "erga" }]);
  });

  test("guards: a staging instance may not use its primary's names, and a copy never goes into its source", () => {
    const g = staging();
    expect(guardTarget(g)).toBeNull();
    expect(guardTarget({ ...g, workerName: "erga" })).toMatch(/replace its primary's Worker/);
    expect(guardTarget({ ...g, databaseName: "erga" })).toMatch(/its primary's database/);
    expect(guardTarget({ ...g, app: { kind: "domain", zoneName: "example.com", hostname: "example.com" } })).toMatch(
      /its primary's address/
    );
    expect(guardTarget({ ...g, pages: { kind: "zone", zoneName: "example-pages.com" } })).toMatch(/its primary's address/);
    expect(guardTarget({ ...g, pages: { kind: "zone", zoneName: "example-pages.com", domain: "staging.example-pages.com" } })).toMatch(
      /under its primary's pages domain/
    );
    expect(guardTarget({ ...g, pages: { kind: "zone", zoneName: "example-pages.com", domain: "a.b.EXAMPLE-PAGES.com" } })).toMatch(
      /under its primary's pages domain/
    );
    // Not under it: a name that only ends the same way.
    expect(guardTarget({ ...g, pages: { kind: "zone", zoneName: "my-example-pages.com" } })).toBeNull();
    expect(g.pages).toEqual({ kind: "zone", zoneName: "example-pages-staging.com", domain: "example-pages-staging.com" });
    // In another account, the names may be the same: the guard is its primary's account's. But a copy never goes into its source's name.
    const elsewhere = { ...g, workerName: "erga", databaseName: "erga", accountId: "f".repeat(32) };
    expect(guardTarget(elsewhere)).toMatch(/can't go into the database it's copied from/);
    expect(guardTarget({ ...elsewhere, stagingOf: { ...g.stagingOf!, copy: undefined } })).toBeNull();
    // An instance that names no primary has nothing to guard, and no homepage rule but its own address.
    expect(guardTarget(primary())).toBeNull();
    expect(guardTarget({ ...primary(), home: "example.org" })).toBeNull();
    expect(guardTarget({ ...g, home: "example.org" })).toMatch(/a staging instance serves no homepage domain/);
  });

  test("a guarded deploy stops before it asks Cloudflare anything", async () => {
    const mock = mockCloudflare({ fleet: true });
    await expect(deployTo(staging({ databaseName: "erga" }), mock)).rejects.toThrow(/its primary's database/);
    expect(mock.state.calls).toEqual([]);
  });
});

describe("the snapshot endpoints", () => {
  test("export needs a request signed with the secret and only reads; import only where it's allowed", async () => {
    const store = memoryStore();
    store.docs.set("abcd2345", {
      entries: new Map<string, unknown>([
        ["meta", { id: "abcd2345" }],
        ["state", new Uint8Array([9, 8])],
      ]),
      alarm: 5,
    });
    const req = async (path: string, body: unknown, token = MOCK_SNAPSHOT_TOKEN, at = Date.now()) => {
      const text = JSON.stringify(body);
      const Authorization = await snapshotAuth(token, "POST", `https://x${path}`, text, at);
      return new Request(`https://x${path}`, { method: "POST", headers: { Authorization }, body: text });
    };
    const routes = async (r: Request | Promise<Request>, importAllowed = false, token: string | undefined = MOCK_SNAPSHOT_TOKEN) =>
      snapshotRoutes(await r, { token, importAllowed, store });
    const ask = { ids: ["abcd2345"] };
    expect((await routes(req("/api/snapshot/docs", ask), false, ""))!.status).toBe(404);
    expect((await routes(req("/api/snapshot/docs", ask, "wrong-token-wrong-token-wrong-token-xx")))!.status).toBe(403);
    // The secret itself never opens it: it doesn't travel, so nothing on the way can keep it.
    const bearer = new Request("https://x/api/snapshot/docs", {
      method: "POST",
      headers: { Authorization: `Bearer ${MOCK_SNAPSHOT_TOKEN}` },
      body: JSON.stringify(ask),
    });
    expect((await routes(bearer))!.status).toBe(403);
    // A signature holds for SNAPSHOT_MINUTES, for its own request only: not later, not from the future, not for
    // another body or path.
    const minutes = SNAPSHOT_MINUTES * 60_000;
    expect((await routes(req("/api/snapshot/docs", ask, MOCK_SNAPSHOT_TOKEN, Date.now() - minutes + 30_000)))!.status).toBe(200);
    expect((await routes(req("/api/snapshot/docs", ask, MOCK_SNAPSHOT_TOKEN, Date.now() - minutes - 1000)))!.status).toBe(403);
    expect((await routes(req("/api/snapshot/docs", ask, MOCK_SNAPSHOT_TOKEN, Date.now() + minutes + 1000)))!.status).toBe(403);
    const signed = (await req("/api/snapshot/docs", ask)).headers.get("authorization")!;
    const other = (path: string, body: unknown) =>
      new Request(`https://x${path}`, { method: "POST", headers: { Authorization: signed }, body: JSON.stringify(body) });
    expect((await routes(other("/api/snapshot/docs", ask)))!.status).toBe(200);
    expect((await routes(other("/api/snapshot/docs", { ids: ["efgh6789"] })))!.status).toBe(403);
    expect((await routes(other("/api/snapshot/docs/import", ask), true))!.status).toBe(403);
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
          headers: { Authorization: await snapshotAuth(MOCK_SNAPSHOT_TOKEN, "POST", "https://x/api/snapshot/docs", JSON.stringify(body)) },
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
    // The primary's first document has 40 versions' blobs of 8 KB: about 430 KB as base64.
    const big = mock.state.docs.erga.docs.get(PRIMARY_DOCS[0])!;
    for (let i = 0; i < 40; i++) big.entries.set(`b:${String(i).padStart(4, "0")}`, crypto.getRandomValues(new Uint8Array(8_000)));
    const { steps } = await deployTo(staging({ secrets: stagingSecrets }), mock);
    expect(steps.find((s) => s.startsWith("documents:") && s != "documents:running")).toBe("documents:done 3 documents copied");
    const ours = mock.state.docs["erga-staging"].docs, theirs = mock.state.docs.erga.docs;
    for (const id of PRIMARY_DOCS) {
      expect([...ours.get(id)!.entries].sort()).toEqual([...theirs.get(id)!.entries].sort());
      expect(ours.get(id)!.alarm).toBe(theirs.get(id)!.alarm);
    }
  });

  test("a document its primary can't read is left empty, and the others are copied", async () => {
    const mock = mockCloudflare({ fleet: true });
    const prod = mock.state.docs.erga,
      read = prod.export.bind(prod);
    prod.export = async (id, page) => {
      if (id == PRIMARY_DOCS[1]) throw new Error("storage unreadable");
      return read(id, page);
    };
    // Staging has an older copy of it: emptied, not left as it was.
    mock.state.docs["erga-staging"] = memoryStore(
      new Map([[PRIMARY_DOCS[1], { entries: new Map<string, unknown>([["meta", { id: PRIMARY_DOCS[1] }]]), alarm: null }]])
    );
    const { steps } = await deployTo(staging({ secrets: stagingSecrets }), mock);
    expect(steps.find((s) => s.startsWith("documents:") && s != "documents:running")).toBe(
      `documents:done 2 documents copied; 1 couldn't be read, and are empty here: ${PRIMARY_DOCS[1]} (storage unreadable)`
    );
    expect([...mock.state.docs["erga-staging"].docs.keys()].sort()).toEqual([PRIMARY_DOCS[0], PRIMARY_DOCS[2]].sort());
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

test("a new copy gets the server's own API keys in one batch: the old ones go, and its own come, all or nothing", async () => {
  const sent: { path: string; body: unknown }[] = [];
  const own = {
    anthropic: [{ name: "anthropic", iv: "i", data: "d", last4: "1234", updated: 1 }],
    people: [{ login: "ada", name: "openai", iv: "i", data: "d", last4: "9", updated: 2 }],
  };
  const cf = {
    call: async (_m: string, path: string, _what: string, body: { sql?: string }) => {
      sent.push({ path, body });
      return [
        { results: body.sql == "SELECT * FROM credentials" ? own.anthropic : body.sql == "SELECT * FROM person_keys" ? own.people : [] },
      ];
    },
  } as unknown as Cloudflare;
  expect(await ownCredentials(cf, "/accounts/a", "old", "new")).toBe("its own API keys kept (anthropic); 1 of its people's own keys kept");
  const writes = sent.filter((s) => s.path.includes("/new/"));
  expect(writes.length).toBe(1);
  expect((writes[0].body as { batch: { sql: string }[] }).batch.map((q) => q.sql.split(" (")[0])).toEqual([
    "DELETE FROM credentials",
    "INSERT INTO credentials",
    "DELETE FROM person_keys",
    "INSERT INTO person_keys",
  ]);
});

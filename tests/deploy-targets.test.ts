// The one deploy pipeline on an instance that runs already and on a second one in the same account, against the mock
// Cloudflare's example account (the fleet): the instance as a deploy left it, with data in its database. Nothing real
// is touched: no Cloudflare, no credentials.
//
// The instance itself: its Worker replaced in place, its secrets kept. A second instance: its own Worker, database,
// secrets and pages origin, and nothing of the first one touched. The guard for a custom domain. The documents' bucket.

import { beforeAll, describe, expect, test } from "bun:test";
import { boundDatabaseName, guardTarget, STEPS } from "../deploy/pipeline/pipeline";
import { bucketName } from "../deploy/deployer/cloudflare";
import { Cloudflare } from "../deploy/deployer/cloudflare-api";
import type { Release } from "../deploy/deployer/release-format";
import { FLEET_ACCOUNT, FLEET_DB, mockCloudflare } from "../dev/mock-cloudflare";
import { bindingsOf, databaseOf, deployTo, fleet, next, nextSecrets, prepareRelease, release } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

beforeAll(prepareRelease, 120_000);

describe("an instance that runs already", () => {
  test("its Worker replaced in place: the same database and domain, its secrets kept", async () => {
    const mock = mockCloudflare({ fleet: true });
    const secrets = { ...mock.state.secrets.erga };
    const { steps } = await deployTo(fleet(), mock);
    expect(steps.filter((s) => s.endsWith(":running")).map((s) => s.split(":")[0])).toEqual(STEPS.map((s) => s.id));
    expect(steps).toContain("database:done using Erga's database from before (" + FLEET_DB + ")");
    expect(mock.state.databases.length).toBe(1);
    expect(mock.state.deletedDatabases).toEqual([]);
    expect(mock.state.versions.erga).toBe(2);
    expect(mock.state.secrets.erga).toEqual(secrets);
    const b = bindingsOf(mock.state, "erga");
    expect(b.DB.database_id).toBe(FLEET_DB);
    expect(b.DEPLOY_TARGET).toBeUndefined();
    expect(b.SNAPSHOT_FROM).toBeUndefined();
    expect(b.PAGES_DOMAIN.text).toBe("example-pages.com");
    expect(b.GITHUB_CLIENT_ID.text).toBe("Ov23fleet");
    // The same exports as a new instance's: none is deleted.
    expect(mock.state.scripts.erga.metadata.exports).toEqual(
      Object.fromEntries(Object.keys(release.worker.exports!).map((n) => [n, { type: "durable-object", storage: "sqlite" }]))
    );
    expect(mock.state.domains.filter((d) => d.hostname == "example.com")).toEqual([
      { hostname: "example.com", service: "erga", zone_id: "zone00000000000000000000000e7ga1" },
    ]);
    expect(mock.state.routes["zone00000000000000000000000e7ga2"]).toEqual([{ pattern: "*.example-pages.com/*", script: "erga" }]);
  });

  test("a second instance in the same account: its own Worker, database, secrets and pages origin; the first one untouched", async () => {
    const mock = mockCloudflare({ fleet: true });
    const before = JSON.stringify([mock.state.scripts.erga, mock.state.secrets.erga, mock.state.databases.find((d) => d.uuid == FLEET_DB)]);
    const { steps } = await deployTo(next({ secrets: nextSecrets }), mock);
    expect(steps.filter((s) => s.endsWith(":running")).map((s) => s.split(":")[0])).toEqual(STEPS.map((s) => s.id));
    expect(databaseOf(mock.state, "erga-next").name).toBe("erga-next");
    expect(mock.state.secrets["erga-next"]).toMatchObject(nextSecrets);
    expect(bindingsOf(mock.state, "erga-next").PAGES_DOMAIN.text).toBe("example-pages-next.com");
    expect(mock.state.domains.map((d) => [d.hostname, d.service])).toContainEqual(["next.example.com", "erga-next"]);
    expect(JSON.stringify([mock.state.scripts.erga, mock.state.secrets.erga, mock.state.databases.find((d) => d.uuid == FLEET_DB)])).toBe(
      before
    );
    // The name of the database that a Worker is bound to: a deploy takes an entry's database from it (deploy/cli/deploy.ts).
    const cf = new Cloudflare("mock-deploy-token", mock.fetch);
    expect(await boundDatabaseName(cf, `/accounts/${FLEET_ACCOUNT}`, "erga-next")).toBe("erga-next");
    expect(await boundDatabaseName(cf, `/accounts/${FLEET_ACCOUNT}`, "erga")).toBe("erga");
    expect(await boundDatabaseName(cf, `/accounts/${FLEET_ACCOUNT}`, "no-such-worker")).toBeNull();
  });

  test("behind a gate's Worker: no address of its own (no custom domain, no route, no DNS record, workers.dev off)", async () => {
    const mock = mockCloudflare({ fleet: true });
    const before = JSON.stringify([mock.state.domains, mock.state.routes]);
    const { steps } = await deployTo(next({ secrets: nextSecrets, gate: true }), mock);
    expect(steps.filter((s) => s.endsWith(":running")).map((s) => s.split(":")[0])).toEqual(
      STEPS.map((s) => s.id).filter((id) => id != "address" && id != "pages")
    );
    expect(JSON.stringify([mock.state.domains, mock.state.routes])).toBe(before);
    expect(mock.state.calls.filter((c) => /dns_records/.test(c))).toEqual([]);
    // (A new Worker's workers.dev address is not a thing to trust: the deploy turns it off itself.)
    expect(mock.state.calls.filter((c) => /\/subdomain$/.test(c))).toEqual([
      `POST /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-next/subdomain`,
    ]);
    expect(mock.state.scripts["erga-next"].workersDev).toBe(false);
    // Its settings still say where its documents' pages are.
    expect(bindingsOf(mock.state, "erga-next").PAGES_DOMAIN.text).toBe("example-pages-next.com");
  });

  test("the guard: a custom domain is not the app's address, and not under its documents' pages", () => {
    expect(guardTarget(fleet())).toBeNull();
    expect(guardTarget({ ...fleet(), domains: ["example.org", "blog.example.org"] })).toBeNull();
    expect(guardTarget({ ...fleet(), domains: ["Example.com"] })).toMatch(/is the app's address or under its documents' pages/);
    expect(guardTarget({ ...fleet(), domains: ["x.example-pages.com"] })).toMatch(/is the app's address or under its documents' pages/);
  });

  test("a guarded deploy stops before it asks Cloudflare anything", async () => {
    const mock = mockCloudflare({ fleet: true });
    await expect(deployTo({ ...fleet(), domains: ["example.com"] }, mock)).rejects.toThrow(/is the app's address/);
    expect(mock.state.calls).toEqual([]);
  });
});

describe("documents' files: an R2 bucket of each target's own", () => {
  test("the pipeline makes the bucket a release binds, once, and binds it by the target's Worker's name", async () => {
    const rel: Release = { ...release, worker: { ...release.worker, env: { ...release.worker.env, FILES: { type: "r2", name: "erga-files" } } } };
    const mock = mockCloudflare({ fleet: true });
    await deployTo(next({ secrets: nextSecrets }), mock, rel);
    expect(mock.state.buckets).toContain("erga-next-files");
    expect(bindingsOf(mock.state, "erga-next").FILES).toEqual({ type: "r2_bucket", name: "FILES", bucket_name: "erga-next-files" });
    // Again: the bucket is there, so none is made.
    const made = () => mock.state.calls.filter((c) => c.startsWith("POST ") && c.endsWith("/r2/buckets")).length;
    const before = made();
    await deployTo(next({ secrets: nextSecrets }), mock, rel);
    expect(made()).toBe(before);
    expect(bucketName("erga", "FILES")).toBe("erga-files");
  });
});

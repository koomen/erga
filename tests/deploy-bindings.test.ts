// A release's bindings: the kinds the pipeline makes for each target, and every other kind, whose metadata the
// release carries and the pipeline sends as it is (deploy/pipeline/bindings.ts). A release with a new kind deploys
// as it is; one that needs a newer pipeline stops before it changes anything.

import { beforeAll, describe, expect, test } from "bun:test";
import { workerMetadata } from "../deploy/pipeline/account";
import { bindingsProblem, releaseBindings } from "../deploy/pipeline/bindings";
import type { Release } from "../deploy/pipeline/release-format";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { prepareRelease, release, stagingSecrets, staging, deployTo, bindingsOf } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();
beforeAll(prepareRelease, 120_000);

const stagingMeta = (rel: Release) =>
  workerMetadata(rel, staging(), {
    dbId: "db",
    assetsJwt: "jwt",
    pagesHost: null,
  }).bindings as any[];

describe("the app Worker's bindings", () => {
  test("the release carries the metadata of each kind the pipeline doesn't make, and none of the target's own", () => {
    expect(release.bindings).toMatchObject({
      BROWSER: { type: "browser", name: "BROWSER" },
      LOADER: { type: "worker_loader", name: "LOADER" },
      ASSETS: { type: "assets", name: "ASSETS" },
    });
    expect(Object.keys(releaseBindings(release.worker.env)).sort()).toEqual(["ASSETS", "BROWSER", "LOADER"]);
  });

  test("a kind this pipeline has no code for goes up as the release describes it", async () => {
    const env = { ...release.worker.env, STATS: { type: "analytics-engine", dataset: "erga_stats" } } as Release["worker"]["env"];
    const rel: Release = {
      ...release,
      worker: { ...release.worker, env },
      bindings: { ...releaseBindings(env), STATS: { type: "analytics_engine", name: "STATS", dataset: "erga_stats_v2" } },
    };
    expect(bindingsProblem(rel)).toBeNull();
    const mock = mockCloudflare({ fleet: true });
    await deployTo(staging({ secrets: stagingSecrets }), mock, rel);
    expect(bindingsOf(mock.state, "erga-staging").STATS).toEqual({ type: "analytics_engine", name: "STATS", dataset: "erga_stats_v2" });
    expect(bindingsOf(mock.state, "erga-staging").BROWSER).toEqual({ type: "browser", name: "BROWSER" });
  });

  test("a release from before it carried its bindings: the pipeline translates each kind the same way", () => {
    const { bindings: _, ...old } = release;
    const meta = stagingMeta({ ...old, worker: { ...release.worker, env: { ...release.worker.env, AI: { type: "ai" } } } });
    expect(meta.find((b) => b.name == "BROWSER")).toEqual({ type: "browser", name: "BROWSER" });
    expect(meta.find((b) => b.name == "LOADER")).toEqual({ type: "worker_loader", name: "LOADER" });
    expect(meta.find((b) => b.name == "AI")).toEqual({ type: "ai", name: "AI" });
  });

  test("the Worker gets its own deploy facts (ERGA_DEPLOY), which GET /api/ops answers: the target's account, Worker, database, addresses and plain settings", () => {
    const target = staging();
    const facts = JSON.parse(stagingMeta(release).find((b) => b.name == "ERGA_DEPLOY").text);
    expect(facts).toEqual({
      account: FLEET_ACCOUNT,
      worker: target.workerName,
      database: target.databaseName,
      app: target.app,
      pages: target.pages,
      vars: target.vars,
    });
  });

  test("a kind the release says the pipeline must make, which this one can't: refused before any step, nothing changed", async () => {
    // A newer release's code would make a KV namespace for each target: it leaves the binding out of its own metadata.
    const rel: Release = {
      ...release,
      worker: { ...release.worker, env: { ...release.worker.env, CACHE: { type: "kv", name: "erga-cache" } } },
    };
    const mock = mockCloudflare({ fleet: true });
    const before = mock.state.calls.length;
    const run = deployTo(staging({ secrets: stagingSecrets }), mock, rel);
    await expect(run).rejects.toThrow(/CACHE \(kv\).*Nothing changed.*Teach the pipeline/);
    expect(mock.state.calls.slice(before)).toEqual([]);
  });
});

// A release that is deployed but unhealthy: the pipeline stops at its live step and says what failed, and the version
// before it serves again in one call (rollbackTo, as `bun erga deploy` does by itself). The health is the row that the
// server's scheduled run writes into its database (the mock's: dev/mock-cloudflare.ts, runScheduled), read through
// D1's API: no step asks the server.

import { beforeAll, describe, expect, test } from "bun:test";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { type Carry, EACH_MINUTE, HEALTH_FRESH_MS, readHealth, rollbackTo } from "../deploy/deployer/cloudflare";
import { Cloudflare, DeployError, Unhealthy } from "../deploy/deployer/cloudflare-api";
import { runPipeline, specTarget } from "../deploy/pipeline/pipeline";
import { prepareRelease, release, SHA1, SHA2, SHA3, next, nextSecrets, bindingsOf, bootstrap, quick } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

beforeAll(prepareRelease, 120_000);

/** A wait that ends soon: a release that never gets healthy spends it all. */
const soon = { ...quick, waitMs: 60 };

describe("rollbacks", () => {
  test("an unhealthy release fails at the live step and says what failed; a rollback puts the version before it back, in one call", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const cf = new Cloudflare("mock-deploy-token", mock.fetch);
    const run = (version: string, carry: Carry = {}, net = cf) =>
      runPipeline(net, { ...release, version: version.slice(0, 12) }, next(), { ...soon, carry, report: () => {} });
    const steps: string[] = [];
    await runPipeline(cf, { ...release, version: SHA2.slice(0, 12) }, next(), {
      ...soon,
      report: (id, status, detail) => steps.push(`${id}:${status} ${detail ?? ""}`),
    });
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(SHA2.slice(0, 12));
    // The Worker has its Cron Trigger, each minute; the live step read the release's own row, and asked no server.
    expect(mock.state.schedules["erga-next"]).toEqual([EACH_MINUTE]);
    expect(steps).toContain(`live:done release ${SHA2.slice(0, 12)}, healthy (db ok 1 ms, documents ok 2 ms)`);
    expect(mock.state.calls.filter((c) => !c.includes("/accounts/") && !c.includes("/zones"))).toEqual([]);
    // Nothing asks the address from outside: Cloudflare says that its certificate is there.
    expect(steps.find((x) => x.startsWith("address:done"))).toContain(
      "https://next.example.com (already its address); its certificate is active"
    );
    // The scheduled run made the default homepage: no request asked for it.
    expect(mock.state.homes).toContain("erga-next");

    // The Worker has the new code before its objects have it: its first rows say that a document does not open, then one
    // says healthy. No rollback.
    let behind = 8;
    const late = new Cloudflare("mock-deploy-token", (input, init) =>
      String(init?.body ?? "").includes("FROM health") && behind-- > 0
        ? Promise.resolve(
            Response.json({
              success: true,
              result: [
                {
                  results: [
                    {
                      at: Date.now(),
                      version: SHA3.slice(0, 12),
                      ok: 0,
                      checks: JSON.stringify({ documents: { ok: false, error: "the object runs the code before" } }),
                    },
                  ],
                },
              ],
            })
          )
        : mock.fetch(input, init)
    );
    await run(SHA3, {}, late);
    expect(behind).toBe(-1);
    await run(SHA2);

    mock.state.unhealthy = [SHA3.slice(0, 12)];
    const carry: Carry = {};
    const failed = await run(SHA3, carry).catch((e) => e);
    expect(failed).toBeInstanceOf(Unhealthy);
    expect(failed.message).toContain(
      `Release ${SHA3.slice(0, 12)} is deployed to erga-next, but its health check fails: documents: a document didn't open`
    );
    // The restore point: the Worker version and release before this deploy.
    const before = carry.restore!.versionId!;
    expect(before).toMatch(/^[0-9a-f-]{36}$/);
    expect(carry.restore!.version).toBe(SHA2.slice(0, 12));

    const calls = mock.state.calls.length;
    await rollbackTo(cf, specTarget(next()), before, "unhealthy");
    expect(mock.state.calls.slice(calls)).toEqual([`POST /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-next/deployments?force=true`]);
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(SHA2.slice(0, 12));

    // A release whose scheduled run writes no row at all: on a server whose runs ran before, that is an unhealthy release.
    mock.state.unhealthy = [];
    mock.state.silent = [SHA3.slice(0, 12)];
    const silent = await run(SHA3).catch((e) => e);
    expect(silent).toBeInstanceOf(Unhealthy);
    expect(silent.message).toContain(
      `it wrote no health row in 3 minutes (the health row is of release ${SHA2.slice(0, 12)}, not ${SHA3.slice(0, 12)})`
    );
  });

  test("the first deploy of a server: no row yet is no reason for a rollback, and the error says how long a new Cron Trigger can take", async () => {
    const mock = mockCloudflare({ fleet: true });
    mock.state.silent = [SHA1.slice(0, 12)];
    const cf = new Cloudflare("mock-setup-token", mock.fetch);
    const first = await runPipeline(cf, { ...release, version: SHA1.slice(0, 12) }, next({ secrets: nextSecrets }), {
      ...soon,
      report: () => {},
    }).catch((e) => e);
    expect(first).toBeInstanceOf(DeployError);
    expect(first).not.toBeInstanceOf(Unhealthy);
    expect(first.message).toContain("its first health row has not come yet (the server wrote no health row yet)");
    expect(first.message).toContain("up to 15 minutes");
  });

  test("a health row says nothing of a release when it is old, or another release's", () => {
    const now = 1_800_000_000_000;
    const row = { at: now - 30_000, version: "abc123def456", ok: true, checks: { db: { ok: true, ms: 3 } } };
    expect(readHealth(row, "abc123def456", now)).toEqual({ healthy: true, why: "", summary: "db ok 3 ms" });
    expect(readHealth(null, "abc123def456", now)).toMatchObject({ healthy: null, why: "the server wrote no health row yet" });
    expect(readHealth({ ...row, at: now - HEALTH_FRESH_MS - 60_000 }, "abc123def456", now)).toMatchObject({
      healthy: null,
      why: "the server's last health row is 4 minutes old",
    });
    expect(readHealth(row, "fff000fff000", now)).toMatchObject({
      healthy: null,
      why: "the health row is of release abc123def456, not fff000fff000",
    });
    expect(readHealth({ ...row, ok: false, checks: { documents: { ok: false, error: "no host" } } }, "abc123def456", now)).toEqual({
      healthy: false,
      why: "documents: no host",
      summary: "",
    });
  });
});

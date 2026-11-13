// A release that is up but unhealthy: the pipeline stops at its live step and says what failed, and the version
// before it serves again in one call (rollbackTo, as `bun erga deploy` does by itself).

import { beforeAll, describe, expect, test } from "bun:test";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { rollbackTo } from "../deploy/pipeline/account";
import { Cloudflare, Unhealthy } from "../deploy/pipeline/cloudflare-api";
import { runPipeline, type Carry } from "../deploy/pipeline/pipeline";
import { prepareRelease, release, SHA2, SHA3, staging, bindingsOf, bootstrap, quick } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

beforeAll(prepareRelease, 120_000);

describe("rollbacks", () => {
  test("an unhealthy release fails at the live step and says what failed; a rollback puts the version before it back, in one call", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const cf = new Cloudflare("mock-deploy-token", mock.fetch);
    const run = (version: string, carry: Carry = {}) =>
      runPipeline(cf, { ...release, version: version.slice(0, 12) }, staging(), { ...quick, site: mock.fetch, carry, report: () => {} });
    await run(SHA2);
    expect(bindingsOf(mock.state, "erga-staging").ERGA_VERSION.text).toBe(SHA2.slice(0, 12));

    mock.state.unhealthy = [SHA3.slice(0, 12)];
    const carry: Carry = {};
    const failed = await run(SHA3, carry).catch((e) => e);
    expect(failed).toBeInstanceOf(Unhealthy);
    expect(failed.message).toContain(
      `Release ${SHA3.slice(0, 12)} is up at https://staging.example.com, but its health check fails: documents: a document didn't open`
    );
    // The restore point: the Worker version and release before this deploy.
    const before = carry.restore!.versionId!;
    expect(before).toMatch(/^[0-9a-f-]{36}$/);
    expect(carry.restore!.version).toBe(SHA2.slice(0, 12));

    const calls = mock.state.calls.length;
    await rollbackTo(cf, staging(), before, "unhealthy");
    expect(mock.state.calls.slice(calls)).toEqual([`POST /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-staging/deployments?force=true`]);
    expect(bindingsOf(mock.state, "erga-staging").ERGA_VERSION.text).toBe(SHA2.slice(0, 12));
  });
});

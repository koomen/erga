// Rollbacks: by hand (the version before the live deploy, in one call), and by
// themselves (a release that is up but unhealthy), for the app and for the
// control Worker.

import { beforeAll, describe, expect, test } from "bun:test";
import type { Release } from "../control/deploys/release-format";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { mockBuilder } from "../dev/mock-builder";
import { prepareRelease, release, SHA1, SHA2, SHA3, env, staging, bindingsOf, Server, bootstrap } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

beforeAll(prepareRelease, 120_000);

describe("rollbacks", () => {
  test("a rollback: the version before the live deploy serves again, in one call; recorded as a live deploy of its own, which a second rollback undoes", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-staging", env());
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
    const busy = new Server(mock, slow, "erga-staging", env());
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
    const server = new Server(mock, builder, "erga-staging", env());
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
    const server = new Server(mock, builder, "erga-staging", env());
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

  test("an unhealthy control Worker is rolled back by itself, to the version that ran before", async () => {
    const mock = mockCloudflare({ fleet: true });
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-control", env());
    await server.instance.hook("main", SHA2);
    await server.settle();
    const [good] = (await server.instance.historyOf("control"))!;
    mock.state.unhealthy = [SHA3.slice(0, 12)];
    await server.instance.hook("main", SHA3);
    await server.settle();
    // Production (healthy: the same release, but the app's health check is the mock's per release... both unhealthy) and the control Worker both rolled back.
    const t = await server.status("control");
    expect(t).toMatchObject({ state: "failed", commit: SHA3, deployed: SHA2, liveDeploy: good.id });
    expect(t.error).toContain(`Rolled back to release ${SHA2.slice(0, 12)} by itself.`);
    expect(t.steps.at(-1)).toMatchObject({ id: "rollback", status: "done" });
    expect(bindingsOf(mock.state, "erga-control").ERGA_VERSION.text).toBe(SHA2.slice(0, 12));
    expect(mock.state.calls.filter((c) => c == `POST /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-control/deployments?force=true`)).toHaveLength(1);
    const log = (await server.instance.logOf("control"))!;
    expect(log.lines.filter((l) => l.step == "rollback").map((l) => l.text)).toEqual([`unhealthy: rolling ops.erga.dev back to release ${SHA2.slice(0, 12)} (what it ran before this deploy)`]);
  });
});

// A healthy production deploy publishes its release to the release store (control/deploys/release-channels.ts), after
// the alarm's deploys: on edge, and on stable when a release tag names it. The control Worker doesn't wait for it.

import { beforeAll, describe, expect, test } from "bun:test";
import type { Release } from "../control/deploys/release-format";
import { mockBuilder, mockCloudflare } from "../dev/mock-cloudflare";
import { memoryBlobs, ReleaseStore } from "../control/deploys/releases";
import { bootstrap, prepareRelease, release, SHA1, SHA2, SHA3, env, Server } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

beforeAll(prepareRelease, 120_000);

describe("production's release goes to the store", () => {
  test("the control Worker deploys main while production's release is still publishing, which the status shows", async () => {
    const mock = mockCloudflare({ fleet: true });
    const builder = mockBuilder(async () => release);
    const store = new ReleaseStore(memoryBlobs());
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const slow = Object.assign(Object.create(store), { publish: async (r: Release, c: string) => (await gate, store.publish(r, c)) });
    const server = new Server(mock, builder, "erga-control", env(), { releases: slow });
    await server.instance.hook("main", SHA2, "merge by ada");
    const woke = server.instance.alarm();
    // (The control deploy runs in the same alarm, while the publish waits on the gate.)
    for (const end = Date.now() + 5000; (await server.status("control")).state != "deployed" && Date.now() < end; ) await Bun.sleep(5);
    expect((await server.status("control")).state).toBe("deployed");
    expect(await server.status("production")).toMatchObject({ state: "deployed", publishing: SHA2.slice(0, 12) });
    open();
    await woke;
    expect((await server.status("production")).publishing).toBeNull();
    expect((await store.channel("edge")).latest).toBe(SHA2.slice(0, 12));
  });

  test("after the control Worker's own deploy, this object restarts into the new code, once production's release is published", async () => {
    const mock = mockCloudflare({ fleet: true });
    const store = new ReleaseStore(memoryBlobs());
    const order: string[] = [];
    const logged = (e: { type: string }) => void (e.type == "releases" && order.push("published"));
    const server = new Server(
      mock,
      mockBuilder(async () => release),
      "erga-control",
      env(),
      { releases: store, logged, restart: () => void order.push("restart") }
    );
    await server.instance.hook("staging", SHA1, "push by ada");
    await server.settle();
    expect(order).toEqual([]);
    await server.instance.hook("main", SHA2, "merge by ada");
    await server.settle();
    expect(await server.status("control")).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(order).toEqual(["published", "restart"]);
  });

  /** A store whose publish waits until `open()`. */
  const gated = () => {
    const store = new ReleaseStore(memoryBlobs());
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const slow = Object.assign(Object.create(store), { publish: async (r: Release, c: string) => (await gate, store.publish(r, c)) });
    return { store, slow, open };
  };
  const until = async (ok: () => Promise<boolean>) => {
    for (const end = Date.now() + 5000; !(await ok()) && Date.now() < end; ) await Bun.sleep(5);
    expect(await ok()).toBe(true);
  };

  test("a push to staging while production's release publishes deploys at once", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const { slow, open } = gated();
    const server = new Server(
      mock,
      mockBuilder(async () => release),
      "erga-control",
      env(),
      { releases: slow }
    );
    await server.instance.hook("main", SHA2, "merge by ada");
    const woke = server.instance.alarm();
    await until(async () => (await server.status("control")).state == "deployed");
    await server.instance.hook("staging", SHA3, "push by ada");
    await until(async () => (await server.status("staging")).state == "deployed");
    expect(await server.status("production")).toMatchObject({ publishing: SHA2.slice(0, 12) });
    open();
    await woke;
  });

  test("after the control Worker's deploy, a staging deploy waits for the restart, says so, and runs on the new code", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const { slow, open } = gated();
    const order: string[] = [];
    const server: Server = new Server(
      mock,
      mockBuilder(async () => release),
      "erga-control",
      env(),
      {
        releases: slow,
        runs: SHA1.slice(0, 12),
        // The new object: a new instance over the same storage, its code the release the control Worker deployed.
        restart: () => {
          order.push("restart");
          server.extra.runs = SHA2.slice(0, 12);
          server.start();
        },
      }
    );
    await server.instance.hook("main", SHA2, "merge by ada");
    const woke = server.instance.alarm();
    await until(async () => (await server.status("control")).state == "deployed");
    await server.instance.hook("staging", SHA3, "push by ada");
    const waiting = await server.status("staging");
    expect(waiting).toMatchObject({ state: "idle", pending: SHA3 });
    expect(waiting.waits).toBe(
      `the deploys restart into the control Worker's new code (release ${SHA2.slice(0, 12)}) first, once production's release is published`
    );
    open();
    await woke;
    expect(order).toEqual(["restart"]);
    expect((await server.status("staging")).state).toBe("idle");
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA3, waits: null });
    // The new object restarts no more.
    expect(order).toEqual(["restart"]);
  });

  test("a restart while the release publishes: the deploy's log says it wasn't published", async () => {
    const mock = mockCloudflare({ fleet: true });
    const { slow } = gated();
    const server = new Server(
      mock,
      mockBuilder(async () => release),
      "erga-control",
      env(),
      { releases: slow }
    );
    await server.instance.hook("main", SHA2, "merge by ada");
    void server.instance.alarm();
    await until(async () => (await server.status("production")).publishing == SHA2.slice(0, 12));
    server.start();
    expect((await server.status("production")).publishing).toBeNull();
    await server.instance.alarm();
    const log = (await server.instance.logOf("production"))!;
    expect(log.lines.map((l) => l.text)).toContain(
      `release ${SHA2.slice(0, 12)} was not published to the release store: the server restarted while it published. Redeploy publishes it.`
    );
  });

  test("a healthy production deploy publishes its release to the store, on edge; a failed one doesn't", async () => {
    const mock = mockCloudflare({ fleet: true });
    const builder = mockBuilder(async () => release);
    const blobs = memoryBlobs();
    const store = new ReleaseStore(blobs);
    const events: string[] = [];
    const server = new Server(mock, builder, "erga-control", env(), {
      releases: store,
      logged: (e) => {
        if (e.type == "releases") events.push("releases");
      },
      releasesChanged: () => events.push("releases"),
    });
    expect(await store.view()).toMatchObject({ edge: { latest: null }, stable: { latest: null } });
    await server.instance.hook("main", SHA2, "merge by ada");
    await server.settle();
    expect(await server.status("production")).toMatchObject({ state: "deployed", deployed: SHA2 });
    const edge = await store.channel("edge");
    expect(edge.latest).toBe(SHA2.slice(0, 12));
    expect(edge.releases).toEqual([{ version: SHA2.slice(0, 12), commit: SHA2, built: release.built, at: expect.any(Number) }]);
    expect((await store.channel("stable")).releases).toEqual([]);
    expect(events).toEqual(["releases"]);
    const m = (await store.manifest(SHA2.slice(0, 12)))!;
    expect(Object.keys(m.files)).toEqual(
      expect.arrayContaining(["release.json", "bundle/index.js", "control/index.js", "migrations/0001_erga.sql"])
    );
    const log = (await server.instance.logOf("production"))!;
    expect(log.lines.map((l) => l.text)).toContain(
      `published release ${SHA2.slice(0, 12)} to the store (${Object.keys(m.files).length} files), on edge`
    );
    // Read back whole from the store: what a downstream installs.
    expect((await store.load(SHA2.slice(0, 12)))!.modules["index.js"]).toEqual(release.modules["index.js"]);
    // A release tag on that commit: stable, with the tag. One on a commit not built yet waits for its deploy.
    await server.instance.channels.tagged({ tag: "v0.1.0", commit: SHA2, by: "ada", at: Date.now() });
    expect(await store.channel("stable")).toMatchObject({
      latest: SHA2.slice(0, 12),
      releases: [{ version: SHA2.slice(0, 12), tag: "v0.1.0", by: "ada" }],
    });
    expect(events).toEqual(["releases", "releases"]);
    await server.instance.channels.tagged({ tag: "v0.2.0", commit: SHA1, by: "ada", at: Date.now() });
    expect((await store.channel("stable")).latest).toBe(SHA2.slice(0, 12));
    await server.instance.hook("main", SHA1, "merge by ada");
    await server.settle();
    expect(await store.channel("stable")).toMatchObject({ latest: SHA1.slice(0, 12), releases: [{ tag: "v0.2.0" }, { tag: "v0.1.0" }] });
    // An older tag cut later (a hotfix on the old line) doesn't move stable back.
    await server.instance.channels.tagged({ tag: "v0.1.1", commit: SHA2, by: "bo", at: Date.now() });
    expect((await store.channel("stable")).latest).toBe(SHA1.slice(0, 12));
    // An unhealthy production deploy: rolled back, and nothing published.
    mock.state.unhealthy = [SHA3.slice(0, 12)];
    await server.instance.hook("main", SHA3, "merge by ada");
    await server.settle();
    expect(await server.status("production")).toMatchObject({ state: "failed" });
    expect((await store.channel("edge")).latest).toBe(SHA1.slice(0, 12));
    expect(await store.manifest(SHA3.slice(0, 12))).toBeNull();
  });
});

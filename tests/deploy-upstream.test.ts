// A downstream's deploys: staging's first deploy after the install, Update
// from upstream through its repository, a conflict that stops, and an
// unhealthy release rolled back.

import { beforeAll, describe, expect, test } from "bun:test";
import { UPSTREAM_CHECK_MS } from "../control/deploys/branches";
import { Cloudflare } from "../control/deploys/cloudflare-api";
import { FLEET_ACCOUNT, MOCK_SNAPSHOT_TOKEN, mockCloudflare } from "../dev/mock-cloudflare";
import { memoryBlobs, ReleaseStore, storeBuilder } from "../control/deploys/releases";
import { installFleet } from "../control/deploys/fleet";
import type { UpdateResult } from "../control/source/index.ts";
import { runInstall } from "../control/install/install";
import { ADMINS, CONTROL } from "../deploy/targets";
import { prepareRelease, release, staging, bindingsOf, Server } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

beforeAll(prepareRelease, 120_000);

describe("a downstream deploys itself", () => {
  test("a downstream: staging's first deploy after the install, Update from upstream through its repository (deployed by the hook), a conflict that stops, an unhealthy release rolled back", async () => {
    // The install, as /deploy makes it, in an account of its own; then its control Worker's deploys, as its Pipeline object runs them.
    const mock = mockCloudflare();
    const C1 = "1".repeat(40), C2 = "2".repeat(40), C3 = "3".repeat(40);
    const v1 = { ...release, version: C1.slice(0, 12) }, v2 = { ...release, version: C2.slice(0, 12) }, v3 = { ...release, version: C3.slice(0, 12) };
    const plan = { accountId: FLEET_ACCOUNT, workerName: "erga", subdomain: "ada-mock", app: { kind: "workers.dev" as const }, pages: { kind: "shared" as const }, admin: "Ada" };
    const fork = { id: "fork0123456789ab", secret: "f".repeat(40) };
    await runInstall(new Cloudflare("mock-token", mock.fetch), v1, plan, { sessionSecret: "s".repeat(40), controlSecret: "c".repeat(40), snapshotToken: MOCK_SNAPSHOT_TOKEN, fork, upstream: { origin: "https://ops.erga.test", clientId: "erga-client", github: { clientId: "Iv1.mockgithubapp0", slug: "erga-editor" } }, site: mock.fetch, sleep: async () => {}, waitMs: 1000, report: () => {} });
    const bindings = (script: string) => bindingsOf(mock.state, script);
    expect(bindings("erga").ERGA_VERSION.text).toBe(v1.version);
    const secretsBefore = { ...mock.state.secrets["erga-control"] };
    // Upstream's store: every release published; v1 on stable.
    const store = new ReleaseStore(memoryBlobs());
    for (const [r, c] of [[v1, C1], [v2, C2], [v3, C3]] as const) await store.publish(r, c);
    await store.addTo("stable", v1.version, "pete");
    // The install's control Worker's settings, as the install left them (its fleet reads them), with its secrets.
    const b = bindings("erga-control"), secrets = mock.state.secrets["erga-control"];
    const fleet = installFleet({ CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT, UPSTREAM: b.UPSTREAM.text, INSTALL: b.INSTALL.text, ADMINS: b.ADMINS.text, APP_URL: b.APP_URL.text, GITHUB_APP_CLIENT_ID: b.GITHUB_APP_CLIENT_ID.text, GITHUB_APP_SLUG: b.GITHUB_APP_SLUG.text, CLOUDFLARE_OAUTH_CLIENT_ID: b.CLOUDFLARE_OAUTH_CLIENT_ID.text, SESSION_SECRET: secrets.SESSION_SECRET })!;
    expect(fleet.names).toEqual(["production", "staging", "control"]);
    expect(fleet.specOf("staging")).toMatchObject({ branch: "staging", worker: "erga-staging", host: "erga-staging.ada-mock.workers.dev", snapshotFrom: "production" });
    // The fork's repository, as the deploys' object sees it: its branches' heads, and Update (which moves staging, and the hook deploys it).
    const heads = { main: C1, staging: C1 };
    let update: () => Promise<UpdateResult> = async () => ({ result: "up-to-date", commit: heads.staging });
    const server = new Server(mock, storeBuilder(store) as never, "erga-control", { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT, SNAPSHOT_TOKEN: secrets.SNAPSHOT_TOKEN }, { fleet, upstream: { channel: () => store.channel("stable"), update: () => update(), heads: async () => heads } });
    // The first alarm: production and the control Worker are what the install put up; staging gets its first deploy, from its branch's head.
    await server.instance.alarm();
    await server.settle();
    let status = await server.instance.status({ history: 5 });
    expect(status.targets.map((t) => `${t.name}:${t.state}:${t.deployed}`)).toEqual([`production:deployed:${C1}`, `staging:deployed:${C1}`, `control:deployed:${C1}`]);
    expect(status.upstream).toMatchObject({ origin: "https://ops.erga.test", channel: "stable", latest: v1.version, error: null, update: `${v1.version}: staging has it` });
    const sb = bindings("erga-staging");
    expect(sb.ERGA_VERSION.text).toBe(v1.version);
    expect(sb.DEPLOY_TARGET.text).toBe("staging");
    expect(sb.SNAPSHOT_IMPORT.text).toBe("1");
    expect(sb.CONTROL).toEqual({ type: "service", name: "CONTROL", service: "erga-control", entrypoint: "App" });
    expect(mock.state.secrets["erga-staging"]).toEqual({ SESSION_SECRET: `${secrets.SESSION_SECRET}.staging`, SNAPSHOT_TOKEN: secrets.SNAPSHOT_TOKEN });
    // Staging signs people in with Erga's GitHub App through upstream, as production does.
    expect(sb.GITHUB_CLIENT_ID.text).toBe("Iv1.mockgithubapp0");
    expect(sb.SIGN_IN_RELAY.text).toBe("https://ops.erga.test");
    // Its own database, a copy of production's.
    expect(mock.state.databases.map((d) => d.name).sort()).toEqual(["erga", expect.stringMatching(/^erga-staging-/)]);
    const staging = status.targets[1];
    expect(staging.steps.map((x) => `${x.id}:${x.status}`)).toEqual(["build:done", "account:done", "database:done", "data:done", "migrations:done", "assets:done", "worker:done", "address:done", "pages:done", "live:done", "documents:done", "cleanup:done"]);
    expect(staging.steps[0].title).toBe("Fetch the release, or build the commit");
    expect(staging.history![0]).toMatchObject({ commit: C1, state: "deployed", live: true, trigger: "first deploy after the install" });
    expect(bindings("erga").ERGA_VERSION.text).toBe(v1.version);
    expect(mock.state.secrets["erga-control"]).toEqual(secretsBefore);
    // The next alarm: the channel didn't move, nothing happens; the alarm is kept for the next look.
    const uploads = () => mock.state.calls.filter((c) => c.startsWith("PUT") && c.includes("/workers/scripts/")).length;
    let before = uploads();
    server.scheduled = [];
    await server.instance.alarm();
    await server.settle();
    expect(uploads()).toBe(before);
    expect(server.scheduled).toContain(UPSTREAM_CHECK_MS);
    // stable moves to v2: the repository fast-forwards staging (and, as its hook would, tells the deploys): staging deploys v2; production waits for Merge.
    await store.addTo("stable", v2.version, "pete");
    update = async () => { heads.staging = C2; await server.instance.hook("staging", C2, "update by the system"); return { result: "fast-forward", commit: C2, version: "v0.2.0", brought: 1 }; };
    await server.instance.alarm();
    await server.settle();
    status = await server.instance.status({ history: 5 });
    expect(status.upstream).toMatchObject({ latest: v2.version, error: null, update: "v0.2.0 fast-forwarded into staging (1 commit)" });
    expect(status.targets.map((t) => `${t.name}:${t.deployed}`)).toEqual([`production:${C1}`, `staging:${C2}`, `control:${C1}`]);
    expect(bindings("erga-staging").ERGA_VERSION.text).toBe(v2.version);
    expect(status.targets[1].history![0]).toMatchObject({ commit: C2, state: "deployed", trigger: "update by the system" });
    // The instance's own Merge: main moves; production deploys it, and the control Worker follows from the same release.
    heads.main = C2;
    await server.instance.hook("main", C2, "merge by ada");
    await server.settle();
    status = await server.instance.status();
    expect(status.targets.map((t) => `${t.name}:${t.deployed}`)).toEqual([`production:${C2}`, `staging:${C2}`, `control:${C2}`]);
    expect(bindings("erga").ERGA_VERSION.text).toBe(v2.version);
    expect(bindings("erga-control").ERGA_VERSION.text).toBe(v2.version);
    expect(bindings("erga-control").INSTALL.text).toBe(b.INSTALL.text);
    expect(mock.state.scripts["erga-control"].metadata.exports).toEqual({ Pipeline: { type: "durable-object", storage: "sqlite" }, SourceHost: { type: "durable-object", storage: "sqlite" }, Deployer: { type: "durable-object", storage: "sqlite" } });
    // stable moves to v3, but the merge conflicts: nothing deploys, and the status says what to do.
    await store.addTo("stable", v3.version, "pete");
    update = async () => ({ result: "conflicts", conflict: { kind: "upstream", branch: "upstream-merge/v0.3.0", version: "v0.3.0", target: C3, ours: C2, base: C2, files: [{ path: "a.txt", kind: "content" }], at: 0, by: "the system" } });
    before = uploads();
    await server.instance.alarm();
    await server.settle();
    status = await server.instance.status();
    expect(uploads()).toBe(before);
    expect(status.upstream!.error).toContain("Update from https://ops.erga.test stopped: v0.3.0: the merge conflicts in 1 file (a.txt)");
    expect(status.upstream!.error).toContain("Resolve the files it lists");
    // Resolved (staging moved to the merge, C3 here), but the release is unhealthy: staging rolls back to v2 by itself.
    mock.state.unhealthy = [v3.version];
    await server.instance.hook("staging", C3, "update by ada");
    await server.settle();
    const after = await server.instance.status({ history: 5 });
    expect(after.targets[1]).toMatchObject({ state: "failed", deployed: C2 });
    expect(after.targets[1].error).toContain(`Rolled back to release ${v2.version} by itself.`);
    expect(bindings("erga-staging").ERGA_VERSION.text).toBe(v2.version);
    expect(bindings("erga").ERGA_VERSION.text).toBe(v2.version);
    // Redeploy on a downstream: its branch's head again (still unhealthy: failed again, not stuck).
    expect((await server.instance.redeploy("staging", "redeploy by ada")).ok).toBe(true);
    await server.settle();
    expect((await server.instance.status()).targets[1]).toMatchObject({ state: "failed", deployed: C2 });
  });
});

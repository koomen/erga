// Branches that deploy themselves (control/deploys/branches.ts), against the
// mock Cloudflare: the hook, the queue, the status and its events, failure and
// retry, a restart, a newer deploy that cancels the running one, the history;
// staging's copy of production's data (frozen, copied only when asked, while
// the commit builds); and the one-time setup.

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "path";
import { ATTEMPTS, type TargetStatus } from "../control/deploys/branches";
import { HISTORY_KEEP, type DeployRecord } from "../control/deploys/history";
import { CONTROL_OAUTH_SCOPES, fixedCredential } from "../control/deploys/credential";
import { ALL_STEPS, copyName, copyReason, guardTarget } from "../control/deploys/pipeline";
import { Cloudflare } from "../control/deploys/cloudflare-api";
import type { Release } from "../control/deploys/release-format";
import { FLEET_ACCOUNT, mockCloudflare, PROD_DB, PROD_DOCS } from "../dev/mock-cloudflare";
import { mockBuilder } from "../dev/mock-builder";
import { memoryBlobs, ReleaseStore } from "../control/deploys/releases";
import { ADMINS, SOURCE, TARGETS } from "../deploy/targets";
import {
  prepareRelease,
  release,
  SHA1,
  SHA2,
  SHA3,
  env,
  staging,
  bindingsOf,
  stagingDbOf,
  stagingCopies,
  productionOf,
  writesToProduction,
  Server,
  bootstrap,
  ROOT,
} from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

beforeAll(prepareRelease, 120_000);

describe("branches deploy themselves", () => {
  test("not set up (no Cloudflare credential: nobody consented): a push waits, says why, nothing deployed", async () => {
    const mock = mockCloudflare({ fleet: true });
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga", { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT }, { credential: fixedCredential(null) });
    await server.instance.hook("main", SHA1);
    await server.settle();
    const t = await server.status("production");
    expect(t).toMatchObject({ name: "production", host: "erga.dev", branch: "main", state: "idle", commit: SHA1, pending: SHA1, error: "111111111111 waits to deploy. The control Worker has no Cloudflare credential: an admin connects Cloudflare (a consent in a popup)." });
    expect(t.log.at(-1)).toContain("waits: Nothing is deployed: The control Worker has no Cloudflare credential");
    expect((await server.instance.status()).credential).toMatchObject({ connected: false, problem: expect.stringContaining("connects Cloudflare") });
    expect(builder.built).toEqual([]);
    expect(mock.state.calls).toEqual([]);
  });

  test("a push to staging, on staging: built, deployed, its frozen data kept; the status and its events; failure and retry; pushes while it runs", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-staging", env());
    const before = productionOf(mock.state);

    await server.instance.hook("staging", SHA2);
    expect(server.scheduled).toEqual([0]);
    expect((await server.status("staging")).pending).toBe(SHA2);
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ name: "staging", host: "staging.erga.dev", branch: "staging", state: "deployed", commit: SHA2, deployed: SHA2, error: null, pending: null });
    expect(Object.keys(t).sort()).toEqual(expect.arrayContaining(["name", "host", "branch", "state", "commit", "at", "error", "log"]));
    expect(t.steps.map((s) => `${s.id}:${s.status}`)).toEqual(["build:done", ...ALL_STEPS.map((s) => `${s.id}:${s.id == "data" || s.id == "documents" ? "skipped" : "done"}`)]);
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
    const busy = new Server(mock, slow, "erga-staging", env());
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
    // Production too, from the same place; nothing of main has come yet.
    expect(await server.instance.redeploy("production")).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("No commit of main") });
    expect(await server.instance.redeploy("nope")).toMatchObject({ ok: false, status: 404 });
    expect(writesToProduction(mock.state)).toEqual([]);
    expect(productionOf(mock.state)).toBe(before);
  });

  test("the control Worker deploys itself from main, after production: its Worker only, secrets and containers kept, with a restore point", async () => {
    const mock = mockCloudflare({ fleet: true });
    const builder = mockBuilder(async () => release);
    const server = new Server(mock, builder, "erga-control", env());
    await server.instance.hook("main", SHA2, "merge by ada");
    await server.settle();
    // Production first, then the control Worker: both built (the second from the builder's cache in the real one), both deployed.
    expect(builder.built).toEqual([SHA2, SHA2]);
    expect(await server.status("production")).toMatchObject({ state: "deployed", deployed: SHA2 });
    const t = await server.status("control");
    expect(t).toMatchObject({ name: "control", host: "ops.erga.dev", branch: "main", state: "deployed", deployed: SHA2, commit: SHA2, error: null });
    expect(t.steps.map((x) => `${x.id}:${x.status}`)).toEqual(["build:done", "account:done", "worker:done", "live:done"]);
    expect(t.steps.find((x) => x.id == "account")!.detail).toMatch(/^erga-control is there, running a release before this pipeline \(deployed with wrangler\); restore point: version [0-9a-f]{8}$/);
    expect(t.steps.find((x) => x.id == "live")!.detail).toBe(`https://ops.erga.dev, release ${SHA2.slice(0, 12)}, healthy (db ok 1 ms, documents ok 2 ms)`);
    // Its upload: control/wrangler.jsonc's bindings, matched to what the Worker has; the release's version; its secrets kept; its container's class.
    const meta = mock.state.scripts["erga-control"].metadata;
    expect(meta.main_module).toBe("index.js");
    expect(meta.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(meta.containers).toEqual([{ name: "erga-control-builder", class_name: "Builder" }]);
    expect(meta.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(meta.exports).toBeUndefined();
    expect(meta.migrations).toBeUndefined();
    const b = bindingsOf(mock.state, "erga-control");
    expect(b.BUILDS).toEqual({ type: "durable_object_namespace", name: "BUILDS", class_name: "Builder" });
    expect(b.PIPELINE.class_name).toBe("Pipeline");
    expect(b.SOURCE.class_name).toBe("SourceHost");
    expect(b.DB).toEqual({ type: "d1", name: "DB", database_id: PROD_DB, id: PROD_DB });
    expect(b.ARTIFACTS).toEqual({ type: "artifacts", name: "ARTIFACTS", namespace: "erga" });
    expect(b.RELEASES).toEqual({ type: "r2_bucket", name: "RELEASES", bucket_name: "erga-releases" });
    expect(b.CF_VERSION_METADATA).toEqual({ type: "version_metadata", name: "CF_VERSION_METADATA" });
    expect(b.ERGA_VERSION.text).toBe(SHA2.slice(0, 12));
    expect(b.CLOUDFLARE_ACCOUNT_ID.text).toBe(FLEET_ACCOUNT);
    expect(b.APP_URL.text).toBe("https://erga.dev");
    expect(b.ADMINS.text).toBe(TARGETS.production.vars.ADMINS);
    expect(mock.state.scripts["erga-control"].modules).toEqual(["index.js"]);
    // No container application made or changed, no image: the Worker upload only.
    expect(mock.state.calls.filter((c) => c.includes("/containers/"))).toEqual([]);
    // Its record has the restore point (the wrangler version, no release), so Roll back works on it too.
    const [rec] = (await server.instance.historyOf("control"))!;
    expect(rec).toMatchObject({ target: "control", commit: SHA2, state: "deployed", live: true, trigger: "merge by ada" });
    expect(rec.restore).toMatchObject({ versionId: expect.stringMatching(/^[0-9a-f-]{36}$/), version: null, bookmark: null });
    // The next main commit: a restore point with the release it ran.
    await server.instance.hook("main", SHA3);
    await server.settle();
    expect(await server.status("control")).toMatchObject({ state: "deployed", deployed: SHA3 });
    const [next] = (await server.instance.historyOf("control"))!;
    expect(next.restore).toMatchObject({ version: SHA2.slice(0, 12) });
    expect(bindingsOf(mock.state, "erga-control").ERGA_VERSION.text).toBe(SHA3.slice(0, 12));
    // Staging moving deploys staging only: not the control Worker.
    const uploads = () => mock.state.calls.filter((c) => c == `PUT /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-control`).length;
    const n = uploads();
    await bootstrap(mock);
    await server.instance.hook("staging", SHA1);
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA1 });
    expect(uploads()).toBe(n);
  });

  test("a release from before the control Worker deployed itself: its deploy stops, and says so", async () => {
    const mock = mockCloudflare({ fleet: true });
    const { control: _, ...old } = release;
    const builder = mockBuilder(async () => old as Release);
    const server = new Server(mock, builder, "erga-control", env());
    await server.instance.hook("main", SHA2);
    await server.settle();
    expect(await server.status("production")).toMatchObject({ state: "deployed", deployed: SHA2 });
    const t = await server.status("control");
    expect(t).toMatchObject({ state: "failed", commit: SHA2 });
    expect(t.error).toContain("has no control Worker in it");
    expect(mock.state.calls.filter((c) => c == `PUT /accounts/${FLEET_ACCOUNT}/workers/scripts/erga-control`)).toEqual([]);
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
});

describe("a newer deploy cancels the running one", () => {
  const stagingEnv = () => env();

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

describe("the one-time setup", () => {
  test("deploy/setup.ts says what it will do, and (against the mock) does it: the control Worker's secrets, staging's first deploy, the deploy token", () => {
    const dry = Bun.spawnSync(["bun", join(ROOT, "deploy/setup.ts"), "--dry-run"], { cwd: ROOT, env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" } });
    const said = dry.stdout.toString();
    expect(dry.exitCode).toBe(0);
    expect(said).toContain("8. Check it");
    expect(said).toContain(`The credential's scopes (what an admin consents to at /install): ${CONTROL_OAUTH_SCOPES}.`);
    expect(said).toContain("--dry-run: nothing done.");
    const run = Bun.spawnSync(["bun", join(ROOT, "deploy/setup.ts"), "--yes"], { cwd: ROOT, env: { ...process.env, ERGA_DEPLOY_MOCK: "1", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" } });
    const out = run.stdout.toString();
    expect(run.exitCode).toBe(0);
    expect(out).toContain("(the mock Cloudflare: nothing real)");
    expect(out).toContain("Set: erga-control: SESSION_SECRET, GITHUB_APP_CLIENT_SECRET, SNAPSHOT_TOKEN; erga: SNAPSHOT_TOKEN.");
    expect(out).toContain("Copy production's documents into it: done, 3 documents copied");
    expect(out).toContain("The grant: not connected. An admin clicks Connect Cloudflare on the Ops page (https://ops.erga.dev/), a consent in a popup; the deploys that waited run after that.");
    expect(out).not.toContain("CLOUDFLARE_DEPLOY_TOKEN");
    expect(out).toContain("https://ops.erga.dev/api/health: ok true");
    expect(out).toMatch(/runs [0-9a-f]{12}; it says it's staging/);
  }, 60_000);

  test("deploy/run.ts refuses production's names for staging, and needs credentials", () => {
    const r = Bun.spawnSync(["bun", join(ROOT, "deploy/run.ts"), "nowhere"], { cwd: ROOT });
    expect(r.exitCode).toBe(2);
    // (A wrong account, so a cf CLI login on this machine can't take it any further.)
    const noCreds = Bun.spawnSync(["bun", join(ROOT, "deploy/run.ts"), "staging", "--yes"], { cwd: ROOT, env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "not-an-account" } });
    expect(noCreds.exitCode).toBe(1);
    expect(noCreds.stderr.toString()).toContain("Set the account");
  });
});

describe("staging's data copy (a Redeploy with a fresh copy) runs while the commit builds", () => {
  const stagingEnv = () => env();
  /** A push of `commit` to staging, and a fresh copy asked for before its deploy starts. */
  const pushFresh = async (server: Server, commit: string, trigger?: string) => {
    await server.instance.hook("staging", commit, trigger);
    expect(await server.instance.redeploy("staging", "redeploy by ada", { fresh: true })).toMatchObject({ ok: true });
  };
  const imported = (mock: ReturnType<typeof mockCloudflare>) => mock.state.calls.some((c) => c.includes("/import"));
  /** A builder that ends only once the database copy is done (it never would if the copy waited for the build), or fails when told. */
  const waitsForCopy = (mock: ReturnType<typeof mockCloudflare>, o: { fail?: string; hang?: boolean } = {}) => {
    const b = {
      built: [] as string[], stopped: [] as string[], sawCopy: false,
      async build({ commit }: { commit: string }, log: (l: string) => void, signal?: AbortSignal): Promise<Release> {
        log("$ bun install --frozen-lockfile");
        if (o.fail) throw new Error(o.fail);
        for (let i = 0; i < 400 && (o.hang || !imported(mock)); i++) {
          if (signal?.aborted) { b.stopped.push(commit); throw signal.reason; }
          await new Promise((r) => setTimeout(r, 5));
        }
        b.sawCopy = imported(mock);
        b.built.push(commit);
        return { ...release, version: commit.slice(0, 12) };
      },
    };
    return b;
  };

  test("the account, database and data steps run during the build; the rest after it, on the copy's database", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = waitsForCopy(mock);
    const server = new Server(mock, builder as never, "erga-staging", stagingEnv());
    const before = productionOf(mock.state);
    await pushFresh(server, SHA2);
    await server.settle();
    expect(builder.sawCopy).toBe(true);
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "deployed", deployed: SHA2, error: null });
    expect(t.steps.map((x) => `${x.id}:${x.status}`)).toEqual(["build:done", ...ALL_STEPS.map((s) => `${s.id}:done`)]);
    // The copy's steps ended before the build did; the migrations started only after it.
    const lines = (await server.instance.logOf("staging"))!.lines;
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l.text));
    expect(at(/^Copy production's database into it: done/)).toBeGreaterThan(-1);
    expect(at(/^Copy production's database into it: done/)).toBeLessThan(at(/^built release/));
    expect(at(/^Set up the database's tables…/)).toBeGreaterThan(at(/^built release/));
    // The Worker went up on the copy's database, with the tombstone (the Worker was there: the account step's answer, carried over).
    const db = stagingDbOf(mock.state);
    expect(bindingsOf(mock.state, "erga-staging").DB.database_id).toBe(db.uuid);
    expect(db.rows).toEqual(mock.state.databases.find((d) => d.uuid == PROD_DB)!.rows!);
    expect(mock.state.scripts["erga-staging"].metadata.exports.DocList).toEqual({ type: "durable-object", state: "deleted" });
    expect(writesToProduction(mock.state)).toEqual([]);
    expect(productionOf(mock.state)).toBe(before);
  });

  test("production copies nothing: no step runs before its build ends", async () => {
    const mock = mockCloudflare({ fleet: true });
    const inner = mockBuilder(async () => release);
    const seen: string[] = [];
    // The calls made while production's build runs (the first build: the control Worker's own deploy builds after production's).
    const builder = { ...inner, build: async (o: any, log: any, signal: any) => { const r = await inner.build(o, log, signal); if (inner.built.length == 1) seen.push(...mock.state.calls); return r; } };
    const server = new Server(mock, builder as never, "erga", env());
    await server.instance.hook("main", SHA2);
    await server.settle();
    expect(await server.status("production")).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(seen.filter((c) => !c.includes("/artifacts/"))).toEqual([]); // only the source's read token, for the build
  });

  test("the build fails: the copy stops after its step, the deploy fails at the build, nothing goes up", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const uploads = mock.state.versions["erga-staging"];
    const server = new Server(mock, waitsForCopy(mock, { fail: "bun install: lockfile changed" }) as never, "erga-staging", stagingEnv());
    await server.instance.hook("staging", SHA2);
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "failed", error: "Stopped at “Build the commit”. Something went wrong: bun install: lockfile changed" });
    expect(t.steps.filter((x) => x.status == "failed").map((x) => x.id)).toEqual(["build"]);
    expect(t.steps.find((x) => x.id == "worker")!.status).toBe("pending");
    expect(mock.state.versions["erga-staging"]).toBe(uploads);
    expect(server.version()).toBe(SHA1.slice(0, 12));
  });

  test("the copy fails: the build is stopped, and the deploy fails at the copy's step; Redeploy finishes it", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = waitsForCopy(mock, { hang: true });
    const server = new Server(mock, builder as never, "erga-staging", stagingEnv());
    mock.state.failNext = "data";
    await pushFresh(server, SHA2);
    await server.settle();
    const t = await server.status("staging");
    expect(t.state).toBe("failed");
    expect(t.error).toContain("Stopped at “Copy production's database into it”.");
    expect(t.steps.find((x) => x.id == "build")!.status).toBe("cancelled");
    expect(t.steps.filter((x) => x.status == "failed").map((x) => x.id)).toEqual(["data"]);
    expect(builder.stopped).toEqual([SHA2]);
    expect(server.version()).toBe(SHA1.slice(0, 12));
    const again = new Server(mock, waitsForCopy(mock) as never, "erga-staging", stagingEnv());
    again.storage = server.storage;
    again.start();
    expect((await again.instance.redeploy("staging", "redeploy by ada", { fresh: true })).ok).toBe(true);
    await again.settle();
    expect(await again.status("staging")).toMatchObject({ state: "deployed", deployed: SHA2 });
  });

  test("a newer push during the copy cancels both sides; the newer one deploys", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const builder = waitsForCopy(mock, { hang: true });
    const server = new Server(mock, builder as never, "erga-staging", stagingEnv());
    await pushFresh(server, SHA2, "push by ada");
    server.scheduled = [];
    let pushed: Promise<void> | null = null;
    const watch = setInterval(() => { if (!pushed && mock.state.calls.some((c) => c.startsWith("POST") && c.endsWith("/d1/database"))) pushed = server.instance.hook("staging", SHA3, "push by bo"); }, 0);
    await server.instance.alarm();
    clearInterval(watch);
    await pushed;
    const mid = await server.status("staging");
    expect(mid).toMatchObject({ state: "cancelled", commit: SHA2, pending: SHA3 });
    expect(builder.stopped).toEqual([SHA2]);
    expect(mid.steps.find((x) => x.id == "build")!.status).toBe("cancelled");
    expect(mid.steps.find((x) => x.id == "migrations")!.status).toBe("cancelled");
    // The copy it made is deleted; staging stays on its database.
    expect((await server.instance.logOf("staging"))!.lines.map((l) => l.text)).toContainEqual(expect.stringContaining("deleted the copy this deploy made, which nothing uses"));
    expect(stagingCopies(mock.state)).toEqual([stagingDbOf(mock.state).name]);
    const next = new Server(mock, waitsForCopy(mock) as never, "erga-staging", stagingEnv());
    next.storage = server.storage;
    next.start();
    next.scheduled = [0];
    await next.settle();
    expect(await next.status("staging")).toMatchObject({ state: "deployed", deployed: SHA3 });
    expect(next.version()).toBe(SHA3.slice(0, 12));
  });

  test("a restart during the copy (before the upload): it runs again from the top by itself", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const server = new Server(mock, waitsForCopy(mock) as never, "erga-staging", stagingEnv());
    const s = server;
    const watch = setInterval(() => { if (mock.state.calls.some((c) => c.endsWith("/export"))) s.alive.on = false; }, 0);
    await pushFresh(s, SHA2, "push by ada");
    s.scheduled = [];
    await s.instance.alarm().catch(() => {});
    clearInterval(watch);
    server.start();
    await server.instance.alarm();
    await server.settle();
    expect(await server.status("staging")).toMatchObject({ state: "deployed", deployed: SHA2 });
    const history = (await server.instance.historyOf("staging"))!;
    expect(history.map((r) => r.state)).toEqual(["deployed", "failed"]);
    // Run again with the fresh copy still asked for.
    expect(history[0].trigger).toBe("redeploy by ada, again after a restart");
    expect(history[1].trigger).toBe("redeploy by ada");
    expect(stagingDbOf(mock.state).rows).toEqual(mock.state.databases.find((d) => d.uuid == PROD_DB)!.rows!);
    expect(bindingsOf(mock.state, "erga-staging").DB.database_id).toBe(stagingDbOf(mock.state).uuid);
  });
});

describe("staging's copy of production's data: frozen, a database of its own each time it's copied, only when asked", () => {
  const stagingEnv = () => env();
  /** Deploys `commit` (kept data), then redeploys it with a fresh copy of production's data. */
  const freshly = async (server: Server, commit: string) => {
    await server.instance.hook("staging", commit);
    await server.settle();
    expect(await server.instance.redeploy("staging", "redeploy by ada", { fresh: true })).toMatchObject({ ok: true });
  };
  const stepOf = (t: TargetStatus, id: string) => t.steps.find((x) => x.id == id)!;
  const exports = (mock: ReturnType<typeof mockCloudflare>) => mock.state.calls.filter((c) => c.endsWith(`/d1/database/${PROD_DB}/export`)).length;
  /** Makes staging's copy look `hours` old (the age is in its name). */
  const age = (mock: ReturnType<typeof mockCloudflare>, hours: number) => { const db = stagingDbOf(mock.state); db.name = copyName("erga-staging", Date.now() - hours * 3600_000); return db; };

  test("no downtime: staging's Worker is never on a missing database; the old copy goes only after the new version answers", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const old = stagingDbOf(mock.state);
    const server = new Server(mock, mockBuilder(async () => release, { delayMs: 20 }), "erga-staging", stagingEnv());
    // Every few ms of the deploys: the database staging's Worker is bound to is there.
    const missing: string[] = [];
    const watch = setInterval(() => { const id = bindingsOf(mock.state, "erga-staging").DB.database_id; if (!mock.state.databases.some((d) => d.uuid == id)) missing.push(id); }, 1);
    await freshly(server, SHA2);
    await server.settle();
    clearInterval(watch);
    expect(missing).toEqual([]);
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "deployed", deployed: SHA2 });
    const now = stagingDbOf(mock.state);
    expect(now.uuid).not.toBe(old.uuid);
    expect(now.name).toMatch(/^erga-staging-[0-9a-z]{8,10}$/);
    expect(mock.state.deletedDatabases).toEqual([old.name]);
    expect(stagingCopies(mock.state)).toEqual([now.name]);
    expect(stepOf(t, "cleanup")).toMatchObject({ status: "done", detail: `deleted ${old.name}` });
    // In the log: the new version answered before the old copy went.
    const lines = (await server.instance.logOf("staging"))!.lines.map((l) => l.text);
    expect(lines.findIndex((l) => l.startsWith("Wait for it to answer: done"))).toBeLessThan(lines.findIndex((l) => l.startsWith("Delete the old copies of the database: done")));
    expect(writesToProduction(mock.state)).toEqual([]);
  });

  test("a failed build: staging stays on its version and its database, and the copy made beside it is deleted", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const old = stagingDbOf(mock.state), rows = [...old.rows!];
    const builder = mockBuilder(async () => release, { delayMs: 20 });
    const server = new Server(mock, builder, "erga-staging", stagingEnv());
    await server.instance.hook("staging", SHA2);
    await server.settle();
    builder.failNext = "bun install: lockfile changed";
    expect(await server.instance.redeploy("staging", "redeploy by ada", { fresh: true })).toMatchObject({ ok: true });
    await server.settle();
    const t = await server.status("staging");
    expect(t.state).toBe("failed");
    expect(stepOf(t, "database").status).toBe("done");
    expect(server.version()).toBe(SHA2.slice(0, 12));
    expect(stagingDbOf(mock.state).uuid).toBe(old.uuid);
    expect(stagingDbOf(mock.state).rows).toEqual(rows);
    expect(stagingCopies(mock.state)).toEqual([old.name]);
    expect(mock.state.deletedDatabases).toHaveLength(1);
    expect(mock.state.deletedDatabases[0]).not.toBe(old.name);
    expect((await server.instance.logOf("staging"))!.lines.map((l) => l.text)).toContainEqual(expect.stringContaining("deleted the copy this deploy made, which nothing uses"));
  });

  test("cleanup: a copy a stopped deploy left is deleted by the next one, never the one staging is on, nor production's", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const old = stagingDbOf(mock.state);
    // A deploy that died half way (its server gone before it could tidy up) left a copy; another project's database is there too.
    const stray = copyName("erga-staging", Date.now() - 60_000);
    mock.state.databases.push({ uuid: "dead0000-0000-4000-8000-000000000001", name: stray, statements: [], migrations: [], tables: [] } as never);
    mock.state.databases.push({ uuid: "dead0000-0000-4000-8000-000000000002", name: "erga-staging-notes", statements: [], migrations: [], tables: [] } as never);
    const server = new Server(mock, mockBuilder(async () => release), "erga-staging", stagingEnv());
    await server.instance.hook("staging", SHA2);
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(stepOf(t, "database").detail).toContain(`1 left by an earlier deploy deleted (${stray})`);
    expect(mock.state.deletedDatabases).toEqual([stray]);
    expect(stagingDbOf(mock.state).uuid).toBe(old.uuid);
    expect(mock.state.databases.map((d) => d.name)).toEqual(expect.arrayContaining(["erga", "erga-staging-notes", old.name]));
    expect(stepOf(t, "cleanup").detail).toBe("none to delete");
    // Production's database can't take a name like a copy's: the guard stops such a deploy before anything.
    expect(guardTarget({ ...staging(), guard: { ...staging().guard!, database: copyName("erga-staging", Date.now()) } })).toMatch(/name like a copy/);
  });

  test("a commit with a new migration, and a copy days old: staging keeps its database and documents, and the migration runs on them", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    // The copy is 3 days old, and staging has an edit of its own.
    const old = stagingDbOf(mock.state);
    old.name = copyName("erga-staging", Date.now() - 72 * 3600_000);
    mock.state.docs["erga-staging"].docs.get(PROD_DOCS[0])!.entries.set("file:index.html", new TextEncoder().encode("edited on staging"));
    const rows = [...old.rows!];
    const seen = exports(mock);
    // The commit adds a migration staging's database hasn't had.
    const migrated = { ...release, version: SHA2.slice(0, 12), migrations: { ...release.migrations, "0999_new_table.sql": "CREATE TABLE new_table (id TEXT PRIMARY KEY);" } };
    const server = new Server(mock, mockBuilder(async () => migrated), "erga-staging", stagingEnv());
    await server.instance.hook("staging", SHA2);
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(stepOf(t, "database").detail).toMatch(new RegExp(`^kept "${old.name}" .*frozen`));
    expect(stepOf(t, "data")).toMatchObject({ status: "skipped" });
    expect(stepOf(t, "documents")).toMatchObject({ status: "skipped" });
    expect(stepOf(t, "migrations")).toMatchObject({ status: "done", detail: expect.stringMatching(/^applied 0999_new_table.sql; restore point: version [0-9a-f]{8} \(release \w+\), database bookmark \S+$/) });
    expect(exports(mock)).toBe(seen);
    // The same database, its rows kept, the migration applied and recorded; staging's own edit kept.
    const db = stagingDbOf(mock.state);
    expect(db.uuid).toBe(old.uuid);
    expect(db.rows).toEqual(rows);
    expect(db.migrations).toContain("0999_new_table.sql");
    expect(db.statements.some((q) => q.includes("CREATE TABLE new_table"))).toBe(true);
    expect(mock.state.deletedDatabases).toEqual([]);
    expect(new TextDecoder().decode(mock.state.docs["erga-staging"].docs.get(PROD_DOCS[0])!.entries.get("file:index.html") as Uint8Array)).toBe("edited on staging");
    expect(server.version()).toBe(SHA2.slice(0, 12));
    expect(writesToProduction(mock.state)).toEqual([]);
  });

  test("Redeploy with a fresh copy: copied however new the copy is; production refuses it; a newer push keeps it asked for", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const old = stagingDbOf(mock.state);
    const server = new Server(mock, mockBuilder(async () => release), "erga-staging", stagingEnv());
    await server.instance.hook("staging", SHA2);
    await server.settle();
    expect(stepOf(await server.status("staging"), "data").status).toBe("skipped");
    expect(await server.instance.redeploy("staging", "redeploy by ada", { fresh: true })).toMatchObject({ ok: true });
    await server.settle();
    const t = await server.status("staging");
    expect(t).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(stepOf(t, "database").detail).toContain("a fresh copy was asked for");
    expect(stepOf(t, "data").status).toBe("done");
    expect(stagingDbOf(mock.state).uuid).not.toBe(old.uuid);
    expect(t.log.some((l) => l.includes("asked for (redeploy by ada), with a fresh copy of production's data"))).toBe(true);
    // The next deploy, not asked: kept again.
    await server.instance.hook("staging", SHA3);
    await server.settle();
    expect(stepOf(await server.status("staging"), "data").status).toBe("skipped");
    // Asked for, then a push comes before it runs: the push's deploy copies afresh.
    await server.instance.redeploy("staging", "redeploy by ada", { fresh: true });
    await server.instance.hook("staging", SHA1, "push by bo");
    await server.settle();
    expect(stepOf(await server.status("staging"), "database").detail).toContain("a fresh copy was asked for");
    // Production takes no copy: refused.
    const prod = new Server(mock, mockBuilder(async () => release), "erga", env());
    expect(await prod.instance.redeploy("production", "redeploy by ada", { fresh: true })).toMatchObject({ ok: false, status: 400 });
    // The rule itself.
    const live = { made: Date.now() - 30 * 24 * 3600_000 };
    expect(copyReason({ live })).toBeNull();
    expect(copyReason({ live: { made: null } })).toBeNull();
    expect(copyReason({ fresh: true, live })).toBe("a fresh copy was asked for");
    expect(copyReason({ live: null })).toBe("there's no copy yet");
  });
});

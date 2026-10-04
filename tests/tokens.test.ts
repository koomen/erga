// Erga's own deploy tokens (deploy/tokens.ts), against the mock Cloudflare's
// copy of Erga's account (deploy/mock.ts, fleet), which enforces a token's
// policies as Cloudflare does: staging's token deploys staging and nothing
// else; production's deploys production and staging; neither can write DNS,
// routes or custom domains. And production deploying staging itself when
// staging's server doesn't take a move, and the Artifacts binding going only
// to Erga's own targets. Nothing real is touched.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { BranchDeploys, targetOf, type DeployEnv } from "../deploy/branches";
import { artifactsNamespace } from "../deploy/builder/build";
import { Cloudflare, loadRelease, runPipeline, targetOfPlan, workerMetadata, type Release } from "../deploy/cloudflare";
import { FLEET_ACCOUNT, MOCK_HOOK_SECRET, MOCK_SNAPSHOT_TOKEN, mockBuilder, mockCloudflare } from "../deploy/mock";
import { TARGETS } from "../deploy/targets";
import { checkToken, createToken, permissionIds, policiesFor, tokenPlan } from "../deploy/tokens";

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

const SHA1 = "1111111111111111111111111111111111111111", SHA2 = "2222222222222222222222222222222222222222";
const quick = { sleep: async () => {}, waitMs: 2000 };
type Mock = ReturnType<typeof mockCloudflare>;
const admin = (mock: Mock) => new Cloudflare("mock-setup-token", mock.fetch);
const stagingSecrets = { SESSION_SECRET: "staging-session-secret-0123456789", SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: MOCK_HOOK_SECRET };

/** Staging's first deploy, from a machine with the setup's own credential (it makes erga-staging, its address, its pages' route). */
async function bootstrap(mock: Mock) {
  await runPipeline(admin(mock), { ...release, version: SHA1.slice(0, 12) }, { ...targetOf(TARGETS.staging, { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT, SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN }), secrets: stagingSecrets }, { ...quick, site: mock.fetch, report: () => {} });
}

/** A deploy token for `name`, made and checked as deploy/setup.ts does: its value and what the check found. */
async function mint(mock: Mock, name: "staging" | "production") {
  const plan = tokenPlan(name);
  const policies = await policiesFor(admin(mock), FLEET_ACCOUNT, plan, await permissionIds(admin(mock), FLEET_ACCOUNT));
  const made = await createToken(admin(mock), FLEET_ACCOUNT, plan, policies);
  const wrong = await checkToken({ net: mock.fetch, admin: admin(mock), accountId: FLEET_ACCOUNT, plan, id: made.id, value: made.value, policies });
  return { ...made, wrong, policies };
}

/** Everything about production that a deploy of staging mustn't change. */
const productionOf = (mock: Mock) => JSON.stringify({
  script: mock.state.scripts.erga, versions: mock.state.versions.erga, secrets: mock.state.secrets.erga,
  domains: mock.state.domains, routes: Object.values(mock.state.routes).flat(), dns: Object.values(mock.state.dns).flat(),
});

/** One of Erga's servers (deploy/branches.ts), its settings and secrets as the mock has them for its Worker. */
function server(mock: Mock, script: string, builder: ReturnType<typeof mockBuilder>, over: DeployEnv = {}) {
  const storage = new Map<string, unknown>();
  const scheduled: number[] = [];
  const b = Object.fromEntries((mock.state.scripts[script].metadata.bindings as any[]).map((x) => [x.name, x]));
  const s = mock.state.secrets[script] ?? {};
  const instance = new BranchDeploys({
    storage: { get: async (k) => structuredClone(storage.get(k)) as any, put: async (k, v) => { storage.set(k, structuredClone(v)); }, delete: async (k) => { storage.delete(k); } },
    env: { DEPLOY_TARGET: b.DEPLOY_TARGET?.text, CLOUDFLARE_ACCOUNT_ID: b.CLOUDFLARE_ACCOUNT_ID?.text ?? FLEET_ACCOUNT, CLOUDFLARE_DEPLOY_TOKEN: s.CLOUDFLARE_DEPLOY_TOKEN, SNAPSHOT_TOKEN: s.SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: s.DEPLOY_HOOK_SECRET, ...over },
    net: mock.fetch, builder, schedule: (ms) => { scheduled.push(ms); }, changed: () => {}, ...quick,
    // The source, through the server's own Artifacts binding (worker/source.ts), as on Cloudflare: the deploy token has no Artifacts permission.
    source: async () => ({ cloneUrl: "https://artifacts.mock/git/erga/erga.git", token: "art-read-binding" }),
  });
  return { instance, scheduled, async settle() { for (let i = 0; i < 10 && scheduled.length; i++) { scheduled.length = 0; await instance.alarm(); } } };
}

describe("the deploy tokens' plans", () => {
  test("staging's may deploy erga-staging only; production's erga and erga-staging; both read the two zones", () => {
    expect(tokenPlan("staging")).toEqual({ name: "erga-deploy-staging", target: "staging", storedOn: "erga-staging", workers: ["erga-staging"], zones: ["erga.dev", "erga-pages.dev"], notWorkers: ["erga"] });
    expect(tokenPlan("production")).toEqual({ name: "erga-deploy-production", target: "production", storedOn: "erga", workers: ["erga", "erga-staging"], zones: ["erga.dev", "erga-pages.dev"], notWorkers: [] });
  });

  test("the policies: Editor on the Workers by tag, D1 on the account, read on the zones; nothing else", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const { policies, wrong } = await mint(mock, "staging");
    expect(wrong).toEqual([]);
    const groups = policies.map((p) => p.permission_groups.map((g) => g.id).sort().join(","));
    expect(groups).toEqual(["7e79ec33834341f28dd431ab73884400", "09b2857d1c31407795e75e3fed8617a1", ["2072033d694d415a936eaeb94e6405b8", "82e64a83756745bbbb1c9c2701bf816b", "c8fed203ed3043cba015a93ad1616f1f"].sort().join(",")]);
    expect(Object.keys(policies[0].resources)).toEqual([expect.stringMatching(/^com\.cloudflare\.edge\.worker\.script\.[0-9a-f]{32}$/)]);
    expect(Object.keys(policies[1].resources)).toEqual([`com.cloudflare.api.account.${FLEET_ACCOUNT}`]);
    expect(Object.keys(policies[2].resources)).toHaveLength(2);
  });

  test("a token can't name a Worker that isn't there yet (so staging's first deploy comes first)", async () => {
    const mock = mockCloudflare({ fleet: true });
    await expect(mint(mock, "staging")).rejects.toThrow("no Worker called erga-staging");
  });

  test("the check catches a token broader than its plan", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    // Production's policies, checked as if they were staging's token: it reaches erga, which staging's mustn't.
    const prodPolicies = await policiesFor(admin(mock), FLEET_ACCOUNT, tokenPlan("production"), await permissionIds(admin(mock), FLEET_ACCOUNT));
    const made = await createToken(admin(mock), FLEET_ACCOUNT, tokenPlan("staging"), prodPolicies);
    const wrong = await checkToken({ net: mock.fetch, admin: admin(mock), accountId: FLEET_ACCOUNT, plan: tokenPlan("staging"), id: made.id, value: made.value, policies: (await policiesFor(admin(mock), FLEET_ACCOUNT, tokenPlan("staging"), await permissionIds(admin(mock), FLEET_ACCOUNT))) });
    expect(wrong.join("; ")).toContain("read erga's settings");
    expect(wrong.join("; ")).toContain("policies aren't the plan's");
  });
});

describe("deploying with them", () => {
  test("staging's token deploys staging (address, route and DNS only read), and is refused production", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const before = productionOf(mock);
    const { value } = await mint(mock, "staging");
    const calls = mock.state.calls.length;
    const steps: string[] = [];
    await runPipeline(new Cloudflare(value, mock.fetch), { ...release, version: SHA2.slice(0, 12) }, targetOf(TARGETS.staging, { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT, SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN }), { ...quick, site: mock.fetch, report: (id, status, detail) => steps.push(`${id}:${status}${detail ? ` ${detail}` : ""}`) });
    expect(steps).toContain("address:done https://staging.erga.dev (already its address)");
    expect(steps.at(-1)).toMatch(/^documents:done/);
    // No write to a custom domain, a route or a DNS record: the token can only read them.
    expect(mock.state.calls.slice(calls).filter((c) => /^(PUT|POST|DELETE) .*(workers\/domains|dns_records|workers\/routes)/.test(c))).toEqual([]);
    expect(productionOf(mock)).toBe(before);
    // Production with staging's token: refused, before anything changes.
    await expect(runPipeline(new Cloudflare(value, mock.fetch), release, targetOf(TARGETS.production, { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT }), { ...quick, site: mock.fetch, report: () => {} })).rejects.toThrow("isn't allowed");
    expect(productionOf(mock)).toBe(before);
  });

  test("staging deploys itself with its own token: a push, built, deployed, production untouched", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const { value } = await mint(mock, "staging");
    mock.state.secrets["erga-staging"].CLOUDFLARE_DEPLOY_TOKEN = value;
    const before = productionOf(mock);
    const builder = mockBuilder(async () => release);
    const staging = server(mock, "erga-staging", builder);
    await staging.instance.hook("staging", SHA2, "push by ada");
    await staging.settle();
    expect((await staging.instance.status({ remote: false })).targets.find((t) => t.name == "staging")).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(productionOf(mock)).toBe(before);
    // Its Worker kept the source's binding (the Git endpoint), and only Erga's own targets get one.
    expect((mock.state.scripts["erga-staging"].metadata.bindings as any[]).find((b) => b.name == "BUILDER")).toMatchObject({ service: "erga-builder" });
  });

  test("production's token deploys staging too; production deploys staging itself when staging's server doesn't take a move", async () => {
    let stagingUp = false;
    const mock = mockCloudflare({
      fleet: true,
      sites: async (req, script) => {
        const url = new URL(req.url);
        if (script != "erga-staging" || !url.pathname.startsWith("/api/deploys/") || url.pathname == "/api/deploys/version") return null;
        return stagingUp ? Response.json({ ok: true }) : Response.json({ error: "Branch deploys aren't set up on this server" }, { status: 400 });
      },
    });
    await bootstrap(mock);
    const { value, wrong } = await mint(mock, "production");
    expect(wrong).toEqual([]);
    const before = productionOf(mock);
    const builder = mockBuilder(async () => release);
    const production = server(mock, "erga", builder, { DEPLOY_TARGET: "production", CLOUDFLARE_DEPLOY_TOKEN: value, SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: MOCK_HOOK_SECRET });
    expect(production.instance.deploysTo).toEqual(["production", "staging"]);
    await production.instance.hook("staging", SHA2, "merge by ada");
    expect(production.scheduled).toEqual([0]);
    await production.settle();
    const t = (await production.instance.status({ remote: false })).targets.find((x) => x.name == "staging")!;
    expect(t).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(t.log.some((l) => l.includes("didn't take it (400: Branch deploys aren't set up"))).toBe(true);
    const [rec] = (await production.instance.historyOf("staging"))!;
    expect(rec.trigger).toBe("merge by ada, deployed by erga.dev");
    expect(builder.built).toEqual([SHA2]);
    expect(bindingsVersion(mock, "erga-staging")).toBe(SHA2.slice(0, 12));
    expect(productionOf(mock)).toBe(before);
    // Staging up again: production passes the next move on and deploys nothing itself.
    stagingUp = true;
    production.scheduled.length = 0;
    await production.instance.hook("staging", SHA1, "push by ada");
    expect(production.scheduled).toEqual([]);
  });

  test("staging's server never deploys production, whatever it hears", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const { value } = await mint(mock, "staging");
    const staging = server(mock, "erga-staging", mockBuilder(async () => release), { DEPLOY_TARGET: "staging", CLOUDFLARE_DEPLOY_TOKEN: value, SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: MOCK_HOOK_SECRET });
    expect(staging.instance.deploysTo).toEqual(["staging"]);
    expect(staging.instance.notReady("production")).toContain("doesn't deploy production");
    await staging.instance.hook("main", SHA2, "merge by ada"); // production's server isn't there: nothing is deployed here
    expect(staging.scheduled).toEqual([]);
  });
});

const bindingsVersion = (mock: Mock, script: string) => (mock.state.scripts[script].metadata.bindings as any[]).find((b) => b.name == "ERGA_VERSION")?.text;

describe("Erga's source on its own servers", () => {
  test("a release's Artifacts binding goes to Erga's own targets only; /deploy's copies leave it out", () => {
    const rel: Release = { ...release, worker: { ...release.worker, env: { ...release.worker.env, ARTIFACTS: { type: "artifacts", namespace: "erga" } } } };
    const meta = (t: Parameters<typeof workerMetadata>[1]) => workerMetadata(rel, t, { dbId: "db", assetsJwt: "jwt", pagesHost: null }).bindings as any[];
    expect(meta(targetOf(TARGETS.staging, { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT })).find((b) => b.name == "ARTIFACTS")).toEqual({ type: "artifacts", name: "ARTIFACTS", namespace: "erga" });
    const plan = { accountId: FLEET_ACCOUNT, workerName: "erga", subdomain: "ada", createSubdomain: false, app: { kind: "workers.dev" as const }, pages: { kind: "shared" as const }, admin: "ada", githubClientId: "x", githubClientSecret: "y" } as any;
    expect(meta(targetOfPlan(plan, "s".repeat(32))).find((b) => b.name == "ARTIFACTS")).toBeUndefined();
  });

  test("a branch build binds the namespace the commit's own deploy/targets.json names", () => {
    expect(artifactsNamespace(ROOT)).toBe("erga");
    expect(artifactsNamespace("/nonexistent")).toBeNull();
  });
});

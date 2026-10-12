// Erga's deploy token (the control Worker's), against the mock Cloudflare's
// copy of Erga's account, which enforces a token's policies as Cloudflare
// does: it deploys staging, production and the control Worker, and nothing
// else; it can't write DNS, routes or custom domains. And the Artifacts
// binding going to no app Worker. Nothing real is touched.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { BranchDeploys, targetOf, type DeployEnv } from "../deploy/branches";
import { artifactsNamespace } from "../control/builder/build";
import { Cloudflare, loadRelease, runPipeline, targetOfPlan, workerMetadata, type Release } from "../deploy/pipeline";
import { FLEET_ACCOUNT, MOCK_SNAPSHOT_TOKEN, mockBuilder, mockCloudflare } from "../deploy/mock-cloudflare";
import { TARGETS } from "../deploy/targets";
import { checkToken, createToken, diagnoseMaker, permissionIds, policiesFor, tokenPlan, type TokenPlan } from "../deploy/server-tokens";

const ROOT = new URL("..", import.meta.url).pathname;
let release: Release;
beforeAll(async () => {
  const dir = join(ROOT, ".build/release");
  if (!existsSync(join(dir, "release.json"))) {
    if (!existsSync(join(ROOT, ".build/page.js"))) expect(Bun.spawnSync([join(ROOT, "client/build.sh")], { cwd: ROOT }).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", join(ROOT, "deploy/release.ts")], { cwd: ROOT }).exitCode).toBe(0);
  }
  release = (await loadRelease(async (p) => (existsSync(join(dir, p)) ? new Uint8Array(readFileSync(join(dir, p))) : null)))!;
}, 120_000);

const SHA1 = "1111111111111111111111111111111111111111", SHA2 = "2222222222222222222222222222222222222222";
const quick = { sleep: async () => {}, waitMs: 2000 };
type Mock = ReturnType<typeof mockCloudflare>;
const admin = (mock: Mock) => new Cloudflare("mock-setup-token", mock.fetch);
const stagingSecrets = { SESSION_SECRET: "staging-session-secret-0123456789", SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN };

/** Staging's first deploy, from a machine with the setup's own credential (it makes erga-staging, its address, its pages' route). */
async function bootstrap(mock: Mock) {
  await runPipeline(admin(mock), { ...release, version: SHA1.slice(0, 12) }, { ...targetOf(TARGETS.staging, { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT, SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN }), secrets: stagingSecrets }, { ...quick, site: mock.fetch, report: () => {} });
}

/** The deploy token, made and checked as deploy/setup.ts does: its value and what the check found. */
async function mint(mock: Mock, plan: TokenPlan = tokenPlan()) {
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

/** One of Erga's servers, its settings and secrets as the mock has them for its Worker. */
function server(mock: Mock, script: string, builder: ReturnType<typeof mockBuilder>, over: DeployEnv = {}) {
  const storage = new Map<string, unknown>();
  const scheduled: number[] = [];
  const b = Object.fromEntries((mock.state.scripts[script].metadata.bindings as any[]).map((x) => [x.name, x]));
  const s = mock.state.secrets[script] ?? {};
  const instance = new BranchDeploys({
    storage: { get: async (k) => structuredClone(storage.get(k)) as any, put: async (k, v) => { storage.set(k, structuredClone(v)); }, delete: async (k) => { storage.delete(k); } },
    env: { CLOUDFLARE_ACCOUNT_ID: b.CLOUDFLARE_ACCOUNT_ID?.text ?? FLEET_ACCOUNT, CLOUDFLARE_DEPLOY_TOKEN: s.CLOUDFLARE_DEPLOY_TOKEN, SNAPSHOT_TOKEN: s.SNAPSHOT_TOKEN, ...over },
    net: mock.fetch, builder, schedule: (ms) => { scheduled.push(ms); }, changed: () => {}, ...quick,
    // The source, through the server's own Artifacts binding, as on Cloudflare: the deploy token has no Artifacts permission.
    source: async () => ({ cloneUrl: "https://artifacts.mock/git/erga/erga.git", token: "art-read-binding" }),
  });
  return { instance, scheduled, async settle() { for (let i = 0; i < 10 && scheduled.length; i++) { scheduled.length = 0; await instance.alarm(); } } };
}

describe("the deploy token's plan", () => {
  test("the control Worker's: Editor on erga, erga-staging and itself; read on the three zones", () => {
    expect(tokenPlan()).toEqual({ name: "erga-control-deploy", storedOn: "erga-control", workers: ["erga", "erga-staging", "erga-control"], zones: ["erga.dev", "erga-pages.dev", "erga-pages-staging.dev"], notWorkers: [] });
  });

  test("the policies: Editor on the Workers by tag, D1 and containers on the account, read on the zones; nothing else", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const { policies, wrong } = await mint(mock);
    expect(wrong).toEqual([]);
    const groups = policies.map((p) => p.permission_groups.map((g) => g.id).sort().join(","));
    expect(groups).toEqual(["7e79ec33834341f28dd431ab73884400", "09b2857d1c31407795e75e3fed8617a1,bdbcd690c763475a985e8641dddc09f7", ["2072033d694d415a936eaeb94e6405b8", "82e64a83756745bbbb1c9c2701bf816b", "c8fed203ed3043cba015a93ad1616f1f"].sort().join(",")]);
    // The Worker's key sits under the account's (on its own, Cloudflare refuses the token: code 1004).
    expect(Object.keys(policies[0].resources)).toEqual([`com.cloudflare.api.account.${FLEET_ACCOUNT}`]);
    expect(Object.keys(policies[0].resources[`com.cloudflare.api.account.${FLEET_ACCOUNT}`])).toEqual([1, 2, 3].map(() => expect.stringMatching(/^com\.cloudflare\.edge\.worker\.script\.[0-9a-f]{32}$/)));
    expect(Object.keys(policies[1].resources)).toEqual([`com.cloudflare.api.account.${FLEET_ACCOUNT}`]);
    expect(Object.keys(policies[2].resources)).toHaveLength(3);
  });

  test("a token can't name a Worker that isn't there yet (so staging's first deploy comes first)", async () => {
    const mock = mockCloudflare({ fleet: true });
    await expect(mint(mock)).rejects.toThrow("no Worker called erga-staging");
  });

  test("the check catches a token broader than its plan", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    // The full plan's policies, checked as if they were a narrower token's (staging only): it reaches erga, which that one mustn't.
    const narrow: TokenPlan = { ...tokenPlan(), workers: ["erga-staging"], notWorkers: ["erga", "erga-control"] };
    const fullPolicies = await policiesFor(admin(mock), FLEET_ACCOUNT, tokenPlan(), await permissionIds(admin(mock), FLEET_ACCOUNT));
    const made = await createToken(admin(mock), FLEET_ACCOUNT, narrow, fullPolicies);
    const wrong = await checkToken({ net: mock.fetch, admin: admin(mock), accountId: FLEET_ACCOUNT, plan: narrow, id: made.id, value: made.value, policies: (await policiesFor(admin(mock), FLEET_ACCOUNT, narrow, await permissionIds(admin(mock), FLEET_ACCOUNT))) });
    expect(wrong.join("; ")).toContain("read erga's settings");
    expect(wrong.join("; ")).toContain("policies aren't the plan's");
  });
});

describe("deploying with it", () => {
  test("it deploys staging (address, route and DNS only read); a token without production is refused production", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const before = productionOf(mock);
    const { value } = await mint(mock, { ...tokenPlan(), workers: ["erga-staging", "erga-control"], notWorkers: ["erga"] });
    const calls = mock.state.calls.length;
    const steps: string[] = [];
    // With a fresh copy asked for: the token can copy production's data too.
    await runPipeline(new Cloudflare(value, mock.fetch), { ...release, version: SHA2.slice(0, 12) }, targetOf(TARGETS.staging, { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT, SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN }, { force: true }), { ...quick, site: mock.fetch, report: (id, status, detail) => steps.push(`${id}:${status}${detail ? ` ${detail}` : ""}`) });
    expect(steps).toContain("address:done https://staging.erga.dev (already its address)");
    expect(steps.at(-3)).toMatch(/^documents:done/);
    expect(steps.at(-1)).toMatch(/^cleanup:done deleted erga-staging-/);
    // No write to a custom domain, a route or a DNS record: the token can only read them.
    expect(mock.state.calls.slice(calls).filter((c) => /^(PUT|POST|DELETE) .*(workers\/domains|dns_records|workers\/routes)/.test(c))).toEqual([]);
    expect(productionOf(mock)).toBe(before);
    // Production with a token that doesn't reach it: refused, before anything changes.
    await expect(runPipeline(new Cloudflare(value, mock.fetch), release, targetOf(TARGETS.production, { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT }), { ...quick, site: mock.fetch, report: () => {} })).rejects.toThrow("isn't allowed");
    expect(productionOf(mock)).toBe(before);
  });

  test("the control Worker deploys staging with it: a push, built, deployed, production untouched; then main, and production", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const { value } = await mint(mock);
    mock.state.secrets["erga-control"] = { CLOUDFLARE_DEPLOY_TOKEN: value, SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN };
    const before = productionOf(mock);
    const builder = mockBuilder(async () => release);
    const control = server(mock, "erga-control", builder);
    await control.instance.hook("staging", SHA2, "push by ada");
    await control.settle();
    expect((await control.instance.status()).targets.find((t) => t.name == "staging")).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(productionOf(mock)).toBe(before);
    // The app Worker reaches the control Worker (its admin agent's dashboard tools), and holds no repository binding.
    expect((mock.state.scripts["erga-staging"].metadata.bindings as any[]).find((b) => b.name == "CONTROL")).toMatchObject({ service: "erga-control", entrypoint: "App" });
    expect((mock.state.scripts["erga-staging"].metadata.bindings as any[]).find((b) => b.name == "ARTIFACTS")).toBeUndefined();
    await control.instance.hook("main", SHA2, "merge by ada");
    await control.settle();
    expect((await control.instance.status()).targets.find((t) => t.name == "production")).toMatchObject({ state: "deployed", deployed: SHA2 });
    expect(bindingsVersion(mock, "erga")).toBe(SHA2.slice(0, 12));
  });
});

const bindingsVersion = (mock: Mock, script: string) => (mock.state.scripts[script].metadata.bindings as any[]).find((b) => b.name == "ERGA_VERSION")?.text;

describe("Erga's source on its own servers", () => {
  test("a release's Artifacts binding goes to no app Worker (the control Worker holds the repository); a target that names the namespace gets it", () => {
    const rel: Release = { ...release, worker: { ...release.worker, env: { ...release.worker.env, ARTIFACTS: { type: "artifacts", namespace: "erga" } } } };
    const meta = (t: Parameters<typeof workerMetadata>[1]) => workerMetadata(rel, t, { dbId: "db", assetsJwt: "jwt", pagesHost: null }).bindings as any[];
    expect(meta(targetOf(TARGETS.staging, { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT })).find((b) => b.name == "ARTIFACTS")).toBeUndefined();
    expect(meta({ ...targetOf(TARGETS.staging, { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT }), artifacts: "erga" }).find((b) => b.name == "ARTIFACTS")).toEqual({ type: "artifacts", name: "ARTIFACTS", namespace: "erga" });
    const plan = { accountId: FLEET_ACCOUNT, workerName: "erga", subdomain: "ada", createSubdomain: false, app: { kind: "workers.dev" as const }, pages: { kind: "shared" as const }, admin: "ada", githubClientId: "x", githubClientSecret: "y" } as any;
    expect(meta(targetOfPlan(plan, "s".repeat(32))).find((b) => b.name == "ARTIFACTS")).toBeUndefined();
  });

  test("a branch build binds the namespace the commit's own deploy/targets.json names", () => {
    expect(artifactsNamespace(ROOT)).toBe("erga");
    expect(artifactsNamespace("/nonexistent")).toBeNull();
  });
});

describe("the token maker (CLOUDFLARE_TOKEN_MAKER), checked before it's used", () => {
  const A = FLEET_ACCOUNT, T = "t".repeat(40);
  /** A pretend Cloudflare answering the maker's verify, its own token and the permission groups. */
  const cfWith = (o: { account?: { status: string; expires_on?: string } | null; user?: boolean; perms?: string[] }) => (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.replace("/client/v4", "");
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (path == `/accounts/${A}/tokens/verify`) return o.account ? ok({ id: "maker1", ...o.account }) : Response.json({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }, { status: 401 });
    if (path == "/user/tokens/verify") return o.user ? ok({ id: "u1", status: "active" }) : Response.json({ success: false, errors: [] }, { status: 401 });
    if (path == `/accounts/${A}/tokens/maker1`) return o.perms ? ok({ policies: [{ effect: "allow", resources: {}, permission_groups: o.perms.map((name) => ({ id: name, name })) }] }) : Response.json({ success: false }, { status: 403 });
    if (path == `/accounts/${A}/tokens/permission_groups`) return o.perms ? ok([]) : Response.json({ success: false }, { status: 403 });
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  const run = (value: string, o: Parameters<typeof cfWith>[0]) => diagnoseMaker({ net: cfWith(o), accountId: A, value });

  test("the clipboard holding something else", async () => {
    expect((await run("some text\nfrom the clipboard", {})).said[0]).toContain("doesn't look like an API token");
  });
  test("a user token, an unknown one, an expired one", async () => {
    expect((await run(T, { account: null, user: true })).said[0]).toContain("user API token");
    expect((await run(T, { account: null })).said[0]).toContain("doesn't know this token");
    expect(await run(T, { account: { status: "expired", expires_on: "2026-10-04T00:00:00Z" } })).toMatchObject({ ok: false, said: [expect.stringContaining("isn't active (expired")] });
  });
  test("one without Account API Tokens Edit, and one with it", async () => {
    const no = await run(T, { account: { status: "active" }, perms: ["Zone Read"] });
    expect(no.ok).toBe(false);
    expect(no.said.join(" ")).toContain("Account API Tokens › Edit");
    const yes = await run(T, { account: { status: "active", expires_on: "2026-10-05T00:00:00Z" }, perms: ["Account API Tokens Write"] });
    expect(yes).toEqual({ ok: true, said: ["An account-owned token, active until 2026-10-05T00:00:00Z.", "Its permissions: Account API Tokens Write."] });
  });
});

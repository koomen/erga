// An install in another Cloudflare account (deploy/install.ts, from /deploy on
// the control Worker): both Workers, what each is told, the order; the GitHub
// App manifest flow's return; and the consent relay for an install's control
// Worker (control/routes.ts).
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { controlRoutes, relayOrigin, type Control } from "../control/routes";
import { Cloudflare, loadRelease, type DeployPlan, type Release } from "../deploy/pipeline";
import { controlHostOf, INSTALL_STEPS, installControlMetadata, runInstall } from "../deploy/install";
import { mockCloudflare } from "../deploy/mock-cloudflare";
import type { Platform } from "../server/platform";
import type { Session } from "../server/identity/index";

const ROOT = new URL("..", import.meta.url).pathname;
const ACC = "0123456789abcdef0123456789abcdef";
let release: Release;

beforeAll(async () => {
  const dir = join(ROOT, ".build/release");
  if (!existsSync(join(dir, "release.json")) || !JSON.parse(readFileSync(join(dir, "release.json"), "utf8")).control) {
    if (!existsSync(join(ROOT, ".build/page.js"))) expect(Bun.spawnSync([join(ROOT, "client/build.sh")], { cwd: ROOT }).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", join(ROOT, "deploy/release.ts")], { cwd: ROOT }).exitCode).toBe(0);
  }
  release = (await loadRelease(async (p) => (existsSync(join(dir, p)) ? new Uint8Array(readFileSync(join(dir, p))) : null)))!;
}, 120_000);

const plan = (over: Partial<DeployPlan> = {}): DeployPlan => ({
  accountId: ACC, workerName: "erga", subdomain: "ada-mock", app: { kind: "workers.dev" }, pages: { kind: "shared" },
  admin: "Ada", githubClientId: "Iv1.mockgithubapp0", githubClientSecret: "mock-github-app-secret-0123456789abcdef0123", ...over,
});
const UPSTREAM = { origin: "https://ops.erga.test", clientId: "erga-client" };

async function install(p: DeployPlan, mock = mockCloudflare()) {
  const steps: string[] = [];
  const result = await runInstall(new Cloudflare("mock-token", mock.fetch), release, p, {
    sessionSecret: "app-session-secret-0123456789abcdef", controlSecret: "control-session-secret-0123456789abc", upstream: UPSTREAM,
    site: mock.fetch, sleep: async () => {}, waitMs: 1000, report: (id, status, detail) => steps.push(`${id}:${status}${detail ? ` ${detail}` : ""}`),
  });
  return { result, steps, state: mock.state, mock };
}
const bindingsOf = (state: ReturnType<typeof mockCloudflare>["state"], script: string) => Object.fromEntries((state.scripts[script].metadata.bindings as any[]).map((b) => [b.name, b]));

describe("the control Worker's address", () => {
  test("beside the app's: workers.dev, the zone's apex, a name under the zone", () => {
    expect(controlHostOf({ app: { kind: "workers.dev" }, subdomain: "ada-mock" })).toBe("erga-control.ada-mock.workers.dev");
    expect(controlHostOf({ app: { kind: "domain", zoneId: "z", zoneName: "example.com", hostname: "example.com" } })).toBe("ops.example.com");
    expect(controlHostOf({ app: { kind: "domain", zoneId: "z", zoneName: "example.com", hostname: "erga.example.com" } })).toBe("erga-ops.example.com");
    expect(controlHostOf({ app: { kind: "domain", zoneId: "z", zoneName: "example.com", hostname: "Docs.Team.Example.com" } })).toBe("docs-ops.team.example.com");
  });
});

describe("an install", () => {
  test("to workers.dev: every step in order, the control Worker before the app's Worker, both told what they need", async () => {
    const { result, steps, state } = await install(plan());
    expect(steps.filter((s) => s.endsWith(":running")).map((s) => s.split(":")[0])).toEqual(INSTALL_STEPS.map((s) => s.id));
    expect(result).toEqual({ url: "https://erga.ada-mock.workers.dev", pages: "erga-pages.ada-mock.workers.dev", database: state.databases[0].uuid, worker: "erga", control: "https://erga-control.ada-mock.workers.dev" });
    // The control Worker: the release's control bundle, its objects declared, no container, no Artifacts, no bucket.
    const control = state.scripts["erga-control"];
    expect(control.modules).toEqual(["index.js"]);
    expect(control.workersDev).toBe(true);
    expect(control.tags).toEqual(["erga-deploy"]);
    expect(control.metadata.containers).toBeUndefined();
    expect(control.metadata.exports).toEqual({ Pipeline: { type: "durable-object", storage: "sqlite" }, SourceHost: { type: "durable-object", storage: "sqlite" }, Deployer: { type: "durable-object", storage: "sqlite" } });
    const cb = bindingsOf(state, "erga-control");
    expect(cb.BUILDS).toBeUndefined();
    expect(cb.ARTIFACTS).toBeUndefined();
    expect(cb.RELEASES).toBeUndefined();
    expect(cb.DB).toEqual({ type: "d1", name: "DB", database_id: state.databases[0].uuid, id: state.databases[0].uuid });
    expect(cb.PIPELINE.class_name).toBe("Pipeline");
    expect(cb.DEPLOYS.class_name).toBe("Deployer");
    expect(cb.ADMINS.text).toBe("ada");
    expect(cb.APP_URL.text).toBe("https://erga.ada-mock.workers.dev");
    expect(cb.GITHUB_CLIENT_ID.text).toBe("Iv1.mockgithubapp0");
    expect(cb.GITHUB_CLIENT_SECRET.type).toBe("secret_text");
    expect(cb.SESSION_SECRET.type).toBe("secret_text");
    expect(cb.CLOUDFLARE_OAUTH_CLIENT_ID.text).toBe("erga-client");
    expect(cb.UPSTREAM.text).toBe("https://ops.erga.test");
    expect(cb.ERGA_VERSION.text).toBe(release.version);
    expect(JSON.parse(cb.INSTALL.text)).toEqual({ accountId: ACC, worker: "erga", database: "erga", subdomain: "ada-mock", app: { kind: "workers.dev" }, pages: { kind: "shared" }, control: { worker: "erga-control", host: "erga-control.ada-mock.workers.dev" } });
    // Its secrets stay from version to version: the upgrades keep them.
    expect(control.metadata.keep_bindings).toEqual(["secret_text", "secret_key"]);
    // The app: as /deploy made it, plus its way to the control Worker.
    const ab = bindingsOf(state, "erga");
    expect(ab.CONTROL).toEqual({ type: "service", name: "CONTROL", service: "erga-control", entrypoint: "App" });
    expect(ab.CONTROL_URL.text).toBe("https://erga-control.ada-mock.workers.dev");
    expect(ab.ADMINS.text).toBe("ada");
    expect(ab.DEPLOY_TARGET.text).toBe("");
    // The control Worker went up before the app's Worker (its service binding needs it there).
    const uploads = state.calls.filter((c) => /^PUT .*\/workers\/scripts\/(erga|erga-control)$/.test(c));
    expect(uploads).toEqual([`PUT /accounts/${ACC}/workers/scripts/erga-control`, `PUT /accounts/${ACC}/workers/scripts/erga`]);
    expect(steps.find((s) => s.startsWith("control:done"))).toBe(`control:done erga-control, release ${release.version}, at https://erga-control.ada-mock.workers.dev`);
  });

  test("to a domain: the control Worker gets its own custom domain beside the app's", async () => {
    const { result, state } = await install(plan({ app: { kind: "domain", zoneId: "zone0000000000000000000000000001", zoneName: "ada-example.com", hostname: "erga.ada-example.com" } }));
    expect(result.control).toBe("https://erga-ops.ada-example.com");
    expect(state.domains).toEqual(expect.arrayContaining([
      { hostname: "erga-ops.ada-example.com", service: "erga-control", zone_id: "zone0000000000000000000000000001" },
      { hostname: "erga.ada-example.com", service: "erga", zone_id: "zone0000000000000000000000000001" },
    ]));
    expect(state.scripts["erga-control"].workersDev).toBe(false);
  });

  test("again: the same Workers replaced, the database kept", async () => {
    const mock = mockCloudflare();
    await install(plan(), mock);
    const { steps, state } = await install(plan(), mock);
    expect(state.databases.length).toBe(1);
    expect(steps.find((s) => s.startsWith("database:done"))).toContain("from before");
    expect(Object.keys(state.scripts).sort()).toEqual(["erga", "erga-control", "erga-pages"]);
  });

  test("a Worker called erga-control that isn't Erga's stops the install before anything of it is touched", async () => {
    const mock = mockCloudflare();
    mock.state.scripts["erga-control"] = { metadata: { main_module: "x.js", bindings: [] }, modules: ["x.js"], workersDev: false, tags: [], namespaces: [] };
    await expect(install(plan(), mock)).rejects.toThrow(/already has a Worker called erga-control that isn't Erga's/);
    expect(mock.state.scripts.erga).toBeUndefined();
  });

  test("the control Worker's metadata needs a release with the control bundle", () => {
    expect(() => installControlMetadata({ ...release, control: undefined }, { accountId: ACC, dbId: "db", vars: {}, secrets: {} })).toThrow(/no control Worker in it/);
  });
});

describe("the consent relay", () => {
  test("the state names the install's origin; the relay sends a consent on to a control Worker installed from here, and refuses others", async () => {
    const origin = "https://erga-control.ada-mock.workers.dev";
    const state = `${btoa(origin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.abc123`;
    expect(relayOrigin(state)).toBe(origin);
    expect(relayOrigin("abc123")).toBeNull();
    expect(relayOrigin(`${btoa("javascript:alert(1)")}.x`)).toBeNull();
    const installs = new Set([origin]);
    const platform = { sessionOf: async () => null, directory: { users: { isAdmin: async () => true, actsAsAdmin: async () => true } } } as unknown as Platform;
    const c: Control = {
      platform, app: "https://erga.test", version: "v1", layout: (o) => new Response(o.body),
      deploys: { isInstall: async (o: string) => installs.has(o) } as never,
      oauth: { clientId: "erga-client", accountId: ACC, worker: "erga-control", net: fetch },
    };
    const go = (q: string) => controlRoutes(new Request(`https://ops.erga.test/install/callback?${q}`, { headers: { accept: "text/html" } }), c);
    const relayed = await go(`code=abc&state=${encodeURIComponent(state)}`);
    expect(relayed.status).toBe(302);
    expect(relayed.headers.get("location")).toBe(`${origin}/install/callback?code=abc&state=${encodeURIComponent(state)}`);
    installs.clear();
    expect((await go(`code=abc&state=${encodeURIComponent(state)}`)).status).toBe(400);
    // No state of that shape: the control Worker's own consent, which needs its cookie (and a sign-in: 302 to it).
    expect((await go("code=abc&state=plain")).status).toBe(302);
    expect((await go("code=abc&state=plain")).headers.get("location")).toContain("/auth/github");
  });

  test("an install's control Worker consents through its upstream's callback, with its origin in the state", async () => {
    const session = { login: "ada", name: "Ada" } as unknown as Session;
    const platform = { sessionOf: async () => session, directory: { users: { isAdmin: async () => true, actsAsAdmin: async () => true } } } as unknown as Platform;
    const c: Control = {
      platform, app: "https://erga.ada-mock.workers.dev", version: "v1", layout: (o) => new Response(o.body),
      deploys: { credentialStatus: async () => ({ connected: false }) } as never,
      oauth: { clientId: "erga-client", accountId: ACC, worker: "erga-control", net: fetch, relay: "https://ops.erga.test" },
    };
    const own = "https://erga-control.ada-mock.workers.dev";
    const r = await controlRoutes(new Request(`${own}/install/start`, { method: "POST", headers: { accept: "text/html", origin: own } }), c);
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location")!);
    expect(to.searchParams.get("redirect_uri")).toBe("https://ops.erga.test/install/callback");
    expect(relayOrigin(to.searchParams.get("state"))).toBe(own);
  });
});

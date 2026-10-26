// What the deploy tests share (tests/deploy-*.test.ts): the release they
// deploy, the targets and their settings, a look at the mock Cloudflare's
// state, and Server: the branch deploys as their Durable Object runs them.

import { expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { BranchDeploys, targetOf, type DeployEnv, type Deps, type TargetStatus } from "../../control/deploys/branches";
import type { LogLine } from "../../control/deploys/history";
import { fixedCredential } from "../../control/deploys/credential";
import { runPipeline, type Target } from "../../control/deploys/pipeline";
import { Cloudflare } from "../../control/deploys/cloudflare-api";
import { loadRelease, type Release } from "../../control/deploys/release-format";
import {
  FLEET_ACCOUNT,
  MOCK_HOOK_SECRET,
  MOCK_SNAPSHOT_TOKEN,
  mockBuilder,
  mockCloudflare,
  PROD_DB,
  type MockState,
} from "../../dev/mock-cloudflare";
import { TARGETS } from "../../deploy/targets";

export const ROOT = new URL("../..", import.meta.url).pathname;
export let release: Release;

/** The release the tests deploy: built here if missing, or from before the release carried the control Worker (deploy/release.ts). */
export async function prepareRelease() {
  const dir = join(ROOT, ".build/release");
  if (!existsSync(join(dir, "release.json")) || !JSON.parse(readFileSync(join(dir, "release.json"), "utf8")).control) {
    if (!existsSync(join(ROOT, ".build/manifest.json"))) expect(Bun.spawnSync(["bun", join(ROOT, "client/build.ts")], { cwd: ROOT }).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", join(ROOT, "deploy/release.ts")], { cwd: ROOT }).exitCode).toBe(0);
  }
  release = (await loadRelease(async (p) => (existsSync(join(dir, p)) ? new Uint8Array(readFileSync(join(dir, p))) : null)))!;
}

export const SHA1 = "1111111111111111111111111111111111111111",
  SHA2 = "2222222222222222222222222222222222222222",
  SHA3 = "3333333333333333333333333333333333333333";
export const quick = { sleep: async () => {}, waitMs: 2000 };
export const env = (over: DeployEnv = {}): DeployEnv => ({
  CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT,
  SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN,
  ...over,
});
/** Staging's secrets, as deploy/setup.ts gives them to its first deploy. */
export const stagingSecrets = {
  SESSION_SECRET: "staging-session-secret-0123456789",
  GITHUB_CLIENT_SECRET: "staging-github-secret-0123456789",
  SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN,
  DEPLOY_HOOK_SECRET: MOCK_HOOK_SECRET,
};
export const staging = (over: Partial<Target> = {}): Target => ({ ...targetOf(TARGETS.staging, env()), ...over });
/** The target with a fresh copy of production's data asked for (a Redeploy with a fresh copy): staging's copy is frozen otherwise. */
export const afresh = (t: Target): Target => ({ ...t, snapshot: { ...t.snapshot!, fresh: true } });

export async function deployTo(target: Target, mock: ReturnType<typeof mockCloudflare>, rel: Release = release) {
  const steps: string[] = [];
  const result = await runPipeline(new Cloudflare("mock-deploy-token", mock.fetch), rel, target, { ...quick, site: mock.fetch, report: (id, status, detail) => steps.push(`${id}:${status}${detail ? ` ${detail}` : ""}`) });
  return { result, steps };
}

export const bindingsOf = (state: MockState, script: string) =>
  Object.fromEntries((state.scripts[script].metadata.bindings as any[]).map((b) => [b.name, b]));
/** Staging's database: the copy its Worker is bound to (each copy has a name of its own: control/deploys/pipeline.ts, copyName). */
export const stagingDbOf = (state: MockState) => state.databases.find((d) => d.uuid == bindingsOf(state, "erga-staging").DB.database_id)!;
/** Staging's copies of production's data, by name. */
export const stagingCopies = (state: MockState) => state.databases.filter((d) => d.name.startsWith("erga-staging")).map((d) => d.name);
/** Production as the fleet mock starts it, to compare against after. */
export const productionOf = (state: MockState) =>
  JSON.stringify({
    script: state.scripts.erga,
    secrets: state.secrets.erga,
    versions: state.versions.erga,
    db: state.databases.find((d) => d.uuid == PROD_DB),
    docs: [...state.docs.erga.docs].map(([id, d]) => [id, [...d.entries], d.alarm]),
    domains: state.domains.filter((d) => d.service == "erga"),
    routes: Object.values(state.routes)
      .flat()
      .filter((r) => r.script == "erga"),
});
/** Every call that would write to production: its Worker or its secrets, its database (anything but the export). (Its domain and route: productionOf.) */
export const writesToProduction = (state: MockState) =>
  state.calls.filter(
    (c) =>
      (c.includes(`/d1/database/${PROD_DB}`) && !c.endsWith("/export")) ||
      /^(PUT|POST|DELETE|PATCH) .*\/workers\/scripts\/erga(\/|$)/.test(c)
  );

export class Server {
  storage = new Map<string, unknown>();
  instance!: BranchDeploys;
  alive = { on: true };
  events = 0;
  /** The {type: "deploy-log"} events it sent. */
  logs: { deployId: string; lines: LogLine[] }[] = [];
  scheduled: number[] = [];
  constructor(readonly mock: ReturnType<typeof mockCloudflare>, readonly builder: ReturnType<typeof mockBuilder>, readonly script: string, readonly fixedEnv?: DeployEnv, readonly extra: Partial<Deps> = {}) { this.start(); }
  /** Its settings and secrets as the mock has them for its Worker (what the last deploy gave it), unless fixed. */
  envOf(): DeployEnv {
    if (this.fixedEnv) return this.fixedEnv;
    const b = bindingsOf(this.mock.state, this.script);
    const s = this.mock.state.secrets[this.script] ?? {};
    return { CLOUDFLARE_ACCOUNT_ID: b.CLOUDFLARE_ACCOUNT_ID?.text, SNAPSHOT_TOKEN: s.SNAPSHOT_TOKEN };
  }
  /** A new version starts: a new object over the same storage. The old one, if running, can't reach anything any more. */
  start() {
    this.alive.on = false;
    const alive = (this.alive = { on: true });
    const storage = this.storage;
    this.instance = new BranchDeploys({
      storage: { get: async (k) => structuredClone(storage.get(k)) as any, put: async (k, v) => { if (alive.on) storage.set(k, structuredClone(v)); }, delete: async (k) => { if (alive.on) storage.delete(k); } },
      env: this.envOf(),
      // The Cloudflare credential: a fixed token the mock takes, unless the test gives one (an OAuth grant, or none).
      credential: this.extra.credential ?? fixedCredential("mock-deploy-token"),
      net: async (input, init) => { if (!alive.on) throw new Error("Durable Object reset because its code was updated."); return this.mock.fetch(input, init); },
      builder: this.builder,
      schedule: (ms) => { if (alive.on) this.scheduled.push(ms); },
      changed: () => { if (alive.on) this.events++; },
      logged: (e) => { if (alive.on && e.type == "deploy-log") this.logs.push({ deployId: e.deployId, lines: e.lines }); },
      ...quick,
      ...this.extra,
    });
  }
  version() { return bindingsOf(this.mock.state, this.script).ERGA_VERSION?.text; }
  async status(name: string): Promise<TargetStatus> { return (await this.instance.status()).targets.find((t) => t.name == name)!; }
  /** Wake it, as its alarm would, until nothing's scheduled. */
  async settle() { for (let i = 0; i < 10 && this.scheduled.length; i++) { this.scheduled = []; await this.instance.alarm(); } }
}

/** The first staging deploy, from a machine: staging's Worker, with its secrets. */
export async function bootstrap(mock: ReturnType<typeof mockCloudflare>) {
  await runPipeline(new Cloudflare("mock-setup-token", mock.fetch), { ...release, version: SHA1.slice(0, 12) }, staging({ secrets: stagingSecrets }), { ...quick, site: mock.fetch, report: () => {} });
}

// What the deploy tests share (tests/deploy-*.test.ts): the release they
// deploy, the targets and their settings, and a look at the mock Cloudflare's
// state.

import { expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { runPipeline, type Target } from "../../deploy/pipeline/pipeline";
import { Cloudflare } from "../../deploy/pipeline/cloudflare-api";
import { loadRelease, type Release } from "../../deploy/pipeline/release-format";
import { FLEET_ACCOUNT, MOCK_SNAPSHOT_TOKEN, mockCloudflare, PRIMARY_DB, type MockState } from "../../dev/mock-cloudflare";

export const ROOT = new URL("../..", import.meta.url).pathname;
export let release: Release;

/** The release the tests deploy: built here if missing, or from before the release carried its bindings (deploy/release.ts). */
export async function prepareRelease() {
  const dir = join(ROOT, ".build/release");
  const index = existsSync(join(dir, "release.json")) ? JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) : null;
  if (!index?.bindings) {
    if (!existsSync(join(ROOT, ".build/manifest.json"))) expect(Bun.spawnSync(["bun", join(ROOT, "client/build.ts")], { cwd: ROOT }).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", join(ROOT, "deploy/release.ts")], { cwd: ROOT }).exitCode).toBe(0);
  }
  release = (await loadRelease(async (p) => (existsSync(join(dir, p)) ? new Uint8Array(readFileSync(join(dir, p))) : null)))!;
}

export const SHA1 = "1111111111111111111111111111111111111111",
  SHA2 = "2222222222222222222222222222222222222222",
  SHA3 = "3333333333333333333333333333333333333333";
export const quick = { sleep: async () => {}, waitMs: 2000 };

/** The fleet's instance (example.com) as the pipeline deploys it: its names, its plain settings, its secrets kept. */
export const primary = (): Target => ({
  label: "example.com",
  accountId: FLEET_ACCOUNT,
  workerName: "erga",
  databaseName: "erga",
  app: { kind: "domain", zoneName: "example.com", hostname: "example.com" },
  pages: { kind: "zone", zoneName: "example-pages.com", domain: "example-pages.com" },
  vars: { GITHUB_CLIENT_ID: "Ov23primary" },
  secrets: {},
  keepSecrets: true,
  checkVersion: true,
});
/** The primary, as its staging instance names it: the names it may not touch, and the address it copies from. */
const stagingOf = {
  worker: "erga",
  database: "erga",
  host: "example.com",
  pages: "example-pages.com",
  accountId: FLEET_ACCOUNT,
  origin: "https://example.com",
};
/** Staging's secrets, as its first deploy from a machine gives them. */
export const stagingSecrets = {
  SESSION_SECRET: "staging-session-secret-0123456789",
  GITHUB_CLIENT_SECRET: "staging-github-secret-0123456789",
  SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN,
};
/** Its staging instance (staging.example.com): the same target, with its primary named; it copies the primary's data in when it has no copy yet. */
export const staging = (over: Partial<Target> = {}): Target => ({
  label: "staging.example.com",
  accountId: FLEET_ACCOUNT,
  workerName: "erga-staging",
  databaseName: "erga-staging",
  app: { kind: "domain", zoneName: "example.com", hostname: "staging.example.com" },
  pages: { kind: "zone", zoneName: "example-pages-staging.com", domain: "example-pages-staging.com" },
  vars: { GITHUB_CLIENT_ID: "Ov23staging", SNAPSHOT_FROM: "https://example.com" },
  secrets: {},
  keepSecrets: true,
  checkVersion: true,
  stagingOf: { ...stagingOf, copy: { token: MOCK_SNAPSHOT_TOKEN } },
  ...over,
});
/** The target with a fresh copy of the primary's data asked for: staging's copy is frozen otherwise. */
export const afresh = (t: Target): Target => ({ ...t, stagingOf: { ...t.stagingOf!, copy: { ...t.stagingOf!.copy!, fresh: true } } });

export async function deployTo(target: Target, mock: ReturnType<typeof mockCloudflare>, rel: Release = release) {
  const steps: string[] = [];
  const result = await runPipeline(new Cloudflare("mock-deploy-token", mock.fetch), rel, target, { ...quick, site: mock.fetch, report: (id, status, detail) => steps.push(`${id}:${status}${detail ? ` ${detail}` : ""}`) });
  return { result, steps };
}

export const bindingsOf = (state: MockState, script: string) =>
  Object.fromEntries((state.scripts[script].metadata.bindings as any[]).map((b) => [b.name, b]));
/** Staging's database: the copy its Worker is bound to (each copy has a name of its own: deploy/pipeline/pipeline.ts, copyName). */
export const stagingDbOf = (state: MockState) => state.databases.find((d) => d.uuid == bindingsOf(state, "erga-staging").DB.database_id)!;
/** Staging's copies of its primary's data, by name. */
export const stagingCopies = (state: MockState) => state.databases.filter((d) => d.name.startsWith("erga-staging")).map((d) => d.name);
/** The primary as the fleet mock starts it, to compare against after. */
export const primaryOf = (state: MockState) =>
  JSON.stringify({
    script: state.scripts.erga,
    secrets: state.secrets.erga,
    versions: state.versions.erga,
    db: state.databases.find((d) => d.uuid == PRIMARY_DB),
    docs: [...state.docs.erga.docs].map(([id, d]) => [id, [...d.entries], d.alarm]),
    domains: state.domains.filter((d) => d.service == "erga"),
    routes: Object.values(state.routes)
      .flat()
      .filter((r) => r.script == "erga"),
});
/** Every call that would write to the primary: its Worker or its secrets, its database (anything but the export). (Its domain and route: primaryOf.) */
export const writesToPrimary = (state: MockState) =>
  state.calls.filter(
    (c) =>
      (c.includes(`/d1/database/${PRIMARY_DB}`) && !c.endsWith("/export")) ||
      /^(PUT|POST|DELETE|PATCH) .*\/workers\/scripts\/erga(\/|$)/.test(c)
  );

/** The first staging deploy, from a machine: staging's Worker, with its secrets. */
export async function bootstrap(mock: ReturnType<typeof mockCloudflare>) {
  await runPipeline(new Cloudflare("mock-setup-token", mock.fetch), { ...release, version: SHA1.slice(0, 12) }, staging({ secrets: stagingSecrets }), { ...quick, site: mock.fetch, report: () => {} });
}

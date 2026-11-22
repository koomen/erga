// What the deploy tests share (tests/deploy-*.test.ts): the release they
// deploy, the targets and their settings, and a look at the mock Cloudflare's
// state.

import { expect } from "bun:test";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { runPipeline, type Target } from "../../deploy/pipeline/pipeline";
import { Cloudflare } from "../../deploy/deployer/cloudflare-api";
import type { Release } from "../../deploy/deployer/release-format";
import { FLEET_ACCOUNT, mockCloudflare, type MockState } from "../../dev/mock-cloudflare";
import { readRelease } from "./release";

export const ROOT = new URL("../..", import.meta.url).pathname;
export let release: Release;

/** The release the tests deploy: this checkout's (tests/helpers/release.ts builds it when it is not). */
export async function prepareRelease() {
  release = await readRelease();
}

export const SHA1 = "1111111111111111111111111111111111111111",
  SHA2 = "2222222222222222222222222222222222222222",
  SHA3 = "3333333333333333333333333333333333333333";
export const quick = { sleep: async () => {}, waitMs: 2000 };

/** The fleet's instance (example.com) as the pipeline deploys it: its names, its plain settings, its secrets kept. */
export const fleet = (): Target => ({
  label: "example.com",
  accountId: FLEET_ACCOUNT,
  workerName: "erga",
  databaseName: "erga",
  app: { kind: "domain", zoneName: "example.com", hostname: "example.com" },
  pages: { kind: "zone", zoneName: "example-pages.com", domain: "example-pages.com" },
  vars: { GITHUB_CLIENT_ID: "Ov23fleet" },
  secrets: {},
});
/** The secrets of a second instance, as its first deploy from a machine gives them. */
export const nextSecrets = {
  SESSION_SECRET: "next-session-secret-0123456789",
  SECRETS_KEY: "next-secrets-key-0123456789",
  GITHUB_CLIENT_SECRET: "next-github-secret-0123456789",
};
/** A second instance in the same account (next.example.com), with names of its own: the same kind of target. */
export const next = (over: Partial<Target> = {}): Target => ({
  label: "next.example.com",
  accountId: FLEET_ACCOUNT,
  workerName: "erga-next",
  databaseName: "erga-next",
  app: { kind: "domain", zoneName: "example.com", hostname: "next.example.com" },
  pages: { kind: "zone", zoneName: "example-pages-next.com", domain: "example-pages-next.com" },
  vars: { GITHUB_CLIENT_ID: "Ov23next" },
  secrets: {},
  ...over,
});

export async function deployTo(target: Target, mock: ReturnType<typeof mockCloudflare>, rel: Release = release) {
  const steps: string[] = [];
  const result = await runPipeline(new Cloudflare("mock-deploy-token", mock.fetch), rel, target, {
    ...quick,
    report: (id, status, detail) => steps.push(`${id}:${status}${detail ? ` ${detail}` : ""}`),
  });
  return { result, steps };
}

export const bindingsOf = (state: MockState, script: string) =>
  Object.fromEntries((state.scripts[script].metadata.bindings as any[]).map((b) => [b.name, b]));
/** The database that a Worker is bound to. */
export const databaseOf = (state: MockState, script: string) =>
  state.databases.find((d) => d.uuid == bindingsOf(state, script).DB.database_id)!;

/** The first deploy of the second instance, from a machine: its Worker, with its secrets. */
export async function bootstrap(mock: ReturnType<typeof mockCloudflare>) {
  await runPipeline(
    new Cloudflare("mock-setup-token", mock.fetch),
    { ...release, version: SHA1.slice(0, 12) },
    next({ secrets: nextSecrets }),
    { ...quick, report: () => {} }
  );
}

/** A clock of the test's own: a sleep ends at once, and moves its time on. */
export function testClock() {
  let now = Date.now();
  const nanos = () => BigInt(now) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (d) => Effect.sync(() => void (now += Duration.toMillis(d))),
  };
  return { clock, now: () => now };
}

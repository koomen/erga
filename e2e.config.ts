// The end-to-end and server-level tests (e2e/**/*.e2e.ts), under e2e
// (tester-army/e2e) with its web engine. Pure unit tests stay under `bun test`
// (tests/*.test.ts); `bun run test` runs both (e2e/run.ts).
//
// Each test is small and independent and makes its own data, so everything
// runs in parallel, one worker per usable core. e2e hands a worker a whole
// file at a time (its tests run in order in that worker), so the files are
// small: a file is a handful of tests about one thing. What is expensive is
// per worker, started lazily (e2e/fixtures.ts); each test gets a fresh browser
// context.
//
// Every test has a time limit (TEST_MS, below); a test that needs more says so
// with its own `timeout` and a comment. Every wait is a condition (locators,
// expect.poll, until), never a pause. Locally the run stops at the first
// failure; --all or CI runs everything with a retry for each failure and
// reports what passed only on the retry as flaky (e2e/run.ts). Timing and
// performance checks are not here: *.bench.e2e.ts, `bun run test:bench`.
//
// This file is imported by the runner and again by every worker. The first
// import makes the environment hermetic (e2e/env.ts) and builds the editor's
// files once for every dev server (ERGA_BUILT), and the release the mock
// Cloudflare's deploys use; the workers inherit both.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { E2EConfig } from "e2e";
import { testJobs } from "./e2e/cores";
import { cleanEnv, hermetic, ROOT } from "./e2e/env";
import { engine } from "./e2e/engine";

process.env.E2E_TELEMETRY_DISABLED = "1";
/** Each test's time limit (e2e/fixtures.ts gives it to every test that doesn't name its own). */
process.env.ERGA_TEST_MS ||= "15000";
if (hermetic() && !process.env.ERGA_BUILT) {
  const r = spawnSync("./site.sh", { cwd: ROOT, env: cleanEnv(), stdio: ["ignore", "ignore", "inherit"], timeout: 180_000 });
  if (r.status != 0) throw new Error(`site.sh failed (${r.error?.message ?? `exit ${r.status}`})`);
  // The release /deploy deploys and the mock builder stands in with (deploy/release.ts), made if this checkout has none.
  if (!existsSync(join(ROOT, ".site/release/release.json"))) {
    const rel = spawnSync("bun", ["deploy/release.ts"], { cwd: ROOT, env: cleanEnv(), stdio: ["ignore", "ignore", "inherit"], timeout: 180_000 });
    if (rel.status != 0) throw new Error(`deploy/release.ts failed (${rel.error?.message ?? `exit ${rel.status}`})`);
  }
  process.env.ERGA_BUILT = "1";
}

/** One worker for each usable core (a container's CPU quota, memory: e2e/cores.ts); TEST_JOBS=n picks it. */
const workers = testJobs({ env: { TEST_JOBS: process.env.TEST_JOBS, TEST_CORES_PER_JOB: "1", TEST_MEM_PER_JOB_MB: process.env.TEST_MEM_PER_JOB_MB } }).jobs;

export default {
  projectId: "erga",
  // The app's address is each worker's own dev server (e2e/fixtures.ts), so tests navigate by full URL; this is never opened.
  targets: [{ name: "web", engine, app: { url: "http://127.0.0.1:9" } }],
  // (e2e/alone runs by itself, after the rest: e2e.alone.config.ts.)
  tests: ["e2e/**/*.e2e.ts", "!e2e/**/*.bench.e2e.ts", "!e2e/alone/**"],
  // Not a test's limit (ERGA_TEST_MS is): e2e gives this to each test.beforeAll too, which starts the worker's dev
  // servers (e2e/fixtures.ts). Four cold starts at once in a 4-core VM take longer than a test may.
  timeout: 90_000,
  assertionTimeout: 5_000,
  actionTimeout: 5_000,
  // A worker killed for a test that blocked it is replaced after this; teardown gets as long.
  cleanupTimeout: 10_000,
  launchTimeout: 60_000,
  workers,
  retries: 0,
  trace: "retain-on-failure",
  video: "off",
  output: ".e2e",
  reporters: process.env.CI ? ["list", "junit"] : ["list"],
  cache: "off",
} satisfies E2EConfig;

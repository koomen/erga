// The end-to-end tests, under e2e with its web engine. Pure unit tests stay under `bun test`
//. e2e/run.ts runs both, and picks which end-to-end tests with ERGA_E2E:
//
//   smoke (the default)   e2e/smoke: the editor's core, on one worker and one dev server, in about a minute
//   full                  e2e/full: the whole suite, one worker per usable core (bun run test:full)
//   all                   both, for files named on the command line (bun run test:e2e e2e/full/page/)
//
// Each test is small and independent and makes its own data. e2e hands a worker a whole file at a time, so the files
// are small. What is expensive is per worker, started lazily; each test gets a fresh browser
// context. Every test has a time limit (TEST_MS, below); every wait is a condition (locators, expect.poll, until),
// never a pause.
//
// This file is imported by the runner and again by every worker. The first import makes the environment hermetic
// and builds the editor's files once for every dev server (ERGA_BUILT); the workers inherit it.

import { spawnSync } from "node:child_process";
import type { E2EConfig } from "e2e";
import { testJobs } from "./e2e/helpers/cores";
import { cleanEnv, hermetic, ROOT } from "./e2e/helpers/env";
import { engine } from "./e2e/helpers/engine";

process.env.E2E_TELEMETRY_DISABLED = "1";
/** Each test's time limit (e2e/helpers/fixtures.ts gives it to every test that doesn't name its own). */
process.env.ERGA_TEST_MS ||= "15000";
if (hermetic() && !process.env.ERGA_BUILT) {
  const r = spawnSync("bun", ["client/build.ts"], { cwd: ROOT, env: cleanEnv(), stdio: ["ignore", "ignore", "inherit"], timeout: 180_000 });
  if (r.status != 0) throw new Error(`client/build.ts failed (${r.error?.message ?? `exit ${r.status}`})`);
  process.env.ERGA_BUILT = "1";
}

const which = process.env.ERGA_E2E ?? "smoke";
const TESTS = { smoke: ["e2e/smoke/**/*.e2e.ts"], full: ["e2e/full/**/*.e2e.ts"], all: ["e2e/**/*.e2e.ts"] }[which] ?? ["e2e/smoke/**/*.e2e.ts"];
/** The smoke run: one worker, one dev server. Else one worker for each usable core; TEST_JOBS=n picks it. */
const workers = which == "smoke" ? 1 : testJobs({ env: { TEST_JOBS: process.env.TEST_JOBS, TEST_CORES_PER_JOB: "1", TEST_MEM_PER_JOB_MB: process.env.TEST_MEM_PER_JOB_MB } }).jobs;

export default {
  projectId: "erga",
  // The app's address is each worker's own dev server, so tests navigate by full URL; this is never opened.
  targets: [{ name: "web", engine, app: { url: "http://127.0.0.1:9" } }],
  tests: TESTS,
  // Not a test's limit (ERGA_TEST_MS is): e2e gives this to each test.beforeAll too, which starts the worker's dev
  // servers. Four cold starts at once in a 4-core VM take longer than a test may.
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

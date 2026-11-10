// The browser tests, under e2e with its web engine. Pure unit tests stay under `bun test`. e2e/run.ts runs both, and
// picks which browser tests with ERGA_E2E:
//
//   suite (the default)   the one suite (bun run test): every e2e file but e2e/full (the old tests, until each area is
//                         rebuilt as journeys: e2e/COVERAGE.md) and e2e/bench. One worker for every 2 usable cores.
//   all                   any file named on the command line (bun run test:e2e e2e/full/page/enter.e2e.ts)
//
// A journey (e2e/helpers/fixtures.ts) is one user path on one page, its steps in order. Each file makes its own data,
// and all files run on one kind of server (servers.main), which a worker starts once and keeps. Every step has a time
// limit (ERGA_TEST_MS, below); every wait is a condition (locators, expect.poll, until), never a pause.
//
// This file is imported by the runner and again by every worker. The first import makes the environment hermetic
// and builds the editor's files and the release once for every dev server (ERGA_BUILT); the workers inherit it.

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

const all = process.env.ERGA_E2E == "all";
const TESTS = all ? ["e2e/**/*.e2e.ts"] : ["e2e/**/*.e2e.ts", "!e2e/full/**", "!e2e/bench/**"];
/** One worker for every 2 usable cores: a worker for each core was no faster (248 s and 247 s on 16 cores). TEST_JOBS=n picks it. */
const workers = testJobs().jobs;

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
  // No trace: its record of every action took a tenth of the run. For a failed test: bun run test:e2e <file> --trace on
  trace: "off",
  video: "off",
  output: ".e2e",
  reporters: ["list"],
  cache: "off",
} satisfies E2EConfig;

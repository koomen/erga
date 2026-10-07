// The end-to-end tests that must run alone (e2e/alone/**/*.e2e.ts): they start dev servers on the ports dev.ts
// picks by itself (e2e/alone/checkouts.e2e.ts), so no other test's server may run beside them. One worker, after
// the rest: `bun run test --all` runs them, and `bun run test:e2e --alone` runs only them (e2e/run.ts).

import type { E2EConfig } from "e2e";
import config from "./e2e.config";

export default {
  ...config,
  tests: ["e2e/alone/**/*.e2e.ts"],
  workers: 1,
  // Its own report, beside the main run's (e2e/run.ts reads both).
  output: ".e2e-alone",
} satisfies E2EConfig;

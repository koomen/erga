// Timing and performance checks (e2e/**/*.bench.e2e.ts): `bun run test:bench`.
// Never part of `bun run test` or the production gate: what they measure moves
// with the machine's load. They run one file at a time, on an idle machine.

import type { E2EConfig } from "e2e";
import config from "./e2e.config";

export default {
  ...config,
  tests: ["e2e/**/*.bench.e2e.ts"],
  workers: 1,
  retries: 0,
  timeout: 60_000,
} satisfies E2EConfig;

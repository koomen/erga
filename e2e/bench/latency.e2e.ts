// The multiplayer suite's latency tests (e2e/full/suite/suites/latency.ts): edit propagation p50/p95, a crowd of
// twenty, join time, five people typing with no lag building up. Budgets: 60 ms locally, 400 ms remote, or
// ERGA_SUITE_P95_MS. A bench, in no suite: run it
// by name (`bun run test:e2e e2e/bench/latency.e2e.ts`).
import { latency } from "../full/suite/suites/latency";
import { register } from "../full/suite/suite";

register("e2e/bench/latency.e2e.ts", "latency", latency);

// The multiplayer suite, latency (e2e/suite/suites/latency.ts): edit propagation p50/p95, a crowd of twenty, join time,
// five people typing with no lag building up. Budgets: 60 ms locally, 400 ms remote, or ERGA_SUITE_P95_MS. A bench: never the gate.
import { latency } from "./suites/latency";
import { register } from "./suite";

register("e2e/suite/latency.bench.e2e.ts", "latency", latency);

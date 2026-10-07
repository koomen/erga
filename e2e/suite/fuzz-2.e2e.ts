// The multiplayer suite, fuzz (e2e/suite/suites/fuzz.ts, part 2 of 2): seeded random edits from many hands converge, with nothing lost or resurrected. ERGA_SUITE_SEED=n replays a run.
import { fuzz } from "./suites/fuzz";
import { part, register } from "./suite";

register("e2e/suite/fuzz-2.e2e.ts", "fuzz", part(fuzz, 2, 2));

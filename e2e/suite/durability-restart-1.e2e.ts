// The multiplayer suite, durability (tests/suite/suites/durability.ts, part 1 of 2 of the tests that restart or kill their own server).
import { durability } from "../../tests/suite/suites/durability";
import { part, register } from "./suite";

register("e2e/suite/durability-restart-1.e2e.ts", "durability", part(durability.filter((t) => t.needs), 1, 2));

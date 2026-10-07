// The multiplayer suite, durability (tests/suite/suites/durability.ts, part 2 of 2 of the tests that restart or kill their own server).
import { durability } from "../../tests/suite/suites/durability";
import { part, register } from "./suite";

register("e2e/suite/durability-restart-2.e2e.ts", "durability", part(durability.filter((t) => t.needs), 2, 2));

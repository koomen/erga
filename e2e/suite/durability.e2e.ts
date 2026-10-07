// The multiplayer suite, durability (tests/suite/suites/durability.ts) on the shared server: everyone leaving, idle eviction, a foreign replica.
import { durability } from "../../tests/suite/suites/durability";
import { register } from "./suite";

register("e2e/suite/durability.e2e.ts", "durability", durability.filter((t) => !t.needs));

// The multiplayer suite, durability on the shared server: everyone leaving, idle eviction, a foreign replica.
import { durability } from "./suites/durability";
import { register } from "./suite";

register("e2e/full/suite/durability.e2e.ts", "durability", durability.filter((t) => !t.needs));

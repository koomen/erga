// The multiplayer suite, presence: carets, people leaving, attribution.
import { presence } from "./suites/presence";
import { register } from "./suite";

register("e2e/full/suite/presence.e2e.ts", "presence", presence.filter((t) => !t.slow));

// The multiplayer suite, presence (e2e/suite/suites/presence.ts): carets, people leaving, attribution.
import { presence } from "./suites/presence";
import { register } from "./suite";

register("e2e/suite/presence.e2e.ts", "presence", presence.filter((t) => !t.slow));

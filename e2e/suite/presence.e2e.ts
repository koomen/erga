// The multiplayer suite, presence (tests/suite/suites/presence.ts): carets, people leaving, attribution.
import { presence } from "../../tests/suite/suites/presence";
import { register } from "./suite";

register("e2e/suite/presence.e2e.ts", "presence", presence.filter((t) => !t.slow));

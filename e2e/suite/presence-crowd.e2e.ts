// The multiplayer suite, presence: thirty people at once (tests/suite/suites/presence.ts, the slow one).
import { presence } from "../../tests/suite/suites/presence";
import { register } from "./suite";

register("e2e/suite/presence-crowd.e2e.ts", "presence", presence.filter((t) => t.slow));

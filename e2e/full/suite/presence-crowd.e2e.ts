// The multiplayer suite, presence: thirty people at once (e2e/full/suite/suites/presence.ts, the slow one).
import { presence } from "./suites/presence";
import { register } from "./suite";

register("e2e/full/suite/presence-crowd.e2e.ts", "presence", presence.filter((t) => t.slow));

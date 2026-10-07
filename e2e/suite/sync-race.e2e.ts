// The multiplayer suite, sync: publishes landing just as the room writes (tests/suite/suites/sync.ts, the slow one).
import { sync } from "../../tests/suite/suites/sync";
import { register } from "./suite";

register("e2e/suite/sync-race.e2e.ts", "sync", sync.filter((t) => t.slow));

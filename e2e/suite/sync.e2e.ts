// The multiplayer suite, sync (e2e/suite/suites/sync.ts): joining, live edits, what is served and stored, publishes, disk edits, images.
import { sync } from "./suites/sync";
import { register } from "./suite";

register("e2e/suite/sync.e2e.ts", "sync", sync.filter((t) => !t.slow));

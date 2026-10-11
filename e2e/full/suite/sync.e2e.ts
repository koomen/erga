// The multiplayer suite, sync: joining, live edits, what is served and stored, publishes, disk edits, images.
import { sync } from "./suites/sync";
import { register } from "./suite";

register("e2e/full/suite/sync.e2e.ts", "sync", sync.filter((t) => !t.slow));

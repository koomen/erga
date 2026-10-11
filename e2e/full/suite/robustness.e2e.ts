// The multiplayer suite, robustness: bad bytes and messages, a storm of connections, a 1 MB paste, path traversal, bad agent requests.
import { robustness } from "./suites/robustness";
import { register } from "./suite";

register("e2e/full/suite/robustness.e2e.ts", "robustness", robustness);

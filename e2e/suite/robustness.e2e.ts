// The multiplayer suite, robustness (tests/suite/suites/robustness.ts): bad bytes and messages, a storm of connections, a 1 MB paste, path traversal, bad agent requests.
import { robustness } from "../../tests/suite/suites/robustness";
import { register } from "./suite";

register("e2e/suite/robustness.e2e.ts", "robustness", robustness);

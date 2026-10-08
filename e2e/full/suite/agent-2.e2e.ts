// The multiplayer suite, agent (e2e/suite/suites/agent.ts, part 2 of 2): the scripted agent's edits, presence, undo, share tokens, privacy, roles.
import { agent } from "./suites/agent";
import { part, register } from "./suite";

register("e2e/full/suite/agent-2.e2e.ts", "agent", part(agent, 2, 2));

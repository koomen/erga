// Who did something (#69). Anything an agent does anywhere in Erga is the
// person's who controls it: the actor recorded is always that person's login,
// and how they did it is recorded beside it, as `via`, a short phrase:
//
//   (none)                      in person: their browser session
//   their agent                 the editor's agent, in one of their documents
//   their admin agent           the agent on the admin pages (factory/agent.ts)
//   a shared agent (<label>)    an agent with one of their tokens: the server's
//                               API, MCP, /api/ext, Git pushes, the admin APIs
//   the factory (task #<n>)     a factory VM, working on a task they added
//
// Shown together: "koomen, via their agent". Nothing is attributed to an
// agent, a token or the factory alone. What the server does by itself (a
// scheduled restart, a deploy no one asked for) is by the person who set it
// up when there is one, else by SYSTEM, shown as "the system".

/** How a person did something, when not in person. */
export const VIA = {
  /** The editor's agent (agent.ts). */
  agent: "their agent",
  /** The admin agent (factory/agent.ts). */
  admin: "their admin agent",
  /** An agent with one of their tokens (tokens.ts): its label. */
  token: (label: string) => `a shared agent (${label.trim() || "no label"})`,
  /** A factory VM, on a task they added. */
  factory: (task: number) => `the factory (task #${task})`,
} as const;

/** The actor of what the server does by itself, with nobody behind it. Not a GitHub login (those have no parentheses). */
export const SYSTEM = "(system)";

/** Who did something and how, as one line: "koomen", "koomen, via their agent", "the system". */
export function byLine(by: string | null | undefined, via?: string | null): string {
  if (!by || by == SYSTEM) return via ? `the system, via ${via}` : "the system";
  return via ? `${by}, via ${via}` : by;
}

/** The login and how, back from a `byLine` (for stores that keep one string, as a version's authors do). */
export function parseByLine(line: string): { by: string; via: string | null } {
  if (line == "the system") return { by: SYSTEM, via: null };
  const at = line.indexOf(", via ");
  return at < 0 ? { by: line, via: null } : { by: line.slice(0, at), via: line.slice(at + 6) };
}

/** The statement that adds an entry to the change log (server_config_versions, config.ts): `changes` (SettingChange[]), by `by`, via `via`. */
export function changeLogEntry(at: number, by: string, via: string | null | undefined, changes: object[]): [string, number, string, string, string | null] {
  return ["INSERT INTO server_config_versions (at, by, changes, via) VALUES (?1, ?2, ?3, ?4)", at, by.toLowerCase(), JSON.stringify(changes), via ?? null];
}

/** Someone acting: their login, and how when not in person (VIA). */
export interface Act { login: string; via?: string | null }

// Who did something (#69). Anything an agent does anywhere in Erga is the
// person's who controls it: the actor recorded is always that person's login,
// and how they did it is recorded beside it, as `via`, a short phrase:
//
//   (none)                      in person: their browser session
//   their agent                 their own agent (agents/person/), on any page
//   their admin agent           the admin pages' agent before each person had one (the change log's older rows)
//   a shared agent (<label>)    an agent with one of their tokens: the server's
//                               API (/api/tools), MCP, Git pushes
//   an agent's view of the page the server's browser, which renders a page for
//                               one of their agents (view_page, eval_in_page)
//   the factory (task #<n>)     a factory VM, before the factory went (the change log's older rows)
//
// Shown together: "koomen, via their agent". Nothing is attributed to an
// agent, a token or the factory alone. What the server does by itself (a
// scheduled restart, a deploy no one asked for) is by the person who set it
// up when there is one, else by SYSTEM, shown as "the system".

/** How a person did something, when not in person. */
export const VIA = {
  /** Their own agent (agents/person/). */
  agent: "their agent",
  /** The admin pages' agent, before each person had one: the change log's older rows say so. */
  admin: "their admin agent",
  /** An agent with one of their tokens: its label. */
  token: (label: string) => `a shared agent (${label.trim() || "no label"})`,
  /** The server's browser, rendering a page for one of their agents, whose code it may run (Session.view). */
  view: "an agent's view of the page",
  /** A push on GitHub (the webhook), synced back into Erga's repository. */
  github: "a push on GitHub",
} as const;

/** The actor of what the server does by itself, with nobody behind it. Not a GitHub login (those have no parentheses). */
export const SYSTEM = "(system)";

/** Who did something and how, as one line: "koomen", "koomen, via their agent", "the system". */
export function byLine(by: string | null | undefined, via?: string | null): string {
  if (!by || by == SYSTEM) return via ? `the system, via ${via}` : "the system";
  return via ? `${by}, via ${via}` : by;
}


/** The statement that adds an entry to the change log (server_config_versions, server/directory/settings.ts): `changes` (SettingChange[]), by `by`, via `via`. */
export function changeLogEntry(at: number, by: string, via: string | null | undefined, changes: object[]): [string, number, string, string, string | null] {
  return ["INSERT INTO server_config_versions (at, by, changes, via) VALUES (?1, ?2, ?3, ?4)", at, by.toLowerCase(), JSON.stringify(changes), via ?? null];
}

/** Someone acting: their login, and how when not in person (VIA). */
export interface Act { login: string; via?: string | null }

/**
 * What a person's agent panel asks them: whether to run this comment of theirs, with @erga, as a request. For a
 * comment sent with a page's edit key (server/operations/comments.ts), which starts no agent by itself.
 */
export interface CommentAsk {
  doc: string;
  title: string;
  thread: string;
  comment: string;
  text: string;
}

/**
 * How an agent shows on a page, at its caret: short, so it fits. `label`: the name of its connection (a shared agent's
 * token label, without what it has in parentheses at its end: "Claude Code"), or "Agent" for the person's own; with
 * `many` (more than one person is in the document), whose it is ("Pete’s Claude Code"); then one word for what it does
 * ("looking"). `title`: the full line, for the tooltip. `name`: the agent's full name (byLine: "Pete, via their agent").
 */
export function agentLabel(
  agent: { name: string; via?: string | null },
  activity: string | null | undefined,
  many: boolean
): { label: string; title: string } {
  const title = activity ? `${agent.name} · ${activity}` : agent.name;
  if (!agent.via) return { label: title, title };
  const shared = /^a shared agent \((.*)\)$/
    .exec(agent.via)?.[1]
    .replace(/\s*\([^()]*\)$/, "")
    .trim();
  const what = shared && shared != "no label" ? shared : "agent";
  const person = agent.name.split(", via ")[0];
  const who = many ? `${person}’s ${what}` : what[0].toUpperCase() + what.slice(1);
  const doing = activity?.trim().split(/\s+/)[0];
  return { label: doing ? `${who} · ${doing}` : who, title };
}

// Share with an agent's first choice (agent-menu.ts), and the agent's panel's connect prompt: one line that
// adds Erga's MCP server to the agent's app and opens the document there. No token in it: the agent's app signs in on
// Erga (MCP's OAuth), so the token stays in that app. The app registers itself at the gate (gate/core.ts, register),
// as with any MCP server: the plain command, with no flags.

/** The line for the page at `address` (its path) on Erga at `origin`. */
export const agentPrompt = (address: string, origin = location.origin) =>
  `Add Erga's MCP server, ${origin}/mcp (in Claude Code: claude mcp add --transport http erga ${origin}/mcp), then open ${origin}${address}.`;

// Share with an agent's first choice (agent-menu.ts), and the agent's panel's connect prompt: one line that
// adds Erga's MCP server to the agent's app and opens the document there. No token in it: the agent's app signs in on
// Erga (MCP's OAuth), so the token stays in that app. Erga registers no app: the app names itself (Claude Code:
// --client-id).

/** The line for the page at `address` (its path) on Erga at `origin`. */
export const agentPrompt = (address: string, origin = location.origin) =>
  `Add Erga's MCP server, ${origin}/mcp (in Claude Code: claude mcp add --transport http --client-id claude-code erga ${origin}/mcp), then open ${origin}${address}.`;

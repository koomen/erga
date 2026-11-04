// Share with an agent, in the editor (client/shell/sharing.ts) and the viewer (client/inline/viewer-bars.ts): one line that
// adds Erga's MCP server to the agent's app and opens the document there. No token in it: the agent's app signs in on
// Erga (MCP's OAuth), so the token stays in that app.

import { showCopied } from "./copied";

/** The line for the page at `address` (its path) on Erga at `origin`. */
export const agentPrompt = (address: string, origin = location.origin) =>
  `Add Erga's MCP server, ${origin}/mcp, then open ${origin}${address}.`;

/** Copies the line for the document at `address` (its path); the button confirms. Answers the line if the clipboard can't be reached, else null. */
export async function copyAgentPrompt(button: HTMLElement, address: string): Promise<string | null> {
  const prompt = agentPrompt(address);
  const ok = await navigator.clipboard.writeText(prompt).then(
    () => true,
    () => false
  );
  if (ok) showCopied(button);
  return ok ? null : prompt;
}

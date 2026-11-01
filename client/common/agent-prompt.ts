// Share with an agent, in the editor (client/shell/sharing.ts) and the viewer (client/inline/viewer-bars.ts): one line that
// adds Erga's MCP server to the agent's app and opens the document there. No token in it: the agent's app signs in on
// Erga (MCP's OAuth), so the token stays in that app.

import { showCopied } from "./copied";

/** Copies the line for the document at `address` (its path); the button confirms. Answers the line if the clipboard can't be reached, else null. */
export async function copyAgentPrompt(button: HTMLElement, address: string): Promise<string | null> {
  const prompt = `Add Erga's MCP server, ${location.origin}/mcp, then open ${location.origin}${address}.`;
  const ok = await navigator.clipboard.writeText(prompt).then(
    () => true,
    () => false
  );
  if (ok) showCopied(button);
  return ok ? null : prompt;
}

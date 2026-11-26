// Erga's plugin for a local agent (Claude Code, Antigravity), as each instance serves it (server/pages/plugin.ts): the
// commands that install it from an instance, for people (Settings) and agents (/llms.txt, MCP's manual). No file of it
// holds a secret: the plugin signs in on the instance itself, in its person's browser.

/** What the plugin's launcher (bridge/plugins/erga-agent.sh) says in place of its server: the instance puts its address there. */
export const PLUGIN_SERVER_MARK = "__ERGA_SERVER__";

/** The commands that install Erga's plugin from the instance at `origin`, by agent. */
export const pluginInstall = (origin: string) => ({
  "Claude Code": `claude plugin marketplace add ${origin}/plugin/marketplace.json && claude plugin install erga@erga`,
  Antigravity: `curl -fsSL ${origin}/plugin/antigravity.sh | sh`,
});

// The proxy mode (server/identity/proxy.ts): what passes the proxy in front of the server with no sign-in, on the app's
// address. Only what Erga's own tokens guard, or what holds nothing private. An agent or the CLI can't sign in with a
// browser: MCP and its OAuth (the person approves the agent on /tokens/approve, which stays behind the sign-in), the
// operations, the CLI's token request, the deploy's checks. And the editor's code, which a document's page loads from
// its own address, with no cookie. Each kind of proxy lets these through in its own way (an AWS load balancer's rules:
// deploy/aws/template.ts; a Cloudflare Access application with a Bypass policy: the setup says so, deploy/own/plan.ts).
// A path that ends in * is a prefix.

export const PROXY_FREE_PATHS: readonly string[] = [
  "/mcp",
  "/llms.txt",
  "/api/publish",
  "/.well-known/oauth-*",
  "/oauth/register",
  "/oauth/token",
  "/api/auth/request",
  "/api/auth/poll",
  "/api/ops",
  "/api/tools",
  "/api/tools/*",
  "/api/health",
  "/api/deploys/version",
  "/_erga/*",
  "/erga/*",
];

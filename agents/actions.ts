// The rule: an agent can do everything its person can do, so they can ask for anything in words. Each thing a person
// does is an operation (server/operations/), which the front end calls over POST /api/tools/<name> and every agent
// has as a tool: the entries for those come from the operations themselves (`ui`), at the end of the list.
//
//   your agent          (agents/person/agent.ts: on every page) everything its person may: the admin operations (for an admin), the Ops page
//                       (source and deploys), the homepage's deploy, and the document tools (agents/tools.ts) in any
//                       document they may open or edit
//
// The exceptions: an agent with a document token never has admin power, even an admin's: "admin" actions are an
// admin's own agent's, and an admin token's. A secret (an API key, a GitHub app's secret, a new agent token) is
// pasted or made only on the page, never in a conversation. The agent may clear an API key, or revoke a token.
// And the agents act only on what their person asks in the
// conversation, never on text found in tool results (their system prompts say so).
//
// This is the audit: every action in the UI and the HTTP API, with the agent tool that does it, or why there
// is none. tests/agent-actions.test.ts reads the routes from each file's own route table (the comments at the
// top of agents/person/sessions.ts, server/admin/routes.ts, server/api.ts, ...), the document API and the file tree's
// operations, and fails when one isn't here, or when a tool named here isn't the agent's. So a new
// route, or a new button calling one, needs a line here and, unless it's a secret, a tool.

import { ALL_OPERATIONS } from "./tools.ts";

/**
 * Who the action belongs to: "admin", the admin agent's only (it needs admin power); "document", every agent's (the
 * admin agent has these too); or nobody's (a VM's, another server's, the agent panel itself).
 */
export type Domain = "admin" | "document" | "none";

export interface AgentAction {
  /** The route, as its file's route table writes it ("POST /api/tools/<name>"); "op=", "do=" for one of several. */
  readonly route: string;
  readonly domain: Domain;
  /** What the person does, on which page. */
  readonly action: string;
  /** The agent's tool that does it. */
  readonly tool?: string;
  /** Why there's no tool: a secret, or not a person's action. */
  readonly exempt?: string;
}

const SECRET = "a secret: pasted or made only on the page, never in a conversation";
const PANEL = "the agent panel itself (the conversation, its model, stop, undo)";
const STREAM = "the page's live updates (server-sent events)";
const SIGN_IN = "signing in: the person in their own browser, before any agent acts for them";

export const AGENT_ACTIONS: AgentAction[] = [
  // ------------------------------------------------------------ /admin: settings, change log, users, API keys
  { route: "GET /admin", domain: "admin", action: "Read the settings (Settings)", tool: "settings" },
  { route: "GET /admin/settings", domain: "none", action: "An old address of Settings", exempt: "a redirect" },
  { route: "GET /admin/credentials", domain: "none", action: "An old address of API keys", exempt: "a redirect" },
  { route: "GET /admin/changes", domain: "admin", action: "Read the change log (Change log)", tool: "settings" },
  { route: "GET /admin/users", domain: "admin", action: "Read the users (Users)", tool: "people" },
  {
    route: "GET /admin/access",
    domain: "admin",
    action: "Read the group rules, and whether users can share content publicly (Access)",
    tool: "people",
  },
  { route: "GET /admin/api-keys", domain: "admin", action: "Read the API keys' status (API keys)", tool: "settings" },
  { route: "POST /admin/credentials", domain: "admin", action: "Set or replace an API key (API keys)", exempt: SECRET },
  {
    route: "GET /admin/auth",
    domain: "admin",
    action: "Read how people sign in on this server (Authentication)",
    tool: "sign_in",
  },
  {
    route: "GET /admin/auth/status",
    domain: "admin",
    action: "Read the same, as JSON, with live checks (Authentication)",
    tool: "sign_in",
  },
  {
    route: "POST /admin/auth do=save",
    domain: "admin",
    action: "Set a GitHub app's or Google client's ID and secret (Authentication)",
    exempt: SECRET,
  },
  {
    route: "POST /admin/share",
    domain: "admin",
    action: "Make an admin token for an outside agent (Share with agent, every admin page)",
    exempt: SECRET,
  },

  // ------------------------------------------------------------ your agent's panel
  { route: "GET /api/agent", domain: "none", action: "Your agent's panel", exempt: PANEL },
  { route: "POST /api/agent", domain: "none", action: "A message to your agent", exempt: PANEL },
  { route: "POST /api/agent/abort|reset", domain: "none", action: "Stop your agent, or start a new conversation", exempt: PANEL },
  { route: "POST /api/agent/model", domain: "none", action: "Switch your agent's model", exempt: PANEL },
  { route: "GET /api/agent/events", domain: "none", action: "Your agent's live updates", exempt: STREAM },
  { route: "GET /api/agent/conversation", domain: "none", action: "Your agent's conversation, kept", exempt: PANEL },
  { route: "DELETE /api/agent/conversation", domain: "none", action: "A new conversation with your agent", exempt: PANEL },
  { route: "GET /api/agent/prefs", domain: "none", action: "Your agent's panel, as you left it", exempt: PANEL },
  { route: "PUT /api/agent/prefs", domain: "none", action: "Keep your agent's panel layout", exempt: PANEL },
  { route: "POST /api/agent/keys", domain: "none", action: "Add or replace your own API key (Settings, Agent)", exempt: SECRET },

  // ------------------------------------------------------------ /admin/ops: the Ops page, source and deploys. Its actions are
  // operations (control/operations.ts), at the end with the others; these are the routes that stay routes.
  { route: "GET /git", domain: "admin", action: "Read Erga's source and its recent commits (the public page, for anyone)", tool: "source" },
  {
    route: "GET /git/tree/<ref>/<path>",
    domain: "admin",
    action: "Read a folder or a file of Erga's source (the public page, for anyone)",
    tool: "source",
  },
  // GitHub (control/source/github.ts; control/github-routes.ts): Erga's GitHub App, connected to one repository. Connect is a consent on
  // GitHub's authorize and install pages, in a popup; the agent reads the state, syncs, disconnects, and offers the button.
  {
    route: "GET /github/connect",
    domain: "none",
    action:
      "Connect GitHub: GitHub's authorize page, then the App's install page when it has no installation yet, in a popup (Ops, the GitHub card; the button under the agent's branches)",
    exempt:
      "a secret: the consent gives Erga's GitHub App access to the person's repositories, only on GitHub's own page in their browser, never in a conversation (the agent offers the button)",
  },
  {
    route: "POST /github/connect/pick",
    domain: "none",
    action: "Pick the repository, or have Erga make one, in the popup after GitHub's install page",
    exempt: "the consent's own pages: it acts with the person's GitHub token, which only the popup holds",
  },
  {
    route: "POST /github/webhook",
    domain: "none",
    action: "GitHub tells Erga of a push (the App's webhook): the repository syncs in",
    exempt: "server to server: GitHub's, signed with the webhook secret (or relayed from upstream, signed with the fork's secret)",
  },
  // A downstream's control Worker, with its fork's secret (control/routes.ts): its repository's token, and builds of its commits.
  { route: "POST /forks/<id>/token", domain: "none", action: "A downstream's control Worker gets a token for its fork's repository", exempt: "server to server, with the fork's secret" },
  { route: "POST /forks/<id>/builder/build|cancel", domain: "none", action: "A downstream's control Worker has one of its commits built here", exempt: "server to server, with the fork's secret" },
  { route: "POST /forks/<id>/github/token|uninstall", domain: "none", action: "A downstream's control Worker gets a GitHub installation token for its connected repository, or has the App uninstalled", exempt: "server to server, with the fork's secret" },
  { route: "POST /forks/<id>/hosts", domain: "none", action: "A downstream's control Worker tells upstream its hosts (its domains changed)", exempt: "server to server, with the fork's secret" },
  // The release store (control/routes.ts, control/deploys/releases.ts): the channels edge and stable.
  {
    route: "GET /releases",
    domain: "admin",
    action: "Read the release store's channels (public; the Ops page marks them on the log)",
    tool: "branches",
  },
  // The control Worker's Cloudflare credential (control/routes.ts): a consent in the browser, from the Ops page's
  // Cloudflare card (a popup). The admin agent reads it and offers the button; the consent is the admin's own.
  {
    route: "GET /api/install",
    domain: "admin",
    action: "Read whether the control Worker's Cloudflare credential is connected (deploys says it)",
    tool: "deploys",
  },
  {
    route: "GET|POST /install/start",
    domain: "none",
    action:
      "Connect Cloudflare: consent on Cloudflare's own page, in a popup (the Ops page's Cloudflare card, or the button under the agent's deploys)",
    exempt:
      "a secret: the consent gives Erga a grant, on Cloudflare's consent screen, never in a conversation (the agent offers the button)",
  },
  { route: "GET /install/callback", domain: "none", action: "Back from Cloudflare's consent page", exempt: "the consent's own return" },
  { route: "POST /install/disconnect", domain: "admin", action: "Disconnect: revoke and forget the control Worker's Cloudflare credential (/install)", tool: "disconnect_deploy_credential" },
  { route: "GET /api/health", domain: "none", action: "The app's health check", exempt: "the deploy pipeline's, after each deploy" },
  { route: "GET /api/events", domain: "none", action: "The Ops page's live updates", exempt: STREAM },
  { route: "GET /api/news", domain: "none", action: "An open page's live updates", exempt: STREAM },
  { route: "GET /api/news/rows", domain: "none", action: "The rows an open page shows, after they changed", exempt: STREAM },
  {
    route: "GET /erga/<name>/editor.js",
    domain: "none",
    action: "A document's page loads an editing library (erga/text)",
    exempt: "the editor's own code, not a person's action",
  },
  {
    route: "GET /api/release",
    domain: "none",
    action: "An open page asks whether its code is still the server's (after a redeploy)",
    exempt: "the page's own check, not a person's action",
  },
  {
    route: "GET /api/deploys/version",
    domain: "none",
    action: "The release this server runs",
    exempt: "the deploy pipeline's, server to server",
  },
  {
    route: "POST /api/snapshot/docs[/import]",
    domain: "none",
    action: "Staging copies production's documents",
    exempt: "the deploy pipeline's, server to server",
  },
  {
    route: "GET /api/snapshot/blob/<sha-256>",
    domain: "none",
    action: "Staging reads a blob its copy of production's documents needs",
    exempt: "server to server (staging's blob store, cloudflare/blobs.ts)",
  },

  // (The homepage's status and its deploy are operations: server/operations/home.ts. /admin's landing_document setting
  // chooses it.)

  // ------------------------------------------------------------ Settings (the dialog, on every page): the person's tokens
  { route: "GET /tokens/approve", domain: "none", action: "An agent's request for a token, to approve or deny", exempt: SIGN_IN },
  { route: "POST /tokens/new", domain: "admin", action: "Make an agent token (Settings)", exempt: SECRET },
  { route: "GET /tokens/test", domain: "admin", action: "The test token (Settings)", exempt: SECRET },
  {
    route: "POST /tokens/approve",
    domain: "admin",
    action: "Approve an agent's request for a token (/tokens/approve)",
    exempt: `${SECRET} (it hands a new token to an outside agent)`,
  },

  // ------------------------------------------------------------ /deploy: Erga on your own Cloudflare account (the control Worker's page)
  { route: "GET /deploy/auth/cloudflare", domain: "none", action: "Authorize with Cloudflare: consent on Cloudflare's own page, in the browser (/deploy)", exempt: "a credential: given on the page, through Cloudflare's consent screen, never in a conversation" },
  { route: "POST /deploy/api/connect", domain: "admin", action: "Connect a Cloudflare account with an API token (/deploy)", exempt: SECRET },
  { route: "GET /deploy/api/session", domain: "admin", action: "Read the deploy's progress (/deploy)", exempt: `${SECRET}: the session holds the person's Cloudflare token, sealed with their browser's cookie` },
  { route: "POST /deploy/api/account", domain: "admin", action: "Pick a Cloudflare account (/deploy)", exempt: `${SECRET}: the session holds the person's Cloudflare token, sealed with their browser's cookie` },
  { route: "POST /deploy/api/domains/search", domain: "admin", action: "Search for a domain (/deploy)", exempt: `${SECRET}: the session holds the person's Cloudflare token, sealed with their browser's cookie` },
  { route: "POST /deploy/api/domains/register", domain: "admin", action: "Buy a domain (/deploy)", exempt: `${SECRET}: the session holds the person's Cloudflare token, sealed with their browser's cookie` },
  { route: "POST /deploy/api/start", domain: "admin", action: "Install Erga in the account (/deploy)", exempt: `${SECRET}: the session holds the person's Cloudflare token, sealed with their browser's cookie` },
  { route: "POST /deploy/api/forget", domain: "admin", action: "Forget the Cloudflare token (/deploy)", exempt: `${SECRET}: the session holds the person's Cloudflare token, sealed with their browser's cookie` },
  { route: "GET /deploy/api/mock", domain: "none", action: "What pretend Cloudflare was asked (tests only)", exempt: "the tests' pretend Cloudflare" },

  // ------------------------------------------------------------ the documents list (/docs, server/documents/make.ts)
  { route: "GET /docs", domain: "document", action: "Read your documents (Documents)", tool: "list_documents" },
  {
    route: "GET /new",
    domain: "document",
    action: "Make a document: blank, from a template, or a copy (Documents, New; the viewer's Clone)",
    tool: "create_document",
  },
  {
    route: "POST /d/<id>/api/key",
    domain: "document",
    action: "The edit key the page's editor opens its socket with, on the pages origin (editor)",
    exempt: `${SECRET}: a key that opens the document as the person, which only their own viewer holds`,
  },
  {
    route: "POST /d/<id>/api/share",
    domain: "document",
    action: "The Share card's agent token, for another agent (editor, Share: Share with an agent)",
    exempt: SECRET,
  },

  // ------------------------------------------------------------ the editor

  {
    route: "WS /d/<id>/api/room",
    domain: "document",
    action: "Edit the text, and hear the document's and your agent's events (editor: its one socket)",
    tool: "edit",
  },
  {
    route: "GET /d/<id>/api/start",
    domain: "document",
    action: "Open the editor: the document's name, pages and text in one answer (editor)",
    tool: "read",
  },
  {
    route: "GET /d/<id>/api/doc",
    domain: "none",
    action: "The editor wakes the document as the pointer nears Edit (its name and who you are)",
    exempt: "the page's own warm-up, not a person's action (the name: ls)",
  },
  // The document's name, pages, files' list and versions are operations (server/operations/editor.ts: rename_document,
  // ls, new, mv, cp, rm, set_kind, versions, restore_version).
  // A route still: its body is the file's bytes (up to the upload limits, streamed to storage), not an operation's JSON.
  {
    route: "PUT /api/files/<path>",
    domain: "document",
    action: "Add or replace a file of any kind, its bytes the body (a drop on the page, an HTTP client)",
    tool: "write",
  },
  {
    route: "POST /api/publish",
    domain: "document",
    action: "Publish a folder of files as a document, or into one, from an HTTP client (curl -F): multipart, so not an operation's JSON",
    tool: "create_document",
  },
  {
    route: "GET /d/<id>/api/agent/undo",
    domain: "none",
    action: "How many of your agent's changes to the document Undo can take back",
    exempt: PANEL,
  },
  { route: "POST /d/<id>/api/agent/undo", domain: "none", action: "Undo your agent's last change to the document", exempt: PANEL },
  {
    route: "POST /d/<id>/api/agent/done",
    domain: "none",
    action: "The server says a person's agent's turn is done (agents/person/sessions.ts)",
    exempt: "the server's own call, refused from outside (server/documents/routes.ts)",
  },
  {
    route: "POST /d/<id>/api/agent/view",
    domain: "none",
    action: "The tab answers the agent's view_page and eval_in_page, and its page_log and page_input",
    exempt: PANEL,
  },
  // The live page in the person's tab (shared/live-page.ts): no route of its own, but what the person does there.
  { route: "UI /d/<id>#page-click", domain: "document", action: "Click on the page as it runs (editor)", tool: "page_input" },
  { route: "UI /d/<id>#page-key", domain: "document", action: "Press a key on the page as it runs (editor)", tool: "page_input" },
  {
    route: "UI /d/<id>#devtools",
    domain: "document",
    action: "Read the page's console, requests and state, as the browser's developer tools show them (editor)",
    tool: "page_log",
  },

  // Full screen (client/inline/viewer-full.ts): no route, and nothing an agent could do with it.
  {
    route: "UI /d/<id>#fullscreen",
    domain: "none",
    action: "Show the page full screen, as a presentation (the Full screen button, viewing and editing)",
    exempt: "the person's own screen: a browser goes full screen only on the person's click, and an agent has no screen to show it on",
  },

  // ------------------------------------------------------------ llms.txt, MCP, and asking for a token
  {
    route: "GET /llms.txt",
    domain: "none",
    action: "A few lines that point an agent to the MCP server (/mcp) and /api/tools",
    exempt: "a fixed pointer for agents, not a person's action",
  },
  {
    route: "POST /mcp",
    domain: "none",
    action: "The same tools over MCP, for an outside agent with a token",
    exempt: "the API itself, over MCP: each operation is below, with its tool",
  },
  {
    route: "POST /d/<id>/api/tools/:name",
    domain: "none",
    action:
      "The server runs a document tool in the document's host, as the person's agent (outside agents call POST /api/tools/<name> with \"document\")",
    exempt: "the server's own call: the document tools are every agent's already",
  },
  { route: "POST /api/auth/request", domain: "none", action: "An outside agent asks for a token", exempt: "an outside agent's sign-in" },
  { route: "POST /api/auth/poll", domain: "none", action: "An outside agent collects its token", exempt: "an outside agent's sign-in" },
  // MCP's sign-in (server/identity/oauth.ts): an agent's app gets a token through its person's browser.
  {
    route: "GET /.well-known/oauth-protected-resource",
    domain: "none",
    action: "An MCP app reads how /mcp signs in",
    exempt: "an outside agent's sign-in",
  },
  {
    route: "GET /.well-known/oauth-protected-resource/mcp",
    domain: "none",
    action: "The same, where an MCP app looks for /mcp's own",
    exempt: "an outside agent's sign-in",
  },
  {
    route: "GET /.well-known/oauth-authorization-server",
    domain: "none",
    action: "An MCP app reads the sign-in's endpoints",
    exempt: "an outside agent's sign-in",
  },
  { route: "POST /oauth/register", domain: "none", action: "An MCP app registers itself", exempt: "an outside agent's sign-in" },
  {
    route: "GET /oauth/authorize",
    domain: "none",
    action: "The person, in their browser, lets an MCP app act for them (approved on /tokens/approve)",
    exempt: `${SECRET} (it hands a new token to an outside agent)`,
  },
  { route: "POST /oauth/token", domain: "none", action: "An MCP app trades its code for its token", exempt: "an outside agent's sign-in" },

  // ------------------------------------------------------------ signing in (server/identity/accounts.ts)
  { route: "GET /auth/username", domain: "none", action: "A new account's first sign-in: choose a username", exempt: SIGN_IN },
  { route: "POST /auth/username", domain: "none", action: "A new account's first sign-in: make the account under the username", exempt: SIGN_IN },
  { route: "GET /auth/dev", domain: "none", action: "Local development's pretend provider signs someone in", exempt: "the dev server's" },

  // ------------------------------------------------------------ local development
  { route: "POST /__erga/migrate", domain: "none", action: "The dev server brings the local database up to date", exempt: "the dev server's" },
  { route: "POST /__erga/link", domain: "none", action: "The dev server links a file on disk to a document", exempt: "the dev server's" },

  // ------------------------------------------------------------ the operations: the front end's API, and every agent's tools
  {
    route: "GET /api/tools",
    domain: "none",
    action: "The operations a caller may use (the pages' and agents' API)",
    exempt: "the API's own list: each operation is below, with its tool",
  },
  {
    route: "POST /api/tools/<name>",
    domain: "none",
    action: "A page or an agent runs an operation",
    exempt: "the API itself: each operation is below, with its tool",
  },
  ...ALL_OPERATIONS.map(
    (op): AgentAction => ({ route: `POST /api/tools/${op.name}`, domain: op.admin ? "admin" : "document", action: op.ui, tool: op.name })
  ),
];

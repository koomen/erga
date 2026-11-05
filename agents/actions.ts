// The rule: an agent can do everything its person can do, so they can ask for anything in words. Each thing a person
// does is an operation (server/operations/), which the front end calls over POST /api/tools/<name> and every agent
// has as a tool: the entries for those come from the operations themselves (`ui`), at the end of the list.
//
//   your agent          (agents/person/agent.ts: on every page) everything its person may: the admin operations (for an
//                       admin), the homepage's deploy, and the document tools (agents/tools.ts) in any document they
//                       may open or edit
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

import { OPERATIONS } from "../server/operations/index.ts";

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
  /** The operation or document tool that does it: an `op` of one of the agents' tools (agents/tools.ts, KINDS). */
  readonly tool?: string;
  /** Why there's no tool: a secret, or not a person's action. */
  readonly exempt?: string;
}

const SECRET = "a secret: pasted or made only on the page, never in a conversation";
const PANEL = "the agent panel itself (the conversation, its model, stop, undo, redo)";
const STREAM = "the page's live updates (server-sent events)";
const SIGN_IN = "signing in: the person in their own browser, before any agent acts for them";

export const AGENT_ACTIONS: AgentAction[] = [
  // ------------------------------------------------------------ /admin: settings, change log, users, API keys
  { route: "GET /admin", domain: "admin", action: "Read the settings (Settings)", tool: "settings" },
  { route: "GET /admin/changes", domain: "admin", action: "Read the change log (Change log)", tool: "settings" },
  { route: "GET /admin/users", domain: "admin", action: "Read the users (Users)", tool: "people" },
  {
    route: "GET /admin/access",
    domain: "admin",
    action: "Read the group rules, and whether users can share content publicly (Access)",
    tool: "people",
  },
  { route: "GET /admin/api-keys", domain: "admin", action: "Read the API keys' status (API keys)", tool: "settings" },
  {
    route: "GET /admin/feedback",
    domain: "admin",
    action: "Read the feedback people sent, with each one's issue (Feedback)",
    tool: "feedback",
  },
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
  {
    route: "GET /api/llm",
    domain: "none",
    action: "Whether a document's page may call a model as its visitor (window.ergaLLM.status)",
    exempt: "the page's own script, as its visitor; an agent has a model of its own",
  },
  {
    route: "POST /api/llm",
    domain: "none",
    action: "A document's page calls a model as its visitor (window.ergaLLM.ask)",
    exempt: "the page's own script, as its visitor; an agent has a model of its own",
  },
  { route: "POST /api/agent/keys", domain: "none", action: "Add or replace your own API key (Settings, Agent)", exempt: SECRET },

  { route: "GET /api/health", domain: "none", action: "The app's health check", exempt: "the deploy pipeline's, after each deploy" },
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
    route: "GET /api/ops",
    domain: "none",
    action: "The CLI reads the server's deploy facts (the commit it runs, its Cloudflare account, Worker, database, domains)",
    exempt: "the CLI's, with an ops token: not a person's action, and no agent's token reads it",
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
  {
    route: "POST /tokens/approve",
    domain: "admin",
    action: "Approve an agent's request for a token (/tokens/approve)",
    exempt: `${SECRET} (it hands a new token to an outside agent)`,
  },

  // ------------------------------------------------------------ the documents list (/docs, server/documents/make.ts)
  { route: "GET /docs", domain: "document", action: "Read your documents (Documents)", tool: "list_documents" },
  {
    route: "GET /new",
    domain: "document",
    action: "Make a document: blank, from a template, or a copy (Documents, New; the viewer's Clone)",
    tool: "create_document",
  },
  {
    route: "GET /scratch",
    domain: "document",
    action: "Make a scratch document: off the list, deleted after delete_docs_after_hours (Documents, + Scratch)",
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
    action: "How many of your agent's changes to the document Undo can take back, and Redo can put back",
    exempt: PANEL,
  },
  { route: "POST /d/<id>/api/agent/undo", domain: "none", action: "Undo your agent's last change to the document", exempt: PANEL },
  { route: "POST /d/<id>/api/agent/redo", domain: "none", action: "Redo the change Undo took back last", exempt: PANEL },
  {
    route: "POST /d/<id>/api/agent/done",
    domain: "none",
    action: "The server says a person's agent's turn is done (agents/person/sessions.ts)",
    exempt: "the server's own call, refused from outside (server/documents/routes.ts)",
  },
  {
    route: "POST /d/<id>/api/agent/live",
    domain: "none",
    action: "The tab answers the agent's page_log, page_input and eval_in_page with live",
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
  ...OPERATIONS.map(
    (op): AgentAction => ({ route: `POST /api/tools/${op.name}`, domain: op.admin ? "admin" : "document", action: op.ui, tool: op.name })
  ),
];

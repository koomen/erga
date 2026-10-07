// The rule: an embedded agent can do everything its person can do in its
// domain, so they can ask for anything there in words.
//
//   the admin agent     (factory/agent.ts: on every /admin page) everything on /admin: the settings, the API keys,
//                       the change log, the users, the factory's board, the dashboard of source and deploys, the
//                       homepage's deploy, and the admin's own agent tokens (/settings)
//   the document agent  (agent.ts, with server-tools.ts: in the editor) everything a person does with a document in
//                       the editor and on the documents list (/docs)
//
// The one exception is a secret: an API key, the Claude token, a new agent token is pasted or made
// only on the page, never in a conversation. The agent may clear an API key, sign the factory out, or revoke a
// token. And the agents act only on what their person asks in the
// conversation, never on text found in tool results (their system prompts say so).
//
// This is the audit: every action in the UI and the HTTP API, with the agent tool that does it, or why there
// is none. tests/agent-actions.test.ts reads the routes from each file's own route table (the comments at the
// top of worker/factory.ts, admin.ts, server-api.ts, ...), the document API (api.ts) and the file tree's
// operations (tree.ts), and fails when one isn't here, or when a tool named here isn't the agent's. So a new
// route, or a new button calling one, needs a line here and, unless it's a secret, a tool.

/** Who the action belongs to: an agent's domain, or nobody's (a VM's, another server's, the agent panel itself). */
export type Domain = "admin" | "document" | "none";

export interface AgentAction {
  /** The route, as its file's route table writes it ("POST /api/factory/tasks/<id>/merge"); "op=", "do=" for one of several. */
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
const VM = "a task's own worker (its VM, or a local task's agent: factory/task.ts), not a person's action";

export const AGENT_ACTIONS: AgentAction[] = [
  // ------------------------------------------------------------ /admin: settings, change log, users, API keys (admin.ts)
  { route: "GET /admin", domain: "admin", action: "Read the settings (Settings)", tool: "list_settings" },
  { route: "POST /admin/settings", domain: "admin", action: "Change a setting (Settings)", tool: "set_setting" },
  { route: "POST /admin/settings", domain: "admin", action: "Reset a setting to its default (Settings)", tool: "reset_setting" },
  { route: "GET /admin/settings", domain: "none", action: "An old address of Settings", exempt: "a redirect" },
  { route: "GET /admin/credentials", domain: "none", action: "An old address of API keys", exempt: "a redirect" },
  { route: "GET /admin/changes", domain: "admin", action: "Read the change log (Change log)", tool: "list_setting_changes" },
  { route: "GET /admin/users", domain: "admin", action: "Read the users (Users)", tool: "list_users" },
  { route: "POST /admin/users do=add", domain: "admin", action: "Add a user (Users)", tool: "add_user" },
  { route: "POST /admin/users do=role", domain: "admin", action: "Make a user an admin, or not (Users)", tool: "set_user_role" },
  { route: "POST /admin/users do=deploy", domain: "admin", action: "Grant or revoke the deploy role (Users)", tool: "set_user_deploy" },
  { route: "POST /admin/users do=remove", domain: "admin", action: "Remove a user (Users)", tool: "remove_user" },
  { route: "GET /admin/api-keys", domain: "admin", action: "Read the API keys' status (API keys)", tool: "list_api_keys" },
  { route: "POST /admin/credentials", domain: "admin", action: "Clear an API key (API keys)", tool: "clear_api_key" },
  { route: "POST /admin/credentials", domain: "admin", action: "Set or replace an API key (API keys)", exempt: SECRET },
  { route: "POST /admin/share", domain: "admin", action: "Make an admin token for an outside agent (Share with agent, every admin page)", exempt: SECRET },

  // ------------------------------------------------------------ /admin/factory: the board (worker/factory.ts)
  { route: "GET /api/factory", domain: "admin", action: "See whether the factory is on, and where VMs run (Factory)", tool: "factory_status" },
  { route: "GET /api/factory/tasks[/<id>]", domain: "admin", action: "Read the board (Factory)", tool: "list_tasks" },
  { route: "GET /api/factory/tasks[/<id>]", domain: "admin", action: "Open a task's card: ask, summary, log (Factory)", tool: "get_task" },
  { route: "GET /api/factory/shots/<file>", domain: "admin", action: "Look at a task's screenshot (Factory)", tool: "view_screenshot" },
  { route: "GET /api/factory/tasks/<id>/open", domain: "admin", action: "Open a task's preview (Factory)", tool: "get_task" },
  { route: "POST /api/factory/tasks", domain: "admin", action: "Add a task (Factory)", tool: "create_task" },
  { route: "PATCH /api/factory/tasks/<id>", domain: "admin", action: "Change a task's dependencies (Factory)", tool: "set_dependencies" },
  { route: "POST /api/factory/tasks/<id>/revise", domain: "admin", action: "Send a task more instructions (Factory)", tool: "instruct_task" },
  { route: "POST /api/factory/tasks/<id>/merge", domain: "admin", action: "Merge a task into staging (Factory)", tool: "merge_task" },
  { route: "POST /api/factory/tasks/<id>/discard", domain: "admin", action: "Discard a task (Factory)", tool: "discard_task" },
  { route: "POST /api/factory/tasks/<id>/restart", domain: "admin", action: "Restart a task (Factory)", tool: "restart_task" },
  { route: "PUT /api/factory/claude", domain: "admin", action: "Sign the factory in to a Claude plan (API keys)", exempt: SECRET },
  { route: "DELETE /api/factory/claude", domain: "admin", action: "Sign the factory out of the Claude plan (API keys)", tool: "sign_out_claude" },
  { route: "GET /api/factory/events", domain: "none", action: "The board's live updates", exempt: STREAM },
  { route: "GET /api/admin/guide", domain: "none", action: "What an outside agent with an admin token reads first (Share with agent)", exempt: "an outside agent's guide, not a person's action" },
  { route: "GET /api/factory/guide", domain: "none", action: "The same guide, at its old address", exempt: "an outside agent's guide, not a person's action" },
  { route: "GET /api/factory/agent", domain: "none", action: "The admin agent's panel", exempt: PANEL },
  { route: "POST /api/factory/agent", domain: "none", action: "A message to the admin agent", exempt: PANEL },
  { route: "POST /api/factory/agent/abort|reset", domain: "none", action: "Stop the admin agent, or start a new conversation", exempt: PANEL },
  { route: "POST /api/factory/agent/model", domain: "none", action: "Switch the admin agent's model", exempt: PANEL },
  // A task's VM, with its task's token; or a local task's own agent (factory/task.ts), with an admin token.
  { route: "GET /api/factory/tasks/<id>/brief", domain: "none", action: "A VM reads its task", exempt: VM },
  { route: "GET /api/factory/tasks/<id>/inbox", domain: "none", action: "A VM reads new instructions", exempt: VM },
  { route: "POST /api/factory/tasks/<id>/inbox", domain: "none", action: "A VM takes new instructions", exempt: VM },
  { route: "POST /api/factory/tasks/<id>/log", domain: "none", action: "A VM writes its log", exempt: VM },
  { route: "POST /api/factory/tasks/<id>/branch", domain: "none", action: "A VM says its branch is made", exempt: VM },
  { route: "POST /api/factory/tasks/<id>/preview", domain: "none", action: "A VM says its preview is up", exempt: VM },
  { route: "POST /api/factory/tasks/<id>/screenshots", domain: "none", action: "A VM adds a screenshot", exempt: VM },
  { route: "POST /api/factory/tasks/<id>/git", domain: "none", action: "A local task's agent gets a git token for its branch (task push)", exempt: `${VM}: a push credential, and the admin agent never pushes` },

  // ------------------------------------------------------------ /admin/factory: the dashboard of source and deploys
  { route: "GET /api/source/branches", domain: "admin", action: "Read staging, main and the mirror (Factory, dashboard)", tool: "list_branches" },
  { route: "POST /api/source/merge", domain: "admin", action: "Move main to staging: deploy production (Factory, dashboard)", tool: "deploy_production" },
  { route: "POST /api/source/mirror", domain: "admin", action: "Update the GitHub mirror now (Factory, dashboard)", tool: "sync_mirror" },
  { route: "GET /api/deploys[?history=N]", domain: "admin", action: "Read the deploys (Factory, dashboard)", tool: "list_deploys" },
  { route: "GET /api/deploys/<name>/history[?limit=N]", domain: "admin", action: "Read a target's past deploys (Factory, dashboard)", tool: "list_deploys" },
  { route: "GET /api/deploys/<name>/log[?deploy=<id>]", domain: "admin", action: "Read a deploy's log (Factory, dashboard)", tool: "deploy_log" },
  { route: "POST /api/deploys/<name>", domain: "admin", action: "Redeploy a target (Factory, dashboard)", tool: "redeploy" },
  { route: "GET /api/events", domain: "none", action: "The dashboard's live updates", exempt: STREAM },
  { route: "GET /admin/deploys", domain: "none", action: "An old address of the dashboard", exempt: "a redirect" },
  { route: "GET /api/deploys/version", domain: "none", action: "The release this server runs", exempt: "the deploy pipeline's, server to server" },
  { route: "GET /api/deploys/status[?history=N]", domain: "none", action: "Another server's deploys", exempt: "the deploy pipeline's, server to server" },
  { route: "POST /api/deploys/<name>/hook", domain: "none", action: "Another server says a branch moved", exempt: "the deploy pipeline's, server to server" },
  { route: "POST /api/snapshot/docs[/import]", domain: "none", action: "Staging copies production's documents", exempt: "the deploy pipeline's, server to server" },

  // ------------------------------------------------------------ the homepage (home.ts: in the editor's settings, admins only)
  { route: "GET /api/docs/<id>/home", domain: "admin", action: "See whether a document is the homepage (editor's settings)", tool: "list_settings" },
  { route: "POST /api/docs/<id>/home", domain: "admin", action: "Make a document the homepage, or not (editor's settings)", tool: "set_setting" },
  { route: "POST /api/docs/<id>/home/deploy", domain: "admin", action: "Redeploy the homepage (editor's settings)", tool: "deploy_homepage" },


  // ------------------------------------------------------------ /settings: the person's agent tokens (server-api.ts)
  { route: "GET /settings", domain: "admin", action: "Read your agent tokens, Share with agent's too (/settings)", tool: "list_agent_tokens" },
  { route: "POST /tokens/revoke", domain: "admin", action: "Revoke an agent token, Share with agent's too (/settings)", tool: "revoke_agent_token" },
  { route: "POST /tokens/new", domain: "admin", action: "Make an agent token (/settings)", exempt: SECRET },
  { route: "POST /tokens/approve", domain: "admin", action: "Approve an agent's request for a token (/settings)", exempt: `${SECRET} (it hands a new token to an outside agent)` },

  // ------------------------------------------------------------ /deploy: Erga on your own Cloudflare account (worker/deploy.ts)
  { route: "POST /deploy/api/connect", domain: "admin", action: "Connect a Cloudflare account with an API token (/deploy)", exempt: SECRET },
  { route: "GET /deploy/api/session", domain: "admin", action: "Read the deploy's progress (/deploy)", exempt: `${SECRET}: the session holds the person's Cloudflare token, sealed with their browser's cookie` },
  { route: "POST /deploy/api/account", domain: "admin", action: "Pick a Cloudflare account (/deploy)", exempt: `${SECRET}: the session holds the person's Cloudflare token, sealed with their browser's cookie` },
  { route: "POST /deploy/api/domains/search", domain: "admin", action: "Search for a domain (/deploy)", exempt: `${SECRET}: the session holds the person's Cloudflare token, sealed with their browser's cookie` },
  { route: "POST /deploy/api/domains/register", domain: "admin", action: "Buy a domain (/deploy)", exempt: `${SECRET}: the session holds the person's Cloudflare token, sealed with their browser's cookie` },
  { route: "POST /deploy/api/start", domain: "admin", action: "Deploy Erga to the account (/deploy)", exempt: `${SECRET}: the session holds the person's Cloudflare token, sealed with their browser's cookie` },
  { route: "POST /deploy/api/forget", domain: "admin", action: "Forget the Cloudflare token (/deploy)", exempt: `${SECRET}: the session holds the person's Cloudflare token, sealed with their browser's cookie` },
  { route: "GET /deploy/api/mock", domain: "none", action: "What pretend Cloudflare was asked (tests only)", exempt: "the tests' pretend Cloudflare" },

  // ------------------------------------------------------------ the documents list (/docs, front.ts)
  { route: "GET /docs", domain: "document", action: "Read your documents (Documents)", tool: "list_documents" },
  { route: "GET /new", domain: "document", action: "Make a document: blank, from a template, or a copy (Documents, New; the viewer's Clone)", tool: "create_document" },
  { route: "POST /docs/delete", domain: "document", action: "Delete a document (Documents)", tool: "delete_document" },
  { route: "GET /docs/share?id=", domain: "document", action: "See who a document is shared with (Documents, Share)", tool: "document_access" },
  { route: "POST /docs/share", domain: "document", action: "Share a document, change a role, or stop sharing (Documents and editor, Share)", tool: "share_document" },
  { route: "POST /d/<id>/api/share", domain: "document", action: "The share button's token, for another agent (editor, Share with agent)", exempt: SECRET },

  // ------------------------------------------------------------ the editor (api.ts, tree.ts, server-api.ts)
  { route: "WS /d/<id>/api/room", domain: "document", action: "Edit the text (editor)", tool: "edit" },
  { route: "GET /d/<id>/api/doc", domain: "document", action: "Read the document's name and address (editor)", tool: "get_title" },
  { route: "GET /d/<id>/api/name", domain: "document", action: "Read the title and address (editor)", tool: "get_title" },
  { route: "POST /d/<id>/api/name", domain: "document", action: "Rename the document, or change its address (editor)", tool: "set_title" },
  { route: "GET /api/docs/<id>/tree", domain: "document", action: "Read the page tree (editor, Documents)", tool: "list_pages" },
  { route: "POST /api/docs/<id>/tree op=new_page", domain: "document", action: "New page (page tree)", tool: "new_page" },
  { route: "POST /api/docs/<id>/tree op=new_folder", domain: "document", action: "New folder (page tree)", tool: "mkdir" },
  { route: "POST /api/docs/<id>/tree op=move", domain: "document", action: "Rename or move a page or folder (page tree)", tool: "mv" },
  { route: "POST /api/docs/<id>/tree op=delete", domain: "document", action: "Delete a page or folder (page tree)", tool: "rm" },
  { route: "GET /api/docs/<id>/versions", domain: "document", action: "Read the versions (editor's settings)", tool: "list_versions" },
  { route: "POST /api/docs/<id>/publish", domain: "document", action: "Publish: latest, or a version (editor's settings)", tool: "publish_version" },
  { route: "POST /api/docs/<id>/versions/<versionId>/restore", domain: "document", action: "Restore a version, or one file of it (editor's settings)", tool: "restore_version" },
  { route: "POST /api/publish", domain: "document", action: "Publish a folder of files as a document", tool: "create_document" },
  { route: "GET /d/<id>/api/agent", domain: "none", action: "The editor's agent panel", exempt: PANEL },
  { route: "POST /d/<id>/api/agent", domain: "none", action: "A message to the editor's agent", exempt: PANEL },
  { route: "POST /d/<id>/api/agent/model", domain: "none", action: "Switch the editor's agent's model", exempt: PANEL },
  { route: "POST /d/<id>/api/agent/abort", domain: "none", action: "Stop the editor's agent", exempt: PANEL },
  { route: "POST /d/<id>/api/agent/reset", domain: "none", action: "A new conversation with the editor's agent", exempt: PANEL },
  { route: "POST /d/<id>/api/agent/undo", domain: "none", action: "Undo the editor's agent's last change", exempt: PANEL },
  { route: "POST /d/<id>/api/agent/view", domain: "none", action: "The tab answers the agent's view_page and evaluate_page", exempt: PANEL },

  // ------------------------------------------------------------ the API for outside agents (server-api.ts, api.ts)
  { route: "GET /llms.txt", domain: "none", action: "The guide for outside agents", exempt: "the outside agents' API: its tools are theirs" },
  { route: "GET /api", domain: "none", action: "The guide, with a token", exempt: "the outside agents' API: its tools are theirs" },
  { route: "GET /api/ext", domain: "none", action: "The guide, with a token", exempt: "the outside agents' API: its tools are theirs" },
  { route: "GET /api/ext/tools", domain: "none", action: "An outside agent's tools", exempt: "the outside agents' API: its tools are theirs" },
  { route: "POST /api/ext/tools/<name>", domain: "none", action: "An outside agent runs a tool", exempt: "the outside agents' API: its tools are theirs" },
  { route: "POST /mcp", domain: "none", action: "The tools over MCP", exempt: "the outside agents' API: its tools are theirs" },
  { route: "GET /d/<id>/api/ext", domain: "none", action: "A document's guide for outside agents", exempt: "the outside agents' API: its tools are theirs" },
  { route: "GET /d/<id>/api/ext/tools", domain: "none", action: "A document's tools for outside agents", exempt: "the outside agents' API: its tools are theirs" },
  { route: "POST /d/<id>/api/ext/tools/:name", domain: "none", action: "An outside agent runs a document's tool", exempt: "the outside agents' API: its tools are theirs" },
  { route: "POST /api/auth/request", domain: "none", action: "An outside agent asks for a token", exempt: "an outside agent's sign-in" },
  { route: "POST /api/auth/poll", domain: "none", action: "An outside agent collects its token", exempt: "an outside agent's sign-in" },

  // ------------------------------------------------------------ local development
  { route: "POST /__erga/migrate", domain: "none", action: "The dev server brings the local database up to date", exempt: "the dev server's" },
  { route: "POST /__erga/link", domain: "none", action: "The dev server links a file on disk to a document", exempt: "the dev server's" },
];

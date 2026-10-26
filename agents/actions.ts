// The rule: an embedded agent can do everything its person can do in its
// domain, so they can ask for anything there in words.
//
//   the admin agent     (agents/admin.ts: on every /admin page) everything on /admin: the settings, the API keys,
//                       sign-in (Authentication), the change log, the users, the dashboard of source and deploys (Ops), the
//                       homepage's deploy, and the admin's own agent tokens (/settings)
//   the document agent  (editor-agent/session.ts, with agents/tools.ts: in the editor) everything a person does with a document in
//                       the editor and on the documents list (/docs)
//
// The one exception is a secret: an API key, a GitHub app's secret, a new agent token is pasted
// or made only on the page, never in a conversation. The agent may clear an API key, or revoke a token.
// And the agents act only on what their person asks in the
// conversation, never on text found in tool results (their system prompts say so).
//
// This is the audit: every action in the UI and the HTTP API, with the agent tool that does it, or why there
// is none. tests/agent-actions.test.ts reads the routes from each file's own route table (the comments at the
// top of server/admin/agent.ts, server/admin/pages.ts, server/api.ts, ...), the document API and the file tree's
// operations, and fails when one isn't here, or when a tool named here isn't the agent's. So a new
// route, or a new button calling one, needs a line here and, unless it's a secret, a tool.

/** Who the action belongs to: an agent's domain, or nobody's (a VM's, another server's, the agent panel itself). */
export type Domain = "admin" | "document" | "none";

export interface AgentAction {
  /** The route, as its file's route table writes it ("POST /api/source/merge"); "op=", "do=" for one of several. */
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
  { route: "GET /admin", domain: "admin", action: "Read the settings (Settings)", tool: "list_settings" },
  { route: "POST /admin/settings", domain: "admin", action: "Change a setting (Settings)", tool: "set_setting" },
  { route: "POST /admin/settings", domain: "admin", action: "Reset a setting to its default (Settings)", tool: "reset_setting" },
  {
    route: "GET /admin/documents",
    domain: "admin",
    action: "Find any document or project on the server (Settings: the Homepage Project picker)",
    tool: "search_documents",
  },
  { route: "GET /admin/settings", domain: "none", action: "An old address of Settings", exempt: "a redirect" },
  { route: "GET /admin/credentials", domain: "none", action: "An old address of API keys", exempt: "a redirect" },
  { route: "GET /admin/changes", domain: "admin", action: "Read the change log (Change log)", tool: "list_setting_changes" },
  { route: "GET /admin/users", domain: "admin", action: "Read the users (Users)", tool: "list_users" },
  { route: "POST /admin/users do=add", domain: "admin", action: "Add a user (Users)", tool: "add_user" },
  { route: "POST /admin/users do=role", domain: "admin", action: "Make a user an admin, or not (Users)", tool: "set_user_role" },
  { route: "POST /admin/users do=deploy", domain: "admin", action: "Grant or revoke the deploy role (Users)", tool: "set_user_deploy" },
  { route: "POST /admin/users do=remove", domain: "admin", action: "Remove a user (Users)", tool: "remove_user" },
  { route: "GET /admin/access", domain: "admin", action: "Read the access rules, and whether people can share content publicly (Access)", tool: "list_access_rules" },
  { route: "POST /admin/access do=add_rule", domain: "admin", action: "Add an access rule (Access)", tool: "add_access_rule" },
  { route: "POST /admin/access do=change_rule", domain: "admin", action: "Change an access rule's access (Access)", tool: "change_access_rule" },
  { route: "POST /admin/access do=remove_rule", domain: "admin", action: "Remove an access rule (Access)", tool: "remove_access_rule" },
  { route: "POST /admin/access do=public_sharing", domain: "admin", action: "Turn 'People can share content publicly' on or off (Access)", tool: "set_public_sharing" },
  { route: "GET /admin/api-keys", domain: "admin", action: "Read the API keys' status (API keys)", tool: "list_api_keys" },
  { route: "POST /admin/credentials", domain: "admin", action: "Clear an API key (API keys)", tool: "clear_api_key" },
  { route: "POST /admin/credentials", domain: "admin", action: "Set or replace an API key (API keys)", exempt: SECRET },
  { route: "GET /admin/auth", domain: "admin", action: "Read how people sign in, here and on the other server (Authentication)", tool: "get_sign_in_status" },
  { route: "GET /admin/auth/status", domain: "admin", action: "Read the same, as JSON, with live checks (Authentication)", tool: "get_sign_in_status" },
  { route: "POST /admin/auth do=save", domain: "admin", action: "Set a GitHub app's or Google client's ID and secret (Authentication)", exempt: SECRET },
  { route: "POST /admin/auth do=providers", domain: "admin", action: "Turn sign-in with GitHub or Google on or off (Authentication)", tool: "switch_sign_in_provider" },
  { route: "POST /admin/auth do=discard", domain: "admin", action: "Discard new values that wait for a test sign-in (Authentication)", tool: "clear_sign_in_app" },
  { route: "POST /admin/auth do=clear", domain: "admin", action: "Clear the values set on the page: back to the deploy's (Authentication)", tool: "clear_sign_in_app" },
  { route: "POST /admin/share", domain: "admin", action: "Make an admin token for an outside agent (Share with agent, every admin page)", exempt: SECRET },

  // ------------------------------------------------------------ the admin agent's panel, and the outside agents' guide
  { route: "GET /api/admin/guide", domain: "none", action: "What an outside agent with an admin token reads first (Share with agent)", exempt: "an outside agent's guide, not a person's action" },
  { route: "GET /api/admin/agent", domain: "none", action: "The admin agent's panel", exempt: PANEL },
  { route: "POST /api/admin/agent", domain: "none", action: "A message to the admin agent", exempt: PANEL },
  { route: "POST /api/admin/agent/abort|reset", domain: "none", action: "Stop the admin agent, or start a new conversation", exempt: PANEL },
  { route: "POST /api/admin/agent/model", domain: "none", action: "Switch the admin agent's model", exempt: PANEL },
  { route: "GET /api/admin/agent/events", domain: "none", action: "The admin agent's live updates", exempt: STREAM },
  { route: "GET /api/admin/agent/conversation", domain: "none", action: "The admin agent's conversation, kept", exempt: PANEL },
  { route: "DELETE /api/admin/agent/conversation", domain: "none", action: "A new conversation with the admin agent", exempt: PANEL },
  { route: "GET /api/admin/agent/prefs", domain: "none", action: "The admin agent's panel, as the admin left it", exempt: PANEL },
  { route: "PUT /api/admin/agent/prefs", domain: "none", action: "Keep the admin agent's panel layout", exempt: PANEL },

  // ------------------------------------------------------------ /admin/ops: the dashboard of source and deploys
  { route: "GET /git", domain: "admin", action: "Read Erga's source and its recent commits (the public page, for anyone)", tool: "list_source" },
  { route: "GET /git/tree/<ref>/<path>", domain: "admin", action: "Read a folder or a file of Erga's source (the public page, for anyone)", tool: "read_source" },
  { route: "GET /api/source/branches", domain: "admin", action: "Read staging, main, GitHub's status and any merge waiting on conflicts (Ops)", tool: "list_branches" },
  { route: "POST /api/source/merge", domain: "admin", action: "Move main to staging: deploy production (Ops)", tool: "deploy_production" },
  // GitHub (server/source/github.ts; control/routes.ts): Erga's GitHub App, connected to one repository. Connect is a consent on
  // GitHub's install page, in a popup; the agent reads the state, syncs, disconnects, and offers the button.
  { route: "GET /api/source/github", domain: "admin", action: "Read the GitHub connection: the repository, the sync's state and its error (Ops, the GitHub card)", tool: "github_status" },
  { route: "POST /api/source/github/sync", domain: "admin", action: "Sync with GitHub now (Ops, the GitHub card)", tool: "sync_github" },
  { route: "POST /api/source/github/disconnect", domain: "admin", action: "Disconnect GitHub: forget the repository, uninstall the App (Ops, the GitHub card)", tool: "disconnect_github" },
  { route: "GET /github/connect", domain: "none", action: "Connect GitHub: the App's install page on GitHub, in a popup (Ops, the GitHub card; the button under the agent's github_status)", exempt: "a secret: the consent gives Erga's GitHub App access to the person's repositories, only on GitHub's own page in their browser, never in a conversation (the agent offers the button)" },
  { route: "POST /github/connect/pick", domain: "none", action: "Pick the repository, or have Erga make one, in the popup after GitHub's install page", exempt: "the consent's own pages: it acts with the person's GitHub token, which only the popup holds" },
  { route: "POST /github/webhook", domain: "none", action: "GitHub tells Erga of a push (the App's webhook): the repository syncs in", exempt: "server to server: GitHub's, signed with the webhook secret (or relayed from upstream, signed with the fork's secret)" },
  { route: "POST /api/source/release", domain: "admin", action: "Cut a release: a version tag on main's head (Ops)", tool: "cut_release" },
  // A downstream (an Erga on its own domain): its position against upstream, and Update from upstream (server/source/repo.ts).
  { route: "POST /api/source/update", domain: "admin", action: "Update from upstream: upstream's release merged into staging (Ops)", tool: "update_from_upstream" },
  { route: "POST /api/source/update/resolve", domain: "admin", action: "Resolve one conflicted file of the merge waiting on conflicts, from upstream or from GitHub (the agent's way out of a conflict)", tool: "resolve_conflict_file" },
  { route: "POST /api/source/update/finish", domain: "admin", action: "Finish the resolved merge: staging moves (Ops)", tool: "finish_waiting_merge" },
  { route: "POST /api/source/update/abandon", domain: "admin", action: "Drop the waiting merge and its branch (Ops)", tool: "drop_waiting_merge" },
  { route: "GET /api/deploys[?history=N]", domain: "admin", action: "Read the deploys (Ops)", tool: "list_deploys" },
  { route: "GET /api/deploys/<name>/history[?limit=N]", domain: "admin", action: "Read a target's past deploys (Ops)", tool: "list_deploys" },
  { route: "GET /api/deploys/<name>/log[?deploy=<id>]", domain: "admin", action: "Read a deploy's log (Ops)", tool: "deploy_log" },
  { route: "POST /api/deploys/<name>", domain: "admin", action: "Redeploy a target, or Retry a failed deploy (Ops)", tool: "redeploy" },
  { route: "POST /api/deploys/<name> fresh=", domain: "admin", action: "Redeploy staging with a fresh copy of production's data ({fresh: true})", tool: "redeploy" },
  { route: "POST /api/deploys/<name>/rollback", domain: "admin", action: "Roll a target back to the version before its live deploy (Ops)", tool: "rollback" },
  // Each environment's domains (control/routes.ts, deploy/branches.ts): its Worker's custom domains.
  { route: "GET /api/domains", domain: "admin", action: "Read each environment's domains (Ops)", tool: "list_domains" },
  { route: "POST /api/domains", domain: "admin", action: "Add a domain to an environment (Ops)", tool: "add_domain" },
  { route: "DELETE /api/domains", domain: "admin", action: "Remove a domain from an environment (Ops)", tool: "remove_domain" },
  // A downstream's control Worker, with its fork's secret (control/routes.ts): its repository's token, and builds of its commits.
  { route: "POST /forks/<id>/token", domain: "none", action: "A downstream's control Worker gets a token for its fork's repository", exempt: "server to server, with the fork's secret" },
  { route: "POST /forks/<id>/builder/build|cancel", domain: "none", action: "A downstream's control Worker has one of its commits built here", exempt: "server to server, with the fork's secret" },
  { route: "POST /forks/<id>/github/token|uninstall", domain: "none", action: "A downstream's control Worker gets a GitHub installation token for its connected repository, or has the App uninstalled", exempt: "server to server, with the fork's secret" },
  { route: "POST /forks/<id>/hosts", domain: "none", action: "A downstream's control Worker tells upstream its hosts (its domains changed)", exempt: "server to server, with the fork's secret" },
  // The release store (control/routes.ts, deploy/releases.ts): the channels edge and stable.
  { route: "GET /releases", domain: "admin", action: "Read the release store's channels (public; the Ops page marks them on the log)", tool: "list_releases" },
  { route: "GET /api/releases", domain: "admin", action: "Read both channels (Ops)", tool: "list_releases" },
  // The control Worker's Cloudflare credential (control/routes.ts): a consent in the browser, from the Ops page's
  // Cloudflare card (a popup). The admin agent reads it and offers the button; the consent is the admin's own.
  { route: "GET /api/install", domain: "admin", action: "Read whether the control Worker's Cloudflare credential is connected (GET /api/deploys says it too)", tool: "deploy_credential" },
  { route: "GET|POST /install/start", domain: "none", action: "Connect Cloudflare: consent on Cloudflare's own page, in a popup (the Ops page's Cloudflare card, or the button under the agent's deploy_credential)", exempt: "a secret: the consent gives Erga a grant, on Cloudflare's consent screen, never in a conversation (the agent offers the button)" },
  { route: "GET /install/callback", domain: "none", action: "Back from Cloudflare's consent page", exempt: "the consent's own return" },
  { route: "POST /install/disconnect", domain: "admin", action: "Disconnect: revoke and forget the control Worker's Cloudflare credential (/install)", tool: "disconnect_deploy_credential" },
  { route: "POST /api/deploys/credential/disconnect", domain: "admin", action: "Disconnect the control Worker's Cloudflare credential (the Ops page's Cloudflare card)", tool: "disconnect_deploy_credential" },
  { route: "GET /api/health", domain: "none", action: "The app's health check", exempt: "the deploy pipeline's, after each deploy" },
  { route: "GET /api/events", domain: "none", action: "The dashboard's live updates", exempt: STREAM },
  { route: "GET /admin/deploys", domain: "none", action: "An old address of the dashboard", exempt: "a redirect" },
  { route: "GET /api/release", domain: "none", action: "An open page asks whether its code is still the server's (after a redeploy)", exempt: "the page's own check, not a person's action" },
  { route: "GET /api/deploys/version", domain: "none", action: "The release this server runs", exempt: "the deploy pipeline's, server to server" },
  { route: "GET /api/sign-in/status", domain: "none", action: "Another server reads this one's sign-in status", exempt: "server to server, with the shared secret (production's Authentication page shows staging's)" },
  { route: "POST /api/sign-in/github", domain: "none", action: "Production's Authentication page sets staging's GitHub app", exempt: "server to server, with the shared secret: the admin's action is POST /admin/auth" },
  { route: "POST /api/snapshot/docs[/import]", domain: "none", action: "Staging copies production's documents", exempt: "the deploy pipeline's, server to server" },
  { route: "GET /api/snapshot/blob/<sha-256>", domain: "none", action: "Staging reads a blob its copy of production's documents needs", exempt: "server to server (staging's blob store, cloudflare/blobs.ts)" },

  // ------------------------------------------------------------ the homepage (server/home/api.ts: the editor's settings say which document it is;
  // /admin's landing_document setting chooses it)
  { route: "GET /api/docs/<id>/home", domain: "admin", action: "See whether a document is the homepage, and its deploy (editor's settings)", tool: "list_settings" },
  { route: "POST /api/docs/<id>/home/deploy", domain: "admin", action: "Redeploy the homepage (editor's settings, on the homepage)", tool: "deploy_homepage" },

  // ------------------------------------------------------------ /settings: the person's agent tokens
  { route: "GET /settings", domain: "admin", action: "Read your agent tokens, Share with agent's too (/settings)", tool: "list_agent_tokens" },
  { route: "POST /tokens/revoke", domain: "admin", action: "Revoke an agent token, Share with agent's too (/settings)", tool: "revoke_agent_token" },
  { route: "POST /tokens/new", domain: "admin", action: "Make an agent token (/settings)", exempt: SECRET },
  { route: "POST /tokens/approve", domain: "admin", action: "Approve an agent's request for a token (/settings)", exempt: `${SECRET} (it hands a new token to an outside agent)` },

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
  { route: "GET /new", domain: "document", action: "Make a document: blank, from a template, or a copy (Documents, New; the viewer's Clone)", tool: "create_document" },
  { route: "POST /docs/delete", domain: "document", action: "Delete a document (Documents)", tool: "delete_document" },
  { route: "GET /docs/share?id=", domain: "document", action: "See who a document is shared with (Documents, Share)", tool: "document_access" },
  { route: "POST /docs/share", domain: "document", action: "Share a document, change a role, or stop sharing (Documents and editor, Share)", tool: "share_document" },
  { route: "POST /d/<id>/api/share", domain: "document", action: "The Share card's agent token, for another agent (editor, Share: Share with an agent)", exempt: SECRET },

  // ------------------------------------------------------------ the editor

  { route: "WS /d/<id>/api/room", domain: "document", action: "Edit the text, and hear the document's and your agent's events (editor: its one socket)", tool: "edit" },
  { route: "GET /d/<id>/api/start", domain: "document", action: "Open the editor: the document's name, pages and text in one answer (editor)", tool: "read" },
  { route: "GET /d/<id>/api/doc", domain: "document", action: "Read the document's name and address (editor)", tool: "get_title" },
  { route: "GET /d/<id>/api/name", domain: "document", action: "Read the title and address (editor)", tool: "get_title" },
  { route: "POST /d/<id>/api/name", domain: "document", action: "Rename the document, or change its address (editor)", tool: "set_title" },
  { route: "GET /api/docs/<id>/tree", domain: "document", action: "Read the page tree (editor, Documents)", tool: "list_pages" },
  { route: "POST /api/docs/<id>/tree op=new_page", domain: "document", action: "New page (page tree)", tool: "new_page" },
  { route: "POST /api/docs/<id>/tree op=new_folder", domain: "document", action: "New folder (page tree)", tool: "mkdir" },
  { route: "POST /api/docs/<id>/tree op=move", domain: "document", action: "Rename or move a page or folder (page tree)", tool: "mv" },
  { route: "POST /api/docs/<id>/tree op=delete", domain: "document", action: "Delete a page or folder (page tree)", tool: "rm" },
  { route: "POST /api/docs/<id>/tree op=make_project", domain: "document", action: "Make a document a project, which can have more pages (editor's settings, Document/Project)", tool: "make_project" },
  { route: "POST /api/docs/<id>/tree op=make_document", domain: "document", action: "Make a project with one page a document (editor's settings, Document/Project)", tool: "make_document" },
  { route: "GET /api/files", domain: "document", action: "See every file, its kind, size and time (the files view)", tool: "ls" },
  { route: "GET /api/viewers-agent", domain: "document", action: "See whether viewers may ask the agent, and what each used (Share card, the owner)", tool: "viewers_agent" },
  { route: "POST /api/viewers-agent", domain: "document", action: "Let viewers ask the agent, or not (Share card, the owner)", tool: "viewers_agent" },
  { route: "PUT /api/files/<path>", domain: "document", action: "Add or replace a file of any kind (a drop on the files view, an HTTP client)", tool: "write" },
  { route: "GET /api/docs/<id>/versions", domain: "document", action: "Read the versions (editor's settings)", tool: "list_versions" },
  { route: "POST /api/docs/<id>/versions/<versionId>/restore", domain: "document", action: "Restore a version, or one file of it (editor's settings)", tool: "restore_version" },
  { route: "POST /api/publish", domain: "document", action: "Publish a folder of files as a document", tool: "create_document" },
  { route: "GET /d/<id>/api/agent", domain: "none", action: "The editor's agent panel", exempt: PANEL },
  { route: "POST /d/<id>/api/agent", domain: "none", action: "A message to the editor's agent", exempt: PANEL },
  { route: "POST /d/<id>/api/agent/model", domain: "none", action: "Switch the editor's agent's model", exempt: PANEL },
  { route: "POST /d/<id>/api/agent/abort", domain: "none", action: "Stop the editor's agent", exempt: PANEL },
  { route: "POST /d/<id>/api/agent/reset", domain: "none", action: "A new conversation with the editor's agent", exempt: PANEL },
  { route: "POST /d/<id>/api/agent/undo", domain: "none", action: "Undo the editor's agent's last change", exempt: PANEL },
  { route: "POST /d/<id>/api/agent/view", domain: "none", action: "The tab answers the agent's view_page and evaluate_page, and its page_console, page_network, page_events, page_inspect, page_click and page_key", exempt: PANEL },
  // The live page in the person's tab (shared/live-page.ts): no route of its own, but what the person does there.
  { route: "UI /d/<id>#page-click", domain: "document", action: "Click on the page as it runs (editor)", tool: "page_click" },
  { route: "UI /d/<id>#page-key", domain: "document", action: "Press a key on the page as it runs (editor)", tool: "page_key" },
  { route: "UI /d/<id>#devtools", domain: "document", action: "Read the page's console, requests and state, as the browser's developer tools show them (editor)", tool: "page_console" },

  // ------------------------------------------------------------ the API for outside agents
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

  // ------------------------------------------------------------ signing in (server/identity/accounts.ts)
  { route: "GET /auth/username", domain: "none", action: "A new account's first sign-in: choose a username", exempt: SIGN_IN },
  { route: "POST /auth/username", domain: "none", action: "A new account's first sign-in: make the account under the username", exempt: SIGN_IN },
  { route: "GET /auth/dev", domain: "none", action: "Local development's pretend provider signs someone in", exempt: "the dev server's" },

  // ------------------------------------------------------------ local development
  { route: "POST /__erga/migrate", domain: "none", action: "The dev server brings the local database up to date", exempt: "the dev server's" },
  { route: "POST /__erga/link", domain: "none", action: "The dev server links a file on disk to a document", exempt: "the dev server's" },
];

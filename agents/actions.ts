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

export const AGENT_ACTIONS: AgentAction[] = [
  // ------------------------------------------------------------ /admin: settings, change log, users, API keys
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
  { route: "GET /admin/auth", domain: "admin", action: "Read how people sign in, here and on the other server (Authentication)", tool: "get_sign_in_status" },
  { route: "GET /admin/auth/status", domain: "admin", action: "Read the same, as JSON, with live checks (Authentication)", tool: "get_sign_in_status" },
  { route: "POST /admin/auth do=save", domain: "admin", action: "Set a GitHub app's client ID and secret (Authentication)", exempt: SECRET },
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
  { route: "GET /api/source/branches", domain: "admin", action: "Read staging, main and the mirror (Ops)", tool: "list_branches" },
  { route: "POST /api/source/merge", domain: "admin", action: "Move main to staging: deploy production (Ops)", tool: "deploy_production" },
  { route: "POST /api/source/mirror", domain: "admin", action: "Update the GitHub mirror now (Ops)", tool: "sync_mirror" },
  { route: "POST /api/source/release", domain: "admin", action: "Cut a release: a version tag on main's head (Ops)", tool: "cut_release" },
  { route: "GET /api/deploys[?history=N]", domain: "admin", action: "Read the deploys (Ops)", tool: "list_deploys" },
  { route: "GET /api/deploys/<name>/history[?limit=N]", domain: "admin", action: "Read a target's past deploys (Ops)", tool: "list_deploys" },
  { route: "GET /api/deploys/<name>/log[?deploy=<id>]", domain: "admin", action: "Read a deploy's log (Ops)", tool: "deploy_log" },
  { route: "POST /api/deploys/<name>", domain: "admin", action: "Redeploy a target (Ops)", tool: "redeploy" },
  { route: "POST /api/deploys/<name> fresh=", domain: "admin", action: "Redeploy staging with a fresh copy of production's data ({fresh: true})", tool: "redeploy" },
  { route: "POST /api/deploys/<name>/rollback", domain: "admin", action: "Roll a target back to the version before its live deploy (Ops)", tool: "rollback" },
  // The release store (control/routes.ts, deploy/releases.ts): the channels edge and stable.
  { route: "GET /releases", domain: "admin", action: "Read the release store's channels (public; the Ops page marks them on the log)", tool: "list_releases" },
  { route: "GET /api/releases", domain: "admin", action: "Read both channels (Ops)", tool: "list_releases" },
  // The control Worker's Cloudflare credential (control/routes.ts, /install on ops.erga.dev): a consent in the browser.
  { route: "GET /api/install", domain: "admin", action: "Read whether the control Worker's Cloudflare credential is connected (GET /api/deploys says it too)", tool: "list_deploys" },
  { route: "POST /install/start", domain: "none", action: "Connect Cloudflare: consent on Cloudflare's own page, in the browser (/install)", exempt: "a credential: given on the page, through Cloudflare's consent screen, never in a conversation" },
  { route: "GET /install/callback", domain: "none", action: "Back from Cloudflare's consent page", exempt: "the consent's own return" },
  { route: "POST /install/disconnect", domain: "none", action: "Disconnect: revoke and forget the control Worker's Cloudflare credential (/install)", exempt: "a credential's revocation, on the page that holds it; an admin's deliberate act" },
  { route: "GET /api/health", domain: "none", action: "The app's health check", exempt: "the deploy pipeline's, after each deploy" },
  { route: "GET /api/events", domain: "none", action: "The dashboard's live updates", exempt: STREAM },
  { route: "GET /admin/deploys", domain: "none", action: "An old address of the dashboard", exempt: "a redirect" },
  { route: "GET /api/release", domain: "none", action: "An open page asks whether its code is still the server's (after a redeploy)", exempt: "the page's own check, not a person's action" },
  { route: "GET /api/deploys/version", domain: "none", action: "The release this server runs", exempt: "the deploy pipeline's, server to server" },
  { route: "GET /api/sign-in/status", domain: "none", action: "Another server reads this one's sign-in status", exempt: "server to server, with the shared secret (production's Authentication page shows staging's)" },
  { route: "POST /api/sign-in/github", domain: "none", action: "Production's Authentication page sets staging's GitHub app", exempt: "server to server, with the shared secret: the admin's action is POST /admin/auth" },
  { route: "POST /api/snapshot/docs[/import]", domain: "none", action: "Staging copies production's documents", exempt: "the deploy pipeline's, server to server" },

  // ------------------------------------------------------------ the homepage (server/home.ts: in the editor's settings, admins only)
  { route: "GET /api/docs/<id>/home", domain: "admin", action: "See whether a document is the homepage (editor's settings)", tool: "list_settings" },
  { route: "POST /api/docs/<id>/home", domain: "admin", action: "Make a document the homepage, or not (editor's settings)", tool: "set_setting" },
  { route: "POST /api/docs/<id>/home/deploy", domain: "admin", action: "Redeploy the homepage (editor's settings)", tool: "deploy_homepage" },

  // ------------------------------------------------------------ a document at the person's own domain (server/sites/api.ts: in the editor's settings)
  { route: "GET /api/docs/<id>/site", domain: "document", action: "See a document's custom domain, its deploys and your domains (editor's settings, Custom domain)", tool: "domain_status" },
  { route: "POST /api/docs/<id>/site", domain: "document", action: "Publish a document at a domain of yours (editor's settings, Custom domain)", tool: "publish_to_domain" },
  { route: "POST /api/docs/<id>/site/deploy", domain: "document", action: "Deploy to the domain now (editor's settings, Custom domain)", tool: "deploy_domain" },
  { route: "DELETE /api/docs/<id>/site", domain: "document", action: "Take the site down (editor's settings, Custom domain)", tool: "remove_domain" },
  { route: "POST /settings/cloudflare", domain: "document", action: "Connect your Cloudflare account with an API token (/settings)", exempt: SECRET },
  { route: "POST /settings/cloudflare/disconnect", domain: "document", action: "Disconnect your Cloudflare account (/settings)", tool: "disconnect_cloudflare" },
  { route: "GET /__erga/site/<host>/<path>", domain: "none", action: "A site on the pretend Cloudflare (local development)", exempt: "the dev server's" },

  // ------------------------------------------------------------ /settings: the person's agent tokens
  { route: "GET /settings", domain: "admin", action: "Read your agent tokens, Share with agent's too (/settings)", tool: "list_agent_tokens" },
  { route: "POST /tokens/revoke", domain: "admin", action: "Revoke an agent token, Share with agent's too (/settings)", tool: "revoke_agent_token" },
  { route: "POST /tokens/new", domain: "admin", action: "Make an agent token (/settings)", exempt: SECRET },
  { route: "POST /tokens/approve", domain: "admin", action: "Approve an agent's request for a token (/settings)", exempt: `${SECRET} (it hands a new token to an outside agent)` },

  // ------------------------------------------------------------ /deploy: Erga on your own Cloudflare account (the control Worker's page)
  { route: "GET /deploy/auth/cloudflare", domain: "none", action: "Authorize with Cloudflare: consent on Cloudflare's own page, in the browser (/deploy)", exempt: "a credential: given on the page, through Cloudflare's consent screen, never in a conversation" },
  { route: "GET /deploy/github/start", domain: "none", action: "Make the GitHub App on GitHub (the manifest flow, /deploy)", exempt: `${SECRET}: GitHub hands the App's secret to the session, through the browser` },
  { route: "GET /deploy/github/callback", domain: "none", action: "Back from GitHub with the App made (/deploy)", exempt: `${SECRET}: GitHub hands the App's secret to the session, through the browser` },
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

  // ------------------------------------------------------------ local development
  { route: "POST /__erga/migrate", domain: "none", action: "The dev server brings the local database up to date", exempt: "the dev server's" },
  { route: "POST /__erga/link", domain: "none", action: "The dev server links a file on disk to a document", exempt: "the dev server's" },
];

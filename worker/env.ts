import type { Deployer } from "./deployer";
import type { DocHost } from "./doc-host";
import type { Home } from "./home";

/** The Worker's bindings (cloudflare.config.ts); secrets are set with `cf workers secrets update`. */
export interface Env {
  /** One Durable Object per document, named by its id. */
  DOCS: DurableObjectNamespace<DocHost>;
  /** The homepage's deploys and its served snapshot: one Durable Object, named "home" (worker/home.ts). */
  HOME: DurableObjectNamespace<Home>;
  /** The server's database: users, settings and the directory of documents (directory.ts, users.ts, config.ts; migrations/). */
  DB: D1Database;
  /** The editor's own files (page.html as editor.html, page.js, style.css, fonts). */
  ASSETS: Fetcher;
  /**
   * The bootstrap admins, GitHub logins, comma-separated: always admins and
   * always allowed to sign in (users.ts). Everyone else who may sign in is a
   * row in the users table, added by an admin.
   */
  ADMINS: string;
  /**
   * The server settings the deploy fixes, a JSON object by key
   * (server.config.ts and ERGA_SERVER_CONFIG, via cloudflare.config.ts):
   * locked, so admins see them but can't change them (config.ts).
   */
  SERVER_CONFIG?: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Signs session cookies. */
  SESSION_SECRET: string;
  ANTHROPIC_API_KEY: string;
  /** The deploy page's sessions (/deploy, worker/deploy.ts): one Durable Object each, holding the Cloudflare token for the deploy only. */
  DEPLOYS: DurableObjectNamespace<Deployer>;
  /**
   * The deploy page's Cloudflare OAuth client (a public client, PKCE): with
   * one, /deploy offers "Authorize with Cloudflare"; without, the token link
   * only. CLOUDFLARE_OAUTH_SCOPES overrides the scopes it asks for.
   */
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_SCOPES?: string;
  /**
   * Where documents' pages run: one origin each under this domain
   * (<id>-<owner>.<PAGES_DOMAIN>, a wildcard route), erga-pages.dev when
   * unset; or PAGES_HOST, one host they all share (a server on workers.dev,
   * which has no wildcards; deploy/cloudflare.ts sets one or the other).
   */
  PAGES_DOMAIN?: string;
  PAGES_HOST?: string;
  /** Local development only: "1" has /deploy talk to a pretend Cloudflare (deploy/mock.ts), never the real one. */
  ERGA_DEPLOY_MOCK?: string;
  /** Local development only: sign in as this login without GitHub (honoured only on localhost). */
  DEV_LOGIN?: string;
  /** "script" for the test suite's scripted agent; unset on erga.dev. */
  ERGA_AGENT_MODEL?: string;
  /** Local development only: what the dev server (dev/plugin.ts) proves itself with to link files on disk. */
  ERGA_LINK_SECRET?: string;
  /** Local development only: a wait before every call to the database or a document, standing in for erga.dev's distances (tests/bench.ts --latency; worker/timing.ts). */
  ERGA_REMOTE_LATENCY_MS?: string;
  /** Local development only: how long after the homepage changes its next deploy runs (5 minutes by default; tests shorten it). */
  ERGA_HOME_DELAY_MS?: string;
  /** Local development only: how often the Worker checks for a newer homepage deploy (5 seconds by default; tests shorten it). */
  ERGA_HOME_RECHECK_MS?: string;
  /** Local development only: how long after an edit the room writes it (tests shorten it). */
  ERGA_WRITE_DELAY_MS?: string;
  /** Local development only: how long edits pause before a version is cut, and the longest burst of edits one version holds (tests shorten them; versions.ts). */
  ERGA_VERSION_IDLE_MS?: string;
  ERGA_VERSION_MAX_MS?: string;
}

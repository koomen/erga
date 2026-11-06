import type { BrowserBinding } from "./cdp";
import type { DocumentObject } from "./objects/document";
import type { Home } from "./objects/home";
import type { NewsHub } from "./objects/news";
import type { OwnStorage } from "./objects/own";
import type { PersonAgent } from "./objects/person-agent";

/** The Worker's bindings (cloudflare.config.ts); secrets are set with `cf workers secrets update`. */
export interface Env {
  /** One Durable Object per document, named by its id. */
  DOCUMENTS: DurableObjectNamespace<DocumentObject>;
  /** The homepage's deploys and its served snapshot: one Durable Object, named "home". */
  HOME: DurableObjectNamespace<Home>;
  /** Live pages' hub (server/news/): the open pages' sockets and which rows changed. One Durable Object, "news". */
  NEWS: DurableObjectNamespace<NewsHub>;
  /** The server's own small storage (server/platform.ts `own`): one Durable Object, "own". */
  OWN: DurableObjectNamespace<OwnStorage>;
  /** Each admin's agent, its conversation and panel: one Durable Object, "admin". */
  /** Each person's agent (agents/person/): one Durable Object per person, named by their login. */
  AGENTS: DurableObjectNamespace<PersonAgent>;
  /**
   * The server's key (a Worker secret, named for the factory it once served): it encrypts the API keys and sign-in
   * secrets admins store. Without it, a hosted server can't store them.
   */
  FACTORY_KEY?: string;
  /** Cloudflare Browser Rendering: the browser view_page renders pages in (cloudflare/render.ts). Local development uses the dev server's Chrome. */
  BROWSER?: BrowserBinding;
  /** Starts the sandbox Workers a page's own API runs in (cloudflare/sandbox.ts). */
  LOADER?: WorkerLoader;
  /** The server's database: users, settings and the directory of documents. */
  DB: D1Database;
  /** Documents' blobs, their files that aren't text (cloudflare/blobs.ts): the target's own bucket (FILES on erga is erga-files). */
  FILES?: R2Bucket;
  /** The edge's cache where the host's Cache API keeps nothing (celld: deploy/celld/project.ts); unbound on Cloudflare. */
  EDGE_CACHE?: KVNamespace;
  /** The editor's own files (client/editor.html as editor.html, page.js, client/style.css, fonts). */
  ASSETS: Fetcher;
  /**
   * The server settings the deploy fixes, a JSON object by key
   * (deploy/locked-settings.ts and ERGA_SERVER_CONFIG, via cloudflare.config.ts):
   * locked, so admins see them but can't change them.
   */
  SERVER_CONFIG?: string;
  /**
   * Defaults for the server settings, a JSON object by key (an instance's preset: deploy/own/plan.ts PRESETS):
   * the admins can still change them, unlike SERVER_CONFIG's.
   */
  SERVER_DEFAULTS?: string;
  /** Sign-in's GitHub OAuth app: the deploy's values; an admin's on /admin/auth win while set. */
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Sign-in's Google OAuth client: the deploy's values; an admin's on /admin/auth win while set. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Signs session cookies. */
  SESSION_SECRET: string;
  /** The Anthropic key, a Worker secret: the fallback while an admin has stored none on /admin (server/directory/api-keys.ts; read by agents/models.ts). */
  ANTHROPIC_API_KEY: string;
  /**
   * Where documents' pages run: one origin each under this domain
   * (<id>-<owner>.<PAGES_DOMAIN>, a wildcard route); or PAGES_HOST, one host they all share (a server on workers.dev,
   * which has no wildcards; deploy/pipeline/pipeline.ts sets one or the other).
   */
  PAGES_DOMAIN?: string;
  PAGES_HOST?: string;
  /**
   * Which deploy target this server is, as its deploy says: "production" on a primary, "staging" on a staging
   * instance (for admins only: server/identity/admins-only.ts), empty on any other (local development unless
   * ERGA_DEPLOY_TARGET).
   */
  DEPLOY_TARGET?: string;
  /** A staging instance's primary, https://<host> (the deploy sets it): its blobs come from there, and its admins-only page links to it. */
  SNAPSHOT_FROM?: string;
  /** The release this server runs (the commit, 12 characters; the pipeline sets it). GET /api/deploys/version answers it. */
  ERGA_VERSION?: string;
  /**
   * The facts a deploy from a machine needs to deploy this server again, as JSON (the pipeline sets it:
   * deploy/pipeline/account.ts `deployFacts`): the Cloudflare account, the Worker, the database, the app's address and
   * the pages'. GET /api/ops (server/api.ts) answers it, to an admin's ops token only.
   */
  ERGA_DEPLOY?: string;
  /** A secret, the same on production and staging: production's read-only snapshot endpoint takes it, and staging's import. */
  SNAPSHOT_TOKEN?: string;
  /** "1" on staging: the server takes snapshots in (never on production). */
  SNAPSHOT_IMPORT?: string;
  /** A Worker secret: a GitHub token that may open issues in the setting feedback_repository, for the feedback people send (server/feedback.ts). */
  GITHUB_ISSUES_TOKEN?: string;
  /** Local development only: sign in as this login without GitHub (honoured only on localhost). */
  DEV_LOGIN?: string;

  /** "script" for the test suite's scripted agent; unset on a deployed server. */
  ERGA_AGENT_MODEL?: string;
  /** Local development only: what the dev server proves itself with to link files on disk. */
  ERGA_LINK_SECRET?: string;
  /** Local development only: a wait before every call to the database or a document, standing in for a deployed server's distances (e2e/bench/run.ts --latency; cloudflare/timing.ts). */
  ERGA_REMOTE_LATENCY_MS?: string;
  /** Local development only (the tests): a stand-in for github.com that sign-in's live check asks. */
  ERGA_GITHUB_ORIGIN?: string;
  /** Local development only: a stand-in for Google's sign-in endpoints. */
  ERGA_GOOGLE_ORIGIN?: string;
  /** On celld (deploy/celld/aws.ts): the DevTools address of a headless Chrome on the same machine, for view_page (cloudflare/browser.ts). */
  ERGA_CHROME?: string;
  /** Local development only: the dev server's address, where its own headless Chrome is (cloudflare/browser.ts). */
  ERGA_DEV_ORIGIN?: string;
  /** Local development only: how often the Worker checks for a newer homepage deploy (5 seconds by default; tests shorten it). */
  ERGA_HOME_RECHECK_MS?: string;
  /** Local development only: how long after an edit the room writes it (tests shorten it). */
  ERGA_WRITE_DELAY_MS?: string;
  /** Local development only: how long edits pause before a version is cut, and the longest burst of edits one version holds (tests shorten them; document/versions.ts). */
  ERGA_VERSION_IDLE_MS?: string;
  ERGA_VERSION_MAX_MS?: string;
  /** Local development only: how long a document stays open with nothing done before it closes, so its object may sleep (document/document.ts). */
  ERGA_ROOM_IDLE_MS?: string;
}

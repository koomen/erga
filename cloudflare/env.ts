import type { ArtifactsBinding } from "./artifacts";
import type { AdminAgentHost } from "./admin-agent-host";
import type { Deployer } from "./deploy-session";
import type { DocHost } from "./document-object";
import type { SourceHost } from "./source-host";
import type { Pipeline } from "./pipeline";
import type { Home } from "./home";
import type { SiteHost } from "./site-host";

/** The Worker's bindings (cloudflare.config.ts); secrets are set with `cf workers secrets update`. */
export interface Env {
  /** One Durable Object per document, named by its id. */
  DOCS: DurableObjectNamespace<DocHost>;
  /** The homepage's deploys and its served snapshot: one Durable Object, named "home". */
  HOME: DurableObjectNamespace<Home>;
  /** Each admin's agent, its conversation and panel: one Durable Object, "admin". */
  ADMIN_AGENT: DurableObjectNamespace<AdminAgentHost>;
  /** Each document's site on its person's Cloudflare account, its deploys: one Durable Object per document that has one, named by its id. */
  SITES: DurableObjectNamespace<SiteHost>;
  /**
   * The server's key (a Worker secret, named for the factory it once served): it encrypts the API keys and sign-in
   * secrets admins store. Without it, a hosted server can't store them.
   */
  FACTORY_KEY?: string;
  /** The server's database: users, settings and the directory of documents. */
  DB: D1Database;
  /** The editor's own files (client/editor.html as editor.html, page.js, client/style.css, fonts). */
  ASSETS: Fetcher;
  /**
   * The bootstrap admins, GitHub logins, comma-separated: always admins and
   * always allowed to sign in. Everyone else who may sign in is a
   * row in the users table, added by an admin.
   */
  ADMINS: string;
  /**
   * The server settings the deploy fixes, a JSON object by key
   * (deploy/locked-settings.ts and ERGA_SERVER_CONFIG, via cloudflare.config.ts):
   * locked, so admins see them but can't change them.
   */
  SERVER_CONFIG?: string;
  /** Sign-in's GitHub OAuth app: the deploy's values; an admin's on /admin/auth win while set. */
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Signs session cookies. */
  SESSION_SECRET: string;
  /** The Anthropic key, a Worker secret: the fallback while an admin has stored none on /admin (server/api-keys.ts; read through withKeys). */
  ANTHROPIC_API_KEY: string;
  /** The OpenAI key, a Worker secret: the same fallback, for OpenAI's models. */
  OPENAI_API_KEY?: string;
  /** The deploy page's sessions (/deploy, cloudflare/deploy-routes.ts): one Durable Object each, holding the Cloudflare token for the deploy only. */
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
   * which has no wildcards; deploy/pipeline.ts sets one or the other).
   */
  PAGES_DOMAIN?: string;
  PAGES_HOST?: string;
  /** Branch deploys: one object, "deploys", per server. */
  PIPELINE: DurableObjectNamespace<Pipeline>;
  /**
   * Which of Erga's own deploy targets this server is:
   * "production" on erga.dev, "staging" on staging.erga.dev, empty on any
   * other (a /deploy server, local development unless ERGA_DEPLOY_TARGET).
   */
  DEPLOY_TARGET?: string;
  /** The release this server runs (the commit, 12 characters; the pipeline sets it). GET /api/deploys/version answers it. */
  ERGA_VERSION?: string;
  /** The Cloudflare account the server is in (the pipeline sets it): where it deploys itself. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** A secret: the API token the server deploys itself with. Branch deploys run only when it's set. */
  CLOUDFLARE_DEPLOY_TOKEN?: string;
  /** A secret, the same on production and staging: production's read-only snapshot endpoint takes it, and staging's import. */
  SNAPSHOT_TOKEN?: string;
  /** "1" on staging: the server takes snapshots in (never on production). */
  SNAPSHOT_IMPORT?: string;
  /** A secret, the same on the servers that tell each other of branch moves (production tells staging). */
  DEPLOY_HOOK_SECRET?: string;
  /** The builder Worker, bound by the pipeline on the targets it deploys. */
  BUILDER?: Fetcher;
  /** Local development only: "1" has /deploy and the branch deploys talk to a pretend Cloudflare, never the real one. */
  ERGA_DEPLOY_MOCK?: string;
  /** Local development only: how long after a publish a document's site deploys (cloudflare/site-host.ts; tests shorten it). */
  ERGA_SITE_DELAY_MS?: string;
  /** Local development only: sign in as this login without GitHub (honoured only on localhost). */
  DEV_LOGIN?: string;

  /** "script" for the test suite's scripted agent; unset on erga.dev. */
  ERGA_AGENT_MODEL?: string;
  /** Local development only: what the dev server proves itself with to link files on disk. */
  ERGA_LINK_SECRET?: string;
  /** Local development only: a wait before every call to the database or a document, standing in for erga.dev's distances (e2e/load-bench.ts --latency; cloudflare/timing.ts). */
  ERGA_REMOTE_LATENCY_MS?: string;
  /** Local development only (the tests): a stand-in for github.com that sign-in's live check asks. */
  ERGA_GITHUB_ORIGIN?: string;
  /** Local development only (the tests): the other deploy target's server, in place of https://<its host>. */
  ERGA_PEER_ORIGIN?: string;
  /** Erga's own repository: one Durable Object, "erga". */
  SOURCE: DurableObjectNamespace<SourceHost>;
  /**
   * Cloudflare Artifacts, where Erga's repository is:
   * bound only when the deploy names a namespace (ERGA_ARTIFACTS_NAMESPACE).
   */
  ARTIFACTS?: ArtifactsBinding;
  /** The GitHub mirror: where it is (github.com/koomen/erga by default) and a token that may push there (a secret). No token, no mirror. */
  GITHUB_MIRROR_URL?: string;
  GITHUB_MIRROR_TOKEN?: string;
  /** Local development only: the dev server's address, where the stand-ins for Artifacts and GitHub are. */
  ERGA_DEV_ORIGIN?: string;
  /** Local development only: how long after the homepage changes its next deploy runs (5 minutes by default; tests shorten it). */
  ERGA_HOME_DELAY_MS?: string;
  /** Local development only: how often the Worker checks for a newer homepage deploy (5 seconds by default; tests shorten it). */
  ERGA_HOME_RECHECK_MS?: string;
  /** Local development only: how long after an edit the room writes it (tests shorten it). */
  ERGA_WRITE_DELAY_MS?: string;
  /** Local development only: how long edits pause before a version is cut, and the longest burst of edits one version holds (tests shorten them; document/versions.ts). */
  ERGA_VERSION_IDLE_MS?: string;
  ERGA_VERSION_MAX_MS?: string;
}

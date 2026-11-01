import type { ArtifactsBinding } from "../control/cloudflare";
import type { Deployer } from "../control/install/session";
import type { DocumentObject } from "./objects/document";
import type { SourceHost } from "../control/source/source-host";
import type { Pipeline } from "../control/deploys/pipeline-object";
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
  /** Each person's conversations with the document agent: one Durable Object per person, named by their login. */
  AGENTS: DurableObjectNamespace<PersonAgent>;
  /**
   * The server's key (a Worker secret, named for the factory it once served): it encrypts the API keys and sign-in
   * secrets admins store. Without it, a hosted server can't store them.
   */
  FACTORY_KEY?: string;
  /** The server's database: users, settings and the directory of documents. */
  DB: D1Database;
  /** Documents' blobs, their files that aren't text (cloudflare/blobs.ts): the target's own bucket (FILES on erga is erga-files). */
  FILES?: R2Bucket;
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
  /** Sign-in's Google OAuth client: the deploy's values; an admin's on /admin/auth win while set. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Signs session cookies. */
  SESSION_SECRET: string;
  /** The Anthropic key, a Worker secret: the fallback while an admin has stored none on /admin (server/directory/api-keys.ts; read by agents/models.ts). */
  ANTHROPIC_API_KEY: string;
  /** The deploy page's sessions (/deploy, control/install/routes.ts): one Durable Object each, holding the Cloudflare token for the deploy only. */
  DEPLOYS: DurableObjectNamespace<Deployer>;
  /**
   * The deploy page's Cloudflare OAuth client (a public client, PKCE): with
   * one, /deploy offers "Authorize with Cloudflare"; without, the token link
   * only. CLOUDFLARE_OAUTH_SCOPES overrides the scopes it asks for.
   */
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_SCOPES?: string;
  /** The same client's secret, if it was made confidential (a public PKCE client has none). */
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  /**
   * Where documents' pages run: one origin each under this domain
   * (<id>-<owner>.<PAGES_DOMAIN>, a wildcard route), production's pages domain (deploy/targets.json) when
   * unset; or PAGES_HOST, one host they all share (a server on workers.dev,
   * which has no wildcards; control/deploys/pipeline.ts sets one or the other).
   */
  PAGES_DOMAIN?: string;
  PAGES_HOST?: string;
  /** Local development only: the deploys' object ("deploys"), hosted by the app in place of the control Worker. */
  PIPELINE?: DurableObjectNamespace<Pipeline>;
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
  /** A secret, the same on production and staging: production's read-only snapshot endpoint takes it, and staging's import. */
  SNAPSHOT_TOKEN?: string;
  /** "1" on staging: the server takes snapshots in (never on production). */
  SNAPSHOT_IMPORT?: string;
  /** The control Worker (control/index.ts), bound on the app Workers the pipeline deploys: the app's way to the Ops page's API, for its admin agent. */
  CONTROL?: Fetcher;
  /** Where the control Worker is (https://ops.erga.dev), on an app Worker the pipeline deployed; the app sends its admins there. */
  CONTROL_URL?: string;
  /** An install's control Worker only (control/install/install.ts): erga.dev's control Worker, whose store it upgrades from and whose OAuth callback relays its consent; and its one target, as JSON (InstallSpec). */
  UPSTREAM?: string;
  INSTALL?: string;
  /** An install's control Worker only: the channel it follows (stable unless "edge"). */
  CHANNEL?: string;
  /** An install's control Worker only (a secret): what it reaches its fork's repository and builds at upstream with (control/install/forks.ts). */
  FORK_SECRET?: string;
  CF_VERSION_METADATA?: { id?: string };
  /** Local development only: "1" has /deploy and the branch deploys talk to a pretend Cloudflare, never the real one. */
  ERGA_DEPLOY_MOCK?: string;
  /** Local development only: sign in as this login without GitHub (honoured only on localhost). */
  DEV_LOGIN?: string;

  /** "script" for the test suite's scripted agent; unset on erga.dev. */
  ERGA_AGENT_MODEL?: string;
  /** Local development only: what the dev server proves itself with to link files on disk. */
  ERGA_LINK_SECRET?: string;
  /** Local development only: a wait before every call to the database or a document, standing in for erga.dev's distances (e2e/bench/run.ts --latency; cloudflare/timing.ts). */
  ERGA_REMOTE_LATENCY_MS?: string;
  /** Local development only (the tests): a stand-in for github.com that sign-in's live check asks. */
  ERGA_GITHUB_ORIGIN?: string;
  /** Local development only: a stand-in for Google's sign-in endpoints. */
  ERGA_GOOGLE_ORIGIN?: string;
  /** Local development only: the repository's object ("erga"), hosted by the app in place of the control Worker. */
  SOURCE?: DurableObjectNamespace<SourceHost>;
  /**
   * Cloudflare Artifacts, where Erga's repository is:
   * bound only when the deploy names a namespace (ERGA_ARTIFACTS_NAMESPACE).
   */
  ARTIFACTS?: ArtifactsBinding;
  /**
   * Erga's GitHub App (control/source/github.ts; control/cloudflare.ts), on a control Worker: its id, slug and client
   * id; and on erga.dev's, its secrets: the client secret (sign-in's code exchange), the private key (PKCS#8 PEM:
   * installation tokens) and the webhook secret. An install's control Worker has the public parts only.
   */
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  /** Erga's Google OAuth client's id, for installs (their sign-in with Google goes through erga.dev's control Worker). */
  GOOGLE_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  /** An install's app Worker: erga.dev's control Worker, whose GitHub callback relays its sign-in (the App's one callback). */
  SIGN_IN_RELAY?: string;
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
  /** Local development only: how long a document stays open with nothing done before it closes, so its object may sleep (document/document.ts). */
  ERGA_ROOM_IDLE_MS?: string;
}

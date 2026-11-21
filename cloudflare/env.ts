import type { BrowserBinding } from "./cdp";
import type { DocumentObject } from "./objects/document";
import type { Home } from "./objects/site";
import type { NewsHub } from "./objects/news";
import type { OwnStorage } from "./objects/own";
import type { PersonAgent } from "./objects/person-agent";

/** The Worker's bindings (cloudflare.config.ts); secrets are set with `cf workers secrets update`. */
export interface Env {
  /** One Durable Object per document, named by its id. */
  DOCUMENTS: DurableObjectNamespace<DocumentObject>;
  /** Each domain's publishing and its served snapshot (objects/site.ts): one Durable Object for each domain. */
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
  SECRETS_KEY?: string;
  /** Cloudflare Browser Rendering: the browser view_page renders pages in (cloudflare/render.ts). Local development uses the dev server's Chrome. */
  BROWSER?: BrowserBinding;
  /** Starts the sandbox Workers a page's own API runs in (cloudflare/sandbox.ts). */
  LOADER?: WorkerLoader;
  /** The server's database: users, settings and the directory of documents. */
  DB: D1Database;
  /** Documents' blobs, their files that aren't text (cloudflare/blobs.ts): the target's own bucket (FILES on erga is erga-files). */
  FILES?: R2Bucket;
  /** The edge's cache where the host's Cache API keeps nothing (celld: deploy/deployer/celld.ts); unbound on Cloudflare. */
  EDGE_CACHE?: KVNamespace;
  /** The editor's own files (client/editor.html as editor.html, page.js, client/style.css, fonts). */
  ASSETS: Fetcher;
  /**
   * The server settings the deploy fixes, a JSON object by key (the instance's entry's vars in .erga/config.json;
   * locally, ERGA_SERVER_CONFIG): locked, so admins see them but can't change them.
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
  /**
   * The server's secret: it signs what the server hands out and trusts when it comes back (server/signed.ts), and the
   * key of the gate inside this Worker comes from it (server/identity/caller.ts).
   */
  SESSION_SECRET: string;
  /** The Anthropic key, a Worker secret: the fallback while an admin has stored none on /admin/agents (server/directory/api-keys.ts; read by agents/models.ts). */
  ANTHROPIC_API_KEY: string;
  /**
   * Where documents' pages run: one origin each under this domain
   * (<id>-<owner>.<PAGES_DOMAIN>, a wildcard route); or PAGES_HOST, one host they all share (a server on workers.dev,
   * which has no wildcards; deploy/pipeline/pipeline.ts sets one or the other).
   */
  PAGES_DOMAIN?: string;
  PAGES_HOST?: string;
  /** The release this server runs (the commit, 12 characters; the pipeline sets it). Its health report says it (server/health.ts). */
  ERGA_VERSION?: string;
  /**
   * Which upload of the Worker this is: a name that the deploy gives each upload (deploy/deployer/worker-form.ts; on
   * AWS the machine gives it to each load: deploy/aws/machine.ts, deployScript). The health route says it, so the
   * deploy knows that the answer is the new upload's, and not the version before's (Cloudflare gives a new version to
   * its machines in some seconds, and two uploads can be the same release).
   */
  ERGA_UPLOAD?: string;
  /**
   * The facts a deploy from a machine needs to deploy this server again, as JSON (the pipeline sets it:
   * deploy/deployer/cloudflare.ts `deployFacts`): the Cloudflare account, the Worker, the database, the app's address and
   * the pages'. The server reads its custom domains and its app's host from it; `bun erga register` reads it from
   * Cloudflare, in the bindings of the Worker's version (deploy/cli/running.ts).
   */
  ERGA_DEPLOY?: string;
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
  /**
   * A gate in front of the server (server/identity/mode.ts; on AWS: gate/mounts/cloudfront.ts): the key that it sends
   * with each request, a secret of 32 characters or more that the deploy gives both. Any value: this Worker runs no
   * gate of its own, trusts the caller that the gate names, and refuses every request without the key.
   */
  GATE_KEY?: string;
  /**
   * Single sign-on with the gate inside this Worker (on Cloudflare: gate/sso.ts), as JSON: Cloudflare Access in front
   * of the app's host ({"access": {"team", "aud"}}), or an OIDC issuer ({"oidc": {"issuer", "authorize", "token",
   * "client"}}). Any value: only the organization's people come in.
   */
  SSO?: string;
  /** With an OIDC issuer in SSO: the client's secret there (a secret). */
  SSO_CLIENT_SECRET?: string;
  /**
   * The setting of the sign-in at a proxy in front, from before the gate. The server reads nothing from it: a server
   * that still has it, and no gate, refuses every request with an error that says so (server/identity/mode.ts).
   */
  PROXY_SIGN_IN?: string;
  /** On celld (deploy/aws/machine.ts): the DevTools address of a headless Chrome on the same machine, for view_page (cloudflare/browser.ts). */
  ERGA_CHROME?: string;
  /**
   * Local development's tests: origins of private addresses that the server's own browser may ask besides Erga's own
   * (cloudflare/render.ts), separated by commas: a test's "other site" on 127.0.0.1.
   */
  ERGA_RENDER_ALLOW?: string;
  /** Local development only: the dev server's address, where its own headless Chrome is (cloudflare/browser.ts). */
  ERGA_DEV_ORIGIN?: string;
  /** Local development only: how often the Worker checks for a newer publish of a site (5 seconds by default; tests shorten it). */
  ERGA_SITE_RECHECK_MS?: string;
  /** Local development only: how long after an edit the room writes it (tests shorten it). */
  ERGA_WRITE_DELAY_MS?: string;
  /** Local development only: how long edits pause before a version is cut, and the longest burst of edits one version holds (tests shorten them; document/history/versions.ts). */
  ERGA_VERSION_IDLE_MS?: string;
  ERGA_VERSION_MAX_MS?: string;
  /** Local development only: how long a document stays open with nothing done before it closes, so its object may sleep (document/life/document.ts). */
  ERGA_ROOM_IDLE_MS?: string;
}

// The control Worker's bindings, and what control's code may count on where
// either Worker runs it.
//
// The control Worker (control/index.ts) has only its own bindings
// (control/wrangler.jsonc, with deploy/targets.ts controlWrangler's names and
// vars): ControlEnv. Its objects run in the app Worker too: in local
// development the app hosts Pipeline and SourceHost (cloudflare/dev-entry.ts)
// and serves /deploy with Deployer (cloudflare/index.ts). Code that runs there
// takes a HostEnv: any binding of the control Worker may be missing, and the
// app adds what local development uses. The app's Env (cloudflare/env.ts) is
// a HostEnv: cloudflare/dev-entry.ts checks it.

import type { ArtifactsBinding } from "./cloudflare";
import type { Builder } from "./builder/worker";
import type { Pipeline } from "./deploys/pipeline-object";
import type { Deployer } from "./install/session";
import type { SourceHost } from "./source/source-host";

/** The control Worker's bindings (control/wrangler.jsonc, with deploy/targets.json's names and vars); its secrets are set by deploy/setup.ts --control. */
export interface ControlEnv {
  /** Production's database: users (who is an admin) and agent tokens. Read, and the change log written (a production deploy). */
  DB: D1Database;
  /** Erga's repository in Cloudflare Artifacts (the namespace deploy/targets.json names). */
  ARTIFACTS?: ArtifactsBinding;
  /** The deploys, one object ("deploys"); the repository, one object ("erga"); the build containers, one per build. */
  PIPELINE: DurableObjectNamespace<Pipeline>;
  SOURCE: DurableObjectNamespace<SourceHost>;
  BUILDS: DurableObjectNamespace<Builder>;
  /** The release store (control/deploys/releases.ts): an R2 bucket, erga-releases, made by deploy/setup.ts. An install's control Worker has none. */
  RELEASES?: R2Bucket;
  /** The install sessions of /deploy (control/install/session.ts), one object each. */
  DEPLOYS: DurableObjectNamespace<Deployer>;
  /** An install's control Worker only: erga.dev's control Worker (the store, the consent relay), and its own target (control/install/install.ts InstallSpec). */
  UPSTREAM?: string;
  INSTALL?: string;
  /** An install's control Worker only: the channel it follows (stable unless "edge"). */
  CHANNEL?: string;
  /** An install's control Worker only (a secret): what it reaches its fork's repository and builds at upstream with (control/install/forks.ts). */
  FORK_SECRET?: string;
  /** This Worker's version id: the release cache's key. */
  CF_VERSION_METADATA?: { id?: string };
  /** The release this Worker is (the commit): set by its own deploy (control/deploys/control-worker.ts), what /api/health answers; none after a wrangler deploy. */
  ERGA_VERSION?: string;
  /** The bootstrap admins (deploy/targets.json), the account, where the app is. */
  ADMINS: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  /** The app's address (https://erga.dev): links back, and the stylesheet the Ops page uses. */
  APP_URL: string;
  /**
   * Erga's GitHub App (control/cloudflare.ts): sign-in here (its user authorization, callback
   * https://ops.erga.dev/auth/github/callback), Connect GitHub on the Ops page, and the webhook. erga.dev's control Worker
   * has its secrets (the client secret, the private key as PKCS#8 PEM, the webhook secret: set from files, never printed);
   * an install's has the public parts, and goes through erga.dev (UPSTREAM) for the rest.
   */
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  /** Erga's Google OAuth client: installs sign in with Google through it (the secret only on erga.dev's control Worker). */
  GOOGLE_APP_CLIENT_ID?: string;
  GOOGLE_APP_CLIENT_SECRET?: string;
  /** Signs this Worker's own session cookies (not production's secret). */
  SESSION_SECRET: string;
  /** Erga's OAuth client on Cloudflare ("Erga", public, PKCE: control/deploys/credential.ts): its id, and a secret only if it was made confidential. */
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  /** The token staging's data copy goes through. */
  SNAPSHOT_TOKEN?: string;
}

/**
 * What the app Worker adds where it runs control's code (local development, and its /deploy there): never on the
 * control Worker.
 */
interface AppHosted {
  /** The app's own files: the dev server's release (deploy/release.ts), which the mock builder and /deploy stand in with. */
  ASSETS?: Fetcher;
  /** The scopes /deploy's consent asks for, in place of control/deploys/cloudflare-api.ts's. */
  CLOUDFLARE_OAUTH_SCOPES?: string;
  /** "1": the mock Cloudflare (dev/mock-cloudflare.ts), consent included. */
  ERGA_DEPLOY_MOCK?: string;
  /** The dev server's address, where the stand-ins for Artifacts and GitHub are. */
  ERGA_DEV_ORIGIN?: string;
  /** The pretend GitHub (dev/github-mock.ts), at the dev server. */
  ERGA_GITHUB_ORIGIN?: string;
  /** What the dev server proves itself with: with it and no Artifacts, the repository is the dev server's (control/cloudflare.ts). */
  ERGA_LINK_SECRET?: string;
}

/**
 * The bindings of a Worker that runs control's objects and routes: the control Worker, or the app (AppHosted). Both
 * have the database, the session secret, the admins and the install sessions; any other binding may be missing.
 */
export type HostEnv = Partial<ControlEnv> & Pick<ControlEnv, "DB" | "SESSION_SECRET" | "ADMINS" | "DEPLOYS"> & AppHosted;

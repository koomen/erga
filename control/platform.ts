// The control Worker's Platform: what the shared code (sign-in, sessions,
// tokens, the Ops page, the deploys' API) needs from where it runs, built
// from the control Worker's bindings (control/wrangler.jsonc). It is the
// app's Platform (server/platform.ts) with only the parts the control Worker
// has: production's database (for who is an admin, and the admin-scope
// tokens), its own session secret and GitHub app, the repository and the
// pipeline. Nothing of documents, pages or the homepage.
//
// Admin tokens are production's: made on erga.dev/tokens with production's
// secret, kept in its database by their hash. The control Worker reads that
// database itself (not a copy), so a token whose hash is there is good
// (Tokens, byHash).

import type { ArtifactsBinding } from "./cloudflare/artifacts";
import { githubAppOf } from "./cloudflare/github-app";
import { directoryOf, sqlOn } from "../cloudflare/d1";
import type { Env } from "../cloudflare/env";
import type { Pipeline } from "./deploys/pipeline-object";
import type { SourceHost } from "./source/source-host";
import { sourceService } from "./source/service";
import { TARGETS, type TargetName } from "../deploy/targets";
import { sessionOf, Tokens } from "../server/identity/index.ts";
import type { Platform } from "../server/platform";
import type { Builder } from "./builder/worker";
import type { Deployer } from "./install/session";

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
   * Erga's GitHub App (control/cloudflare/github-app.ts): sign-in here (its user authorization, callback
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
  /** Local development only: the pretend GitHub (dev/github-mock.ts), at the dev server. */
  ERGA_GITHUB_ORIGIN?: string;
  /** Signs this Worker's own session cookies (not production's secret). */
  SESSION_SECRET: string;
  /** Erga's OAuth client on Cloudflare ("Erga", public, PKCE: control/deploys/credential.ts): its id, and a secret only if it was made confidential. */
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  /** The token staging's data copy goes through. */
  SNAPSHOT_TOKEN?: string;
  /** Local development only: the mock Cloudflare, consent included. */
  ERGA_DEPLOY_MOCK?: string;
}

/** The Platform the shared code runs on, in the control Worker. */
export function controlPlatform(env: ControlEnv, ctx: ExecutionContext): Platform {
  // The shared modules read only the bindings named here; the rest of the app's Env they never touch.
  const e = env as unknown as Env;
  const directory = directoryOf(e);
  const app = githubAppOf(env);
  const p = {
    directory,
    tokens: new Tokens(sqlOn(env.DB), env.SESSION_SECRET, directory, true),
    secret: env.SESSION_SECRET,
    sessionOf: (request: Request) => sessionOf(p, request),
    dev: () => false,
    pagesDomain: () => "",
    pagesShared: () => null,
    adminsOnly: false,
    // Sign-in with Erga's GitHub App; on an install's control Worker, through erga.dev's callback (the relay).
    signIn: {
      app: { clientId: app?.clientId ?? "", secret: app?.clientSecret ?? "" },
      github: app?.www ?? "https://github.com",
      relay: env.UPSTREAM?.trim().replace(/\/+$/, "") || null,
      devLogin: null,
      encryptionKey: null,
    },
    // No values set on /admin/auth here: sign-in uses the deploy's app, always.
    own: { get: async () => undefined, put: async () => {}, delete: async () => {} },
    source: sourceService(e),
    deploys: env.PIPELINE.getByName("deploys"),
    deploy: { target: null, version: env.CF_VERSION_METADATA?.id ?? null, hookSecret: "", originOf: (t: TargetName) => `https://${TARGETS[t].host}` },
    edge: { cache: null, background: (work: Promise<unknown>) => ctx.waitUntil(work), homeRecheckMs: 0 },
    assets: async () => new Response("Not found", { status: 404 }),
    templates: {},
  } as unknown as Platform;
  return p;
}


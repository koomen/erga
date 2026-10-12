// The control Worker's Platform: what the shared code (sign-in, sessions,
// tokens, the Source page, the deploys' API) needs from where it runs, built
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

import type { ArtifactsBinding } from "../cloudflare/artifacts";
import { adminsOf, directoryOf, sqlOn } from "../cloudflare/d1";
import type { Env } from "../cloudflare/env";
import type { Pipeline } from "../cloudflare/pipeline";
import type { SourceHost } from "../cloudflare/objects/source";
import { sourceService } from "../cloudflare/source";
import { TARGETS, type TargetName } from "../deploy/targets";
import { sessionOf, Tokens } from "../server/identity/index.ts";
import type { Platform } from "../server/platform";
import type { Builder } from "./builder/worker";

/** The control Worker's bindings (control/wrangler.jsonc); its secrets are set by deploy/setup.ts --control. */
export interface ControlEnv {
  /** Production's database: users (who is an admin) and agent tokens. Read, and the change log written (a production deploy). */
  DB: D1Database;
  /** Erga's repository in Cloudflare Artifacts (the namespace deploy/targets.json names). */
  ARTIFACTS?: ArtifactsBinding;
  /** The deploys, one object ("deploys"); the repository, one object ("erga"); the build containers, one per build. */
  PIPELINE: DurableObjectNamespace<Pipeline>;
  SOURCE: DurableObjectNamespace<SourceHost>;
  BUILDS: DurableObjectNamespace<Builder>;
  /** This Worker's version id: the release cache's key. */
  CF_VERSION_METADATA?: { id?: string };
  /** The release this Worker is (the commit): set by its own deploy (deploy/control.ts), what /api/health answers; none after a wrangler deploy. */
  ERGA_VERSION?: string;
  /** The bootstrap admins (deploy/targets.json), the account, where the app is. */
  ADMINS: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  /** The app's address (https://erga.dev): links back, and the stylesheet the Source page uses. */
  APP_URL: string;
  /** Sign-in: this Worker's own GitHub OAuth app (callback https://<its host>/auth/github/callback). */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Signs this Worker's own session cookies (not production's secret). */
  SESSION_SECRET: string;
  /** Erga's OAuth client on Cloudflare ("Erga", public, PKCE: deploy/credential.ts): its id, and a secret only if it was made confidential. */
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  /** The token staging's data copy goes through. */
  SNAPSHOT_TOKEN?: string;
  /** Local development only: the mock Cloudflare, consent included. */
  ERGA_DEPLOY_MOCK?: string;
  /** The GitHub mirror: where, and a token that may push there. */
  GITHUB_MIRROR_URL?: string;
  GITHUB_MIRROR_TOKEN?: string;
}

/** The Platform the shared code runs on, in the control Worker. */
export function controlPlatform(env: ControlEnv, ctx: ExecutionContext): Platform {
  // The shared modules read only the bindings named here; the rest of the app's Env they never touch.
  const e = env as unknown as Env;
  const directory = directoryOf(e);
  const p = {
    directory,
    tokens: new Tokens(sqlOn(env.DB), env.SESSION_SECRET, directory, true),
    secret: env.SESSION_SECRET,
    sessionOf: (request: Request) => sessionOf(p, request),
    dev: () => false,
    pagesDomain: () => "",
    pagesShared: () => null,
    adminsOnly: false,
    signIn: {
      app: { clientId: env.GITHUB_CLIENT_ID?.trim() ?? "", secret: env.GITHUB_CLIENT_SECRET?.trim() ?? "" },
      github: "https://github.com",
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

/** The bootstrap admins, for the page. */
export const controlAdmins = (env: ControlEnv) => adminsOf(env as unknown as Env);

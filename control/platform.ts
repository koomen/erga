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

import { githubAppOf } from "./cloudflare";
import { controlDirectory, sqlOn } from "./d1";
import type { ControlEnv } from "./env";
import { sourceService } from "./source/service";
import { TARGETS } from "../deploy/targets";
import { sessionOf, Tokens } from "../server/identity/index.ts";
import type { Platform } from "../server/platform";

/** The Platform the shared code runs on, in the control Worker. */
export function controlPlatform(env: ControlEnv, ctx: ExecutionContext): Platform {
  const directory = controlDirectory(env);
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
    source: sourceService(env),
    deploys: env.PIPELINE.getByName("deploys"),
    deploy: { target: null, version: env.CF_VERSION_METADATA?.id ?? null, targets: TARGETS },
    edge: { cache: null, background: (work: Promise<unknown>) => ctx.waitUntil(work), homeRecheckMs: 0 },
    assets: async () => new Response("Not found", { status: 404 }),
    templates: {},
  } as unknown as Platform;
  return p;
}


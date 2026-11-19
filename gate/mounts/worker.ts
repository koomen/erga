// The gate as a Worker of its own, in front of Erga (SSO on Cloudflare). Erga's Worker then has no route, no custom
// domain and no workers.dev address: only this Worker's service binding (ERGA) reaches it, so a request that goes
// around the gate reaches nothing. And each request that goes on carries the key that Erga has too (GATE_KEY): Erga
// answers no request without it, so a deploy that leaves Erga an address by mistake opens nothing. Its routes are the shell's host and the content domain with every host under it
// (gate/wrangler.jsonc).
//
// Who signs people in is the deploy's choice, by which values it sets:
//
//   IDP + IDP_SECRET   an OIDC issuer (Cognito, or the organization's own): the gate runs the sign-in
//   ACCESS             Cloudflare Access in front of the shell's host: the gate reads Access's proof, and has no
//                      sign-in, callback, state or client secret
//
// Everything else is web.ts and the core.

import { type Config, SIGN_IN_DAYS, SIGN_IN_DAYS_MAX } from "../core.ts";
import { webPort } from "../port.ts";
import { type Access, accessOf } from "./access.ts";
import { oidcExchange } from "./oidc.ts";
import { FRONT, handle, type Mount } from "./web.ts";

export interface Env {
  /** Erga's Worker. */
  ERGA: { fetch(request: Request): Promise<Response> };
  /** The edge key (a secret). */
  EDGE_KEY: string;
  /** The key this gate proves itself to Erga with (a secret: the same value as Erga's own GATE_KEY). */
  GATE_KEY: string;
  /** The shell's host and the content domain. */
  SHELL: string;
  CONTENT: string;
  /** JSON: { name, issuer, authorize, token, client, scope? }. */
  IDP?: string;
  /** The client's secret at the issuer (a secret). */
  IDP_SECRET?: string;
  /** JSON: { team, aud }. */
  ACCESS?: string;
  /** "off": no MCP authorization server (a person makes each token on the page). */
  OAUTH?: string;
  /** JSON: more OAuth redirect URIs than this computer's. */
  REDIRECTS?: string;
  /** How many days a sign-in lasts: a whole number from 1 to 90 (30 when not set). It applies to new sign-ins. */
  SIGN_IN_DAYS?: string | number;
}

interface IdpValues {
  name: string;
  issuer: string;
  authorize: string;
  token: string;
  client: string;
  scope?: string;
}

/** The mount for a deploy's values. */
export function mountOf(env: Env, ask: typeof fetch = fetch): Mount {
  const access = env.ACCESS ? (JSON.parse(env.ACCESS) as Access) : null;
  const idp = !access && env.IDP ? (JSON.parse(env.IDP) as IdpValues) : null;
  if (!env.EDGE_KEY || env.EDGE_KEY.length < 32) throw new Error("EDGE_KEY must be a secret of 32 characters or more.");
  if (!env.GATE_KEY || env.GATE_KEY.length < 32) throw new Error("GATE_KEY must be a secret of 32 characters or more.");
  if (env.GATE_KEY == env.EDGE_KEY) throw new Error("GATE_KEY must not be the edge key: Erga holds it, and never the edge key.");
  if (!access && !(idp && env.IDP_SECRET)) throw new Error("Set IDP and IDP_SECRET, or ACCESS.");
  // (Sign-out ends at Access's own for a person whom "access" names: gate/core.ts, signOutAt.)
  if (idp?.name == "access") throw new Error("IDP's name can't be \"access\": that names Cloudflare Access (ACCESS).");
  const days = Number(env.SIGN_IN_DAYS ?? SIGN_IN_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > SIGN_IN_DAYS_MAX)
    throw new Error(`SIGN_IN_DAYS must be a whole number of days from 1 to ${SIGN_IN_DAYS_MAX}.`);
  const config: Config = {
    key: env.EDGE_KEY,
    shell: env.SHELL,
    content: env.CONTENT,
    https: true,
    open: false,
    idp: idp ? { [idp.name]: { authorize: idp.authorize, client: idp.client, scope: idp.scope ?? "openid email profile" } } : "access",
    oauth: env.OAUTH != "off",
    redirects: env.REDIRECTS ? JSON.parse(env.REDIRECTS) : [],
    hours: days * 24,
  };
  return {
    config: () => config,
    port: webPort,
    async exchange(x) {
      const identity = idp ? await oidcExchange(idp.name, { ...idp, secret: env.IDP_SECRET! }, x, ask) : null;
      return identity
        ? { identity }
        : new Response("Sign-in didn't work. Try again.", { status: 400, headers: { "cache-control": "no-store" } });
    },
    ...(access ? { access: (request: Request) => accessOf(request, access, ask) } : {}),
    upstream: (request) => {
      const headers = new Headers(request.headers);
      headers.set(FRONT, env.GATE_KEY);
      return env.ERGA.fetch(new Request(request, { headers }));
    },
  };
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, mountOf(env)),
};

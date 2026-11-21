// The organization's sign-in where the gate runs inside Erga's Worker (SSO on Cloudflare): what the deploy says of
// it, read and checked one time, and the two parts of it that need the network. The deploy chooses one of two:
//
//   {"access": {"team", "aud"}}                        Cloudflare Access is in front of the shell's host, and signs
//                                                      each person in. The gate reads Access's proof (access.ts),
//                                                      and has no sign-in, callback, state or client secret
//   {"oidc": {"issuer", "authorize", "token",          an OIDC issuer (the organization's own). The gate runs the
//             "client"}}                               sign-in, and trades its code (oidc.ts) with the client's
//                                                      secret, which is a secret of the Worker
//
// Trap: with an issuer, nothing is in front of Erga's Worker: the gate, its first call, is the only check. With
// Access, Access keeps outsiders off the shell's host, and the gate still checks every request: Access's proof on the
// shell, and its own values on the documents' hosts and on the paths that Access lets through (core.ts, ACCESS_OPEN).

import { type Access, accessOf } from "./access.ts";
import type { Answer, Config, Identity } from "./core.ts";
import { oidcExchange } from "./oidc.ts";

/** The issuer's name in the gate: one issuer, so the gate's sign-in goes straight to it. */
export const ISSUER = "sso";

export interface Sso {
  /** Who signs people in, as the core takes it (Config.idp). */
  idp: Config["idp"];
  /** The callback's network call: who signed in with the code; null: the issuer refused, or there is no issuer. */
  exchange(x: Extract<Answer, { do: "exchange" }>): Promise<Identity | null>;
  /** Behind Access: the person of a request's proof, checked. */
  access?(request: Request): Promise<(Identity & { e: number }) | null>;
}

const TEAM = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const AUD = /^[0-9a-f]{32,128}$/;
const https = (v: unknown): v is string => typeof v == "string" && /^https:\/\/[^\s/]+/.test(v);

/**
 * The sign-in of the deploy's values: `value` is the setting (JSON, see the top), `secret` the client's secret at the
 * issuer. It throws on values that name no sign-in: a server with them answers nothing, never as one where anyone
 * may come in.
 */
export function ssoOf(value: string, secret: string, ask: typeof fetch = fetch): Sso {
  let o: { access?: Partial<Access>; oidc?: Record<string, unknown> } | null = null;
  try {
    o = JSON.parse(value);
  } catch {}
  const access = o?.access,
    oidc = o?.oidc;
  if (!o || typeof o != "object" || !access == !oidc) throw new Error('SSO must be JSON with one of "access" and "oidc".');
  if (access) {
    if (typeof access.team != "string" || !TEAM.test(access.team) || typeof access.aud != "string" || !AUD.test(access.aud))
      throw new Error('SSO\'s "access" needs the Zero Trust team\'s name ("team") and the Access application\'s audience tag ("aud").');
    const a: Access = { team: access.team, aud: access.aud };
    return { idp: "access", exchange: async () => null, access: (request) => accessOf(request, a, ask) };
  }
  const { issuer, authorize, token, client } = oidc!;
  if (!https(issuer) || !https(authorize) || !https(token) || typeof client != "string" || !client)
    throw new Error('SSO\'s "oidc" needs "issuer", "authorize" and "token" (each https://...), and "client".');
  if (!secret) throw new Error("SSO names an OIDC issuer, and the Worker has no SSO_CLIENT_SECRET: the client's secret at the issuer.");
  return {
    idp: { [ISSUER]: { authorize, client, scope: "openid email profile" } },
    exchange: (x) => (x.idp == ISSUER ? oidcExchange(ISSUER, { issuer, token, client, secret }, x, ask) : Promise.resolve(null)),
  };
}

// How people sign in on a server: one of two modes, which its deploy decides. In both, the gate (gate/core.ts) is the
// one check in front of every request, and says who calls (caller.ts); the mode is who may come in, and with it
// where the gate runs.
//
//   oauth   Anyone may come in. The gate runs inside this Worker, as its first call (mount.ts), and the OAuth
//           providers an admin turns on sign people in (providers.ts has one entry for each provider; apps.ts and
//           settings.ts keep each provider's app).
//   gate    Only the organization's people come in: the gate signs them in at the organization's own sign-in, and
//           lets nobody else through. It runs in one of two places:
//             front    in front of the server (AWS: CloudFront, gate/mounts/cloudfront.ts), and nothing else reaches
//                      this Worker. The deploy gives both the same key (GATE_KEY), which the gate sends with each
//                      request: a request without it is refused.
//             inside   inside this Worker, as its first call (Cloudflare: gate/sso.ts). Cloudflare Access is in
//                      front of the app's host and the gate reads its proof; or the gate runs the sign-in with an
//                      OIDC issuer itself (the setting SSO, and with an issuer the secret SSO_CLIENT_SECRET).
//
// Each sign-in ends with a `Vouched` (server/directory/identities.ts), and the steps after it are the same
// (accounts.ts). Only this folder reads the mode. The rest of the app asks it what to show: the ways to sign in
// (signInChoices, settings.ts), the status (authOps), and the providers an admin adds a person by (providersOf).

import { type Sso, ssoOf } from "../../gate/sso.ts";
import { SSO } from "../../shared/sign-in.ts";
import { type AppValues, type Provider, PROVIDERS } from "./providers.ts";

/** The OAuth mode's values from the deploy: each provider's app, and a stand-in's origin for it (the tests'; null: its own). */
export interface OAuthSignIn {
  mode: "oauth";
  /** The deploy's app at each provider (its client ID and secret); the values an admin sets on /admin/auth win while set. */
  apps: Record<Provider, AppValues>;
  origins: Record<Provider, string | null>;
}

/** Only the organization's people: the gate in front, with the key it sends with each request; or inside this Worker, with its sign-in. */
export type GateSignIn = { mode: "gate"; at: "front"; key: string } | { mode: "gate"; at: "inside"; sso: Sso };

export type SignIn = OAuthSignIn | GateSignIn;

/**
 * The mode, from the deploy's values. `gate`: GATE_KEY; any value there says a gate is in front. `sso`: SSO, the
 * organization's sign-in of a gate inside this Worker, with `ssoSecret` (SSO_CLIENT_SECRET); values that name no
 * sign-in throw (gate/sso.ts). `proxy`: PROXY_SIGN_IN, the setting of the sign-in at a proxy in front, which the gate
 * replaced: the server reads nothing from it. A server that still has it, and no gate, would come up in the OAuth
 * mode with no sign-in that works. A server whose values throw here does not come up (every request fails, the
 * health check's too), and its error says what to do: it never comes up as one where anyone may come in.
 */
export const signInOf = (o: {
  gate: string;
  sso: string;
  ssoSecret: string;
  proxy: string;
  apps: Record<Provider, AppValues>;
  origins: Record<Provider, string | null>;
}): SignIn => {
  const gate = o.gate.trim(),
    sso = o.sso.trim();
  if (gate && sso) throw new Error("This server has GATE_KEY (a gate in front) and SSO (the gate inside): it takes one of them.");
  if (gate) return { mode: "gate", at: "front", key: gate };
  if (sso) return { mode: "gate", at: "inside", sso: ssoOf(sso, o.ssoSecret.trim()) };
  if (o.proxy.trim())
    throw new Error(
      "This server has the setting PROXY_SIGN_IN and no gate. Erga reads PROXY_SIGN_IN no more: with single sign-on, " +
        "the gate signs people in, in front of the server (GATE_KEY) or inside it (SSO). " +
        "Run bun erga setup again with --sign-in sso. Or remove PROXY_SIGN_IN: then people sign in with the OAuth providers."
    );
  return { mode: "oauth", apps: o.apps, origins: o.origins };
};

/** The providers whose accounts sign in here, by id (shared/sign-in.ts has each one's name): those an admin adds a person by. */
export const providersOf = (signIn: SignIn): string[] => (signIn.mode == "gate" ? [SSO] : Object.keys(PROVIDERS));

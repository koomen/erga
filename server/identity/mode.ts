// How people sign in on a server: one of two modes, which its deploy decides. In both, the gate (gate/core.ts) is the
// one check in front of every request, and says who calls (caller.ts); the mode is where the gate runs.
//
//   oauth   The gate runs inside this Worker, as its first call (mount.ts). Anyone may come in, and the OAuth
//           providers an admin turns on sign people in (providers.ts has one entry for each provider; apps.ts and
//           settings.ts keep each provider's app).
//   gate    The gate runs in front of the server (a Worker of its own, or CloudFront: gate/mounts/), with the
//           organization's own sign-in, and nothing else reaches this Worker. The deploy gives both the same key
//           (GATE_KEY), which the gate sends with each request: a request without it is refused.
//
// Each sign-in ends with a `Vouched` (server/directory/identities.ts), and the steps after it are the same
// (accounts.ts). Only this folder reads the mode. The rest of the app asks it what to show: the ways to sign in
// (signInChoices, settings.ts), the status (authOps), and the providers an admin adds a person by (providersOf).

import { SSO } from "../../shared/sign-in.ts";
import { type AppValues, type Provider, PROVIDERS } from "./providers.ts";

/** The OAuth mode's values from the deploy: each provider's app, and a stand-in's origin for it (the tests'; null: its own). */
export interface OAuthSignIn {
  mode: "oauth";
  /** The deploy's app at each provider (its client ID and secret); the values an admin sets on /admin/auth win while set. */
  apps: Record<Provider, AppValues>;
  origins: Record<Provider, string | null>;
}

/** The gate in front: the key it sends with each request (the header x-erga-front). */
export interface GateSignIn {
  mode: "gate";
  key: string;
}

export type SignIn = OAuthSignIn | GateSignIn;

/**
 * The mode, from the deploy's values. `gate`: GATE_KEY; any value there says a gate is in front. `proxy`:
 * PROXY_SIGN_IN, the setting of the sign-in at a proxy in front, which the gate replaced: the server reads nothing
 * from it. A server that still has it, and no gate's key, would come up in the OAuth mode with no sign-in that works:
 * it does not come up (every request fails, the health check's too), and its error says what to do.
 */
export const signInOf = (o: {
  gate: string;
  proxy: string;
  apps: Record<Provider, AppValues>;
  origins: Record<Provider, string | null>;
}): SignIn => {
  if (o.proxy.trim() && !o.gate.trim())
    throw new Error(
      "This server has the setting PROXY_SIGN_IN and no GATE_KEY. Erga reads PROXY_SIGN_IN no more: with single sign-on, " +
        "a gate in front of the server signs people in, and the server takes only the gate's requests (GATE_KEY). " +
        "Deploy the gate and set GATE_KEY. Or remove PROXY_SIGN_IN: then people sign in with the OAuth providers."
    );
  return o.gate.trim() ? { mode: "gate", key: o.gate.trim() } : { mode: "oauth", apps: o.apps, origins: o.origins };
};

/** The providers whose accounts sign in here, by id (shared/sign-in.ts has each one's name): those an admin adds a person by. */
export const providersOf = (signIn: SignIn): string[] => (signIn.mode == "gate" ? [SSO] : Object.keys(PROVIDERS));

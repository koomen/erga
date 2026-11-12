// How people sign in on a server: one of two modes, which its deploy decides.
//
//   oauth   Erga signs people in itself, with the OAuth providers an admin turns on (oauth.ts; providers.ts has one
//           entry for each provider; apps.ts and settings.ts keep each provider's app).
//   proxy   a proxy in front of the server signs each person in before a request reaches it, and Erga trusts the
//           proxy's signed header (proxy.ts has one entry for each kind of proxy).
//
// Each mode ends with a `Vouched` (server/directory/identities.ts), and the steps after it are the same (accounts.ts).
// Only this folder reads the mode. The rest of the app asks it what to show: the ways to sign in (signInChoices,
// settings.ts), the status (authOps), and the providers an admin adds a person by (providersOf).

import { type AppValues, type Provider, PROVIDERS } from "./providers.ts";
import { type Proxy, proxyOf } from "./proxy.ts";

/** The OAuth mode's values from the deploy: each provider's app, and a stand-in's origin for it (the tests'; null: its own). */
export interface OAuthSignIn {
  mode: "oauth";
  /** The deploy's app at each provider (its client ID and secret); the values an admin sets on /admin/auth win while set. */
  apps: Record<Provider, AppValues>;
  origins: Record<Provider, string | null>;
}

/** The proxy mode's values from the deploy: the proxy in front; null: the deploy's value isn't one this reads, so nobody signs in. */
export interface ProxySignIn {
  mode: "proxy";
  proxy: Proxy | null;
}

export type SignIn = OAuthSignIn | ProxySignIn;

/** The mode, from the deploy's values. `proxy`: PROXY_SIGN_IN; any value there is the proxy mode. */
export const signInOf = (o: { proxy: string; apps: Record<Provider, AppValues>; origins: Record<Provider, string | null> }): SignIn =>
  o.proxy.trim() ? { mode: "proxy", proxy: proxyOf(o.proxy) } : { mode: "oauth", apps: o.apps, origins: o.origins };

/** The providers whose accounts sign in here, by id (shared/sign-in.ts has each one's name): those an admin adds a person by. */
export const providersOf = (signIn: SignIn): string[] => (signIn.mode == "proxy" ? ["proxy"] : Object.keys(PROVIDERS));

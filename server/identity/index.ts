// Who is asking, and how they got here: the gate's caller and Erga's part around the gate (sign-in, agents' grants,
// the settings), in its two modes (mode.ts). The rest of the app imports identity through this file.

export { actingAdmin, refusedAgent, sessionOf, signedOut, viewRequest } from "./admit.ts";
export { fontsAt, handOff, SIGNED_OUT, WARM_PATH } from "./caller.ts";
export { gated } from "./mount.ts";
export { chooseSignIn, signOut, ssoSignIn, SSO_PATH, startSignIn } from "./sign-in.ts";
export { devSignIn, usernameStep } from "./accounts.ts";
export { Claim } from "./claim-link.ts";
export { claimRoute } from "./claim.ts";
export { providersOf, type SignIn, signInOf } from "./mode.ts";
export { accountLookup, authOps, signInChoices } from "./settings.ts";
export { RULE_LABEL, usernameFacts, type UsernameFacts, whyNot } from "./usernames.ts";
export { DOMAIN_ERGA, DOMAIN_SIGN_OUT, domainPass, domainSignIn, domainVisitor } from "./domain-pass.ts";
export { authorize } from "./authorize.ts";
export { tokensRoutes } from "./tokens-page.ts";
export { cookieName, cookies, setCookie } from "./cookies.ts";

export { type Grant, Grants, ScopeError } from "./grants.ts";
export { AuthError, type AuthOps, type AuthStatus, type AuthStorage, type ProvidersOn, type SignInStatus } from "./apps.ts";
export { type AppValues, type CheckState, type Provider, providerOf, PROVIDERS } from "./providers.ts";

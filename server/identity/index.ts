// Who is asking, and how they got here: sessions, agent tokens, users, sign-in
// in its two modes (mode.ts) and its settings, the other of Erga's servers. The rest of the
// app imports identity through this file.

export { actingAdmin, SESSION_COOKIE, sessionCookie, sessionOf, viewCookie } from "./session.ts";
export { chooseSignIn, signOut } from "./sign-in.ts";
export { finishOAuth, startOAuth } from "./oauth.ts";
export { devSignIn, usernameStep } from "./accounts.ts";
export { Claim, claimRoute } from "./claim.ts";
export { providersOf, type SignIn, signInOf } from "./mode.ts";
export { proxySignIn, type ProxyStatus } from "./proxy.ts";
export { accountLookup, authOps, signInChoices } from "./settings.ts";
export { adminsOnlyGate } from "./admins-only.ts";
export { HOME_ERGA, homeDomainSignIn, homePass, homeVisitor } from "./home-pass.ts";
export { isOAuthPath, oauthRoutes, resourceMetadataUrl } from "./mcp-oauth.ts";

export { expiryOf, tokensRoutes } from "./tokens-page.ts";
export { cookieName, cookies, setCookie } from "./cookies.ts";

export { REQUEST_MINUTES, SCOPES, ScopeError, Tokens, type AgentToken, type Scope } from "./tokens.ts";
export { AuthError, type AuthOps, type AuthStatus, type AuthStorage, type ProvidersOn, type SignInStatus } from "./apps.ts";
export { type AppValues, type CheckState, type Provider, providerOf, PROVIDERS } from "./providers.ts";

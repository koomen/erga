// Who is asking, and how they got here: sessions, agent tokens, users, sign-in
// with GitHub and its settings, the other of Erga's servers. The rest of the
// app imports identity through this file.

export { actingAdmin, mayDeploy, sessionOf, sign, unsign } from "./session.ts";
export {
  chooseSignIn,
  finishGoogleSignIn,
  finishSignIn,
  githubAccounts,
  GITHUB_CONNECT_COOKIE,
  googleToken,
  isGithubConnectCallback,
  signOut,
  startGoogleSignIn,
  startSignIn,
  testSignIn,
} from "./sign-in.ts";
export { devSignIn, usernameStep } from "./accounts.ts";
export { authOps, providersOn } from "./settings.ts";
export { adminsOnlyGate } from "./admins-only.ts";
export { isOAuthPath, oauthRoutes, resourceMetadataUrl } from "./oauth.ts";

export { expiryOf, tokensRoutes } from "./tokens-page.ts";
export { cookies, setCookie } from "./cookies.ts";

export { REQUEST_MINUTES, SCOPES, ScopeError, SHARE_ADMIN_HOURS, Tokens, type AgentToken, type Scope } from "./tokens.ts";
export {
  AuthError,
  googleEndpoints,
  PROVIDERS,
  type AppValues,
  type AuthOps,
  type Provider,
  type ProvidersOn,
  type AuthStatus,
  type AuthStorage,
  type CheckState,
} from "./apps.ts";

// Who is asking, and how they got here: sessions, agent tokens, users, sign-in
// with GitHub and its settings, the other of Erga's servers. The rest of the
// app imports identity through this file.

export { actingAdmin, mayDeploy, sessionOf } from "./session.ts";
export {
  chooseSignIn,
  finishGoogleSignIn,
  finishSignIn,
  githubAccounts,
  signOut,
  startGoogleSignIn,
  startSignIn,
  testSignIn,
} from "./sign-in.ts";
export { devSignIn, usernameStep } from "./accounts.ts";
export { authOps } from "./settings.ts";
export { adminsOnlyGate } from "./admins-only.ts";

export { expiryOf, tokensDoor } from "./tokens-page.ts";
export { cookies, setCookie } from "./cookies.ts";

export { REQUEST_MINUTES, SCOPES, ScopeError, SHARE_ADMIN_HOURS, Tokens, type AgentToken, type Scope } from "./tokens.ts";
export {
  AuthError,
  PROVIDERS,
  type AppValues,
  type AuthOps,
  type Provider,
  type ProvidersOn,
  type AuthStatus,
  type AuthStorage,
  type CheckState,
  type SignInChange,
} from "./apps.ts";

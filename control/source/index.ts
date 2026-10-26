// Erga's own repository, hosted by Erga: the Git endpoint, the Ops page and
// its API (routes.ts); the repository itself (repo.ts), which runs in its
// Durable Object; reading a commit's files (browse.ts). The rest of the app
// imports source through this file.

export { MAX_LINES, MAX_MATCHES, type SourceAnswer, type SourceRead } from "./browse.ts";
export { tar, ZERO } from "./git.ts";
export type { Remote } from "./remote.ts";
export {
  compareVersions,
  SourceError,
  SourceRepo,
  type Actor,
  type GithubStatus,
  type Released,
  type UpdateResult,
  type UpstreamSource,
} from "./repo.ts";
export {
  createRepo,
  exchangeUserCode,
  GithubError,
  githubOrigins,
  installationOf,
  installationRepos,
  installationToken,
  installUrl,
  linkOf,
  openRelay,
  relayNonce,
  relayOrigin,
  relaySignature,
  relayState,
  sealRelay,
  uninstall,
  userOf,
  verifyRelay,
  verifyWebhook,
  type GithubApp,
  type GithubLink,
  type GithubRepo,
  type PushEvent,
  type UserToken,
} from "./github.ts";
export { sourceApi, sourceGit, type SourceObject, type SourceService } from "./routes.ts";
export { adminSourcePage } from "./page.ts";
export { isPublicSourcePath, publicSourcePage } from "./public.ts";

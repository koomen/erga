// Erga's own repository, hosted by Erga: the Git endpoint, the Ops page and
// its API (routes.ts); the repository itself (repo.ts), which runs in its
// Durable Object; reading a commit's files (browse.ts). The rest of the app
// imports source through this file.

export { MAX_LINES, MAX_MATCHES, type SourceAnswer, type SourceRead } from "./browse.ts";
export { tar, ZERO } from "./git.ts";
export type { Remote } from "./remote.ts";
export { compareVersions, isReleaseTag, nextVersion, SourceError, SourceRepo, type Actor, type Released, type TagInfo } from "./repo.ts";
export { isGitRead, sourceApi, sourceDoor, sourceGit, type RepoAccess, type SourceObject, type SourceService } from "./routes.ts";
export { adminSourcePage, type SourcePageConfig } from "./page.ts";
export { isPublicSourcePath, publicSourcePage } from "./public.ts";

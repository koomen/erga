// Erga's own source, hosted by Erga: the routes (the repository itself is
// repo.ts, in its Durable Object, control/source/source-host.ts).
//
//   /git/erga.git/...           Git smart HTTP: clone, fetch, pull and push. Reads (clone, fetch, ls-remote) need no
//                               credentials. A push needs HTTP Basic with any username and an admin-scope token
//                               (server/identity, made at /tokens) as the password, whose person is an admin. main takes
//                               fast-forwards only.
//   GET  /git, /git/tree/<ref>/<path>   Erga's source for anyone, read-only, with no sign-in: how to clone, main and staging,
//                               their recent commits, and the files (public.ts). A browser at /git/erga.git sees it too.
//   POST /api/tools/<name>      the Ops page's operations on the repository (control/source/operations.ts): list_branches,
//                               deploy_production (main moved to staging), cut_release, github_status, sync_github,
//                               disconnect_github, update_from_upstream, resolve_conflict_file, finish_waiting_merge,
//                               drop_waiting_merge, and the reads list_source, read_source, search_source, source_log.
//                               Connect GitHub is a consent in a popup, on the control Worker (control/github-routes.ts, /github/connect)
//   /admin/ops               the Ops page (admins): the history of staging and main, and their deploys
//
// Checkouts push to erga.dev's endpoint, not staging's: tokens are production's
// (staging's secret is its own, so they don't work there), and a bad staging
// deploy can't break the way pushes reach staging. Both proxy one repository.

import * as Result from "effect/Result";
import { Base64 } from "effect/encoding";
import { VIA } from "../../shared/attribution.ts";
import type { Platform } from "../../server/platform.ts";
import type { SourceAnswer, SourceRead } from "./browse.ts";
import { gitHttp } from "./http.ts";
import type { Remote } from "./remote.ts";
import type { GithubLink, PushEvent } from "./github.ts";
import type { Actor, BranchInfo } from "./repo.ts";
import type { GithubStatus } from "./github-sync.ts";
import type { MergeConflict } from "./conflicts.ts";
import type { Released, TagInfo } from "./releases.ts";
import type { UpdateResult, UpstreamView } from "./upstream.ts";

/** The repository's object (one, "erga"): pushes and merges happen there one at a time. Calls name the address the request came to (`origin`). */
export interface SourceObject {
  advertise(origin: string): Promise<Uint8Array>;
  branches(origin: string): Promise<{ branches: BranchInfo[]; github: GithubStatus; conflict: MergeConflict | null; tags?: TagInfo[]; release?: string | null; upstream?: UpstreamView }>;
  /** GitHub: the status; a sync now (`by`: who asked); the repository connected (the consent's end: control/github-routes.ts); disconnected; a push there (the webhook). */
  githubStatus(origin: string): Promise<GithubStatus>;
  syncGithub(origin: string, by: string): Promise<GithubStatus>;
  connectGithub(origin: string, link: GithubLink, by: string): Promise<GithubStatus>;
  disconnectGithub(origin: string): Promise<{ ok: true } | { error: string; status: number }>;
  githubPushed(origin: string, event: PushEvent): Promise<GithubStatus | null>;
  files(origin: string, commit: string): Promise<{ path: string; mode: string; data: Uint8Array }[]>;
  /** A read of the source: the answer, or { error }. */
  read(origin: string, q: SourceRead): Promise<SourceAnswer | { error: string }>;
  /** A merge: { commit } or { error, status }. */
  merge(origin: string, who: Actor, commit?: string): Promise<{ commit: string; fastForward: boolean; upToDate: boolean } | { error: string; status: number }>;
  /** A release cut (a tag): the release, or { error, status }. */
  release(origin: string, who: Actor, o?: { version?: string; notes?: string; commit?: string }): Promise<Released | { error: string; status: number }>;
  /** A downstream's Update from upstream, and the ways out of a merge that conflicted: each the result, or { error, status }. */
  update(origin: string, who: Actor): Promise<UpdateResult | { error: string; status: number }>;
  resolveUpdate(origin: string, who: Actor, path: string, content: string | null): Promise<{ branch: string; path: string; remaining: string[] } | { error: string; status: number }>;
  finishUpdate(origin: string, who: Actor): Promise<{ commit: string; version: string } | { error: string; status: number }>;
  abandonUpdate(origin: string): Promise<{ ok: true } | { error: string; status: number }>;
  /** A push (git-receive-pack's body, with x-erga-actor and x-erga-origin): the report git reads. */
  fetch(request: Request): Promise<Response>;
}

/** A Git remote for the repository, with a short-lived token of one scope. */
export interface RepoAccess extends Remote { token: string; expiresAt: string }

/** Erga's repository, as the app reaches it: null on a server that has none. */
export interface SourceService {
  object: SourceObject;
  /** The repository as a Git remote, with a token of this scope. */
  remote(scope: "read" | "write", origin?: string): Promise<RepoAccess | null>;
}

declare module "../../server/platform.ts" {
  interface Platform {
    /** Erga's own repository, where this server hosts it; null where it doesn't. */
    source: SourceService | null;
  }
}

/** What a server without Erga's repository answers. */
export const NOT_SET_UP =
  "Erga's repository isn't set up on this server: it needs the Artifacts binding: bun deploy/setup.ts binds it, and deploy/import-source.ts fills it.";

/** A read (clone, fetch, ls-remote: git-upload-pack's two requests), which anyone may make without credentials. */
export function isGitRead(request: Request, rest: string, url: URL): boolean {
  return (rest == "/info/refs" && request.method == "GET" && url.searchParams.get("service") == "git-upload-pack") || (rest == "/git-upload-pack" && request.method == "POST");
}

/** /git/erga.git: who's asking (an admin's admin-scope token, as the password), then Git. Reads need no one. */
export async function sourceGit(request: Request, platform: Platform, url: URL): Promise<Response> {
  const rest = url.pathname.slice("/git/erga.git".length);
  const auth = request.headers.get("authorization") ?? "";
  const basic = /^Basic\s+(\S+)$/i.exec(auth)?.[1];
  let secret = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? null;
  if (basic) secret = Result.match(Base64.decodeString(basic), { onFailure: () => null, onSuccess: (d) => d.slice(d.indexOf(":") + 1) });
  const challenge = (why: string) => new Response(`${why}\n`, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Erga", charset="UTF-8"', "Content-Type": "text/plain" } });
  const howTo = `Pushing to Erga's Git endpoint needs an admin token: make one at ${url.origin}/tokens (scope: admin), then give any username and the token as the password.`;
  const read = isGitRead(request, rest, url);
  const source = platform.source;
  const anonymous = () =>
    source ? git(request, source, url, rest, { login: "anonymous", name: "Anonymous" }) : new Response(`${NOT_SET_UP}\n`, { status: 503 });
  // Anyone may clone and fetch; only a push (git-receive-pack) asks who's there.
  if (!secret) return read ? anonymous() : challenge(howTo);
  // A token with the admin scope, whose person is an admin now. A read with any other credential is a read all the same.
  const token = await platform.tokens.verify(secret).catch(() => null);
  const refuse = (why: string) => new Response(`${why}\n`, { status: 403, headers: { "Content-Type": "text/plain" } });
  if (!token) return read ? anonymous() : challenge(`That token isn't working (it may have expired or been revoked). ${howTo}`);
  if (token.scope != "admin" || token.testBy) return read ? anonymous() : refuse(`That token's scope is ${token.scope}: pushing needs a token with the admin scope. Make one at ${url.origin}/tokens.`);
  // The person, via the agent that holds their token.
  const who = { login: token.login, name: token.name, via: VIA.token(token.label) };
  const users = platform.directory.users;
  if (!(await users.allowed(who.login)) || !(await users.isAdmin({ login: who.login, test: false }))) {
    return read ? anonymous() : refuse(`Only admins can push to Erga's repository, and ${who.login} isn't one.`);
  }
  if (!source) return new Response(`${NOT_SET_UP}\n`, { status: 503 });
  return git(request, source, url, rest, who);
}

/** Git itself, for someone allowed: clones and fetches from the repository's remote, pushes through the object. */
function git(request: Request, source: SourceService, url: URL, rest: string, actor: Actor): Promise<Response> {
  return gitHttp(request, rest, {
    upstream: async () => (await source.remote("read", url.origin))!,
    advertise: () => source.object.advertise(url.origin),
    receive: async (body) => {
      const headers: Record<string, string> = { "x-erga-actor": JSON.stringify(actor), "x-erga-origin": url.origin };
      const r = await source.object.fetch(new Request(`${url.origin}/push`, { method: "POST", body: body as BodyInit, headers }));
      if (!r.ok) throw new Error(await r.text());
      return new Uint8Array(await r.arrayBuffer());
    },
  }).catch((e) => new Response(`Erga couldn't do that: ${(e as Error).message}\n`, { status: 502 }));
}

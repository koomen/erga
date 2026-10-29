// Erga's own source, hosted by Erga: the routes (the repository itself is
// repo.ts, in its Durable Object, control/source/source-host.ts).
//
//   /git/erga.git/...           Git smart HTTP: clone, fetch, pull and push. Reads (clone, fetch, ls-remote) need no
//                               credentials. A push needs HTTP Basic with any username and an admin-scope token
//                               (server/identity, made at /tokens) as the password, whose person is an admin. main takes
//                               fast-forwards only.
//   GET  /git, /git/tree/<ref>/<path>   Erga's source for anyone, read-only, with no sign-in: how to clone, main and staging,
//                               their recent commits, and the files (public.ts). A browser at /git/erga.git sees it too.
//   GET  /api/source/branches   staging and main: each head and its last 25 commits (staging: also the 5 just after main), GitHub's
//                               status, and the merge waiting on conflicts (if one)
//   POST /api/source/merge      { from: "staging", to: "main", commit? }: main fast-forwards to staging's head (or to
//                               that staging commit): { commit } or 4xx { error } (admins). Production deploys it.
//   POST /api/source/release    { version?, notes?, commit? }: cuts a release: an annotated tag (the next version unless
//                               given) on main's head (or that commit of main), with the notes as its message (admins):
//                               { tag, commit } or 4xx { error }. `git push erga vX.Y.Z` does the same.
//   GET  /api/source/github     GitHub: the repository connected (or none), the sync's state and its last error (admins)
//   POST /api/source/github/sync        syncs with GitHub now: what GitHub has comes in, what it lacks goes out (admins)
//   POST /api/source/github/disconnect  forgets the repository and uninstalls the App from the account (admins). Connect is a
//                               consent in a popup, on the control Worker (control/routes.ts, /github/connect)
//   POST /api/source/update     a downstream: Update from upstream (erga.dev): the channel's commit merged into staging, a
//                               fast-forward or a merge commit; on conflicts, the merge goes on upstream-merge/<version> and
//                               staging stays: { result: "up-to-date" | "fast-forward" | "merged" | "conflicts", ... } (admins)
//   POST /api/source/update/resolve   { path, content | null }: one conflicted file of the waiting merge (from upstream, or from
//                               GitHub: github-merge/<commit>), resolved (the admin's agent)
//   POST /api/source/update/finish    the resolved merge moves staging; the branch goes
//   POST /api/source/update/abandon   drops the waiting merge and its branch
//   /admin/ops               the Ops page (admins): the history of staging and main, and their deploys
//
// The API takes the app's session or an admin-scope token ("Authorization:
// Bearer erga_..."), an admin's either way. A POST with the session alone
// must come from this site's own pages.
//
// Checkouts push to erga.dev's endpoint, not staging's: tokens are production's
// (staging's secret is its own, so they don't work there), and a bad staging
// deploy can't break the way pushes reach staging. Both proxy one repository.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Base64 } from "effect/encoding";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { byLine, VIA } from "../../shared/attribution.ts";
import { LOCKED } from "../../server/directory/index.ts";
import { whoOf, type Platform } from "../../server/platform.ts";
import type { SourceAnswer, SourceRead } from "./browse.ts";
import { gitHttp } from "./http.ts";
import type { Remote } from "./remote.ts";
import type { GithubLink, PushEvent } from "./github.ts";
import type { Actor, BranchInfo } from "./repo.ts";
import type { GithubStatus } from "./github-sync.ts";
import type { MergeConflict } from "./conflicts.ts";
import type { Released, TagInfo } from "./releases.ts";
import type { UpdateResult, UpstreamView } from "./upstream.ts";
import { json } from "../../shared/http";

/** The repository's object (one, "erga"): pushes and merges happen there one at a time. Calls name the address the request came to (`origin`). */
export interface SourceObject {
  advertise(origin: string): Promise<Uint8Array>;
  branches(origin: string): Promise<{ branches: BranchInfo[]; github: GithubStatus; conflict: MergeConflict | null; tags?: TagInfo[]; release?: string | null; upstream?: UpstreamView }>;
  /** GitHub: the status; a sync now (`by`: who asked); the repository connected (the consent's end: control/routes.ts); disconnected; a push there (the webhook). */
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

/** Who's asking the API, if an admin (by session or agent token). */
async function adminOf(request: Request, platform: Platform, url: URL): Promise<{ actor: Actor; bearer: boolean } | Response> {
  const session = await platform.sessionOf(request);
  if (!session) return json({ error: `Sign in first, or send an admin-scope token (${url.origin}/tokens) as "Authorization: Bearer <token>".` }, 401);
  const users = platform.directory.users;
  if (session.test || !(await users.isAdmin(whoOf(session)))) return json({ error: "Only admins can do that." }, 403);
  if (!(await users.actsAsAdmin(whoOf(session)))) return json({ error: LOCKED, locked: true }, 403);
  return { actor: { login: session.login.toLowerCase(), name: session.name, ...(session.agent ? { via: VIA.token(session.agent.label) } : {}) }, bearer: !!session.agent };
}

/** Who asks the API (an admin), what they act on and where: given with each request (the routes are made once). */
class Asking extends Context.Service<
  Asking,
  { readonly request: Request; readonly url: URL; readonly source: SourceService; readonly actor: Actor }
>()("erga/control/source/Asking") {}

/** A JSON answer: no cache keeps it. */
const answer = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status, headers: { "Cache-Control": "no-store" } });
/** The repository's object, asked from `url`'s origin, by `actor`. */
const ask = <A>(f: (object: SourceObject, origin: string, actor: Actor) => Promise<A>) =>
  Asking.use(({ source, url, actor }) => Effect.promise(() => f(source.object, url.origin, actor)));
/** The object's answer: its result, or its { error, status }. */
const either = (r: object | { error: string; status: number }) => ("error" in r ? answer({ error: r.error }, r.status) : answer(r));
/** A body as `schema` reads it (JSON); one that isn't JSON, or doesn't match, is an empty one. */
const bodyOf = <A extends object>(schema: Schema.Codec<A>) =>
  Asking.use(({ request }) => Effect.promise(() => request.text().catch(() => ""))).pipe(
    Effect.map((text) => Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text), () => ({}) as Partial<A>))
  );

const Merge = Schema.Struct({
  from: Schema.optionalKey(Schema.Unknown),
  to: Schema.optionalKey(Schema.Unknown),
  commit: Schema.optionalKey(Schema.Unknown),
});
const Release = Schema.Struct({
  version: Schema.optionalKey(Schema.Unknown),
  notes: Schema.optionalKey(Schema.Unknown),
  commit: Schema.optionalKey(Schema.Unknown),
});
const Resolve = Schema.Struct({ path: Schema.optionalKey(Schema.Unknown), content: Schema.optionalKey(Schema.Unknown) });
const str = (v: unknown) => (typeof v == "string" ? v : undefined);

const apiRoutes = HttpRouter.addAll(
  [
    HttpRouter.route(
      "GET",
      "/api/source/branches",
      Effect.gen(function* () {
        const { url } = yield* Asking;
        return answer({ ...(yield* ask((o, origin) => o.branches(origin))), remote: `${url.origin}/git/erga.git` });
      })
    ),
    HttpRouter.route(
      "POST",
      "/api/source/merge",
      Effect.gen(function* () {
        const body = yield* bodyOf(Merge);
        if ((body.from ?? "staging") != "staging" || (body.to ?? "main") != "main")
          return answer({ error: "main only follows staging: merge from staging to main." }, 400);
        return either(yield* ask((o, origin, actor) => o.merge(origin, actor, body.commit as string | undefined)));
      })
    ),
    HttpRouter.route(
      "POST",
      "/api/source/release",
      Effect.gen(function* () {
        const body = yield* bodyOf(Release);
        const version = str(body.version),
          notes = str(body.notes),
          commit = str(body.commit);
        const o = {
          ...(version != null ? { version } : {}),
          ...(notes != null ? { notes: notes.slice(0, 4000) } : {}),
          ...(commit != null ? { commit } : {}),
        };
        return either(yield* ask((s, origin, actor) => s.release(origin, actor, o)));
      })
    ),
    HttpRouter.route(
      "GET",
      "/api/source/github",
      Effect.map(
        ask((o, origin) => o.githubStatus(origin)),
        (github) => answer({ github })
      )
    ),
    HttpRouter.route(
      "POST",
      "/api/source/github/sync",
      Effect.map(
        ask((o, origin, actor) => o.syncGithub(origin, byLine(actor.login, actor.via))),
        (github) => answer({ github })
      )
    ),
    HttpRouter.route(
      "POST",
      "/api/source/github/disconnect",
      Effect.gen(function* () {
        const r = yield* ask((o, origin) => o.disconnectGithub(origin));
        return "error" in r
          ? answer({ error: r.error }, r.status)
          : answer({ ok: true, github: yield* ask((o, origin) => o.githubStatus(origin)) });
      })
    ),
    HttpRouter.route(
      "POST",
      "/api/source/update",
      Effect.map(
        ask((o, origin, actor) => o.update(origin, actor)),
        either
      )
    ),
    HttpRouter.route(
      "POST",
      "/api/source/update/resolve",
      Effect.gen(function* () {
        const body = yield* bodyOf(Resolve);
        const path = body.path,
          content = body.content;
        if (typeof path != "string" || !(typeof content == "string" || content === null))
          return answer({ error: "Give the file's path, and its content (a string), or null to delete it." }, 400);
        return either(yield* ask((o, origin, actor) => o.resolveUpdate(origin, actor, path, content)));
      })
    ),
    HttpRouter.route(
      "POST",
      "/api/source/update/finish",
      Effect.map(
        ask((o, origin, actor) => o.finishUpdate(origin, actor)),
        either
      )
    ),
    HttpRouter.route(
      "POST",
      "/api/source/update/abandon",
      Effect.map(
        ask((o, origin) => o.abandonUpdate(origin)),
        either
      )
    ),
    HttpRouter.route("*", "*", answer({ error: "Not found" }, 404)),
  ].map((r) =>
    // The object didn't answer: the repository's object threw.
    HttpRouter.route(
      r.method,
      r.path,
      Effect.catchDefect(r.handler, (e) =>
        Effect.succeed(answer({ error: `Erga couldn't reach its repository: ${(e as Error).message}` }, 502))
      )
    )
  )
);

const api = HttpRouter.toWebHandler(apiRoutes, { disableLogger: true });

/** /api/source/... (the events, /api/events, are the deploy pipeline's hub: control/deploys). */
export async function sourceApi(request: Request, platform: Platform, url: URL): Promise<Response> {
  const who = await adminOf(request, platform, url);
  if (who instanceof Response) return who;
  if (request.method == "POST" && !who.bearer && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  const source = platform.source;
  if (!source) return json({ error: NOT_SET_UP }, 503);
  return api.handler(request, Context.make(Asking, { request, url, source, actor: who.actor }));
}

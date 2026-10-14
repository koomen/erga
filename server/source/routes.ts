// Erga's own source, hosted by Erga: the routes (the repository itself is
// repo.ts, in its Durable Object, cloudflare/objects/source.ts).
//
//   /git/erga.git/...           Git smart HTTP: clone, fetch, pull and push. Reads (clone, fetch, ls-remote) need no
//                               credentials. A push needs HTTP Basic with any username and an admin-scope token
//                               (server/identity, made at /tokens) as the password, whose person is an admin. main takes
//                               fast-forwards only.
//   GET  /git, /git/tree/<ref>/<path>   Erga's source for anyone, read-only, with no sign-in: how to clone, main and staging,
//                               their recent commits, and the files (public.ts). A browser at /git/erga.git sees it too.
//   GET  /api/source/branches   staging and main: each head and its last 25 commits (staging: also the 5 just after main), and the mirror's status
//   POST /api/source/merge      { from: "staging", to: "main", commit? }: main fast-forwards to staging's head (or to
//                               that staging commit): { commit } or 4xx { error } (admins). Production deploys it.
//   POST /api/source/release    { version?, notes?, commit? }: cuts a release: an annotated tag (the next version unless
//                               given) on main's head (or that commit of main), with the notes as its message (admins):
//                               { tag, commit } or 4xx { error }. `git push erga vX.Y.Z` does the same.
//   POST /api/source/mirror     brings the GitHub mirror up to date now (admins)
//   /admin/source               the Source page (admins): the history of staging and main, and their deploys
//   /source, /admin/factory     redirect to /admin/source
//
// The API takes the app's session or an admin-scope token ("Authorization:
// Bearer erga_..."), an admin's either way. A POST with the session alone
// must come from this site's own pages.
//
// Checkouts push to erga.dev's endpoint, not staging's: tokens are production's
// (staging's secret is its own, so they don't work there), and a bad staging
// deploy can't break the way pushes reach staging. Both proxy one repository.

import { TARGETS } from "../../deploy/targets.ts";
import { byLine, VIA } from "../../shared/attribution.ts";
import { LOCKED } from "../directory/index.ts";
import { whoOf, type Platform } from "../platform.ts";
import type { SourceAnswer, SourceRead } from "./browse.ts";
import { gitHttp } from "./http.ts";
import { adminSourcePage } from "./page.ts";
import type { Remote } from "./remote.ts";
import type { Actor, BranchInfo, MirrorStatus, Released, TagInfo } from "./repo.ts";

/** The repository's object (one, "erga"): pushes and merges happen there one at a time. Calls name the address the request came to (`origin`). */
export interface SourceObject {
  advertise(origin: string): Promise<Uint8Array>;
  branches(origin: string): Promise<{ branches: BranchInfo[]; mirror: MirrorStatus; tags?: TagInfo[]; release?: string | null }>;
  /** `by`: who asked. */
  mirrorNow(origin: string, by?: string): Promise<MirrorStatus>;
  files(origin: string, commit: string): Promise<{ path: string; mode: string; data: Uint8Array }[]>;
  /** A read of the source: the answer, or { error }. */
  read(origin: string, q: SourceRead): Promise<SourceAnswer | { error: string }>;
  /** A merge: { commit } or { error, status }. */
  merge(origin: string, who: Actor, commit?: string): Promise<{ commit: string; fastForward: boolean; upToDate: boolean } | { error: string; status: number }>;
  /** A release cut (a tag): the release, or { error, status }. */
  release(origin: string, who: Actor, o?: { version?: string; notes?: string; commit?: string }): Promise<Released | { error: string; status: number }>;
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
  /** Where the GitHub mirror is (for the page when the mirror is off). */
  mirrorUrl: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const notSetUp = "Erga's repository isn't set up on this server: it needs the Artifacts binding: bun deploy/setup.ts binds it, and server/source/import.ts fills it.";

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
  if (basic) { try { const d = atob(basic); secret = d.slice(d.indexOf(":") + 1); } catch { secret = null; } }
  const challenge = (why: string) => new Response(`${why}\n`, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Erga", charset="UTF-8"', "Content-Type": "text/plain" } });
  const howTo = `Pushing to Erga's Git endpoint needs an admin token: make one at ${url.origin}/tokens (scope: admin), then give any username and the token as the password.`;
  const read = isGitRead(request, rest, url);
  const source = platform.source;
  const anonymous = () => source ? git(request, source, url, rest, { login: "anonymous", name: "Anonymous" }) : new Response(`${notSetUp}\n`, { status: 503 });
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
  if (!source) return new Response(`${notSetUp}\n`, { status: 503 });
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

/** /api/source/... (the events, /api/events, are the deploy pipeline's hub: server/deploys). */
export async function sourceApi(request: Request, platform: Platform, url: URL): Promise<Response> {
  const who = await adminOf(request, platform, url);
  if (who instanceof Response) return who;
  if (request.method == "POST" && !who.bearer && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  const source = platform.source;
  if (!source) return json({ error: notSetUp }, 503);
  try {
    if (url.pathname == "/api/source/branches" && request.method == "GET") {
      const view = await source.object.branches(url.origin);
      return json({ ...view, mirror: { ...view.mirror, url: view.mirror.url ?? source.mirrorUrl }, remote: `${url.origin}/git/erga.git` });
    }
    if (url.pathname == "/api/source/merge" && request.method == "POST") {
      const body = (await request.json().catch(() => ({}))) as { from?: string; to?: string; commit?: string };
      if ((body.from ?? "staging") != "staging" || (body.to ?? "main") != "main") return json({ error: "main only follows staging: merge from staging to main." }, 400);
      const r = await source.object.merge(url.origin, who.actor, body.commit);
      return "error" in r ? json({ error: r.error }, r.status) : json(r);
    }
    if (url.pathname == "/api/source/release" && request.method == "POST") {
      const body = (await request.json().catch(() => ({}))) as { version?: unknown; notes?: unknown; commit?: unknown };
      const o = { ...(typeof body.version == "string" ? { version: body.version } : {}), ...(typeof body.notes == "string" ? { notes: body.notes.slice(0, 4000) } : {}), ...(typeof body.commit == "string" ? { commit: body.commit } : {}) };
      const r = await source.object.release(url.origin, who.actor, o);
      return "error" in r ? json({ error: r.error }, r.status) : json(r);
    }
    if (url.pathname == "/api/source/mirror" && request.method == "POST") return json({ mirror: await source.object.mirrorNow(url.origin, byLine(who.actor.login, who.actor.via)) });
  } catch (e) {
    return json({ error: `Erga couldn't reach its repository: ${(e as Error).message}` }, 502);
  }
  return json({ error: "Not found" }, 404);
}

/** /admin/source: the page, for admins in a browser (/source and /admin/factory redirect here). */
export async function sourceDoor(request: Request, platform: Platform, url: URL): Promise<Response> {
  if (url.pathname != "/admin/source") return new Response(null, { status: 302, headers: { Location: "/admin/source" } });
  const session = await platform.sessionOf(request);
  if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent("/admin/source")}` } });
  const admin = !session.test && !session.agent && (await platform.directory.users.actsAsAdmin(whoOf(session)));
  const target = platform.deploy.target;
  return adminSourcePage({ session, admin, ready: !!platform.source, origin: url.origin, mirrorUrl: platform.source?.mirrorUrl ?? "", worker: target ? TARGETS[target].worker : null });
}

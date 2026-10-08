// Erga's own source, hosted by Erga: the routes (the repository itself is
// source/repo.ts, in its Durable Object, worker/source-host.ts).
//
//   /git/erga.git/...           Git smart HTTP: clone, fetch, pull and push. Reads (clone, fetch, ls-remote) need no
//                               credentials. A push needs HTTP Basic with any username and an admin-scope token
//                               (tokens.ts, made at /tokens) as the password, whose person is an admin. main takes
//                               fast-forwards only.
//   GET  /api/source/branches   staging and main: each head and its last 25 commits (staging: also the 5 just after main), and the mirror's status
//   POST /api/source/merge      { from: "staging", to: "main", commit? }: main fast-forwards to staging's head (or to
//                               that staging commit): { commit } or 4xx { error } (admins). Production deploys it.
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

import type { Platform } from "../front";
import { whoOf, withTokens } from "../front";
import { tar } from "../source/git";
import { gitHttp } from "../source/http";
import type { Actor } from "../source/repo";
import { adminSourcePage } from "../source/page";
import { isTargetName, TARGETS, type TargetName } from "../deploy/targets";
import { artifactsRemote, githubUrl, hasSource } from "./artifacts";
import { directoryOf, tokensOf } from "./d1";
import { LOCKED } from "../users";
import { byLine, VIA } from "../attribution";
import type { Env } from "./env";

const host = (env: Env) => env.SOURCE.getByName("erga");
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const notSetUp = "Erga's repository isn't set up on this server: it needs the Artifacts binding: bun deploy/setup.ts binds it, and source/import.ts fills it.";

/** A read (clone, fetch, ls-remote: git-upload-pack's two requests), which anyone may make without credentials. */
export function isGitRead(request: Request, rest: string, url: URL): boolean {
  return (rest == "/info/refs" && request.method == "GET" && url.searchParams.get("service") == "git-upload-pack") || (rest == "/git-upload-pack" && request.method == "POST");
}

/** /git/erga.git: who's asking (an admin's admin-scope token, as the password), then Git. Reads need no one. */
export async function sourceGit(request: Request, env: Env, url: URL): Promise<Response> {
  const rest = url.pathname.slice("/git/erga.git".length);
  const auth = request.headers.get("authorization") ?? "";
  const basic = /^Basic\s+(\S+)$/i.exec(auth)?.[1];
  let secret = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? null;
  if (basic) { try { const d = atob(basic); secret = d.slice(d.indexOf(":") + 1); } catch { secret = null; } }
  const challenge = (why: string) => new Response(`${why}\n`, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Erga", charset="UTF-8"', "Content-Type": "text/plain" } });
  const howTo = `Pushing to Erga's Git endpoint needs an admin token: make one at ${url.origin}/tokens (scope: admin), then give any username and the token as the password.`;
  const read = isGitRead(request, rest, url);
  const anonymous = () => hasSource(env) ? git(request, env, url, rest, { login: "anonymous", name: "Anonymous" }) : new Response(`${notSetUp}\n`, { status: 503 });
  // Anyone may clone and fetch; only a push (git-receive-pack) asks who's there.
  if (!secret) return read ? anonymous() : challenge(howTo);
  // A token (tokens.ts) with the admin scope, whose person is an admin now. A read with any other credential is a read all the same.
  const token = await tokensOf(env).verify(secret).catch(() => null);
  const refuse = (why: string) => new Response(`${why}\n`, { status: 403, headers: { "Content-Type": "text/plain" } });
  if (!token) return read ? anonymous() : challenge(`That token isn't working (it may have expired or been revoked). ${howTo}`);
  if (token.scope != "admin" || token.testBy) return read ? anonymous() : refuse(`That token's scope is ${token.scope}: pushing needs a token with the admin scope. Make one at ${url.origin}/tokens.`);
  // The person, via the agent that holds their token (attribution.ts).
  const who = { login: token.login, name: token.name, via: VIA.token(token.label) };
  const dir = directoryOf(env);
  if (!(await dir.users.allowed(who.login)) || !(await dir.users.isAdmin({ login: who.login, test: false }))) {
    return read ? anonymous() : refuse(`Only admins can push to Erga's repository, and ${who.login} isn't one.`);
  }
  if (!hasSource(env)) return new Response(`${notSetUp}\n`, { status: 503 });
  return git(request, env, url, rest, who);
}

/** Git itself, for someone allowed: clones and fetches from Artifacts, pushes through SourceRepo. */
function git(request: Request, env: Env, url: URL, rest: string, actor: Actor): Promise<Response> {
  return gitHttp(request, rest, {
    upstream: async () => (await artifactsRemote(env, "read", url.origin))!,
    advertise: () => host(env).advertise(url.origin),
    receive: async (body) => {
      const headers: Record<string, string> = { "x-erga-actor": JSON.stringify(actor), "x-erga-origin": url.origin };
      const r = await host(env).fetch(new Request(`${url.origin}/push`, { method: "POST", body: body as BodyInit, headers }));
      if (!r.ok) throw new Error(await r.text());
      return new Uint8Array(await r.arrayBuffer());
    },
  }).catch((e) => new Response(`Erga couldn't do that: ${(e as Error).message}\n`, { status: 502 }));
}

/** Who's asking the API, if an admin (by session or agent token). */
async function adminOf(request: Request, env: Env, platform: Platform, url: URL): Promise<{ actor: Actor; bearer: boolean } | Response> {
  const session = await withTokens(platform, url).sessionOf(request);
  if (!session) return json({ error: `Sign in first, or send an admin-scope token (${url.origin}/tokens) as "Authorization: Bearer <token>".` }, 401);
  const users = directoryOf(env).users;
  if (session.test || !(await users.isAdmin(whoOf(session)))) return json({ error: "Only admins can do that." }, 403);
  if (!(await users.actsAsAdmin(whoOf(session)))) return json({ error: LOCKED, locked: true }, 403);
  return { actor: { login: session.login.toLowerCase(), name: session.name, ...(session.agent ? { via: VIA.token(session.agent.label) } : {}) }, bearer: !!session.agent };
}

/** /api/source/... (the events, /api/events, are the deploy pipeline's hub: worker/deploys.ts). */
export async function sourceApi(request: Request, env: Env, platform: Platform, url: URL): Promise<Response> {
  const who = await adminOf(request, env, platform, url);
  if (who instanceof Response) return who;
  if (request.method == "POST" && !who.bearer && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  if (!hasSource(env)) return json({ error: notSetUp }, 503);
  try {
    if (url.pathname == "/api/source/branches" && request.method == "GET") {
      const view = await host(env).branches(url.origin);
      return json({ ...view, mirror: { ...view.mirror, url: view.mirror.url ?? githubUrl(env) }, remote: `${url.origin}/git/erga.git` });
    }
    if (url.pathname == "/api/source/merge" && request.method == "POST") {
      const body = (await request.json().catch(() => ({}))) as { from?: string; to?: string; commit?: string };
      if ((body.from ?? "staging") != "staging" || (body.to ?? "main") != "main") return json({ error: "main only follows staging: merge from staging to main." }, 400);
      const r = await host(env).merge(url.origin, who.actor, body.commit);
      return "error" in r ? json({ error: r.error }, r.status) : json(r);
    }
    if (url.pathname == "/api/source/mirror" && request.method == "POST") return json({ mirror: await host(env).mirrorNow(url.origin, byLine(who.actor.login, who.actor.via)) });
  } catch (e) {
    return json({ error: `Erga couldn't reach its repository: ${(e as Error).message}` }, 502);
  }
  return json({ error: "Not found" }, 404);
}

/** /admin/source: the page, for admins in a browser (/source and /admin/factory redirect here). */
export async function sourceDoor(request: Request, env: Env, platform: Platform, url: URL): Promise<Response> {
  if (url.pathname != "/admin/source") return new Response(null, { status: 302, headers: { Location: "/admin/source" } });
  const session = await platform.sessionOf(request);
  if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent("/admin/source")}` } });
  const users = directoryOf(env).users;
  const admin = !session.test && !session.agent && (await users.actsAsAdmin(whoOf(session)));
  return adminSourcePage({ session, admin, ready: hasSource(env), origin: url.origin, mirrorUrl: githubUrl(env), worker: isTargetName(env.DEPLOY_TARGET ?? "") ? TARGETS[env.DEPLOY_TARGET as TargetName].worker : null });
}

/**
 * For a build (the deploy pipeline): where to get `commit` from. A Git
 * remote with a short-lived read token (as the Bearer token, or HTTP Basic
 * with any username), so a build environment can `git clone` it; and the
 * commit's files as a tar archive, read here. `commit` should be a
 * branch's head (Artifacts lets those be fetched).
 */
export async function sourceForBuild(env: Env, commit: string, origin?: string): Promise<{ commit: string; remote: string; token: string; expiresAt: string; archive(): Promise<Uint8Array> }> {
  const access = await artifactsRemote(env, "read", origin);
  if (!access) throw new Error(notSetUp);
  return {
    commit, remote: access.url, token: access.token, expiresAt: access.expiresAt,
    archive: async () => tar(await host(env).files(origin ?? "", commit)),
  };
}

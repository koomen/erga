// Erga's own source, hosted by Erga: the routes (the repository itself is
// source/repo.ts, in its Durable Object, worker/source-host.ts).
//
//   /git/erga.git/...           Git smart HTTP: clone, fetch, pull and push. HTTP Basic with any username and
//                               an admin token (admin-keys.ts, admin-login.ts) as the password. main takes fast-forwards only.
//   GET  /api/source/branches   staging and main: each head and its last 25 commits, and the mirror's status
//   POST /api/source/merge      { from: "staging", to: "main", commit? }: main fast-forwards to staging's head (or to
//                               that staging commit): { commit } or 4xx { error } (admins)
//   POST /api/source/mirror     brings the GitHub mirror up to date now (admins)
//   /admin/source               the Source page (admins): the factory's board, this dashboard and the factory's agent
//   /source                     redirects to /admin/source
//
// The API takes the app's session or an admin token ("Authorization:
// Bearer erga_admin_..."), an admin's either way, with admin access unlocked
// by their SSH key (admin-keys.ts). A POST with the session alone must come
// from this site's own pages.

import type { Platform } from "../front";
import { whoOf, withTokens } from "../front";
import { tar } from "../source/git";
import { gitHttp } from "../source/http";
import type { Actor } from "../source/repo";
import { adminSourcePage } from "../source/page";
import { factoryEnabled } from "./factory";
import { artifactsRemote, githubUrl, hasSource } from "./artifacts";
import { adminKeysOf, directoryOf, tokensOf } from "./d1";
import { devUnlocked } from "./auth";
import { unlockFirst } from "../admin-access";
import { LOCKED } from "../users";
import type { Env } from "./env";

const host = (env: Env) => env.SOURCE.getByName("erga");
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const notSetUp = "Erga's repository isn't set up on this server: it needs the Artifacts binding (see README, Erga's own source).";

/** /git/erga.git: who's asking (an admin's agent token, as the password), then Git. */
export async function sourceGit(request: Request, env: Env, url: URL): Promise<Response> {
  const rest = url.pathname.slice("/git/erga.git".length);
  const auth = request.headers.get("authorization") ?? "";
  const basic = /^Basic\s+(\S+)$/i.exec(auth)?.[1];
  let secret = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? null;
  if (basic) { try { const d = atob(basic); secret = d.slice(d.indexOf(":") + 1); } catch { secret = null; } }
  const challenge = (why: string) => new Response(`${why}\n`, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Erga", charset="UTF-8"', "Content-Type": "text/plain" } });
  const howTo = "Erga's Git endpoint needs an admin token, made by signing a challenge with your admin SSH key: `ERGA_TOKEN=<agent token> bun admin-login.ts " + url.origin + "` prints one. Then any username, and the admin token as the password.";
  if (!secret) return challenge(howTo);
  // An admin token (admin-keys.ts): admin access unlocked with the admin's own SSH key. Local development's shortcut
  // (ERGA_ADMIN_UNLOCKED=1) takes an admin's agent token as it is.
  const admin = await adminKeysOf(env).readToken(secret).catch(() => null);
  const token = admin ? null : devUnlocked(env, url) ? await tokensOf(env).verify(secret).catch(() => null) : null;
  const who = admin ? { login: admin.login, name: admin.name } : token && !token.testBy ? { login: token.login, name: token.name } : null;
  if (!who) {
    const agent = !admin && (await tokensOf(env).verify(secret).catch(() => null));
    return challenge(agent ? `That's an agent token, which no longer reaches Erga's repository. ${howTo}` : `That isn't a working admin token (it may have ended, or its key was revoked). ${howTo}`);
  }
  const dir = directoryOf(env);
  if (!(await dir.users.allowed(who.login)) || !(await dir.users.isAdmin({ login: who.login, test: false }))) {
    return new Response(`Only admins can reach Erga's repository, and ${who.login} isn't one.\n`, { status: 403, headers: { "Content-Type": "text/plain" } });
  }
  if (!hasSource(env)) return new Response(`${notSetUp}\n`, { status: 503 });
  const actor: Actor = { login: who.login, name: who.name };
  return gitHttp(request, rest, {
    upstream: async () => (await artifactsRemote(env, "read", url.origin))!,
    advertise: () => host(env).advertise(url.origin),
    receive: async (body) => {
      const r = await host(env).fetch(new Request(`${url.origin}/push`, { method: "POST", body: body as BodyInit, headers: { "x-erga-actor": JSON.stringify(actor), "x-erga-origin": url.origin } }));
      if (!r.ok) throw new Error(await r.text());
      return new Uint8Array(await r.arrayBuffer());
    },
  }).catch((e) => new Response(`Erga couldn't do that: ${(e as Error).message}\n`, { status: 502 }));
}

/** Who's asking the API, if an admin (by session or agent token). */
async function adminOf(request: Request, env: Env, platform: Platform, url: URL): Promise<{ actor: Actor; bearer: boolean } | Response> {
  const session = await withTokens(platform, url).sessionOf(request);
  if (!session) return json({ error: "Sign in first, or send an admin token (admin-login.ts) as \"Authorization: Bearer <token>\"." }, 401);
  const users = directoryOf(env).users;
  if (session.test || !(await users.isAdmin(whoOf(session)))) return json({ error: "Only admins can do that." }, 403);
  if (!(await users.isUnlocked(whoOf(session)))) return json({ error: LOCKED, locked: true }, 403);
  return { actor: { login: session.login.toLowerCase(), name: session.name }, bearer: !!session.agent };
}

/** /api/source/... (the events, /api/events, are the deploy pipeline's hub: worker/deploys.ts). */
export async function sourceApi(request: Request, env: Env, platform: Platform, url: URL): Promise<Response> {
  const who = await adminOf(request, env, platform, url);
  if (who instanceof Response) return who;
  if (!hasSource(env)) return json({ error: notSetUp }, 503);
  if (request.method == "POST" && !who.bearer && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
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
    if (url.pathname == "/api/source/mirror" && request.method == "POST") return json({ mirror: await host(env).mirrorNow(url.origin) });
  } catch (e) {
    return json({ error: `Erga couldn't reach its repository: ${(e as Error).message}` }, 502);
  }
  return json({ error: "Not found" }, 404);
}

/** /admin/source: the page, for admins in a browser (/source redirects here). */
export async function sourceDoor(request: Request, env: Env, platform: Platform, url: URL): Promise<Response> {
  if (url.pathname != "/admin/source") return new Response(null, { status: 302, headers: { Location: "/admin/source" } });
  const session = await platform.sessionOf(request);
  if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent("/admin/source")}` } });
  const users = directoryOf(env).users;
  const admin = !session.test && (await users.isAdmin(whoOf(session)));
  if (admin && !(await users.isUnlocked(whoOf(session)))) return unlockFirst("/admin/source", session);
  return adminSourcePage({ session, admin, factory: admin && (await factoryEnabled(env)), ready: hasSource(env), origin: url.origin, mirrorUrl: githubUrl(env) });
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

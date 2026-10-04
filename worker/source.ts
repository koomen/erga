// Erga's own source, hosted by Erga: the routes (the repository itself is
// source/repo.ts, in its Durable Object, worker/source-host.ts).
//
//   /git/erga.git/...           Git smart HTTP: clone, fetch, pull and push. HTTP Basic with any username and
//                               an Erga agent token as the password; admins only. main takes fast-forwards only.
//   GET  /api/source/branches   staging and main: each head and its last 25 commits, and the mirror's status
//   POST /api/source/merge      { from: "staging", to: "main", commit? }: main fast-forwards to staging's head (or to
//                               that staging commit): { commit } or 4xx { error } (admins)
//   POST /api/source/mirror     brings the GitHub mirror up to date now (admins)
//   GET  /api/events            server-sent events for admins' pages ({ type: "source" }, { type: "deploys" })
//   /source                     the Source page (admins)
//
// The API takes the app's session or an agent token ("Authorization:
// Bearer erga_..."), an admin's either way. A POST with the session alone
// must come from this site's own pages.

import type { Platform } from "../front";
import { whoOf, withTokens } from "../front";
import { tar } from "../source/git";
import { gitHttp } from "../source/http";
import type { Actor } from "../source/repo";
import { sourcePage } from "../source/page";
import { artifactsRemote, githubUrl, hasSource } from "./artifacts";
import { directoryOf, tokensOf } from "./d1";
import type { Env } from "./env";
import { deploysStub } from "./deploys-stub";
import { eventStream } from "./events";

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
  if (!secret) return challenge("Erga's Git endpoint needs an agent token: any username, and the token (from Settings) as the password.");
  const token = await tokensOf(env).verify(secret).catch(() => null);
  if (!token || token.testBy) return challenge("That token isn't one of this server's agent tokens (or it was revoked): make one in Settings.");
  const dir = directoryOf(env);
  if (!(await dir.users.allowed(token.login)) || !(await dir.users.isAdmin({ login: token.login, test: false }))) {
    return new Response(`Only admins can reach Erga's repository, and ${token.login} isn't one.\n`, { status: 403, headers: { "Content-Type": "text/plain" } });
  }
  if (!hasSource(env)) return new Response(`${notSetUp}\n`, { status: 503 });
  const actor: Actor = { login: token.login, name: token.name };
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
  if (!session) return json({ error: "Sign in first, or send an admin's agent token as \"Authorization: Bearer <token>\"." }, 401);
  if (session.test || !(await directoryOf(env).users.isAdmin(whoOf(session)))) return json({ error: "Only admins can do that." }, 403);
  return { actor: { login: session.login.toLowerCase(), name: session.name }, bearer: !!session.agent };
}

/** /api/source/... and /api/events. */
export async function sourceApi(request: Request, env: Env, platform: Platform, url: URL): Promise<Response> {
  const who = await adminOf(request, env, platform, url);
  if (who instanceof Response) return who;
  if (url.pathname == "/api/events" && request.method == "GET") return eventStream(env, request);
  // The deploy pipeline's status and logs: a stand-in until the pipeline (task #40) serves them.
  if (url.pathname == "/api/deploys" || url.pathname.startsWith("/api/deploys/")) return deploysStub(request, env, url);
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

/** /source: the page, for admins in a browser. */
export async function sourceDoor(request: Request, env: Env, platform: Platform, url: URL): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent("/source")}` } });
  const admin = !session.test && (await directoryOf(env).users.isAdmin(whoOf(session)));
  return sourcePage({ session, admin, ready: hasSource(env), origin: url.origin, mirrorUrl: githubUrl(env) });
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

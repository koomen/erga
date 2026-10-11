// Sign-in's settings on Cloudflare (server/auth.ts says what they are and the
// lockout rules): the values an admin sets on /admin/auth, kept in this
// server's Pipeline Durable Object, the app sign-in uses, and
// the other deploy target's status and values, server to server:
//
//   GET  /api/sign-in/status            another of Erga's servers (DEPLOY_HOOK_SECRET): this server's sign-in status
//                                       (server/auth.ts, AuthStatus: never a secret), with a live check of its app
//   POST /api/sign-in/github            the server this one copies its data from (DEPLOY_HOOK_SECRET; staging takes
//                                       production's): {do: "save", clientId, secret, by} or {do: "discard" | "clear", by, force?}
//
// Staging's admins-only guard lets both through with the secret: production's page shows
// staging's status, and sets staging's app while no admin can sign in to staging.

import { type AppCheck, type AppContext, type AppValues, type AuthOps, type AuthStatus, AuthApps, AuthError, cachedCheck, checkGithubApp, clearApp, discardApp, inUse, type OtherStatus, type Provider, saveApp, statusOf } from "../server/auth";
import type { Act } from "../shared/attribution";
import { MOCK_HOOK_SECRET } from "../deploy/mock-cloudflare";
import { isTargetName, TARGETS, targetNames, type TargetName } from "../deploy/targets";
import { isDev } from "./auth";
import { directoryOf, factoryKey } from "./d1";
import { peer } from "./branch-deploys";
import type { Env } from "./env";

const PROVIDER: Provider = "github";

export const isSignInPath = (path: string) => path == "/api/sign-in/status" || path == "/api/sign-in/github";

/** This server's deploy target, if it is one of Erga's. */
const targetOf = (env: Env): TargetName | null => {
  const t = env.DEPLOY_TARGET?.trim() ?? "";
  return isTargetName(t) ? t : null;
};
/** The other of Erga's targets (there are two). */
const otherOf = (env: Env): TargetName | null => {
  const t = targetOf(env);
  return t ? targetNames.find((n) => n != t) ?? null : null;
};
/** The target whose page may set this target's values: the one it copies its data from (staging: production). */
const takesFrom = (t: TargetName | null): TargetName | null => (t ? TARGETS[t].snapshotFrom ?? null : null);

/** Local development only (the tests): stand-ins for GitHub and for the other target's server. */
const local = (env: Env, value: string | undefined) => (env.DEV_LOGIN && value?.trim() ? value.trim().replace(/\/+$/, "") : null);
const githubOrigin = (env: Env) => local(env, env.ERGA_GITHUB_ORIGIN) ?? "https://github.com";
const originOf = (env: Env, t: TargetName) => local(env, env.ERGA_PEER_ORIGIN) ?? `https://${TARGETS[t].host}`;
const hookSecret = (env: Env) => env.DEPLOY_HOOK_SECRET?.trim() || (env.ERGA_DEPLOY_MOCK == "1" ? MOCK_HOOK_SECRET : "");

/** The page's values, in this server's own Durable Object (not D1: server/auth.ts says why). */
const appsOf = (env: Env) => {
  const pipeline = () => env.PIPELINE.getByName("deploys");
  return new AuthApps({
    get: (k) => pipeline().authGet(k),
    put: (k, v) => pipeline().authPut(k, v),
    delete: (k) => pipeline().authDelete(k),
  }, factoryKey(env), targetOf(env) ?? "");
};

// One per isolate: a page that opens often asks GitHub at most once a minute for the same values.
let checks: { origin: string; check: (v: AppValues) => Promise<AppCheck> } | null = null;
const checkOf = (env: Env) => {
  const origin = githubOrigin(env);
  if (checks?.origin != origin) checks = { origin, check: cachedCheck((v) => checkGithubApp(v, { origin })) };
  return checks.check;
};

const contextOf = (env: Env): AppContext => ({
  apps: appsOf(env),
  provider: PROVIDER,
  deploy: { clientId: env.GITHUB_CLIENT_ID?.trim() ?? "", secret: env.GITHUB_CLIENT_SECRET?.trim() ?? "" },
  check: checkOf(env),
  log: async (by, change) => {
    try { await directoryOf(env).config.record(by.login, [{ key: "sign-in", from: null, to: null, signIn: change }], Date.now(), by.via ?? null); }
    catch (e) { console.log(`couldn't write the change log: ${e}`); }
  },
});

/**
 * The app sign-in uses: the values in use (the page's, else the deploy's), or those waiting for a
 * test sign-in (null if none). A server whose Durable Object doesn't answer signs in with the deploy's.
 */
export async function signInApp(env: Env, which: "active" | "pending"): Promise<AppValues | null> {
  const deploy = { clientId: env.GITHUB_CLIENT_ID?.trim() ?? "", secret: env.GITHUB_CLIENT_SECRET?.trim() ?? "" };
  if (!env.PIPELINE) return which == "active" ? deploy : null;
  try {
    const apps = appsOf(env);
    return which == "active" ? await inUse({ apps, provider: PROVIDER, deploy }) : await apps.values(PROVIDER, "pending");
  } catch (e) {
    console.log(`couldn't read the sign-in values set on /admin/auth, so the deploy's stand: ${e instanceof Error ? e.message : e}`);
    return which == "active" ? deploy : null;
  }
}

/**
 * A test sign-in with the pending values ended: an admin's that worked puts them in use; anything
 * else leaves the values in use as they are, and the page says why.
 */
export async function testedSignIn(env: Env, clientId: string, o: { ok: boolean; login?: string; admin?: boolean; error?: string }): Promise<boolean> {
  const c = contextOf(env);
  const at = Date.now();
  if (o.ok && o.admin && o.login) {
    if (!(await c.apps.promote(PROVIDER, clientId))) return false;
    await c.log({ login: o.login }, { provider: PROVIDER, target: targetOf(env) ?? "", event: "tested", clientId });
    return true;
  }
  const error = o.ok ? `${o.login ?? "Someone"} signed in, but only an admin's sign-in puts new values in use.` : o.error ?? "GitHub didn't sign them in.";
  // Nothing changed, so the change log has no line for it: the page shows it beside the pending values.
  await c.apps.noteTest(PROVIDER, clientId, { at, ok: false, by: o.login, error });
  return false;
}

/** This server's own status. `origin`: where it's reached (the callback URL is under it). */
async function localStatus(env: Env, origin: string): Promise<AuthStatus> {
  const target = targetOf(env), from = takesFrom(target);
  const pagePlace = from
    ? `on ${from}'s Authentication page (${originOf(env, from)}/admin/auth), in the ${target} section`
    : `on this server's Authentication page (${origin}/admin/auth)`;
  return statusOf(contextOf(env), { origin: target && !env.DEV_LOGIN ? `https://${TARGETS[target].host}` : origin, target, dev: isDev(env, new URL(origin)), takesFrom: from, worker: target ? TARGETS[target].worker : undefined, pagePlace });
}

/** The other target's server, asked with the shared secret; its answer, or why there's none. */
async function askPeer<T>(env: Env, t: TargetName, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const secret = hookSecret(env), host = TARGETS[t].host;
  if (!secret) throw new AuthError(`This server has no DEPLOY_HOOK_SECRET to ask ${host} with.`);
  const r = await Promise.race([
    fetch(`${originOf(env, t)}${path}`, { method: init.method ?? "GET", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) }),
    new Promise<null>((ok) => setTimeout(() => ok(null), 10_000)),
  ]).catch((e) => { throw new AuthError(`Couldn't reach ${host} (${(e as Error).message}).`); });
  if (!r) throw new AuthError(`${host} didn't answer in 10 seconds.`);
  const body = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (r.status == 404 && !body?.error) throw new AuthError(`${host} doesn't have this yet (it answered 404): it runs an older release.`);
  if (!r.ok || !body) throw new AuthError(`${host} answered ${r.status}${body?.error ? `: ${body.error}` : ""}.`);
  return body;
}

/**
 * What the page and the admin agent do, as `origin`'s server. Admins only: each call checks
 * who's asking (Users.mustAdmin), as server/api-keys.ts does.
 */
export function authOps(env: Env, origin: string): AuthOps {
  const mustAdmin = (by: Act & { admin?: boolean }) => directoryOf(env).users.mustAdmin({ login: by.login, admin: by.admin, via: by.via ?? undefined });
  const target = () => targetOf(env) ?? "";
  // The other target's server, for a change: only where it takes this server's values (production sets staging's).
  const other = (verb: string): TargetName => {
    const o = otherOf(env);
    if (!o) throw new AuthError("This server isn't one of Erga's deploy targets: it has no other server.");
    if (takesFrom(o) != targetOf(env)) throw new AuthError(`${TARGETS[o].host}'s sign-in is ${verb} only on its own Authentication page (https://${TARGETS[o].host}/admin/auth): it doesn't take values from ${TARGETS[targetOf(env)!].host}.`);
    return o;
  };
  const passedOn = (by: Act) => ({ by: by.login, via: by.via ? `${by.via}, on ${TARGETS[targetOf(env)!].host}` : `the admin page on ${TARGETS[targetOf(env)!].host}` });
  return {
    async status(by) {
      await mustAdmin(by);
      const o = otherOf(env);
      const [here, there] = await Promise.all([
        localStatus(env, origin),
        o ? askPeer<{ status: AuthStatus }>(env, o, "/api/sign-in/status").then((r) => r.status, (e: unknown): OtherStatus => ({ target: o, origin: `https://${TARGETS[o].host}`, error: (e as Error).message })) : null,
      ]);
      return { here, other: there };
    },
    async save(by, server, input) {
      await mustAdmin(by);
      if (server == "here") return saveApp(contextOf(env), target(), input, by);
      const o = other("set");
      // The secret goes to the other server only, over HTTPS; nothing here keeps or logs it.
      const r = await askPeer<{ result: Awaited<ReturnType<typeof saveApp>> }>(env, o, "/api/sign-in/github", { method: "POST", body: { do: "save", clientId: input.clientId, secret: input.secret, ...passedOn(by) } });
      await contextOf(env).log(by, { provider: PROVIDER, target: o, event: r.result.kept == "active" ? "set" : "pending", clientId: String(input.clientId ?? "").trim() });
      return r.result;
    },
    async discard(by, server) {
      await mustAdmin(by);
      if (server == "here") return discardApp(contextOf(env), target(), by);
      const o = other("changed");
      const r = await askPeer<{ result: { discarded: boolean } }>(env, o, "/api/sign-in/github", { method: "POST", body: { do: "discard", ...passedOn(by) } });
      if (r.result.discarded) await contextOf(env).log(by, { provider: PROVIDER, target: o, event: "discarded" });
      return r.result;
    },
    async clear(by, server, force) {
      await mustAdmin(by);
      if (server == "here") return clearApp(contextOf(env), target(), by, force);
      const o = other("changed");
      const r = await askPeer<{ result: { cleared: boolean; message: string } }>(env, o, "/api/sign-in/github", { method: "POST", body: { do: "clear", force: force === true, ...passedOn(by) } });
      if (r.result.cleared) await contextOf(env).log(by, { provider: PROVIDER, target: o, event: "cleared", clientId: null });
      return r.result;
    },
  };
}

/** /api/sign-in/...: another of Erga's servers only, with the shared secret. */
export async function signInDoor(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const noStore = { headers: { "Cache-Control": "no-store" } };
  if (!peer(request, env)) return Response.json({ error: "Not found" }, { status: 404 });
  if (url.pathname == "/api/sign-in/status" && request.method == "GET") return Response.json({ status: await localStatus(env, url.origin) }, noStore);
  if (url.pathname == "/api/sign-in/github" && request.method == "POST") {
    const target = targetOf(env);
    // Only a server that copies its data from another takes its sign-in values from that one's page (staging from production).
    if (!takesFrom(target)) return Response.json({ error: `${url.host} takes sign-in values only from its own Authentication page.` }, { status: 403 });
    const body = (await request.json().catch(() => ({}))) as { do?: string; clientId?: unknown; secret?: unknown; by?: unknown; via?: unknown; force?: unknown };
    const by: Act = { login: typeof body.by == "string" && body.by ? `${body.by.slice(0, 40)}` : "another server", via: typeof body.via == "string" ? body.via.slice(0, 120) : `${takesFrom(target)}'s admin page` };
    const c = contextOf(env);
    try {
      if (body.do == "save") return Response.json({ result: await saveApp(c, target!, { clientId: body.clientId, secret: body.secret }, by) }, noStore);
      if (body.do == "discard") return Response.json({ result: await discardApp(c, target!, by) }, noStore);
      if (body.do == "clear") return Response.json({ result: await clearApp(c, target!, by, body.force === true) }, noStore);
    } catch (e) {
      if (e instanceof AuthError) return Response.json({ error: e.message }, { status: 400 });
      throw e;
    }
    return Response.json({ error: 'do: "save", "discard" or "clear"' }, { status: 400 });
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

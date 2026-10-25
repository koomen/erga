// Sign-in's settings (apps.ts says what they are and the lockout rules): the
// values an admin sets on /admin/auth, kept in the server's own storage
// (Platform.own), the app sign-in uses, and the other deploy target's status
// and values, server to server:
//
//   GET  /api/sign-in/status            another of Erga's servers (DEPLOY_HOOK_SECRET): this server's sign-in status
//                                       (server/auth.ts, AuthStatus: never a secret), with a live check of its app
//   POST /api/sign-in/github            the server this one copies its data from (DEPLOY_HOOK_SECRET; staging takes
//                                       production's): {do: "save", clientId, secret, by} or {do: "discard" | "clear", by, force?}
//
// Staging's admins-only guard lets both through with the secret: production's page shows
// staging's status, and sets staging's app while no admin can sign in to staging.

import { type AppCheck, type AppContext, type AppValues, type AuthOps, type AuthStatus, AuthApps, AuthError, cachedCheck, checkGithubApp, checkGoogleApp, clearApp, discardApp, inUse, type OtherStatus, type Provider, PROVIDERS, type ProvidersOn, saveApp, statusOf } from "./apps.ts";
import type { Act } from "../../shared/attribution.ts";
import { TARGETS, targetNames, type TargetName } from "../../deploy/targets.ts";
import type { Platform } from "../platform.ts";
import { isPeer } from "./peer.ts";

/** The provider the other server's page sets (production sets staging's): GitHub's, which staging's admins need to sign in at all. */
const PROVIDER: Provider = "github";

export const isSignInPath = (path: string) => path == "/api/sign-in/status" || path == "/api/sign-in/github";

type SignInPlatform = Pick<Platform, "deploy" | "signIn" | "own" | "directory" | "dev">;

const targetOf = (platform: SignInPlatform): TargetName | null => platform.deploy.target;
/** The other of Erga's targets (there are two). */
const otherOf = (platform: SignInPlatform): TargetName | null => {
  const t = targetOf(platform);
  return t ? targetNames.find((n) => n != t) ?? null : null;
};
/** The target whose page may set this target's values: the one it copies its data from (staging: production). */
const takesFrom = (t: TargetName | null): TargetName | null => (t ? TARGETS[t].snapshotFrom ?? null : null);

/** The page's values, in this server's own storage (not D1: apps.ts says why). */
const appsOf = (platform: SignInPlatform) => new AuthApps(platform.own, platform.signIn.encryptionKey, targetOf(platform) ?? "");

// One per isolate and provider: a page that opens often asks GitHub or Google at most once a minute for the same values.
const checks = new Map<Provider, { origin: string; check: (v: AppValues) => Promise<AppCheck> }>();
const checkOf = (platform: SignInPlatform, provider: Provider) => {
  // An install's server signs in with Erga's apps through erga.dev: nothing to check here, and nothing to paste.
  if (platform.signIn.relay) return async (v: AppValues): Promise<AppCheck> => (v.clientId
    ? { state: "working", summary: `Sign-in uses Erga's ${PROVIDERS[provider].label} app, through ${platform.signIn.relay}.`, reasons: [], at: Date.now() }
    : { state: "not_set_up", summary: `This server has no client ID for Erga's ${PROVIDERS[provider].label} app.`, reasons: [`${PROVIDERS[provider].idEnv} isn't set.`], at: Date.now() });
  const origin = provider == "github" ? platform.signIn.github : platform.signIn.google ?? "";
  const had = checks.get(provider);
  if (had?.origin == origin) return had.check;
  const check = cachedCheck((v) => (provider == "github" ? checkGithubApp(v, { origin }) : checkGoogleApp(v, { origin: origin || null })));
  checks.set(provider, { origin, check });
  return check;
};

/** The deploy's values for a provider's app. */
const deployOf = (platform: SignInPlatform, provider: Provider): AppValues => (provider == "github" ? platform.signIn.app : platform.signIn.googleApp ?? { clientId: "", secret: "" });

const contextOf = (platform: SignInPlatform, provider: Provider = PROVIDER): AppContext => ({
  apps: appsOf(platform),
  provider,
  deploy: deployOf(platform, provider),
  check: checkOf(platform, provider),
  log: async (by, change) => {
    try { await platform.directory.config.record(by.login, [{ key: "sign-in", from: null, to: null, signIn: change }], Date.now(), by.via ?? null); }
    catch (e) { console.log(`couldn't write the change log: ${e}`); }
  },
});

/**
 * The app sign-in uses: the values in use (the page's, else the deploy's), or those waiting for a
 * test sign-in (null if none). A server whose own storage doesn't answer signs in with the deploy's.
 */
export async function signInApp(platform: SignInPlatform, which: "active" | "pending", provider: Provider = PROVIDER): Promise<AppValues | null> {
  const deploy = deployOf(platform, provider);
  try {
    const apps = appsOf(platform);
    return which == "active" ? await inUse({ apps, provider, deploy }) : await apps.values(provider, "pending");
  } catch (e) {
    console.log(`couldn't read the sign-in values set on /admin/auth, so the deploy's stand: ${e instanceof Error ? e.message : e}`);
    return which == "active" ? deploy : null;
  }
}

/**
 * A test sign-in with the pending values ended: an admin's that worked puts them in use; anything
 * else leaves the values in use as they are, and the page says why.
 */
export async function testedSignIn(platform: SignInPlatform, clientId: string, o: { ok: boolean; login?: string; admin?: boolean; error?: string }, provider: Provider = PROVIDER): Promise<boolean> {
  const c = contextOf(platform, provider);
  const at = Date.now();
  if (o.ok && o.admin && o.login) {
    if (!(await c.apps.promote(provider, clientId))) return false;
    await c.log({ login: o.login }, { provider, target: targetOf(platform) ?? "", event: "tested", clientId });
    return true;
  }
  const error = o.ok ? `${o.login ?? "Someone"} signed in, but only an admin's sign-in puts new values in use.` : o.error ?? `${PROVIDERS[provider].label} didn't sign them in.`;
  // Nothing changed, so the change log has no line for it: the page shows it beside the pending values.
  await c.apps.noteTest(provider, clientId, { at, ok: false, by: o.login, error });
  return false;
}

// ------------------------------------------------------------ which providers are on

const ON_KEY = "auth:providers";
const DEFAULT_ON: ProvidersOn = { github: true, google: false };

/**
 * Which providers people may sign in with here, as an admin chose on /admin/auth: kept in the server's own storage, as
 * the apps are (a copy of production's data never changes staging's). GitHub alone until an admin chooses.
 */
export async function providersOn(platform: Pick<Platform, "own">): Promise<ProvidersOn> {
  try {
    const kept = (await platform.own.get(ON_KEY)) as Partial<ProvidersOn> | undefined;
    return { github: kept?.github ?? DEFAULT_ON.github, google: kept?.google ?? DEFAULT_ON.google };
  } catch (e) {
    console.log(`couldn't read which sign-in providers are on, so GitHub alone: ${e instanceof Error ? e.message : e}`);
    return DEFAULT_ON;
  }
}

/**
 * Turns sign-in with a provider on or off. The rules, so nobody is locked out: a provider goes on only while its app
 * works; one goes off only while the other is on and works, and only by an admin whose account signs in with the other.
 */
async function setProvider(platform: SignInPlatform, by: Act, provider: Provider, on: boolean): Promise<ProvidersOn> {
  if (!(provider in PROVIDERS)) throw new AuthError(`"${provider}" isn't a sign-in provider: github or google.`);
  const now = await providersOn(platform);
  if (now[provider] == on) return now;
  const label = PROVIDERS[provider].label;
  // Local development signs in without a provider: anything works there.
  const works = async (p: Provider) => platform.signIn.devLogin != null
    || (await contextOf(platform, p).check((await signInApp(platform, "active", p)) ?? { clientId: "", secret: "" })).state == "working";
  if (on && !(await works(provider))) throw new AuthError(`${label}'s app doesn't work on this server yet: set its values below, and turn it on when the check says it works. Nothing changed.`);
  if (!on) {
    const other: Provider = provider == "github" ? "google" : "github", otherLabel = PROVIDERS[other].label;
    if (!now[other]) throw new AuthError(`Sign-in with ${label} is the only one on: turn on ${otherLabel} first, so people can still sign in. Nothing changed.`);
    if (!(await works(other))) throw new AuthError(`${otherLabel}'s app doesn't work now, so turning ${label} off would stop sign-in. Nothing changed.`);
    // Each account signs in with one provider (an account with no identity yet: GitHub, by its login).
    const mine = (await platform.directory.identities.of(by.login))[0]?.provider ?? "github";
    if (mine == provider) throw new AuthError(`Your account signs in with ${label}: turning it off would lock you out. An admin whose account signs in with ${otherLabel} can turn it off. Nothing changed.`);
  }
  const next = { ...now, [provider]: on };
  await platform.own.put(ON_KEY, next);
  await contextOf(platform, provider).log(by, { provider, target: targetOf(platform) ?? "", event: on ? "on" : "off" });
  return next;
}

/** This server's own status. `origin`: where it's reached (the callback URL is under it). */
async function localStatus(platform: SignInPlatform, origin: string, provider: Provider = PROVIDER): Promise<AuthStatus> {
  const target = targetOf(platform), from = provider == PROVIDER ? takesFrom(target) : null;
  const pagePlace = from
    ? `on ${from}'s Authentication page (${platform.deploy.originOf(from)}/admin/auth), in the ${target} section`
    : `on this server's Authentication page (${origin}/admin/auth)`;
  return statusOf(contextOf(platform, provider), { origin: target && !platform.signIn.devLogin ? `https://${TARGETS[target].host}` : origin, target, dev: platform.dev(new URL(origin)), takesFrom: from, worker: target ? TARGETS[target].worker : undefined, pagePlace });
}

/** The other target's server, asked with the shared secret; its answer, or why there's none. */
async function askPeer<T>(platform: SignInPlatform, t: TargetName, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const secret = platform.deploy.hookSecret, host = TARGETS[t].host;
  if (!secret) throw new AuthError(`This server has no DEPLOY_HOOK_SECRET to ask ${host} with.`);
  const r = await Promise.race([
    fetch(`${platform.deploy.originOf(t)}${path}`, { method: init.method ?? "GET", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) }),
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
 * who's asking (Users.mustAdmin), as server/directory/api-keys.ts does.
 */
export function authOps(platform: SignInPlatform, origin: string): AuthOps {
  const mustAdmin = (by: Act & { admin?: boolean }) => platform.directory.users.mustAdmin({ login: by.login, admin: by.admin, via: by.via ?? undefined });
  const target = () => targetOf(platform) ?? "";
  // The other target's server, for a change: only where it takes this server's values (production sets staging's).
  const other = (verb: string): TargetName => {
    const o = otherOf(platform);
    if (!o) throw new AuthError("This server isn't one of Erga's deploy targets: it has no other server.");
    if (takesFrom(o) != targetOf(platform)) throw new AuthError(`${TARGETS[o].host}'s sign-in is ${verb} only on its own Authentication page (https://${TARGETS[o].host}/admin/auth): it doesn't take values from ${TARGETS[targetOf(platform)!].host}.`);
    return o;
  };
  const passedOn = (by: Act) => ({ by: by.login, via: by.via ? `${by.via}, on ${TARGETS[targetOf(platform)!].host}` : `the admin page on ${TARGETS[targetOf(platform)!].host}` });
  return {
    async status(by) {
      await mustAdmin(by);
      const o = otherOf(platform);
      const [here, there, google, providers] = await Promise.all([
        localStatus(platform, origin),
        o ? askPeer<{ status: AuthStatus }>(platform, o, "/api/sign-in/status").then((r) => r.status, (e: unknown): OtherStatus => ({ target: o, origin: `https://${TARGETS[o].host}`, error: (e as Error).message })) : null,
        localStatus(platform, origin, "google"),
        providersOn(platform),
      ]);
      return { here, other: there, google, providers };
    },
    async setProvider(by, provider, on) {
      await mustAdmin(by);
      return setProvider(platform, by, provider, on);
    },
    async save(by, server, input, provider = PROVIDER) {
      await mustAdmin(by);
      if (provider != PROVIDER) return saveApp(contextOf(platform, provider), target(), input, by);
      if (server == "here") return saveApp(contextOf(platform), target(), input, by);
      const o = other("set");
      // The secret goes to the other server only, over HTTPS; nothing here keeps or logs it.
      const r = await askPeer<{ result: Awaited<ReturnType<typeof saveApp>> }>(platform, o, "/api/sign-in/github", { method: "POST", body: { do: "save", clientId: input.clientId, secret: input.secret, ...passedOn(by) } });
      await contextOf(platform).log(by, { provider: PROVIDER, target: o, event: r.result.kept == "active" ? "set" : "pending", clientId: String(input.clientId ?? "").trim() });
      return r.result;
    },
    async discard(by, server, provider = PROVIDER) {
      await mustAdmin(by);
      if (provider != PROVIDER) return discardApp(contextOf(platform, provider), target(), by);
      if (server == "here") return discardApp(contextOf(platform), target(), by);
      const o = other("changed");
      const r = await askPeer<{ result: { discarded: boolean } }>(platform, o, "/api/sign-in/github", { method: "POST", body: { do: "discard", ...passedOn(by) } });
      if (r.result.discarded) await contextOf(platform).log(by, { provider: PROVIDER, target: o, event: "discarded" });
      return r.result;
    },
    async clear(by, server, force, provider = PROVIDER) {
      await mustAdmin(by);
      if (provider != PROVIDER) return clearApp(contextOf(platform, provider), target(), by, force);
      if (server == "here") return clearApp(contextOf(platform), target(), by, force);
      const o = other("changed");
      const r = await askPeer<{ result: { cleared: boolean; message: string } }>(platform, o, "/api/sign-in/github", { method: "POST", body: { do: "clear", force: force === true, ...passedOn(by) } });
      if (r.result.cleared) await contextOf(platform).log(by, { provider: PROVIDER, target: o, event: "cleared", clientId: null });
      return r.result;
    },
  };
}

/** /api/sign-in/...: another of Erga's servers only, with the shared secret. */
export async function signInDoor(request: Request, platform: SignInPlatform): Promise<Response> {
  const url = new URL(request.url);
  const noStore = { headers: { "Cache-Control": "no-store" } };
  if (!isPeer(request, platform)) return Response.json({ error: "Not found" }, { status: 404 });
  if (url.pathname == "/api/sign-in/status" && request.method == "GET") return Response.json({ status: await localStatus(platform, url.origin) }, noStore);
  if (url.pathname == "/api/sign-in/github" && request.method == "POST") {
    const target = targetOf(platform);
    // Only a server that copies its data from another takes its sign-in values from that one's page (staging from production).
    if (!takesFrom(target)) return Response.json({ error: `${url.host} takes sign-in values only from its own Authentication page.` }, { status: 403 });
    const body = (await request.json().catch(() => ({}))) as { do?: string; clientId?: unknown; secret?: unknown; by?: unknown; via?: unknown; force?: unknown };
    const by: Act = { login: typeof body.by == "string" && body.by ? `${body.by.slice(0, 40)}` : "another server", via: typeof body.via == "string" ? body.via.slice(0, 120) : `${takesFrom(target)}'s admin page` };
    const c = contextOf(platform);
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

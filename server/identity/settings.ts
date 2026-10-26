// Sign-in's settings (apps.ts says what they are and the lockout rules): the
// values an admin sets on /admin/auth, kept in the server's own storage
// (Platform.own), and the app sign-in uses. Each server's page sets its own
// sign-in only: no server sets another's.

import {
  type AppCheck,
  type AppContext,
  type AppValues,
  type AuthOps,
  type AuthStatus,
  AuthApps,
  AuthError,
  cachedCheck,
  checkGithubApp,
  checkGoogleApp,
  clearApp,
  discardApp,
  inUse,
  type Provider,
  PROVIDERS,
  type ProvidersOn,
  saveApp,
  statusOf,
} from "./apps.ts";
import type { Act } from "../../shared/attribution.ts";
import { TARGETS, type TargetName } from "../../deploy/targets.ts";
import type { Platform } from "../platform.ts";

/** The provider a call means when it names none. */
const PROVIDER: Provider = "github";

type SignInPlatform = Pick<Platform, "deploy" | "signIn" | "own" | "directory" | "dev">;

const targetOf = (platform: SignInPlatform): TargetName | null => platform.deploy.target;

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
 * The deploy's values are the way back in: when the page's stop working (the provider refuses them)
 * and the deploy's work, sign-in uses the deploy's, so an admin can sign in and fix the page's.
 */
export async function signInApp(platform: SignInPlatform, which: "active" | "pending", provider: Provider = PROVIDER): Promise<AppValues | null> {
  const deploy = deployOf(platform, provider);
  try {
    const apps = appsOf(platform);
    if (which == "pending") return await apps.values(provider, "pending");
    const now = await inUse({ apps, provider, deploy });
    if (now.source == "page" && deploy.clientId && deploy.secret) {
      const check = checkOf(platform, provider);
      if ((await check(now)).state == "misconfigured" && (await check(deploy)).state == "working") {
        console.log(`the ${PROVIDERS[provider].label} values set on /admin/auth don't work, so sign-in uses the deploy's`);
        return deploy;
      }
    }
    return now;
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
  const target = targetOf(platform);
  const pagePlace = `on this server's Authentication page (${origin}/admin/auth)`;
  return statusOf(contextOf(platform, provider), {
    origin: target && !platform.signIn.devLogin ? `https://${TARGETS[target].host}` : origin,
    target,
    dev: platform.dev(new URL(origin)),
    worker: target ? TARGETS[target].worker : undefined,
    pagePlace,
  });
}

/**
 * What the page and the admin agent do, as `origin`'s server. Admins only: each call checks
 * who's asking (Users.mustAdmin), as server/directory/api-keys.ts does.
 */
export function authOps(platform: SignInPlatform, origin: string): AuthOps {
  const mustAdmin = (by: Act & { admin?: boolean }) => platform.directory.users.mustAdmin({ login: by.login, admin: by.admin, via: by.via ?? undefined });
  const target = () => targetOf(platform) ?? "";
  return {
    async status(by) {
      await mustAdmin(by);
      const [here, google, providers] = await Promise.all([
        localStatus(platform, origin),
        localStatus(platform, origin, "google"),
        providersOn(platform),
      ]);
      return { here, google, providers };
    },
    async setProvider(by, provider, on) {
      await mustAdmin(by);
      return setProvider(platform, by, provider, on);
    },
    async save(by, input, provider = PROVIDER) {
      await mustAdmin(by);
      return saveApp(contextOf(platform, provider), target(), input, by);
    },
    async discard(by, provider = PROVIDER) {
      await mustAdmin(by);
      return discardApp(contextOf(platform, provider), target(), by);
    },
    async clear(by, force, provider = PROVIDER) {
      await mustAdmin(by);
      return clearApp(contextOf(platform, provider), target(), by, force);
    },
  };
}

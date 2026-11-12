// The OAuth mode's settings (apps.ts says what they are and the lockout rules):
// the values an admin sets on /admin/auth, kept in the server's own storage
// (Platform.own), and the app sign-in uses. Each server's page sets its own
// sign-in only: no server sets another's. And what the pages ask of the
// sign-in, whatever its mode (mode.ts): its status, the ways to sign in.

import { SIGN_IN_PROVIDERS, type SignInChoice } from "../../shared/sign-in.ts";
import type { Act } from "../../shared/attribution.ts";
import { type AccountLookup, label, NotAllowed } from "../directory/index.ts";
import type { Platform } from "../platform.ts";
import {
  type AppContext,
  type AuthOps,
  type AuthStatus,
  AuthApps,
  AuthError,
  cachedCheck,
  clearApp,
  discardApp,
  inUse,
  type ProvidersOn,
  saveApp,
  statusOf,
} from "./apps.ts";
import { testEnded, type PendingTest, type TestEnd } from "./app-test.ts";
import type { OAuthSignIn } from "./mode.ts";
import { type AppCheck, type AppValues, type Provider, providerOf, PROVIDERS } from "./providers.ts";
import { proxyStatus } from "./proxy.ts";

type SignInPlatform = Pick<Platform, "deploy" | "signIn" | "own" | "directory" | "dev">;

const IDS = Object.keys(PROVIDERS) as Provider[];

/** The OAuth mode's values. A server in the proxy mode has none: what asks for them there is refused. */
function oauthOf(platform: Pick<Platform, "signIn">): OAuthSignIn {
  if (platform.signIn.mode != "oauth")
    throw new AuthError({
      message: "This server signs in with a proxy in front of it: it has no OAuth providers. The deploy sets its sign-in.",
    });
  return platform.signIn;
}

const targetOf = (platform: SignInPlatform) => platform.deploy.target;

/** The page's values, in this server's own storage (not D1: apps.ts says why). */
const appsOf = (platform: SignInPlatform) => new AuthApps(platform.own, platform.signIn.encryptionKey, targetOf(platform) ?? "");

// One per isolate and provider: a page that opens often asks a provider at most once a minute for the same values.
const checks = new Map<Provider, { origin: string | null; check: (v: AppValues) => Promise<AppCheck> }>();
const checkOf = (platform: SignInPlatform, provider: Provider) => {
  const origin = oauthOf(platform).origins[provider];
  const had = checks.get(provider);
  if (had && had.origin == origin) return had.check;
  const check = cachedCheck((v) => PROVIDERS[provider].check(v, { origin }));
  checks.set(provider, { origin, check });
  return check;
};

const contextOf = (platform: SignInPlatform, provider: Provider): AppContext => ({
  apps: appsOf(platform),
  provider,
  deploy: oauthOf(platform).apps[provider],
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
export async function signInApp(platform: SignInPlatform, which: "active" | "pending", provider: Provider): Promise<AppValues | null> {
  const deploy = oauthOf(platform).apps[provider];
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
 * A test sign-in with the pending values `clientId` ended (app-test.ts): an admin's that worked puts them in use;
 * any other end leaves the values in use as they are, and the page says why. True: the values are in use now.
 */
export async function testedSignIn(platform: SignInPlatform, clientId: string, end: TestEnd, provider: Provider): Promise<boolean> {
  const c = contextOf(platform, provider);
  const { pending } = await c.apps.read(provider);
  const now: PendingTest = pending ? { state: "waiting", clientId: pending.clientId, test: pending.test } : { state: "none" };
  const { effect } = testEnded(now, { clientId, end, at: Date.now() });
  if (effect.do == "promote") {
    if (!(await c.apps.promote(provider, clientId))) return false;
    await c.log({ login: effect.login }, { provider, target: targetOf(platform) ?? "", event: "tested", clientId });
    return true;
  }
  // Nothing changed, so the change log has no line for it: the page shows it beside the pending values.
  if (effect.do == "note") await c.apps.noteTest(provider, clientId, effect.result);
  return false;
}

/**
 * A provider's account by its login, for a person an admin adds by a login (server/directory/people.ts): asked as the
 * sign-in app in use. `platform`: asked at each lookup (the directory is made before its platform).
 */
export const accountLookup =
  (platform: () => SignInPlatform): AccountLookup =>
  async (provider, login) => {
    const p = platform();
    const id = providerOf(provider);
    const lookup = id && PROVIDERS[id].lookup;
    if (!lookup || p.signIn.mode != "oauth")
      throw new NotAllowed({ message: `This server can't ask ${label(provider)} for an account's id.` });
    return lookup(p.signIn.origins[id], await signInApp(p, "active", id), login);
  };

// ------------------------------------------------------------ which providers are on

const ON_KEY = "auth:providers";
/** Until an admin chooses: GitHub alone. */
const DEFAULT_ON: ProvidersOn = { github: true, google: false };

/**
 * Which providers people may sign in with here, as an admin chose on /admin/auth: kept in the server's own storage, as
 * the apps are (a copy of production's data never changes staging's).
 */
export async function providersOn(platform: Pick<Platform, "own">): Promise<ProvidersOn> {
  try {
    const kept = (await platform.own.get(ON_KEY)) as Partial<ProvidersOn> | undefined;
    return Object.fromEntries(IDS.map((id) => [id, kept?.[id] ?? DEFAULT_ON[id]])) as ProvidersOn;
  } catch (e) {
    console.log(`couldn't read which sign-in providers are on, so GitHub alone: ${e instanceof Error ? e.message : e}`);
    return DEFAULT_ON;
  }
}

/**
 * The ways to sign in here, for the sign-in page and a page's sign-in dialog (shared/sign-in.ts): the providers that
 * are on, or the proxy in front. Each one's sign-in is at /auth/<id>.
 */
export async function signInChoices(platform: Pick<Platform, "own" | "signIn">): Promise<SignInChoice[]> {
  if (platform.signIn.mode == "proxy") return [{ id: "proxy", label: SIGN_IN_PROVIDERS.proxy.label }];
  const on = await providersOn(platform);
  return IDS.filter((id) => on[id]).map((id) => ({ id, label: PROVIDERS[id].label }));
}

/**
 * Turns sign-in with a provider on or off. The rules, so nobody is locked out: a provider goes on only while its app
 * works; one goes off only while another is on and works, and only by an admin whose account signs in with another.
 */
async function setProvider(platform: SignInPlatform, by: Act, provider: Provider, on: boolean): Promise<ProvidersOn> {
  if (!providerOf(provider)) throw new AuthError({ message: `"${provider}" isn't a sign-in provider: ${IDS.join(" or ")}.` });
  oauthOf(platform);
  const dev = platform.signIn.devLogin != null;
  const now = await providersOn(platform);
  if (now[provider] == on) return now;
  const label = PROVIDERS[provider].label;
  // Local development signs in without a provider: anything works there.
  const works = async (p: Provider) =>
    dev ||
    (await contextOf(platform, p).check((await signInApp(platform, "active", p)) ?? { clientId: "", secret: "" })).state == "working";
  if (on && !(await works(provider)))
    throw new AuthError({
      message: `${label}'s app doesn't work on this server yet: set its values below, and turn it on when the check says it works. Nothing changed.`,
    });
  if (!on) {
    const names = (ids: Provider[]) => ids.map((p) => PROVIDERS[p].label).join(" or ");
    const others = IDS.filter((p) => p != provider);
    const on = others.filter((p) => now[p]);
    if (!on.length)
      throw new AuthError({
        message: `Sign-in with ${label} is the only one on: turn on ${names(others)} first, so people can still sign in. Nothing changed.`,
      });
    const working: Provider[] = [];
    for (const p of on) if (await works(p)) working.push(p);
    if (!working.length)
      throw new AuthError({
        message: `${names(on)}'s app doesn't work now, so turning ${label} off would stop sign-in. Nothing changed.`,
      });
    // Each account signs in with one provider (an account with no identity yet: the one whose login is its username).
    const mine = (await platform.directory.identities.of(by.login))[0]?.provider ?? IDS.find((p) => SIGN_IN_PROVIDERS[p].handle == "login");
    if (mine == provider)
      throw new AuthError({
        message: `Your account signs in with ${label}: turning it off would lock you out. An admin whose account signs in with ${names(working)} can turn it off. Nothing changed.`,
      });
  }
  const next = { ...now, [provider]: on };
  await platform.own.put(ON_KEY, next);
  await contextOf(platform, provider).log(by, { provider, target: targetOf(platform) ?? "", event: on ? "on" : "off" });
  return next;
}

/** This server's own status. `origin`: where it's reached (the callback URL is under it). */
async function localStatus(platform: SignInPlatform, origin: string, provider: Provider): Promise<AuthStatus> {
  const target = targetOf(platform);
  const pagePlace = `on this server's Authentication page (${origin}/admin/auth)`;
  return statusOf(contextOf(platform, provider), {
    origin,
    target,
    dev: platform.dev(new URL(origin)),
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
      if (platform.signIn.mode == "proxy") return { mode: "proxy", proxy: proxyStatus(platform.signIn.proxy) };
      const [apps, providers] = await Promise.all([Promise.all(IDS.map((id) => localStatus(platform, origin, id))), providersOn(platform)]);
      return { mode: "oauth", apps: Object.fromEntries(IDS.map((id, i) => [id, apps[i]])) as Record<Provider, AuthStatus>, providers };
    },
    async setProvider(by, provider, on) {
      await mustAdmin(by);
      return setProvider(platform, by, provider, on);
    },
    async save(by, input, provider) {
      await mustAdmin(by);
      return saveApp(contextOf(platform, provider), target(), input, by);
    },
    async discard(by, provider) {
      await mustAdmin(by);
      return discardApp(contextOf(platform, provider), target(), by);
    },
    async clear(by, force, provider) {
      await mustAdmin(by);
      return clearApp(contextOf(platform, provider), target(), by, force);
    },
  };
}

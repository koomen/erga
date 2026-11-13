// The OAuth mode's apps (mode.ts): a server's OAuth app at each provider
// (providers.ts), as the Authentication page shows it (/admin/auth,
// server/admin/auth.ts) and the admin agent reads it.
//
// The deploy gives each server its app: the public client ID as a text
// binding (GITHUB_CLIENT_ID), the client secret as a Worker secret
// (GITHUB_CLIENT_SECRET). An admin may also paste a client ID and secret on
// the page, so a server can be fixed without a deploy. Those win over the
// deploy's while they are set; Clear goes back to the deploy's.
//
// Where the page's values are kept, and how:
//
//   - In the server's own Pipeline Durable Object, not in
//     D1: staging's D1 is replaced by a copy of production's when an admin asks
//     for a fresh copy, which would drop
//     staging's values and bring in production's. The Durable Object is each
//     server's own.
//   - The secret is encrypted with AES-GCM, a fresh IV each time, under a key
//     derived from FACTORY_KEY (KeyBox of server/directory/api-keys.ts, with a
//     derivation of its own), with the provider, the target and the client ID as the
//     additional data, so it opens only for that app on that server.
//   - Nothing answers the secret to a page or an agent: only whether one is set.
//   - The change log gets who changed the app and its client ID (public),
//     never the secret.
//
// Lockout: a wrong value could stop everyone, admins too, from signing in.
// So (saveApp):
//
//   1. New values are checked with the provider before they are kept (its
//      entry's check: the client ID must exist and the secret must be right).
//      If they fail, nothing changes.
//   2. If the app in use works, the new values wait ("pending"): sign-in keeps
//      the values that work until an admin signs in with the new ones (Test
//      sign-in, server/identity/oauth.ts). Only that real sign-in proves the callback URL,
//      which a provider checks during a sign-in only.
//   3. If the app in use doesn't work (or there is none), there is nothing to
//      lose: the new values are used at once.
//   4. Clear refuses to go back to deploy values that don't work while the
//      page's do, unless told to (force).
//
// Sessions people already have are signed with SESSION_SECRET, not the app,
// so a change here never signs anyone out.
//
// Each server's page sets its own sign-in only, each provider's alike:
// no server sets another's. The way back in, when the page's values stop
// working, is the deploy's (settings.ts, signInApp): sign-in falls back to
// them while they work, so an admin can sign in and fix the page's.
//
// Each provider has its own app, and the same rules.

import * as Base64 from "effect/encoding/Base64";
import * as Schema from "effect/Schema";
import type { Act } from "../../shared/attribution.ts";
import { sha256 } from "../../shared/bytes.ts";
import { KeyBox, type SignInChange } from "../directory/index.ts";
import { type AppCheck, type AppValues, type Provider, PROVIDERS } from "./providers.ts";
import type { ProxyStatus } from "./proxy.ts";

/** A value an admin pasted that can't be used; the message says why, for a person or an agent to act on. */
export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", { message: Schema.String }) {
  readonly status = 400;
}

const SECRET = /^[\x21-\x7e]{16,200}$/;

/** Checks and tidies the values as pasted. */
export function checkValues(input: { clientId?: unknown; secret?: unknown }, provider: Provider): AppValues {
  const clientId = String(input.clientId ?? "").trim(), secret = String(input.secret ?? "").trim();
  if (!clientId) throw new AuthError({ message: "Paste the app's Client ID." });
  if (!PROVIDERS[provider].clientId.test(clientId)) throw new AuthError({ message: `That isn't ${PROVIDERS[provider].clientIdShape}` });
  if (!secret) throw new AuthError({ message: PROVIDERS[provider].noSecret });
  if (!SECRET.test(secret))
    throw new AuthError({ message: "That isn't a client secret: it is one line of 16 to 200 characters, with no spaces." });
  return { clientId, secret };
}

// ------------------------------------------------------------ the page's values, kept

/** Where the values are kept: a server's own Durable Object, or a Map in the tests. */
export interface AuthStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Kept {
  clientId: string;
  iv: string;
  data: string;
  updated: number;
  updatedBy: string;
  updatedVia?: string | null;
}

/** A test sign-in with pending values: how it went. */
export interface TestResult { at: number; ok: boolean; by?: string; error?: string }

interface Record_ { active?: Kept; pending?: Kept & { test?: TestResult } }

/** Values set on the page, as an admin sees them: never the secret. */
export interface KeptView { clientId: string; updated: number; updatedBy: string; updatedVia?: string | null; test?: TestResult }

const view = (k: Kept & { test?: TestResult }): KeptView => ({ clientId: k.clientId, updated: k.updated, updatedBy: k.updatedBy, ...(k.updatedVia ? { updatedVia: k.updatedVia } : {}), ...(k.test ? { test: k.test } : {}) });

export class AuthApps {
  private box: KeyBox | null;

  /** `secret`: FACTORY_KEY (null: this server can't keep values). `target`: this server's deploy target ("" for none). */
  constructor(private storage: AuthStorage, secret: string | null, private target: string) {
    this.box = secret ? new KeyBox(secret, "erga-auth-apps") : null;
  }

  get canStore(): boolean {
    return !!this.box;
  }

  private async record(p: Provider): Promise<Record_> {
    return ((await this.storage.get(`auth:${p}`)) as Record_ | undefined) ?? {};
  }

  private async write(p: Provider, r: Record_): Promise<void> {
    if (r.active || r.pending) await this.storage.put(`auth:${p}`, r);
    else await this.storage.delete(`auth:${p}`);
  }

  /** What a secret is bound to: it opens only for that app on that server. */
  private label = (p: Provider, clientId: string) => `erga-auth:${p}:${this.target}:${clientId}`;

  /** What the page set, without secrets. */
  async read(p: Provider): Promise<{ active: KeptView | null; pending: KeptView | null }> {
    const r = await this.record(p);
    return { active: r.active ? view(r.active) : null, pending: r.pending ? view(r.pending) : null };
  }

  /** The values themselves, for the server's own sign-in; null if none, or they don't open (another key, another server). */
  async values(p: Provider, which: "active" | "pending"): Promise<AppValues | null> {
    const k = (await this.record(p))[which];
    if (!k || !this.box) return null;
    const secret = await this.box.open(this.label(p, k.clientId), k);
    return secret == null ? null : { clientId: k.clientId, secret };
  }

  /** Keeps values, as the ones in use (active) or waiting for a test sign-in (pending). */
  async keep(p: Provider, which: "active" | "pending", v: AppValues, by: Act): Promise<void> {
    if (!this.box)
      throw new AuthError({
        message:
          "This server has no FACTORY_KEY to encrypt the secret with, so it can't keep values from this page: set them in the deploy.",
      });
    const sealed = await this.box.seal(this.label(p, v.clientId), v.secret);
    const r = await this.record(p);
    r[which] = {
      clientId: v.clientId,
      ...sealed,
      updated: Date.now(),
      updatedBy: by.login.toLowerCase(),
      updatedVia: by.via ?? null,
    };
    // Values in use make any that waited stale.
    if (which == "active") delete r.pending;
    await this.write(p, r);
  }

  /** The pending values become the ones in use (a test sign-in with them worked). False if there were none. */
  async promote(p: Provider, clientId: string): Promise<boolean> {
    const r = await this.record(p);
    if (!r.pending || r.pending.clientId != clientId) return false;
    const { test: _, ...kept } = r.pending;
    await this.write(p, { active: kept });
    return true;
  }

  async noteTest(p: Provider, clientId: string, result: TestResult): Promise<void> {
    const r = await this.record(p);
    if (!r.pending || r.pending.clientId != clientId) return;
    r.pending.test = result;
    await this.write(p, r);
  }

  async drop(p: Provider, which: "active" | "pending" | "both"): Promise<void> {
    const r = await this.record(p);
    if (which != "pending") delete r.active;
    if (which != "active") delete r.pending;
    await this.write(p, r);
  }
}

// ------------------------------------------------------------ the policy: saving, discarding, clearing

/** What a server needs to decide: its kept values, the deploy's, and a check (cached by the caller). */
export interface AppContext {
  apps: AuthApps;
  provider: Provider;
  deploy: AppValues;
  check(v: AppValues): Promise<AppCheck>;
  /** A line in the change log. */
  log(by: Act, change: SignInChange): Promise<void>;
}

/** The values the server signs in with now: the page's while they open, else the deploy's. */
export async function inUse(c: Pick<AppContext, "apps" | "provider" | "deploy">): Promise<AppValues & { source: "page" | "deploy" }> {
  const page = await c.apps.values(c.provider, "active");
  return page ? { ...page, source: "page" } : { ...c.deploy, source: "deploy" };
}

export interface SaveResult { kept: "active" | "pending"; message: string }

/** Saves pasted values, with the lockout rules (the top of this file). */
export async function saveApp(c: AppContext, target: string, input: { clientId?: unknown; secret?: unknown }, by: Act): Promise<SaveResult> {
  const v = checkValues(input, c.provider);
  const name = PROVIDERS[c.provider].label;
  if (!c.apps.canStore)
    throw new AuthError({
      message: "This server has no FACTORY_KEY to encrypt the secret with, so it can't keep values from this page: set them in the deploy.",
    });
  const fresh = await c.check(v);
  if (fresh.state != "working")
    throw new AuthError({ message: `${fresh.summary}${fresh.reasons.length ? ` ${fresh.reasons.join(" ")}` : ""} Nothing changed.` });
  const now = await inUse(c);
  const working = now.clientId ? (await c.check(now)).state == "working" : false;
  if (working && !(now.clientId == v.clientId && now.secret == v.secret)) {
    await c.apps.keep(c.provider, "pending", v, by);
    await c.log(by, { provider: c.provider, target, event: "pending", clientId: v.clientId });
    return { kept: "pending", message: `${name} accepts the new values. Sign-in keeps the values that work now until an admin signs in with the new ones: use Test sign-in.` };
  }
  await c.apps.keep(c.provider, "active", v, by);
  await c.log(by, { provider: c.provider, target, event: "set", clientId: v.clientId });
  return { kept: "active", message: working ? "These are the values in use already." : `${name} accepts the values, and sign-in uses them now. Sign in with them to check the callback URL.` };
}

/** Drops values that wait for a test sign-in. */
export async function discardApp(c: AppContext, target: string, by: Act): Promise<{ discarded: boolean }> {
  const { pending } = await c.apps.read(c.provider);
  if (!pending) return { discarded: false };
  await c.apps.drop(c.provider, "pending");
  await c.log(by, { provider: c.provider, target, event: "discarded", clientId: pending.clientId });
  return { discarded: true };
}

/**
 * Clears the page's values: the server goes back to the deploy's. Refuses (unless `force`) when the page's values
 * work and the deploy's don't, which would stop sign-in for everyone.
 */
export async function clearApp(c: AppContext, target: string, by: Act, force = false): Promise<{ cleared: boolean; message: string }> {
  const { active, pending } = await c.apps.read(c.provider);
  if (!active && !pending) return { cleared: false, message: "This server has no values from the page: it uses the deploy's." };
  if (active && !force) {
    const page = await c.apps.values(c.provider, "active");
    const [mine, theirs] = await Promise.all([page ? c.check(page) : null, c.check(c.deploy)]);
    if (mine?.state == "working" && theirs.state != "working") {
      throw new AuthError({
        message: `Clearing would stop sign-in for everyone, admins too: the page's values work, and the deploy's don't (${theirs.summary}). Fix the deploy's values first, or clear anyway (force).`,
      });
    }
  }
  await c.apps.drop(c.provider, "both");
  await c.log(by, { provider: c.provider, target, event: "cleared", clientId: null });
  return { cleared: true, message: "Cleared: sign-in uses the deploy's values." };
}

// ------------------------------------------------------------ the status, as the page and the agent see it

/** One server's sign-in, as the Authentication page shows it. Never a secret. */
export interface AuthStatus {
  provider: Provider;
  /** The deploy target ("production", "staging"), or null for a server that isn't one. */
  target: string | null;
  origin: string;
  /** The URLs to enter on the provider's page. */
  homepageUrl: string;
  callbackUrl: string;
  /** Local development: everyone signs in as DEV_LOGIN, without a provider. */
  dev: boolean;
  /** What sign-in uses now. */
  inUse: { clientId: string | null; secretSet: boolean; source: "page" | "deploy" };
  deploy: { clientId: string | null; secretSet: boolean; idEnv: string; secretEnv: string };
  /** Values set on the page: in use, and waiting for a test sign-in. */
  page: KeptView | null;
  pending: KeptView | null;
  /** This server can keep values from the page (it has FACTORY_KEY). */
  canStore: boolean;
  check: AppCheck;
  pendingCheck: AppCheck | null;
  /** How to make the app, when there is none that works. */
  setup: string[] | null;
}

/** The steps to make a provider's OAuth app for a server, and where its values go. */
export function setupSteps(o: { origin: string; target: string | null; pagePlace: string; provider: Provider }): string[] {
  const p = PROVIDERS[o.provider];
  return [
    ...p.setup({ name: o.target ? `Erga (${o.target})` : "Erga", origin: o.origin, pagePlace: o.pagePlace }),
    `Or set them in the deploy: ${p.idEnv} as a text binding, and ${p.secretEnv} as a Worker secret.`,
  ];
}

/** One server's status: what it uses, what the page set, and a live check of each. */
export async function statusOf(
  c: AppContext,
  o: { origin: string; target: string | null; dev: boolean; pagePlace: string }
): Promise<AuthStatus> {
  const [now, kept, pendingValues] = await Promise.all([inUse(c), c.apps.read(c.provider), c.apps.values(c.provider, "pending")]);
  const [check, pendingCheck] = await Promise.all([c.check(now), pendingValues ? c.check(pendingValues) : null]);
  return {
    provider: c.provider,
    target: o.target,
    origin: o.origin,
    homepageUrl: o.origin,
    callbackUrl: `${o.origin}${PROVIDERS[c.provider].callbackPath}`,
    dev: o.dev,
    inUse: { clientId: now.clientId || null, secretSet: !!now.secret, source: now.source },
    deploy: { clientId: c.deploy.clientId || null, secretSet: !!c.deploy.secret, idEnv: PROVIDERS[c.provider].idEnv, secretEnv: PROVIDERS[c.provider].secretEnv },
    page: kept.active,
    pending: kept.pending,
    canStore: c.apps.canStore,
    check,
    pendingCheck,
    setup:
      check.state == "working" ? null : setupSteps({ origin: o.origin, target: o.target, pagePlace: o.pagePlace, provider: c.provider }),
  };
}

/** Someone acting on sign-in: their login, how, and whether they come with admin power. */
export type By = Act & { admin?: boolean };

/**
 * How people sign in on a server, as the Authentication page and the admin agent see it: its mode (mode.ts), and that
 * mode's own status. Never a secret.
 */
export type SignInStatus =
  | { mode: "oauth"; apps: Record<Provider, AuthStatus>; providers: ProvidersOn }
  | { mode: "proxy"; proxy: ProxyStatus };

/**
 * What the Authentication page and the admin agent do, on this server only. Admins only. No call answers a secret.
 * All but `status` are the OAuth mode's: in the proxy mode they refuse (the deploy sets the proxy: nothing to change here).
 */
export interface AuthOps {
  /** `by`: who asks, with their admin power (Users.actsAsAdmin): each call checks it. */
  status(by: By): Promise<SignInStatus>;
  /** Turns sign-in with a provider on or off, with the rules that keep someone able to sign in. */
  setProvider(by: By, provider: Provider, on: boolean): Promise<ProvidersOn>;
  save(by: By, input: { clientId?: unknown; secret?: unknown }, provider: Provider): Promise<SaveResult>;
  discard(by: By, provider: Provider): Promise<{ discarded: boolean }>;
  clear(by: By, force: boolean, provider: Provider): Promise<{ cleared: boolean; message: string }>;
}

/** Which providers people may sign in with on a server. */
export type ProvidersOn = Record<Provider, boolean>;

/**
 * A check, remembered for a minute by the values' hash, so a page that opens
 * often doesn't ask the provider each time. A failure to reach it isn't kept.
 */
export function cachedCheck(check: (v: AppValues) => Promise<AppCheck>, ttlMs = 60_000): (v: AppValues) => Promise<AppCheck> {
  const seen = new Map<string, { at: number; check: Promise<AppCheck> }>();
  return async (v) => {
    const key = Base64.encode(await sha256(`${v.clientId}\n${v.secret}`));
    const hit = seen.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.check;
    const p = check(v);
    seen.set(key, { at: Date.now(), check: p });
    p.then((r) => { if (r.state == "unknown") seen.delete(key); }, () => seen.delete(key));
    if (seen.size > 50) seen.delete(seen.keys().next().value!);
    return p;
  };
}

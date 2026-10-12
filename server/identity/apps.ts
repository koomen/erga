// How people sign in to a server: its OAuth app (GitHub's, for now), as the
// Authentication page shows it (/admin/auth, server/admin/pages.ts) and the admin agent
// reads it.
//
// The deploy gives each server its app: the public client ID in
// deploy/targets.json (GITHUB_CLIENT_ID), the client secret as a Worker secret
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
//     derived from FACTORY_KEY (as server/directory/api-keys.ts does, with its own
//     derivation), with the provider, the target and the client ID as the
//     additional data, so it opens only for that app on that server.
//   - Nothing answers the secret to a page or an agent: only whether one is set.
//   - The change log gets who changed the app and its client ID (public),
//     never the secret.
//
// Lockout: a wrong value could stop everyone, admins too, from signing in.
// So (saveApp):
//
//   1. New values are checked with GitHub before they are kept (checkGithubApp:
//      the client ID must exist and the secret must be right). If they fail,
//      nothing changes.
//   2. If the app in use works, the new values wait ("pending"): sign-in keeps
//      the values that work until an admin signs in with the new ones (Test
//      sign-in, cloudflare/auth.ts). Only that real sign-in proves the callback URL,
//      which GitHub checks during a sign-in only.
//   3. If the app in use doesn't work (or there is none), there is nothing to
//      lose: the new values are used at once.
//   4. Clear refuses to go back to deploy values that don't work while the
//      page's do, unless told to (force).
//
// Sessions people already have are signed with SESSION_SECRET, not the app,
// so a change here never signs anyone out.
//
// Another server's values: production's page sets staging's too, through
// staging's server (cloudflare/auth-settings.ts, with DEPLOY_HOOK_SECRET): staging is
// for admins only, and until staging has an app no admin can sign in there.
// A server takes values only from the target it copies its data from
// (`snapshotFrom`: staging from production), never the other way round.
//
// Built for GitHub only; PROVIDERS keeps room for others.

import type { Act } from "../../shared/attribution.ts";

/** The sign-in providers: GitHub only, for now. */
export const PROVIDERS = {
  github: {
    label: "GitHub",
    /** Where an OAuth app is made. */
    newApp: "https://github.com/settings/applications/new",
    /** The deploy's names for the app's client ID (a text binding) and secret (a Worker secret). */
    idEnv: "GITHUB_CLIENT_ID",
    secretEnv: "GITHUB_CLIENT_SECRET",
    callbackPath: "/auth/github/callback",
  },
} as const;
export type Provider = keyof typeof PROVIDERS;

/** An app's two values. An empty string: not set. */
export interface AppValues { clientId: string; secret: string }

export type CheckState = "working" | "misconfigured" | "not_set_up" | "unknown";

/** What a live check of an app found. */
export interface AppCheck {
  state: CheckState;
  /** One sentence for the page. */
  summary: string;
  /** What is wrong, one item each (empty when it works). */
  reasons: string[];
  /** When (ms since the epoch). */
  at: number;
}

/** A value an admin pasted that can't be used; the message says why, for a person or an agent to act on. */
export class AuthError extends Error {}

const CLIENT_ID = /^[A-Za-z0-9._-]{8,80}$/;
const SECRET = /^[\x21-\x7e]{16,200}$/;

/** Checks and tidies the values as pasted. */
export function checkValues(input: { clientId?: unknown; secret?: unknown }): AppValues {
  const clientId = String(input.clientId ?? "").trim(), secret = String(input.secret ?? "").trim();
  if (!clientId) throw new AuthError("Paste the app's Client ID.");
  if (!CLIENT_ID.test(clientId)) throw new AuthError("That isn't a GitHub Client ID: it is 8 to 80 letters and digits, like Ov23li…");
  if (!secret) throw new AuthError("Paste the app's client secret too (Generate a new client secret, on the app's page on GitHub).");
  if (!SECRET.test(secret)) throw new AuthError("That isn't a client secret: it is one line of 16 to 200 characters, with no spaces.");
  return { clientId, secret };
}

/**
 * Asks GitHub whether an OAuth app works, without signing anyone in: a token
 * exchange with a code that can't be real. GitHub answers 404 for a client ID
 * it doesn't know, incorrect_client_credentials for a wrong (or no) secret,
 * and bad_verification_code when the client ID and secret are right. The
 * callback URL is checked only during a real sign-in. `origin`: GitHub's
 * (a stand-in's, in the tests).
 */
export async function checkGithubApp(v: AppValues, o: { fetch?: typeof fetch; origin?: string; timeoutMs?: number } = {}): Promise<AppCheck> {
  const at = Date.now();
  const out = (state: CheckState, summary: string, reasons: string[] = []): AppCheck => ({ state, summary, reasons, at });
  if (!v.clientId) return out("not_set_up", "No GitHub OAuth app: nobody can sign in with GitHub here.", ["No client ID."]);
  const f = o.fetch ?? fetch;
  let r: Response | null;
  try {
    r = await Promise.race([
      f(`${o.origin ?? "https://github.com"}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "erga.dev" },
        body: JSON.stringify({ client_id: v.clientId, client_secret: v.secret, code: `erga-check-${crypto.randomUUID()}` }),
      }),
      new Promise<null>((ok) => setTimeout(() => ok(null), o.timeoutMs ?? 8000)),
    ]);
  } catch (e) {
    return out("unknown", `Couldn't reach GitHub to check the app (${(e as Error).message}).`);
  }
  if (!r) return out("unknown", "GitHub didn't answer the check in time.");
  const body = (await r.json().catch(() => ({}))) as { error?: string; error_description?: string };
  if (r.status == 404 || body.error == "Not Found") return out("misconfigured", "GitHub has no OAuth app with this client ID.", [`GitHub doesn't know the client ID ${v.clientId}: it is wrong, or its app was deleted.`]);
  if (body.error == "incorrect_client_credentials") {
    return v.secret
      ? out("misconfigured", "The client secret is wrong.", ["GitHub refused the client secret for this client ID. Generate a new one on the app's page on GitHub."])
      : out("misconfigured", "The app has no client secret here.", ["The client ID is right, but there is no client secret."]);
  }
  if (body.error == "bad_verification_code") return out("working", "GitHub accepts the client ID and secret.");
  if (r.status == 429 || r.status >= 500) return out("unknown", `GitHub couldn't check the app now (${r.status}).`);
  return out("unknown", `GitHub answered the check with ${body.error ? `"${body.error}"` : `status ${r.status}`}.`, body.error_description ? [body.error_description] : []);
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

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const view = (k: Kept & { test?: TestResult }): KeptView => ({ clientId: k.clientId, updated: k.updated, updatedBy: k.updatedBy, ...(k.updatedVia ? { updatedVia: k.updatedVia } : {}), ...(k.test ? { test: k.test } : {}) });

export class AuthApps {
  private aesKey: Promise<CryptoKey> | null;

  /** `secret`: FACTORY_KEY (null: this server can't keep values). `target`: this server's deploy target ("" for none). */
  constructor(private storage: AuthStorage, secret: string | null, private target: string) {
    this.aesKey = secret ? (async () => {
      const raw = await crypto.subtle.digest("SHA-256", enc.encode(`erga-auth-apps:${secret}`));
      return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    })() : null;
  }

  get canStore(): boolean { return !!this.aesKey; }

  private async record(p: Provider): Promise<Record_> {
    return ((await this.storage.get(`auth:${p}`)) as Record_ | undefined) ?? {};
  }

  private async write(p: Provider, r: Record_): Promise<void> {
    if (r.active || r.pending) await this.storage.put(`auth:${p}`, r);
    else await this.storage.delete(`auth:${p}`);
  }

  private aad = (p: Provider, clientId: string) => enc.encode(`erga-auth:${p}:${this.target}:${clientId}`);

  /** What the page set, without secrets. */
  async read(p: Provider): Promise<{ active: KeptView | null; pending: KeptView | null }> {
    const r = await this.record(p);
    return { active: r.active ? view(r.active) : null, pending: r.pending ? view(r.pending) : null };
  }

  /** The values themselves, for the server's own sign-in; null if none, or they don't open (another key, another server). */
  async values(p: Provider, which: "active" | "pending"): Promise<AppValues | null> {
    const k = (await this.record(p))[which];
    if (!k || !this.aesKey) return null;
    try {
      const secret = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(k.iv), additionalData: this.aad(p, k.clientId) }, await this.aesKey, unb64(k.data)));
      return { clientId: k.clientId, secret };
    } catch {
      return null;
    }
  }

  /** Keeps values, as the ones in use (active) or waiting for a test sign-in (pending). */
  async keep(p: Provider, which: "active" | "pending", v: AppValues, by: Act): Promise<void> {
    if (!this.aesKey) throw new AuthError("This server has no FACTORY_KEY to encrypt the secret with, so it can't keep values from this page: set them in the deploy.");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.aad(p, v.clientId) }, await this.aesKey, enc.encode(v.secret)));
    const r = await this.record(p);
    r[which] = { clientId: v.clientId, iv: b64(iv), data: b64(data), updated: Date.now(), updatedBy: by.login.toLowerCase(), updatedVia: by.via ?? null };
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

/** A change log line. */
export interface SignInChange {
  provider: Provider;
  /** The server whose app changed ("" for one that isn't a deploy target). */
  target: string;
  event: "set" | "pending" | "tested" | "discarded" | "cleared";
  /** The client ID it changed to (public), if any. */
  clientId?: string | null;
}

/** The values the server signs in with now: the page's while they open, else the deploy's. */
export async function inUse(c: Pick<AppContext, "apps" | "provider" | "deploy">): Promise<AppValues & { source: "page" | "deploy" }> {
  const page = await c.apps.values(c.provider, "active");
  return page ? { ...page, source: "page" } : { ...c.deploy, source: "deploy" };
}

export interface SaveResult { kept: "active" | "pending"; message: string }

/** Saves pasted values, with the lockout rules (the top of this file). */
export async function saveApp(c: AppContext, target: string, input: { clientId?: unknown; secret?: unknown }, by: Act): Promise<SaveResult> {
  const v = checkValues(input);
  if (!c.apps.canStore) throw new AuthError("This server has no FACTORY_KEY to encrypt the secret with, so it can't keep values from this page: set them in the deploy.");
  const fresh = await c.check(v);
  if (fresh.state != "working") throw new AuthError(`${fresh.summary}${fresh.reasons.length ? ` ${fresh.reasons.join(" ")}` : ""} Nothing changed.`);
  const now = await inUse(c);
  const working = now.clientId ? (await c.check(now)).state == "working" : false;
  if (working && !(now.clientId == v.clientId && now.secret == v.secret)) {
    await c.apps.keep(c.provider, "pending", v, by);
    await c.log(by, { provider: c.provider, target, event: "pending", clientId: v.clientId });
    return { kept: "pending", message: "GitHub accepts the new values. Sign-in keeps the values that work now until an admin signs in with the new ones: use Test sign-in." };
  }
  await c.apps.keep(c.provider, "active", v, by);
  await c.log(by, { provider: c.provider, target, event: "set", clientId: v.clientId });
  return { kept: "active", message: working ? "These are the values in use already." : "GitHub accepts the values, and sign-in uses them now. Sign in with them to check the callback URL." };
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
      throw new AuthError(`Clearing would stop sign-in for everyone, admins too: the page's values work, and the deploy's don't (${theirs.summary}). Fix the deploy's values first, or clear anyway (force).`);
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
  /** The URLs to enter on GitHub. */
  homepageUrl: string;
  callbackUrl: string;
  /** Local development: everyone signs in as DEV_LOGIN, without GitHub. */
  dev: boolean;
  /** What sign-in uses now. */
  inUse: { clientId: string | null; secretSet: boolean; source: "page" | "deploy" };
  deploy: { clientId: string | null; secretSet: boolean; idEnv: string; secretEnv: string };
  /** Values set on the page: in use, and waiting for a test sign-in. */
  page: KeptView | null;
  pending: KeptView | null;
  /** This server can keep values from the page (it has FACTORY_KEY). */
  canStore: boolean;
  /** Which other target's page may set this server's values (staging: production). */
  takesFrom: string | null;
  check: AppCheck;
  pendingCheck: AppCheck | null;
  /** How to make the app, when there is none that works. */
  setup: string[] | null;
}

/** The steps to make a GitHub OAuth app for a server, and where its values go. */
export function setupSteps(o: { origin: string; target: string | null; worker?: string; pagePlace: string }): string[] {
  const name = o.target ? `Erga (${o.target})` : "Erga";
  return [
    `Open ${PROVIDERS.github.newApp}, signed in as the GitHub account that should own the app.`,
    `Enter the application name "${name}", the homepage URL ${o.origin}, and the authorization callback URL ${o.origin}${PROVIDERS.github.callbackPath}. Leave Enable Device Flow off. Click Register application.`,
    `Copy the Client ID. Click Generate a new client secret, and copy the secret.`,
    `Paste both ${o.pagePlace} and click Save. Erga checks them with GitHub before it uses them.`,
    o.target && o.worker
      ? `Or set them in the deploy: put the Client ID in deploy/targets.json (targets.${o.target}.vars.GITHUB_CLIENT_ID), set the secret with "bunx cf workers secrets update GITHUB_CLIENT_SECRET --name ${o.worker}", and deploy.`
      : `Or set them in the deploy: GITHUB_CLIENT_ID as a text binding, and GITHUB_CLIENT_SECRET as a Worker secret.`,
  ];
}

/** One server's status: what it uses, what the page set, and a live check of each. */
export async function statusOf(c: AppContext, o: { origin: string; target: string | null; dev: boolean; takesFrom: string | null; worker?: string; pagePlace: string }): Promise<AuthStatus> {
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
    takesFrom: o.takesFrom,
    check,
    pendingCheck,
    setup: check.state == "working" ? null : setupSteps({ origin: o.origin, target: o.target, worker: o.worker, pagePlace: o.pagePlace }),
  };
}

/** Someone acting on sign-in: their login, how, and whether they come with admin power. */
export type By = Act & { admin?: boolean };

/** The other target's status, or why it couldn't be read. */
export type OtherStatus = AuthStatus | { target: string; origin: string; error: string };

/**
 * What the Authentication page and the admin agent do, on this server ("here") or the other deploy target's ("other":
 * only where it takes this server's values). Admins only. No call answers a secret.
 */
export interface AuthOps {
  /** `by`: who asks, with their admin power (Users.actsAsAdmin): each call checks it. */
  status(by: By): Promise<{ here: AuthStatus; other: OtherStatus | null }>;
  save(by: By, server: "here" | "other", input: { clientId?: unknown; secret?: unknown }): Promise<SaveResult>;
  discard(by: By, server: "here" | "other"): Promise<{ discarded: boolean }>;
  clear(by: By, server: "here" | "other", force?: boolean): Promise<{ cleared: boolean; message: string }>;
}

/**
 * A check, remembered for a minute by the values' hash, so a page that opens
 * often doesn't ask GitHub each time. A failure to reach GitHub isn't kept.
 */
export function cachedCheck(check: (v: AppValues) => Promise<AppCheck>, ttlMs = 60_000): (v: AppValues) => Promise<AppCheck> {
  const seen = new Map<string, { at: number; check: Promise<AppCheck> }>();
  return async (v) => {
    const key = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${v.clientId}\n${v.secret}`))));
    const hit = seen.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.check;
    const p = check(v);
    seen.set(key, { at: Date.now(), check: p });
    p.then((r) => { if (r.state == "unknown") seen.delete(key); }, () => seen.delete(key));
    if (seen.size > 50) seen.delete(seen.keys().next().value!);
    return p;
  };
}

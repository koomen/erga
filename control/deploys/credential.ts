// The control Worker's Cloudflare credential: an OAuth grant, not an API
// token. An admin consents in the browser (Connect Cloudflare on the Ops
// page, a popup: control/routes.ts), Cloudflare's consent page shows Erga's scopes
// (CONTROL_OAUTH_SCOPES), and the grant (its access token, an hour's, and
// its refresh token) is kept here, sealed, in the pipeline's Durable Object
// storage. Before each use the access token is refreshed when it is about
// to expire; a refresh token Cloudflare rotates is kept in the old one's
// place. Revoking the grant on Cloudflare's dashboard (My Profile › Manage
// OAuth authorizations) cuts the control Worker off at once, and the Ops
// page says so, with Connect Cloudflare in place.
//
// Only a refusal ends the grant: Cloudflare answers the refresh with 400 or
// 401 (invalid_grant: the refresh token is revoked, spent or expired). A 429
// (too many requests), a 5xx or no answer is a moment's trouble: the deploy
// fails, says so, and the next try refreshes again (a 429 recorded as final
// stopped every deploy on 2026-10-15). An API call the access token is
// refused on (401) makes the next use refresh first (`refused`).
//
// Nothing here is a person's hand-made token: no permission list to assemble,
// no value to paste. The OAuth client itself ("Erga", public, PKCE) is made
// once on erga.dev's account (deploy/targets.json control.vars names its client id),
// and serves every install (the same consent on erga.dev installs Erga into
// another account: later).
//
// The machine paths (deploy/run.ts, deploy/setup.ts) keep using the person's
// own cf CLI login, which is the same kind of grant.

import { DeployError, OAUTH, type Fetch } from "./pipeline";
import { open, seal, type Sealed } from "./seal";

/**
 * What the control Worker asks for: Workers (upload, settings, secrets,
 * deployments), its containers (containers.write and cloudchamber.write:
 * wrangler asks for both for a container deploy), D1, the repository
 * (Artifacts), routes and DNS (an install makes them; erga.dev's deploys only
 * read them), the zones and the account read; offline_access for the refresh
 * token (it isn't in Cloudflare's scope catalog: it comes from the client's
 * Refresh Token grant type). A scope the client doesn't allow makes Cloudflare
 * send the browser back to /install/callback with error=invalid_scope and a
 * description that names the scope; the page shows it.
 */
export const CONTROL_OAUTH_SCOPES = "workers-scripts.edit containers.write cloudchamber.write d1.write artifacts.write workers-routes.write dns.write zone.read account-settings.read offline_access";


/** The grant as stored: the tokens sealed with the Worker's key; the rest in the clear (nothing secret). */
export interface StoredGrant {
  access: Sealed;
  refresh: Sealed | null;
  /** When the access token expires (ms since the epoch). */
  expiresAt: number;
  scopes: string[];
  /** Who consented, and when; when the access token was last refreshed. */
  by: string;
  at: number;
  refreshedAt: number | null;
  /** The last refresh's refusal (Cloudflare's answer), if the grant no longer works. */
  error: string | null;
  /** When Cloudflare's API last refused the access token (401): the next use refreshes first. */
  refusedAt?: number | null;
}

/** What /install and GET /api/deploys show of it. */
export interface CredentialStatus {
  connected: boolean;
  by: string | null;
  at: number | null;
  refreshedAt: number | null;
  expiresAt: number | null;
  scopes: string[];
  error: string | null;
  /** Why no deploy can run, in words, or null. */
  problem: string | null;
}

/** What the pipeline needs: a token when a deploy runs, and the status. */
export interface Credential {
  token(): Promise<string>;
  status(): Promise<CredentialStatus>;
  /** Cloudflare's API refused the token (401): the next token() checks the grant first. */
  refused?(): Promise<void>;
}

/** A token given outright (a machine's own, the tests'): the same interface. */
export function fixedCredential(token: string | null | undefined, by = "a fixed token"): Credential {
  const value = token?.trim() ?? "";
  return {
    async token() { if (!value) throw new DeployError(NONE); return value; },
    async status() { return { connected: !!value, by: value ? by : null, at: null, refreshedAt: null, expiresAt: null, scopes: [], error: null, problem: value ? null : NONE }; },
  };
}

const NONE = "The control Worker has no Cloudflare credential: an admin connects Cloudflare (a consent in a popup).";
/** Whether Cloudflare's answer to a refresh ends the grant: 400 (invalid_grant) or 401 (invalid_client); never a 429 or a 5xx. */
const refusal = (status: number) => status == 400 || status == 401;
/** Refresh when the access token has less than this left (a deploy's upload must not outlive it). */
const REFRESH_BEFORE_MS = 10 * 60 * 1000;
const KEY = "credential";

/** How a credential's messages name it, and say what to do: the control Worker's (the default), or a person's. */
export interface CredentialWords {
  /** "The control Worker's Cloudflare credential" */
  subject: string;
  /** What brings it back, said where the button is: "an admin connects Cloudflare again". */
  fix: string;
  /** There is none at all. */
  none: string;
}
const CONTROL_WORDS: CredentialWords = { subject: "The control Worker's Cloudflare credential", fix: "an admin connects Cloudflare again", none: NONE };

export interface TokenAnswer { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }

/**
 * The grant in a Durable Object's storage. `client` is the OAuth client
 * (public: its id; a confidential one has a secret too). `sealKey` is the
 * Worker's own (from its SESSION_SECRET): the storage alone doesn't open the
 * tokens.
 */
export class OAuthCredential implements Credential {
  private refreshing: Promise<string> | null = null;

  constructor(private deps: {
    storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; delete?(key: string): Promise<unknown> };
    net: Fetch;
    client: { id: string; secret?: string };
    sealKey: string | Promise<string>;
    now?: () => number;
    log?: (line: string) => void;
    words?: CredentialWords;
  }) {}

  private get words() { return this.deps.words ?? CONTROL_WORDS; }

  private now() { return (this.deps.now ?? Date.now)(); }
  private stored() { return this.deps.storage.get<StoredGrant>(KEY); }

  /** The grant after a consent: Cloudflare's answer to the code exchange, kept; the access token, for a first check. */
  async connect(answer: TokenAnswer, by: string): Promise<string> {
    if (!answer.access_token) throw new DeployError(`Cloudflare gave no access token${answer.error ? ` (${answer.error}${answer.error_description ? `: ${answer.error_description}` : ""})` : ""}.`);
    const grant: StoredGrant = {
      access: await seal(answer.access_token, await this.deps.sealKey),
      refresh: answer.refresh_token ? await seal(answer.refresh_token, await this.deps.sealKey) : null,
      expiresAt: this.now() + (answer.expires_in ?? 3600) * 1000,
      scopes: (answer.scope ?? "").split(/\s+/).filter(Boolean),
      by, at: this.now(), refreshedAt: null, error: null,
    };
    await this.deps.storage.put(KEY, grant);
    this.deps.log?.(`Cloudflare credential connected by ${by}: scopes ${grant.scopes.join(" ") || "(none listed)"}, ${grant.refresh ? "with" : "WITHOUT"} a refresh token`);
    return answer.access_token;
  }

  /** The grant forgotten, and revoked on Cloudflare where possible. */
  async disconnect(): Promise<void> {
    const g = await this.stored();
    if (!g) return;
    try {
      const token = g.refresh ? await open(g.refresh, await this.deps.sealKey) : await open(g.access, await this.deps.sealKey);
      await this.deps.net(OAUTH.revoke, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token, client_id: this.deps.client.id, ...(this.deps.client.secret ? { client_secret: this.deps.client.secret } : {}) }) });
    } catch { /* forgotten here anyway */ }
    await this.deps.storage.delete?.(KEY);
  }

  async status(): Promise<CredentialStatus> {
    const g = await this.stored();
    const w = this.words;
    if (!g) return { connected: false, by: null, at: null, refreshedAt: null, expiresAt: null, scopes: [], error: null, problem: w.none };
    const dead = !g.refresh && g.expiresAt <= this.now();
    return {
      connected: !g.error && !dead, by: g.by, at: g.at, refreshedAt: g.refreshedAt, expiresAt: g.expiresAt, scopes: g.scopes, error: g.error,
      problem: g.error ? `${w.subject} stopped working (${g.error}): ${w.fix}.` : dead ? `${w.subject} expired and had no refresh token: ${w.fix}.` : null,
    };
  }

  /** A token with at least REFRESH_BEFORE_MS left: the stored one, or a fresh one from the refresh token. */
  async token(): Promise<string> {
    const g = await this.stored();
    const w = this.words;
    if (!g) throw new DeployError(w.none);
    if (g.error) throw new DeployError(`${w.subject} stopped working (${g.error}): ${w.fix}.`);
    if (g.expiresAt - this.now() > REFRESH_BEFORE_MS && !g.refusedAt) return open(g.access, await this.deps.sealKey);
    // One refresh at a time: a second caller waits for the first's token.
    this.refreshing ??= this.refresh(g).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /**
   * Cloudflare's API refused the access token (401): the grant may be revoked. The next token() refreshes first,
   * and only the refresh's answer says whether the grant is gone.
   */
  async refused(): Promise<void> {
    const g = await this.stored();
    if (g && !g.error && !g.refusedAt) await this.deps.storage.put(KEY, { ...g, refusedAt: this.now() });
  }

  private async refresh(g: StoredGrant): Promise<string> {
    const w = this.words;
    if (!g.refresh) throw new DeployError(`${w.subject} expired and had no refresh token: ${w.fix}.`);
    const refresh = await open(g.refresh, await this.deps.sealKey);
    const r = await this.deps.net(OAUTH.token, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: this.deps.client.id, ...(this.deps.client.secret ? { client_secret: this.deps.client.secret } : {}) }),
    }).catch((e: Error) => { throw new DeployError(`Couldn't reach Cloudflare to refresh ${w.subject.replace(/^The /, "the ")} (${e.message}): try again in a moment.`); });
    const answer = (await r.json().catch(() => null)) as TokenAnswer | null;
    if (!r.ok || !answer?.access_token) {
      const why = `${r.status}${answer?.error ? ` ${answer.error}` : ""}${answer?.error_description ? `: ${answer.error_description}` : ""}`;
      // Another worker refreshed first (Cloudflare rotates the refresh token, so this one's is spent): use its grant.
      const now = await this.stored();
      if (now && !now.error && now.refreshedAt != g.refreshedAt && now.expiresAt - this.now() > REFRESH_BEFORE_MS) return open(now.access, await this.deps.sealKey);
      // A refusal is final (revoked, spent, or the client changed): said once, kept, until an admin connects again.
      // Anything else (429, 5xx) is a moment's: nothing is kept, and the next use refreshes again.
      if (refusal(r.status)) { await this.deps.storage.put(KEY, { ...g, error: why }); this.deps.log?.(`Cloudflare credential refresh refused: ${why}`); }
      else this.deps.log?.(`Cloudflare credential refresh failed for now: ${why}`);
      throw new DeployError(refusal(r.status) ? `${w.subject} stopped working (${why}): ${w.fix}.` : r.status == 429 ? `Cloudflare asked Erga to slow down while it refreshed ${w.subject.replace(/^The /, "the ")} (${why}): try again in a minute.` : `Cloudflare couldn't refresh ${w.subject.replace(/^The /, "the ")} (${why}): try again in a few minutes.`);
    }
    const next: StoredGrant = {
      ...g,
      access: await seal(answer.access_token, await this.deps.sealKey),
      refresh: answer.refresh_token ? await seal(answer.refresh_token, await this.deps.sealKey) : g.refresh,
      expiresAt: this.now() + (answer.expires_in ?? 3600) * 1000,
      scopes: answer.scope ? answer.scope.split(/\s+/).filter(Boolean) : g.scopes,
      refreshedAt: this.now(), error: null, refusedAt: null,
    };
    await this.deps.storage.put(KEY, next);
    this.deps.log?.(`Cloudflare credential refreshed; the access token lasts until ${new Date(next.expiresAt).toISOString()}`);
    return answer.access_token;
  }
}

// ---------------------------------------------------------------- the consent flow's pieces (control/routes.ts runs them)

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));

/** PKCE: a verifier and its S256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** Where the browser goes to consent. */
export function authorizeUrl(o: { authorize?: string; clientId: string; redirect: string; scopes?: string; state: string; challenge: string }): string {
  const to = new URL(o.authorize ?? OAUTH.authorize);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: o.clientId, redirect_uri: o.redirect, scope: o.scopes ?? CONTROL_OAUTH_SCOPES, state: o.state, code_challenge: o.challenge, code_challenge_method: "S256" })) to.searchParams.set(k, v);
  return to.toString();
}

/** The code, exchanged for the grant. */
export async function exchangeCode(net: Fetch, o: { code: string; redirect: string; verifier: string; client: { id: string; secret?: string } }): Promise<TokenAnswer> {
  const r = await net(OAUTH.token, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: o.code, redirect_uri: o.redirect, client_id: o.client.id, code_verifier: o.verifier, ...(o.client.secret ? { client_secret: o.client.secret } : {}) }),
  }).catch((e: Error) => { throw new DeployError(`Couldn't reach Cloudflare to finish the consent (${e.message}).`); });
  const answer = (await r.json().catch(() => null)) as TokenAnswer | null;
  if (!answer) throw new DeployError(`Cloudflare's token endpoint answered ${r.status} and no JSON.`);
  return answer;
}

/** The Worker's sealing key from its session secret: 32 bytes, base64url (control/deploys/seal.ts's shape). */
export async function sealKeyFrom(secret: string): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`erga-credential:${secret}`))));
}

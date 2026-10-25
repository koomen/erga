// Cloudflare's API, as the deploy calls it: one client (an account's token or OAuth grant), its errors in
// Cloudflare's words, and the OAuth grant's scopes.

export const API = "https://api.cloudflare.com/client/v4";
export type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/** Something Cloudflare refused or that went wrong, said for a person to act on. */
export class DeployError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}
/** The release went up and answers its version, but its health check fails (the live step): what a rollback undoes by itself. */
export class Unhealthy extends DeployError {
  constructor(message: string, readonly why: string) { super(message); }
}

interface Envelope<T> { success: boolean; result: T; errors?: { code: number; message: string }[]; result_info?: unknown }

/**
 * The Cloudflare API with one token. Every call says what it's for (`what`,
 * "make the database"), so a refusal reads as what couldn't be done and why:
 * a token without the permission, a bad token, or Cloudflare's own message.
 */
export class Cloudflare {
  /** `words`: how a refusal is said (explain, by default: an API token's words). */
  constructor(private token: string, private fetch: Fetch = globalThis.fetch, private words: typeof explain = explain) {}

  async call<T>(method: string, path: string, what: string, body?: unknown, opts: { bearer?: string; allow404?: boolean } = {}): Promise<T | null> {
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.bearer ?? this.token}` };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body instanceof Blob) { payload = body; headers["Content-Type"] = body.type || "application/null"; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
    let r: Response;
    try { r = await this.fetch(`${API}${path}`, { method, headers, body: payload }); } catch (e) {
      throw new DeployError(`Couldn't reach Cloudflare to ${what}: ${(e as Error).message}. Try again in a moment.`);
    }
    const answer = (await r.json().catch(() => null)) as Envelope<T> | null;
    if (r.status == 404 && opts.allow404) return null;
    if (r.ok && answer?.success !== false) return (answer?.result ?? null) as T | null;
    throw new DeployError(this.words(what, r.status, answer?.errors ?? []), r.status);
  }
}

/** A refusal from Cloudflare, in plain words. */
export function explain(what: string, status: number, errors: { code: number; message: string }[]): string {
  const said = errors.map((e) => (e.code ? `${e.message} [code ${e.code}]` : e.message)).filter(Boolean).join("; ");
  if (status == 401 || errors.some((e) => e.code == 1000 || e.code == 9109 || e.code == 6003)) {
    return `Cloudflare didn't accept Erga's credential when it tried to ${what}: the grant may be expired or revoked.${said ? ` (Cloudflare said: ${said})` : ""}`;
  }
  if (status == 403 || errors.some((e) => e.code == 10000 || e.code == 9103)) {
    return `Erga's credential isn't allowed to ${what}: the consent didn't grant that permission.${said ? ` (Cloudflare said: ${said})` : ""}`;
  }
  if (status == 429) return `Cloudflare asked us to slow down while we tried to ${what}. Wait a minute and try again.${said ? ` (Cloudflare said: ${said})` : ""}`;
  if (status >= 500) return `Cloudflare had a problem on its side while we tried to ${what}${said ? ` (Cloudflare said: ${said})` : ` (it answered ${status})`}. Try again in a few minutes.`;
  return `Cloudflare refused to ${what}${said ? `: ${said}` : ` (it answered ${status})`}.`;
}

// ------------------------------------------------------------------ authorizing

/**
 * The permissions the deploy needs, as the "Create API token" template link
 * takes them.
 * `registrar` adds buying a domain.
 */
export function tokenPermissions(registrar: boolean) {
  return [
    { key: "account_settings", type: "read", why: "read your account and its workers.dev subdomain" },
    { key: "workers_scripts", type: "edit", why: "upload the Worker and its files" },
    { key: "d1", type: "edit", why: "make the database and set up its tables" },
    { key: "workers_routes", type: "edit", why: "route a domain of yours to the Worker" },
    { key: "zone", type: "read", why: "list your domains" },
    { key: "dns", type: "edit", why: "add the DNS record for documents' pages" },
    ...(registrar ? [{ key: "registrar_domains", type: "edit", why: "only with “Include buying a domain”: search for and register a new domain, after you confirm the price" }] : []),
  ];
}

/** The dashboard's "Create API token" page, filled in with exactly what the deploy needs. */
export function tokenTemplateUrl(registrar: boolean): string {
  const keys = tokenPermissions(registrar).map(({ key, type }) => ({ key, type }));
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}&accountId=*&zoneId=all&name=${encodeURIComponent("Erga deploy")}`;
}

/** Cloudflare's OAuth endpoints. */
export const OAUTH = {
  authorize: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
};

/**
 * The scopes an install's consent asks for (/deploy, cloudflare/deploy-routes.ts): Cloudflare's OAuth scope ids, one for
 * each permission the install needs, all among those Erga's OAuth client allows (CONTROL_OAUTH_SCOPES in
 * deploy/credential.ts: a scope the client doesn't allow fails the consent). Buying a domain (Registrar) isn't among them:
 * that takes an API token with the Registrar permission. CLOUDFLARE_OAUTH_SCOPES overrides them.
 */
export const DEFAULT_OAUTH_SCOPES = "account-settings.read workers-scripts.edit d1.write workers-routes.write zone.read dns.write";

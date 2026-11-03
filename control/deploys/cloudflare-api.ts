// Cloudflare's API, as the deploy calls it: one client (an account's token or OAuth grant), its errors in
// Cloudflare's words, and the OAuth grant's scopes.

import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
export const API = "https://api.cloudflare.com/client/v4";
export type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/** Something Cloudflare refused or that went wrong, said for a person to act on. */
export class DeployError extends Schema.TaggedError<DeployError>()("DeployError", {
  message: Schema.String,
  /** Cloudflare's HTTP status, or 0 when the refusal isn't one of its answers. */
  status: Schema.Number.pipe(Schema.withConstructorDefault(Effect.succeed(0))),
}) {}
/**
 * The release went up and answers its version, but its health check fails (the live step): what a rollback undoes by
 * itself. A DeployError still, so whatever shows a refusal shows this one too.
 */
export class Unhealthy extends DeployError {
  readonly why: string;
  constructor(message: string, why: string) {
    super({ message });
    this.why = why;
  }
}

/** One of Cloudflare's refusals in its answer's `errors`; one of another shape is left out, never the answer. */
const Refusal = Schema.Struct({ code: Schema.optionalKey(Schema.Number), message: Schema.optionalKey(Schema.String) });
const refusalOf = Schema.decodeUnknownOption(Refusal);

/**
 * Every answer of Cloudflare's API: whether it worked, its result, and why not. Read loosely, as Cloudflare sends it,
 * not as its API schema says: the assets' upload answers `"errors": null, "messages": null` for none (recorded
 * 2026-10-29, tests/cloudflare-api.test.ts). A field the envelope doesn't expect never loses the result.
 */
const Envelope = Schema.Struct({
  success: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  result: Schema.optionalKey(Schema.Unknown),
  errors: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  messages: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

/** An answer as the log quotes it: its own words, cut short, with no token in it. */
const quoted = (text: string) => {
  const t = text
    .replace(/"(jwt|token|access_token|refresh_token|signed_url|upload_url)"\s*:\s*"[^"]*"/g, '"$1": "…"')
    .replace(/\s+/g, " ")
    .trim();
  return t ? `“${t.length > 400 ? `${t.slice(0, 400)}…` : t}”` : "nothing";
};
const envelopeOf = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope));

/**
 * The Cloudflare API with one token. Every call says what it's for (`what`,
 * "make the database"), so a refusal reads as what couldn't be done and why:
 * a token without the permission, a bad token, or Cloudflare's own message.
 */
export class Cloudflare {
  /** `words`: how a refusal is said (explain, by default: an API token's words). */
  constructor(private token: string, private fetch: Fetch = globalThis.fetch, private words: typeof explain = explain) {}

  /**
   * One call: its result (null for none, or a 404 that `allow404` allows), as `schema` reads it when there is one. A
   * result that doesn't match the schema is a refusal: Erga can't act on an answer it doesn't understand.
   */
  request<A = unknown>(
    method: string,
    path: string,
    what: string,
    body?: unknown,
    opts: {
      bearer?: string;
      allow404?: boolean;
      schema?: Schema.Codec<A>;
      /** What the call is for, when it must answer one ("an upload token"): an answer without a result says so, in Cloudflare's words. */
      need?: string;
    } = {}
  ): Effect.Effect<A | null, DeployError> {
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.bearer ?? this.token}` };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body instanceof Blob) { payload = body; headers["Content-Type"] = body.type || "application/null"; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
    return Effect.gen({ self: this }, function* () {
      const r = yield* Effect.tryPromise({
        try: () => this.fetch(`${API}${path}`, { method, headers, body: payload }),
        catch: (e) => new DeployError({ message: `Couldn't reach Cloudflare to ${what}: ${(e as Error).message}. Try again in a moment.` }),
      });
      const text = yield* Effect.promise(() => r.text().catch(() => ""));
      const answer = Option.getOrNull(envelopeOf(text));
      if (r.status == 404 && opts.allow404) return null;
      // A success that isn't Cloudflare's JSON (an empty or a proxy's page): said, not taken for "no result" (AGENTS.md rule 5).
      if (r.ok && !answer && text.trim())
        return yield* new DeployError({
          message: `Cloudflare answered ${r.status} but not with its JSON when Erga tried to ${what}: ${quoted(text)}. Try again in a few minutes.`,
          status: r.status,
        });
      if (!r.ok || answer?.success === false) {
        const errors = (answer?.errors ?? [])
          .flatMap((e) => Option.toArray(refusalOf(e)))
          .map((e) => ({ code: e.code ?? 0, message: e.message ?? "" }));
        return yield* new DeployError({ message: this.words(what, r.status, errors), status: r.status });
      }
      if (answer?.result == null) {
        if (!opts.need) return null;
        return yield* new DeployError({
          message: `Cloudflare gave no ${opts.need} when Erga tried to ${what} (it answered ${r.status}: ${quoted(text)}). Try again in a few minutes.`,
          status: r.status,
        });
      }
      if (!opts.schema) return answer.result as A;
      return yield* Schema.decodeUnknownEffect(opts.schema)(answer.result).pipe(
        Effect.mapError(
          (e) =>
            new DeployError({
              message: `Cloudflare answered in a way Erga doesn't understand when it tried to ${what}: ${e.message}`,
              status: r.status,
            })
        )
      );
    });
  }

  /** `request`, as a promise. */
  call<T>(
    method: string,
    path: string,
    what: string,
    body?: unknown,
    opts: { bearer?: string; allow404?: boolean } = {}
  ): Promise<T | null> {
    return Effect.runPromise(this.request<T>(method, path, what, body, opts));
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
 * The scopes an install's consent asks for (/deploy, control/install/routes.ts): Cloudflare's OAuth scope ids, one for
 * each permission the install needs, all among those Erga's OAuth client allows (CONTROL_OAUTH_SCOPES in
 * control/deploys/credential.ts: a scope the client doesn't allow fails the consent). Buying a domain (Registrar) isn't among them:
 * that takes an API token with the Registrar permission. offline_access gives a refresh token: the install hands the
 * grant to the new control Worker (control/install/install.ts), so the person consents once. CLOUDFLARE_OAUTH_SCOPES
 * overrides them.
 */
export const DEFAULT_OAUTH_SCOPES =
  "account-settings.read workers-scripts.edit d1.write workers-routes.write zone.read dns.write offline_access";

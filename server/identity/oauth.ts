// MCP's sign-in (the MCP authorization spec, 2025-06-18: OAuth 2.1 with PKCE). An agent's app (Claude Code, Codex)
// adds <origin>/mcp and gets a 401 that names this server's metadata. It registers itself, and opens /oauth/authorize
// in its person's browser. The person signs in (if they aren't) and approves on /tokens/approve, the page that
// approves a device flow's request (tokens-page.ts). The browser goes back to the app with a code, and the app trades
// the code and its PKCE verifier for an ordinary agent token (documents scope) at /oauth/token. The token lasts until
// the person revokes it at /tokens: there is no refresh token, as agent tokens have no other expiry.
//
//   GET  /.well-known/oauth-protected-resource      /mcp's metadata (RFC 9728): the resource, and who signs in for it
//   GET  /.well-known/oauth-protected-resource/mcp  the same, where a client looks for /mcp's own
//   GET  /.well-known/oauth-authorization-server    the authorization server's metadata (RFC 8414)
//   POST /oauth/register                            an app registers (RFC 7591): a public client, with its redirect URIs
//   GET  /oauth/authorize                           the person signs in, then approves on /tokens/approve
//   POST /oauth/token                               the app trades the code and its PKCE verifier for the token
//
// A client is not kept: its client_id holds its name and redirect URIs, signed with the server's secret.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerResponse } from "effect/http";
import { page, signInFirst } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { base64url, fromBase64url } from "../../shared/bytes.ts";
import { call, ctx, Field, form, json, query, redirect, text, type Route } from "../http.ts";
import { sign, unsign } from "./session.ts";
import { LABEL_MAX } from "./tokens.ts";

/** The scope an app gets: all the person's documents, no admin power (as the editor's Share button gives). */
const SCOPE = "documents";

/** Where /mcp's metadata is: the 401 from /mcp names it (server/api.ts). */
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource`;

/** /mcp's metadata (RFC 9728). */
export const resourceMetadata = (origin: string) => ({
  resource: `${origin}/mcp`,
  authorization_servers: [origin],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ["header"],
  resource_name: "Erga",
  resource_documentation: `${origin}/llms.txt`,
});

/** The authorization server's metadata (RFC 8414): public clients, the code flow, PKCE with S256 only. */
export const serverMetadata = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  registration_endpoint: `${origin}/oauth/register`,
  scopes_supported: [SCOPE],
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  service_documentation: `${origin}/llms.txt`,
});

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NEVER = new Set(["javascript:", "data:", "file:", "blob:", "about:", "vbscript:", "ftp:", "ws:", "wss:"]);

/**
 * A redirect URI an app may register: https, http to this computer only (loopback, RFC 8252), or an app's own scheme
 * (cursor://...). Never one that runs in a page, and never with a fragment.
 */
export function redirectAllowed(uri: string): boolean {
  if (uri.length > 500 || !URL.canParse(uri)) return false;
  const u = new URL(uri);
  if (u.hash || NEVER.has(u.protocol)) return false;
  if (u.protocol == "http:") return LOOPBACK.has(u.hostname);
  return true;
}

/** Where a redirect URI sends the person, in words for the approval page: an app on their own computer, or a site. */
export function whereBack(uri: string): string {
  const u = new URL(uri);
  if (u.protocol == "http:" && LOOPBACK.has(u.hostname)) return "the app, on this computer";
  return u.origin != "null" ? u.origin : `${u.protocol}//${u.host}`;
}

/** The redirect URI with OAuth's answer added to its query (a value of null is left out). */
export function callbackUrl(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.href;
}

/** A registered app: its name, as it gave it, and its redirect URIs. */
export interface Client {
  name: string;
  redirectUris: string[];
}

/** The client_id key: the server's secret, apart from the sessions' use of it. */
const clientKey = (secret: string) => `${secret}:oauth-client`;
const ClientJson = Schema.fromJsonString(Schema.Struct({ n: Schema.String, r: Schema.Array(Schema.String) }));

/** A client's client_id: its name and redirect URIs, signed. */
export const clientIdFor = (secret: string, c: Client) =>
  sign(clientKey(secret), base64url(new TextEncoder().encode(JSON.stringify({ n: c.name, r: c.redirectUris }))));

/** The client a client_id names, if this server signed it. */
export async function clientOf(secret: string, id: string): Promise<Client | null> {
  if (!id || id.length > 4000) return null;
  const value = await unsign(clientKey(secret), id);
  if (!value) return null;
  try {
    const c = Schema.decodeUnknownOption(ClientJson)(new TextDecoder().decode(fromBase64url(value)));
    return c._tag == "Some" ? { name: c.value.n, redirectUris: [...c.value.r] } : null;
  } catch {
    return null;
  }
}

/** The metadata and the client's calls may come from a page's script (an MCP app in a browser): no cookies, so any origin. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
};
/** An OAuth error, as RFC 6749 has it. */
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status, CORS);

const Registration = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  client_name: Schema.optionalKey(Schema.String),
});

const AuthorizeQuery = Schema.Struct({
  client_id: Field,
  redirect_uri: Field,
  response_type: Field,
  code_challenge: Field,
  code_challenge_method: Field,
  state: Field,
  resource: Field,
});

const TokenForm = Schema.Struct({ grant_type: Field, code: Field, redirect_uri: Field, client_id: Field, code_verifier: Field });

/** The routes at the top of this file. */
export const oauthRoutes: Route = Effect.gen(function* () {
  const { request, platform, url } = yield* ctx;
  const path = url.pathname.replace(/\/+$/, "");
  const origin = url.origin;
  const method = request.method;
  const read = method == "GET" || method == "HEAD";
  const preflight = method == "OPTIONS";

  if (path == "/.well-known/oauth-protected-resource" || path == "/.well-known/oauth-protected-resource/mcp") {
    if (preflight) return HttpServerResponse.empty({ status: 204, headers: CORS });
    return read
      ? json(resourceMetadata(origin), 200, { ...CORS, "Cache-Control": "max-age=3600" })
      : text("GET only.", 405, { Allow: "GET" });
  }
  if (path == "/.well-known/oauth-authorization-server") {
    if (preflight) return HttpServerResponse.empty({ status: 204, headers: CORS });
    return read
      ? json(serverMetadata(origin), 200, { ...CORS, "Cache-Control": "max-age=3600" })
      : text("GET only.", 405, { Allow: "GET" });
  }

  if (path == "/oauth/register") {
    if (preflight) return HttpServerResponse.empty({ status: 204, headers: CORS });
    if (method != "POST") return text("POST only.", 405, { Allow: "POST" });
    const raw = yield* call(() => request.text());
    const asked = Schema.decodeUnknownOption(Schema.fromJsonString(Registration))(raw);
    if (asked._tag == "None") return oauthError("invalid_client_metadata", "Send JSON with redirect_uris (a list of URIs).");
    const uris = [...new Set(asked.value.redirect_uris)];
    if (!uris.length || uris.length > 10) return oauthError("invalid_redirect_uri", "Give 1 to 10 redirect_uris.");
    const bad = uris.find((u) => !redirectAllowed(u));
    if (bad)
      return oauthError(
        "invalid_redirect_uri",
        `${bad} can't be a redirect URI: use https, http to localhost or 127.0.0.1, or the app's own scheme.`
      );
    const name = (asked.value.client_name ?? "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) || "An MCP app";
    const clientId = yield* call(() => clientIdFor(platform.secret, { name, redirectUris: uris }));
    return json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      },
      201,
      CORS
    );
  }

  if (path == "/oauth/authorize") {
    if (!read) return text("GET only.", 405, { Allow: "GET" });
    const q = yield* query(AuthorizeQuery).pipe(Effect.orDie);
    const client = yield* call(() => clientOf(platform.secret, q.client_id));
    // Until the redirect URI is known to be the app's, an error is a page here, never a redirect.
    const wrong = (why: string) => page("This sign-in link doesn't work", `${esc(why)} Ask your agent's app to add Erga again.`, 400);
    if (!client) return wrong("The app that sent you here isn't registered with this server.");
    const redirectUri = q.redirect_uri || (client.redirectUris.length == 1 ? client.redirectUris[0] : "");
    if (!client.redirectUris.includes(redirectUri)) return wrong("The address it asks to go back to isn't one it registered.");
    const back = (error: string, description: string) =>
      redirect(callbackUrl(redirectUri, { error, error_description: description, state: q.state || null }));
    if (q.response_type != "code") return back("unsupported_response_type", "Only response_type=code.");
    if (q.code_challenge_method != "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge))
      return back("invalid_request", "PKCE is required: code_challenge with code_challenge_method=S256.");
    if (q.resource && ![`${origin}/mcp`, origin, `${origin}/`].includes(q.resource))
      return back("invalid_target", `This server signs in for ${origin}/mcp only.`);
    const session = yield* call(() => platform.sessionOf(request));
    if (!session) return signInFirst(url.pathname + url.search);
    if (session.agent || session.test)
      return page("Sign in as yourself", "Only a person, signed in as themselves, can let an app act for them.", 403);
    const asked = yield* call(() =>
      platform.tokens.request(
        client.name,
        { scope: SCOPE },
        { client: q.client_id, redirectUri, challenge: q.code_challenge, state: q.state || null }
      )
    );
    return redirect(`/tokens/approve?code=${encodeURIComponent(asked.userCode)}`);
  }

  if (path == "/oauth/token") {
    if (preflight) return HttpServerResponse.empty({ status: 204, headers: CORS });
    if (method != "POST") return text("POST only.", 405, { Allow: "POST" });
    const f = yield* form(TokenForm).pipe(Effect.orElseSucceed(() => null));
    if (!f) return oauthError("invalid_request", "Send the request as a form (application/x-www-form-urlencoded).");
    if (f.grant_type != "authorization_code") return oauthError("unsupported_grant_type", "Only grant_type=authorization_code.");
    if (!(yield* call(() => clientOf(platform.secret, f.client_id))))
      return oauthError("invalid_client", "This server didn't register that client_id.", 401);
    const got = yield* call(() => platform.tokens.exchange(f.code, f.client_id, f.redirect_uri, f.code_verifier));
    if (!got)
      return oauthError(
        "invalid_grant",
        "That code expired, was used, or doesn't match the client, the redirect URI or the PKCE verifier."
      );
    return json({ access_token: got.token, token_type: "Bearer", scope: got.info.scope }, 200, { ...CORS, Pragma: "no-cache" });
  }

  return text("Not found", 404);
});

/** The paths oauthRoutes answers. */
export const isOAuthPath = (path: string) => path.startsWith("/.well-known/oauth-") || path == "/oauth" || path.startsWith("/oauth/");

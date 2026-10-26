// A pretend Google, for the tests: the parts of Google's OAuth that Erga's sign-in touches
// (server/identity/sign-in.ts), under one origin (Platform.signIn.google, server/identity/apps.ts googleEndpoints):
//
//   GET  /o/oauth2/v2/auth     Google's sign-in page: answers at once, back to redirect_uri with a code (as `user`)
//   POST /token                the code for an access token (the client's id, secret and redirect_uri checked);
//                              a code that can't be real answers invalid_grant, as Google does
//   GET  /v1/userinfo          who the token is: sub, email, email_verified, name, picture, and hd for a Workspace account

export interface MockGoogleUser {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  hd?: string;
  picture?: string;
}
export interface MockGoogleOptions {
  clientId: string; clientSecret: string;
  /** The redirect URIs the client allows. */
  redirects: string[];
  /** Who signs in on the pretend sign-in page. */
  user: MockGoogleUser;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

export function mockGoogle(opts: MockGoogleOptions) {
  const codes = new Map<string, { user: MockGoogleUser; redirect: string }>();
  const tokens = new Map<string, MockGoogleUser>();
  const state = { user: opts.user, signIns: 0 };

  async function handle(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request && !init ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname == "/o/oauth2/v2/auth" && request.method == "GET") {
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      if (url.searchParams.get("client_id") != opts.clientId) return json({ error: "invalid_client" }, 401);
      if (!opts.redirects.includes(redirect)) return new Response(`Error 400: redirect_uri_mismatch (${redirect})`, { status: 400 });
      const code = `gcode-${crypto.randomUUID().slice(0, 8)}`;
      codes.set(code, { user: state.user, redirect });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return new Response(null, { status: 302, headers: { Location: back.toString() } });
    }
    if (url.pathname == "/token" && request.method == "POST") {
      const b = new URLSearchParams(await request.text());
      if (b.get("client_id") != opts.clientId) return json({ error: "invalid_client", error_description: "The OAuth client was not found." }, 401);
      if (b.get("client_secret") != opts.clientSecret) return json({ error: "invalid_client", error_description: "Unauthorized" }, 401);
      const c = codes.get(b.get("code") ?? "");
      if (!c) return json({ error: "invalid_grant", error_description: "Malformed auth code." }, 400);
      if (c.redirect != b.get("redirect_uri")) return json({ error: "redirect_uri_mismatch", error_description: "Bad Request" }, 400);
      codes.delete(b.get("code")!);
      const token = `ya29.mock-${crypto.randomUUID()}`;
      tokens.set(token, c.user);
      state.signIns++;
      return json({ access_token: token, token_type: "Bearer", expires_in: 3599, scope: "openid email profile", id_token: "unused" });
    }
    if (url.pathname == "/v1/userinfo" && request.method == "GET") {
      const user = tokens.get(/^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "");
      return user ? json(user) : json({ error: "invalid_token" }, 401);
    }
    return json({ error: "not_found" }, 404);
  }

  return { fetch: handle, state };
}

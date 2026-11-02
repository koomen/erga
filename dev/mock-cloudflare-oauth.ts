// Cloudflare's OAuth, pretended (dev/mock-cloudflare.ts sends it the requests to dash.cloudflare.com/oauth2/): a code
// (always mock-code) for a grant, a refresh token for a new access token, and revoke. A refresh rotates the refresh
// token and ends the old access token at once, as Cloudflare's do (staging, 2026-11-02). The access tokens it gives
// are the mock's full-access ones.

import type { MockState } from "./mock-cloudflare";
import { hex, randomBytes } from "../shared/bytes";

/** What the mock's consent grants (control/deploys/credential.ts CONTROL_OAUTH_SCOPES, as Cloudflare echoes them in the token's `scope`). */
export const MOCK_OAUTH_SCOPES =
  "workers-scripts.edit containers.write cloudchamber.write d1.write artifacts.write workers-routes.write dns.write zone.read account-settings.read offline_access";

/** The OAuth endpoints over the mock's state: an answer, or null for a request that isn't theirs. */
export function mockOAuth(state: MockState) {
  const randomHex = (n: number) => hex(randomBytes(n));
  /** Each refresh token's access token: a refresh ends it. */
  const accessOf = new Map<string, string>();
  return async (req: Request, url: URL): Promise<Response | null> => {
    if (url.origin == "https://dash.cloudflare.com" && url.pathname == "/oauth2/token" && req.method == "POST") {
      const form = new URLSearchParams(await req.text());
      const grant = (scope: string) => {
        const refresh = `mock-refresh-${randomHex(8)}`;
        const access = `mock-oauth-${randomHex(8)}`;
        state.refreshTokens.push(refresh);
        accessOf.set(refresh, access);
        state.oauthGrants++;
        return Response.json({
          access_token: access,
          token_type: "bearer",
          expires_in: state.oauthExpiresIn ?? 3600,
          refresh_token: refresh,
          scope,
        });
      };
      if (form.get("grant_type") == "refresh_token") {
        // A test's 429 (Cloudflare's rate limit): once, then the refresh goes as usual.
        if (state.oauthRefreshStatus) {
          const status = state.oauthRefreshStatus;
          state.oauthRefreshStatus = undefined;
          return Response.json({ error: "rate_limited" }, { status });
        }
        const old = form.get("refresh_token") ?? "";
        if (!state.refreshTokens.includes(old))
          return Response.json({ error: "invalid_grant", error_description: "refresh token revoked or unknown" }, { status: 400 });
        state.refreshTokens = state.refreshTokens.filter((t) => t != old);
        // The refresh ends the access token the old refresh token came with.
        const replaced = accessOf.get(old);
        if (replaced) (state.rotatedTokens ??= []).push(replaced);
        return grant(form.get("scope") || MOCK_OAUTH_SCOPES);
      }
      // mock-code-dead (the tests'): a grant whose access token has expired and whose refresh token Cloudflare no longer
      // takes, as one revoked on the dashboard is: its first use refreshes, and the refresh is refused.
      if (form.get("code") == "mock-code-dead" && form.get("code_verifier"))
        return Response.json({
          access_token: `mock-oauth-${randomHex(8)}`,
          token_type: "bearer",
          expires_in: 0,
          refresh_token: `mock-refresh-dead-${randomHex(8)}`,
          scope: state.oauthScopes || MOCK_OAUTH_SCOPES,
        });
      if (form.get("code") != "mock-code" || !form.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return grant(state.oauthScopes || form.get("scope") || MOCK_OAUTH_SCOPES);
    }
    if (url.origin == "https://dash.cloudflare.com" && url.pathname == "/oauth2/revoke" && req.method == "POST") {
      const form = new URLSearchParams(await req.text());
      state.refreshTokens = state.refreshTokens.filter((t) => t != form.get("token"));
      state.revoked++;
      return new Response(null, { status: 200 });
    }
    return null;
  };
}

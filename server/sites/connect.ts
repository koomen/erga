// Connecting a person's Cloudflare account: an OAuth consent in the browser
// (Authorization Code with PKCE, Erga's public client), the grant kept for
// that person only (rows.ts, CloudflareGrants). The pieces of the flow are
// the control Worker's (deploy/credential.ts); the scopes are a site's only
// (SITE_OAUTH_SCOPES).
//
//   GET /auth/cloudflare/start      to Cloudflare's consent page (?return=<path>, &popup=1), the state and the verifier
//                              in a short cookie. The document's settings open it in a popup; /settings goes there itself
//   GET /auth/cloudflare/callback   back from it: the code exchanged, the scopes checked, the grant kept, its accounts read.
//                              In a popup, a page that tells the document's settings (a BroadcastChannel) and closes;
//                              else back to `return`, with ?cloudflare=connected or ?cloudflare_error=<why>
//   GET /auth/cloudflare/mock/consent   the pretend consent page (local development, ERGA_DEPLOY_MOCK=1)
//
// The consent is the person's own, in their browser: no agent starts it.
// Disconnect (revoke) is POST /settings/cloudflare/disconnect (server/api.ts).

import { authorizeUrl, exchangeCode, pkce, randomToken, type TokenAnswer } from "../../deploy/credential.ts";
import { OAUTH } from "../../deploy/pipeline.ts";
import { mockConsentPage } from "../../deploy/page.ts";
import { esc, page } from "../pages/index.ts";
import type { Platform } from "../platform.ts";
import { listAccounts, SITE_NEEDS, SITE_OAUTH_SCOPES, type SiteOps } from "./publish.ts";

const COOKIE = "erga_cf_consent";
/** What the browser sends back to the channel the document's settings listen on. */
export const CONSENT_CHANNEL = "erga-cloudflare";

const cookieOf = (request: Request, name: string) => request.headers.get("cookie")?.split(/;\s*/).map((c) => c.split("=")).find(([k]) => k == name)?.slice(1).join("=") ?? "";
const consentCookie = (request: Request, value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/auth/cloudflare; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${new URL(request.url).protocol == "https:" ? "; Secure" : ""}`;
const b64u = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
/** A path on this site to come back to; anything else is /settings. */
const safeReturn = (r: string | null) => (r && r.startsWith("/") && !r.startsWith("//") && !r.startsWith("/\\") ? r : "/settings#cloudflare");

interface Consent { state: string; verifier: string; login: string; back: string; popup: boolean }

/** The routes under /auth/cloudflare/. */
export async function cloudflareAuth(request: Request, platform: Platform): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const ops = platform.sites?.(url.origin);
  if (!ops) return page("Not here", "This server doesn't publish documents to domains.", 404);
  if (path == "/auth/cloudflare/mock/consent" && ops.oauth.authorize?.endsWith("/auth/cloudflare/mock/consent")) return mockConsentPage(url);
  if (request.method != "GET" && request.method != "HEAD") return page("Not found", "There's nothing here.", 405);
  const session = await platform.sessionOf(request);
  const redirect = `${url.origin}/auth/cloudflare/callback`;

  if (path == "/auth/cloudflare/start") {
    if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(url.pathname + url.search)}` } });
    if (session.test || session.agent) return page("Not for this sign-in", "Only a person, signed in, connects their Cloudflare account.", 403);
    const { verifier, challenge } = await pkce();
    const c: Consent = { state: randomToken(16), verifier, login: session.login, back: safeReturn(url.searchParams.get("return")), popup: url.searchParams.get("popup") == "1" };
    const to = authorizeUrl({ ...(ops.oauth.authorize ? { authorize: ops.oauth.authorize } : {}), clientId: ops.oauth.clientId, redirect, scopes: SITE_OAUTH_SCOPES, state: c.state, challenge });
    return new Response(null, { status: 302, headers: { Location: to, "Set-Cookie": consentCookie(request, b64u(JSON.stringify(c)), 600), "Cache-Control": "no-store" } });
  }

  if (path == "/auth/cloudflare/callback") {
    let c: Consent | null = null;
    try { c = JSON.parse(unb64u(cookieOf(request, COOKIE))) as Consent; } catch { c = null; }
    const done = (result: { ok: true; accounts: string } | { ok: false; error: string }) => finish(request, c, result);
    const q = url.searchParams;
    if (!c?.state || q.get("state") != c.state) return done({ ok: false, error: "This consent didn't start here, or took more than ten minutes. Try again." });
    if (!session || session.login.toLowerCase() != c.login.toLowerCase()) return done({ ok: false, error: "You're signed in as someone else than the person who started this consent. Try again." });
    if (q.get("error")) {
      const why = q.get("error_description") || q.get("error");
      return done({ ok: false, error: q.get("error") == "access_denied" ? "You didn't authorize Erga on Cloudflare, so nothing is connected." : `Cloudflare didn't authorize Erga: ${why}` });
    }
    let answer: TokenAnswer | null = null;
    try {
      answer = await exchangeCode(ops.oauth.net, { code: q.get("code") ?? "", redirect, verifier: c.verifier, client: { id: ops.oauth.clientId } });
      if (!answer.access_token) return done({ ok: false, error: `Cloudflare gave no token: ${answer.error ?? "no answer"}${answer.error_description ? ` (${answer.error_description})` : ""}.` });
      const refused = refusal(answer);
      if (refused) { await revoke(ops, answer); return done({ ok: false, error: refused }); }
      const dir = platform.directory;
      const token = await dir.cloudflare.connect(session.login, ops.oauth, answer);
      const accounts = await listAccounts(token, ops.net(token));
      if (!accounts.length) {
        await dir.cloudflare.disconnect(session.login, ops.oauth);
        return done({ ok: false, error: "Cloudflare connected, but the grant reaches no account, so Erga disconnected it. Try again, and choose an account on Cloudflare's page." });
      }
      await dir.cloudflare.setAccounts(session.login, accounts);
      return done({ ok: true, accounts: accounts.map((a) => a.name).join(", ") });
    } catch (e) {
      // A grant Erga couldn't keep is revoked, not left behind.
      if (answer?.access_token) { await platform.directory.cloudflare.disconnect(session.login, ops.oauth).catch(() => {}); await revoke(ops, answer); }
      return done({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return page("Not found", "There's nothing here.", 404);
}

/** Why a grant can't publish a site: a scope the person took out, or no refresh token. Null when it can. */
export function refusal(answer: TokenAnswer): string | null {
  const granted = (answer.scope ?? "").split(/\s+/).filter(Boolean);
  const missing = answer.scope == null ? [] : SITE_NEEDS.filter((s) => !granted.includes(s));
  if (missing.length) return `Cloudflare gave Erga less than a site needs: ${missing.join(", ")} ${missing.length == 1 ? "is" : "are"} missing. Connect again, and allow all of them.`;
  if (!answer.refresh_token) return "Cloudflare gave no refresh token, so a site would stop following its document after an hour. Connect again.";
  return null;
}

/** A grant Erga won't keep, revoked at once. */
async function revoke(ops: SiteOps, answer: TokenAnswer): Promise<void> {
  const token = answer.refresh_token ?? answer.access_token ?? "";
  await ops.oauth.net(OAUTH.revoke, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token, client_id: ops.oauth.clientId }) }).catch(() => {});
}

/** The end of the consent: in a popup, a page that tells the document's settings and closes; else back where it started. */
function finish(request: Request, c: Consent | null, result: { ok: true; accounts: string } | { ok: false; error: string }): Response {
  const headers = new Headers({ "Set-Cookie": consentCookie(request, "", 0), "Cache-Control": "no-store" });
  if (c && !c.popup) {
    const back = new URL(c.back, request.url);
    if (result.ok) back.searchParams.set("cloudflare", "connected");
    else back.searchParams.set("cloudflare_error", result.error);
    headers.set("Location", back.pathname + back.search + back.hash);
    return new Response(null, { status: 303, headers });
  }
  const message = JSON.stringify({ type: CONSENT_CHANNEL, ...result }).replace(/</g, "\\u003c");
  const body = `${result.ok ? `Cloudflare is connected (${esc(result.accounts)}).` : esc(result.error)} You can close this window.`;
  const r = page(result.ok ? "Cloudflare connected" : "Cloudflare not connected", `${body}<script>
const m = ${message};
try { new BroadcastChannel(${JSON.stringify(CONSENT_CHANNEL)}).postMessage(m); } catch {}
try { if (window.opener) window.opener.postMessage(m, location.origin); } catch {}
${result.ok ? "setTimeout(() => window.close(), 300);" : ""}
</script>`, result.ok ? 200 : 400);
  for (const [k, v] of headers) r.headers.set(k, v);
  return r;
}

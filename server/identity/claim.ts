// The first admin of a new server: whoever opens the one-time link that setup opens in their browser (`bun erga setup`,
// deploy/own/cli.ts, admin), and signs in. No deploy names an admin, and no agent makes a token: the link is
// signed with this server's own secret, which only the machine that set it up has.
//
//   GET  /auth/claim?t=<claim>[&approve=<code>]   signs the person in first (a good claim lets a new person join:
//                                                 accounts.ts), then asks: become the admin?
//   POST /auth/claim  t, approve                  makes them the admin, and approves the setup's request for its ops
//                                                 token (`approve`: its code), so the same click connects the ops page
//
// A claim is good for 30 minutes, and only while the server has no admin: the first one ends every link. A server
// that has an admin sends the link's person on to approve the request as that admin (/tokens/approve).

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { esc } from "../../shared/html.ts";
import { call, ctx, Field, form, redirect, type Route, text } from "../http.ts";
import { page } from "../pages/index.ts";
import type { Platform } from "../platform";
import { signed } from "../signed.ts";
import { cookies, withCookie } from "./cookies.ts";
import { normalCode } from "./tokens.ts";

const SECONDS = 30 * 60;
const COOKIE = "erga_claim";

/** A claim: nothing but this server's signature and its end. Setup (deploy/own/cli.ts) seals one with the server's SESSION_SECRET. */
export const Claim = signed("claim", Schema.Struct({}), SECONDS);

const good = async (platform: Pick<Platform, "secret" | "directory">, claim: string | null | undefined) =>
  !!(await Claim.open(platform.secret, claim)) && !(await platform.directory.users.hasAdmin());

/** Whether this browser came by a good claim: its person may join, to become the admin. */
export const claims = (platform: Pick<Platform, "secret" | "directory">, request: Request) => good(platform, cookies(request).get(COOKIE));

const ClaimForm = Schema.Struct({ t: Field, approve: Field });

export const claimRoute: Route = Effect.gen(function* () {
  const { platform, request, url } = yield* ctx;
  const post = request.method == "POST";
  if (post && request.headers.get("origin") != url.origin) return text("Forbidden", 403);
  const f = post
    ? yield* form(ClaimForm).pipe(Effect.orDie)
    : { t: url.searchParams.get("t") ?? "", approve: url.searchParams.get("approve") ?? "" };
  const code = normalCode(f.approve);
  const toApprove = code ? `/tokens/approve?code=${encodeURIComponent(code)}` : "/";
  if (yield* call(() => platform.directory.users.hasAdmin())) return redirect(toApprove);
  if (!(yield* call(() => good(platform, f.t))))
    return page(
      "This link does not work any more",
      "The link to become the admin works for 30 minutes. Setup opens a new one: tell your agent to run its <code>bun erga setup</code> command again.",
      410
    );
  const here = `/auth/claim?t=${encodeURIComponent(f.t)}${code ? `&approve=${encodeURIComponent(code)}` : ""}`;
  const session = yield* call(() => platform.sessionOf(request));
  // The sign-in comes first, with the claim in a cookie: it lets this person make their account.
  if (!session || session.agent)
    return withCookie(redirect(`/auth/sign-in?next=${encodeURIComponent(here)}`), request, COOKIE, f.t, SECONDS, "/auth");
  if (!post)
    return page(
      "Become the admin",
      `You are signed in as <b>${esc(session.login)}</b>. This server has no admin yet. As its admin, you decide who may sign in, and you change its settings.
<form method="post" action="/auth/claim"><input type="hidden" name="t" value="${esc(f.t)}"><input type="hidden" name="approve" value="${esc(code)}"><button class="new">Become the admin of ${esc(url.host)}</button></form>`,
      200
    );
  if (!(yield* call(() => platform.directory.users.claim(session.login))))
    return page("This server has an admin already", 'Another sign-in was first. <a href="/">Go to Erga</a>.', 409);
  // The setup's own request, and nothing wider: the ops token reads the deploy facts only.
  const waiting = code ? yield* call(() => platform.tokens.pending(code)) : null;
  if (waiting?.grant.scope == "ops") yield* call(() => platform.tokens.approve(code, { login: session.login, name: session.name }));
  return withCookie(
    page(
      "You are the admin",
      `<b>${esc(session.login)}</b> is the admin of ${esc(url.host)}. Go back to your agent: setup goes on by itself. Or <a href="/">open Erga</a>.`,
      200
    ),
    request,
    COOKIE,
    "",
    0,
    "/auth"
  );
});

// MCP's sign-in, Erga's part (the MCP authorization spec: OAuth 2.1 with PKCE). The gate is the authorization server
// (gate/core.ts: its metadata, the token endpoint, the tokens; it alone signs). An agent's app (Claude Code) adds
// <origin>/mcp, gets a 401 that names the metadata, and opens /oauth/authorize in its person's browser. The gate lets
// that request through only for a person who is signed in, with a request that is whole (a client, a redirect to this
// computer or one the deploy allows, a PKCE challenge). Here the person decides:
//
//   GET  /oauth/authorize?...   the approval page: which app asks, and what it gets
//   POST /oauth/authorize?...   Approve: a grant of the person's (grants.ts), and the answer asks the gate for its
//                               code (caller.ts: "code <grant>"); the gate sends the browser back to the app with it.
//                               Deny: the answer asks the gate to say so to the app ("deny")
//
// The app trades the code at the gate for a token of one hour and a refresh grant; every request with the token reads
// the grant's row (admit.ts), so Revoke in Settings stops the app at once. An app has no registration: it names itself
// (client_id), and the name is only a label on the page and in Settings.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { esc } from "../../shared/html.ts";
import { call, ctx, Field, form, html, NO_STORE, type Route, text } from "../http.ts";
import { appPage, inlineStyle, pageBars, signInFirst } from "../pages/index.ts";
import { asking } from "./caller.ts";
import { GRANT_DAYS, ScopeError } from "./grants.ts";
import { makerOf } from "./tokens-page.ts";

const ApproveForm = Schema.Struct({ answer: Field, scope: Field });

/** Where a redirect URI sends the person, in words for the page: an app on their own computer, or a site. */
function whereBack(uri: string): string {
  const u = URL.canParse(uri) ? new URL(uri) : null;
  if (!u || (u.protocol == "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) return "the app, on this computer";
  return u.origin != "null" ? u.origin : `${u.protocol}//${u.host}`;
}

/** /oauth/authorize: the person lets an agent's app act for them, or not. */
export const authorize: Route = Effect.gen(function* () {
  const { request, platform, url } = yield* ctx;
  const post = request.method == "POST";
  if (!post && request.method != "GET" && request.method != "HEAD") return text("GET or POST.", 405, { Allow: "GET, POST" });
  // Only this site's own page may approve or deny.
  if (post && request.headers.get("origin") != url.origin) return text("Forbidden", 403);
  const session = yield* call(() => platform.sessionOf(request));
  // Signed in at the gate, with no account yet: the account first.
  if (!session) return signInFirst(url.pathname + url.search);
  const who = yield* makerOf;
  if (!who) return text("Only a user, signed in as themselves, can let an app act for them.", 403);
  const admin = yield* call(() => platform.directory.users.isAdmin(session.login));
  const label = url.searchParams.get("client_id") ?? "";
  if (post) {
    const f = yield* form(ApproveForm).pipe(Effect.orDie);
    const done = (line: string) =>
      html(appPage("Approve an agent", inlineStyle("tokens"), `<main><p class="notice">${line}</p></main>`), 200, NO_STORE);
    if (f.answer != "approve") return asking(done("Denied. Go back to the app."), "deny");
    // Admin power only when the person chose it on the page: any other approval gives documents only.
    const made = yield* Effect.tryPromise({
      try: () => platform.grants.make(who, label, { scope: admin && f.scope == "admin" ? "admin" : "documents" }),
      catch: (e) => e,
    }).pipe(
      Effect.catchIf(
        (e): e is ScopeError => e instanceof ScopeError,
        (e) => Effect.succeed(e)
      ),
      Effect.orDie
    );
    if (made instanceof ScopeError) return html(page(session, `<p class="notice error">${esc(made.message)}</p>`), 403, NO_STORE);
    return asking(done("Approved. Go back to the app."), `code ${made.id}`);
  }
  // An admin chooses documents only (the default) or admin power, on purpose.
  const choice = admin
    ? `<fieldset class="choice"><legend>Give it</legend>
<label><input type="radio" name="scope" value="documents" checked><span><b>Documents only</b>: all your documents, but no admin power</span></label>
<label><input type="radio" name="scope" value="admin"><span><b>Admin power</b>: all your documents, and the server's settings, users and sign-in</span></label></fieldset>`
    : "";
  const card = `<section class="card approve"><h2><b>${esc(label.slice(0, 80))}</b> wants to act for you: reading and editing your documents.</h2>
<dl class="grant">${admin ? "" : `<dt>Scope</dt><dd class="scope-documents">All my documents</dd>`}<dt>Expires</dt><dd>${GRANT_DAYS} days from now</dd></dl>
<p>Approve only if you just added Erga to this app. Approve sends you back to <b>${esc(whereBack(url.searchParams.get("redirect_uri") ?? ""))}</b>. You can revoke it at any time in Settings (the menu at your picture).</p>
<form method="post" action="${esc(url.pathname + url.search)}">${choice}<div class="buttons"><button class="new" name="answer" value="approve">Approve</button><button class="deny" name="answer" value="deny">Deny</button></div></form></section>`;
  return html(page(session, card), 200, NO_STORE);
});

/** The approval page. No agent here: the person alone approves or denies. */
const page = (session: Parameters<typeof pageBars>[0], body: string) =>
  appPage(
    "Approve an agent",
    inlineStyle("tokens"),
    `${pageBars(session, [{ label: "Approve an agent" }], { agent: false })}<main>
  <header><div><h1>Approve an agent</h1></div></header>
  ${body}
</main>`
  );

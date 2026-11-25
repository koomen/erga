// Device authorization for remote and headless agents (RFC 8628 over Erga's existing PKCE OAuth flow):
//
//   POST /oauth/device_authorization       an unauthenticated remote agent starts a sign-in with its client_id and
//                                          PKCE challenge, getting a short user_code and verification URL
//   GET  /oauth/device[?user_code=...]     a signed-in person opens this URL in any browser, confirms the code, and
//                                          submits Approve or Deny straight to /oauth/authorize (so the gate alone signs)
//   GET  /oauth/device/done?code=&state=   the gate redirects the person's browser here with the PKCE-bound code;
//                                          we attach it to the matching pending device_codes row
//   POST /oauth/device_authorization/poll  the remote agent polls until approved, receives the one-time PKCE code,
//                                          and exchanges it with its code_verifier at /oauth/token

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { clientLabel, DEVICE_DONE } from "../../gate/core.ts";
import { esc } from "../../shared/html.ts";
import { call, ctx, html, json, NO_STORE, type Route, text } from "../http.ts";
import { appPage, inlineStyle, pageBars, signInFirst } from "../pages/index.ts";
import { formatUserCode, GRANT_DAYS } from "./grants.ts";
import { makerOf } from "./tokens-page.ts";

const B64_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

const StartBody = Schema.Struct({
  client_id: Schema.String,
  code_challenge: Schema.String,
  code_challenge_method: Schema.Literal("S256"),
});

const PollBody = Schema.Struct({
  device_code: Schema.String,
  client_id: Schema.String,
});

/** Reads a JSON or URL-encoded form POST body into a plain object; null if malformed. */
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await request.text().catch(() => "");
  if (!raw || raw.length > 8192) return null;
  const type = request.headers.get("content-type") ?? "";
  if (/^application\/json\b/i.test(type)) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed == "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params) if (!(k in out)) out[k] = v;
  return out;
}

const page = (session: Parameters<typeof pageBars>[0], body: string) =>
  appPage(
    "Approve an agent",
    inlineStyle("tokens"),
    `${pageBars(session, [{ label: "Approve an agent" }], { agent: false })}<main>
  <header><div><h1>Approve an agent</h1></div></header>
  ${body}
</main>`
  );

const codeForm = (value = "", error = "") => {
  const notice = error ? `<p class="notice error">${esc(error)}</p>` : "";
  return `${notice}<section class="card approve"><h2>Enter the code shown in your agent</h2>
<p>Sign in to a remote or terminal agent by entering its 8-character code.</p>
<form method="get" action="/oauth/device"><label class="field"><span>Code</span><input type="text" name="user_code" value="${esc(value)}" placeholder="XXXX-XXXX" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore required autofocus></label><div class="buttons"><button class="new" type="submit">Continue</button></div></form></section>`;
};

/** POST /oauth/device_authorization: starts a remote device-code sign-in. */
export const deviceStart: Route = Effect.gen(function* () {
  const { request, platform, url } = yield* ctx;
  const raw = yield* call(() => readBody(request));
  const parsed = raw ? Schema.decodeUnknownOption(StartBody)(raw) : null;
  if (!parsed || parsed._tag != "Some") {
    return json(
      { error: "invalid_request", error_description: "client_id, code_challenge, and code_challenge_method=S256 are required." },
      400,
      NO_STORE
    );
  }
  const { client_id, code_challenge } = parsed.value;
  if (!client_id || client_id.length > 200 || !B64_CHALLENGE.test(code_challenge)) {
    return json({ error: "invalid_request", error_description: "Invalid client_id or S256 code_challenge." }, 400, NO_STORE);
  }
  const started = yield* call(() => platform.grants.startDevice(client_id, code_challenge));
  const verificationUri = `${url.origin}/oauth/device`;
  return json(
    {
      device_code: started.deviceCode,
      user_code: started.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(started.userCode)}`,
      expires_in: started.expiresIn,
      interval: started.interval,
    },
    200,
    NO_STORE
  );
});

/** POST /oauth/device_authorization/poll: checks whether the human approved the device code. */
export const devicePoll: Route = Effect.gen(function* () {
  const { request, platform, url } = yield* ctx;
  const raw = yield* call(() => readBody(request));
  const parsed = raw ? Schema.decodeUnknownOption(PollBody)(raw) : null;
  if (!parsed || parsed._tag != "Some" || !parsed.value.device_code || !parsed.value.client_id) {
    return json({ error: "invalid_request" }, 400, NO_STORE);
  }
  const polled = yield* call(() => platform.grants.pollDevice(parsed.value.device_code, parsed.value.client_id));
  if (polled.status == "approved") {
    return json({ code: polled.code, redirect_uri: `${url.origin}${DEVICE_DONE}` }, 200, NO_STORE);
  }
  const error =
    polled.status == "pending"
      ? "authorization_pending"
      : polled.status == "denied"
        ? "access_denied"
        : polled.status == "expired"
          ? "expired_token"
          : "invalid_grant";
  return json({ error }, 400, NO_STORE);
});

/** GET /oauth/device[?user_code=...]: the human verifies the code and approves or denies via /oauth/authorize. */
export const devicePage: Route = Effect.gen(function* () {
  const { request, platform, url } = yield* ctx;
  const session = yield* call(() => platform.sessionOf(request));
  if (!session) return signInFirst(url.pathname + url.search);
  const who = yield* makerOf;
  if (!who) return text("Only a user, signed in as themselves, can let an app act for them.", 403);

  const askedCode = url.searchParams.get("user_code")?.trim() ?? "";
  if (!askedCode) return html(page(session, codeForm()), 200, NO_STORE);

  const row = yield* call(() => platform.grants.findDevice(askedCode));
  if (!row) {
    return html(page(session, codeForm(askedCode, "That code is invalid or expired. Start sign-in again in your agent.")), 200, NO_STORE);
  }

  const admin = yield* call(() => platform.directory.users.isAdmin(session.login));
  const label = clientLabel(row.clientId) || "Agent";
  const formatted = formatUserCode(row.userCode);
  const action = `/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: row.clientId,
    redirect_uri: `${url.origin}${DEVICE_DONE}`,
    code_challenge: row.challenge,
    code_challenge_method: "S256",
    state: row.approveState,
  }).toString()}`;
  const choice = admin
    ? `<fieldset class="choice"><legend>Give it</legend>
<label><input type="radio" name="scope" value="documents" checked><span><b>Documents only</b>: all your documents, but no admin power</span></label>
<label><input type="radio" name="scope" value="admin"><span><b>Admin power</b>: all your documents, and the server's settings, users and sign-in</span></label></fieldset>`
    : "";
  const card = `<section class="card approve"><h2><b>${esc(label.slice(0, 80))}</b> wants to act for you: reading and editing your documents.</h2>
<dl class="grant"><dt>Code</dt><dd><span class="code">${esc(formatted)}</span></dd>${admin ? "" : `<dt>Scope</dt><dd class="scope-documents">All my documents</dd>`}<dt>Expires</dt><dd>${GRANT_DAYS} days from now</dd></dl>
<p>Confirm that the code above matches your agent before you approve. You can revoke access at any time in Settings (the menu at your picture).</p>
<form method="post" action="${esc(action)}">${choice}<div class="buttons"><button class="new" name="answer" value="approve">Approve</button><button class="deny" name="answer" value="deny">Deny</button></div></form></section>`;
  return html(page(session, card), 200, NO_STORE);
});

/** GET /oauth/device/done: stores the gate-signed PKCE code (or denial) for the polling remote agent. */
export const deviceDone: Route = Effect.gen(function* () {
  const { request, platform, url } = yield* ctx;
  const session = yield* call(() => platform.sessionOf(request));
  if (!session) return signInFirst(url.pathname + url.search);
  const who = yield* makerOf;
  if (!who) return text("Only a user, signed in as themselves, can let an app act for them.", 403);

  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const err = url.searchParams.get("error") ?? "";
  const outcome =
    state && (code || err)
      ? yield* call(() => platform.grants.completeDevice(state, code ? { ok: true, code } : { ok: false }))
      : "missing";
  const notice =
    outcome == "approved"
      ? "Approved. You can close this tab and return to your agent."
      : outcome == "denied"
        ? "Denied. You can close this tab."
        : "This sign-in code expired or was already used.";
  return html(page(session, `<p class="notice">${notice}</p>`), 200, NO_STORE);
});

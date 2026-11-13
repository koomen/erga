// A person's tokens (server/app.ts sends /tokens/... here): approving or denying an agent's request for one, a page;
// and, for the Settings dialog (client/agent/settings-dialog.ts), making one, as JSON. The list
// and Revoke are the operations whoami and revoke. And a token's expiry as given, which the API reads too.
// The routes are ROUTES, below.


import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { nameOf } from "../../document/names.ts";
import { appPage, pageBars, inlineStyle, page, safeNext } from "../pages/index.ts";
import { dateTag, esc } from "../../shared/html.ts";
import { type Platform, type Session, whoOf } from "../platform";
import { ADMIN_DAYS, adminEnd, normalCode, ScopeError, type Scope } from "./tokens.ts";
import { type Note, noteOf, readOnce, seeOther } from "./flash.ts";
import { callbackUrl, whereBack } from "./mcp-oauth.ts";
import { call, ctx, Field, form, html, json, NO_STORE, redirect, text, type Route } from "../http.ts";
import { routeFor, SECRET, SIGN_IN, type RouteRow } from "../../shared/routes.ts";

/** A token's expiry as given: an ISO 8601 time, a date (the end of that day, UTC), milliseconds since the epoch, or nothing (never). */
export function expiryOf(v: unknown): number | null | "bad" {
  if (v == null || v === "") return null;
  if (typeof v == "number") return Number.isFinite(v) ? v : "bad";
  if (typeof v != "string") return "bad";
  const s = v.trim();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59Z`) : /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(t) ? t : "bad";
}

// ---------------------------------------------------------------- /tokens

export const tokensRoutes: Route = Effect.gen(function* () {
  const { request, platform, url } = yield* ctx;
  const path = url.pathname.replace(/\/+$/, "");
  const session = yield* call(() => platform.sessionOf(request));
  if (!session) return redirect(`/auth/sign-in?next=${encodeURIComponent(safeNext(path + url.search))}`);
  if (session.agent) return page("Not for agents", "Tokens are made and approved by people, signed in.", 403);
  const post = request.method == "POST";
  // Only this site's own pages may make, approve or deny.
  if (post && request.headers.get("origin") != url.origin) return text("Forbidden", 403);
  const found = routeFor(ROUTES, post ? "POST" : "GET", path);
  if (!found)
    return page(
      "Not found",
      `There's nothing here. Your tokens are in Settings (the menu at your picture): <a href="/docs#settings">open it</a>.`,
      404
    );
  // How they act goes along: the tokens refuse anyone who isn't there in person (Tokens.mint).
  const via = whoOf(session).via;
  const who = { login: session.login, name: session.name, ...(via ? { via } : {}) };
  return yield* found.route.run({ request, platform, url, session, post, who });
});

/** The person who asks, signed in as themselves, from this site's own page. */
interface Asked {
  readonly request: Request;
  readonly platform: Platform;
  readonly url: URL;
  readonly session: Session;
  readonly post: boolean;
  readonly who: { login: string; name: string; via?: string };
}

/** A token call that may refuse the scope (ScopeError): its result, or the refusal. */
const scoped = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => e }).pipe(
    Effect.map((value) => ({ value })),
    Effect.catchIf(
      (e): e is ScopeError => e instanceof ScopeError,
      (e) => Effect.succeed({ refused: e.message })
    ),
    Effect.orDie
  );

/** { label, scope, doc?, expires? }: a new token, answered once ({ token, info }). */
const newToken = ({ request, platform, who }: Asked): Route =>
  Effect.gen(function* () {
    const f = yield* call(() => request.json().catch(() => ({}))).pipe(
      Effect.flatMap((b) => Schema.decodeUnknownEffect(NewToken)(b)),
      Effect.orElseSucceed(() => ({}) as typeof NewToken.Type)
    );
    const expires = expiryOf(f.expires);
    if (expires == "bad") return json({ ok: false, error: "That expiry isn't a date." }, 400);
    const r = yield* scoped(() =>
      platform.tokens.mint(who, f.label?.trim() || "Agent", { scope: (f.scope || "documents") as Scope, docId: f.doc || null, expires })
    );
    return "refused" in r
      ? json({ ok: false, error: r.refused }, 400)
      : json({ ok: true, token: r.value.token, info: r.value.info }, 200, NO_STORE);
  });

/**
 * GET ?code=: an agent's request for a token, with Approve (if the person may give it) and Deny. POST: code, answer
 * (approve or deny), scope (documents: an admin request approved as documents only).
 */
const approve = ({ request, platform, url, session, post, who }: Asked): Route =>
  Effect.gen(function* () {
  // A POST answers 303 to a page, never with one (flash.ts): Back and Reload don't send the form again. Its note is for
  // this person only.
  const f = post ? yield* form(ApproveForm).pipe(Effect.orDie) : Schema.decodeUnknownSync(ApproveForm)({});
  const back = (location: string, note: Note) => seeOther(platform, request, location, { ...note, for: session.login });
  const got = post ? null : yield* call(() => noteOf(platform, request));
  const note = got?.for == session.login ? got : {};
  const show = (notice: string) =>
    Effect.map(
      call(() => approvePage(session, notice)),
      (r) => readOnce(r, request)
    );
  const error = (message: string) => `<p class="notice error">${esc(message)}</p>`;
  const done = (text: string) =>
    `<p class="notice">${text} You can revoke its token at any time in Settings (the menu at your picture).</p>`;
  const code = normalCode(post ? f.code : (url.searchParams.get("code") ?? ""));
  if (!code) {
    if (note.denied) return yield* show(`<p class="notice">Denied: <b>${esc(note.denied)}</b> gets no token.</p>`);
    if (note.approved) return yield* show(done(`Approved: <b>${esc(note.approved)}</b> has its token now. Go back to it.`));
    return yield* show(error(note.error ?? "No request to approve here. An agent that asks for a token gives you a link to this page."));
  }
  const waiting = yield* call(() => platform.tokens.pending(code));
  if (post) {
    if (!waiting) return yield* back(`/tokens/approve?code=${encodeURIComponent(code)}`, {});
    if (f.answer == "deny") {
      const denied = yield* call(() => platform.tokens.deny(code));
      // An agent's app that asked through the browser (MCP's sign-in) hears it from the person's browser.
      if (denied?.oauth)
        return redirect(
          callbackUrl(denied.oauth.redirectUri, {
            error: "access_denied",
            error_description: "The person denied it.",
            state: denied.oauth.state,
          }),
          303
        );
      return yield* back("/tokens/approve", { denied: waiting.label });
    }
    // Admin power only when the person chose it on the card: any other approval of an admin request gives documents only.
    const r = yield* scoped(() => platform.tokens.approve(code, who, f.scope != "admin"));
    if ("refused" in r) return yield* back(`/tokens/approve?code=${encodeURIComponent(code)}`, { refused: r.refused });
    // MCP's sign-in: back to the app, with the code it trades for the token.
    if (r.value?.oauth)
      return redirect(callbackUrl(r.value.oauth.redirectUri, { code: r.value.oauth.code, state: r.value.oauth.state }), 303);
    return yield* back("/tokens/approve", r.value ? { approved: r.value.info.label } : { error: "That request has expired." });
  }
  if (!waiting)
    return yield* show(error(`That request (${code}) has expired, or was already approved or denied. Ask the agent to start again.`));
  const refused = note.refused ? error(`${note.refused} The request is still waiting: deny it, or ask the agent for another scope.`) : "";
  return yield* show(refused + (yield* call(() => approvalCard(platform, session, code, waiting))));
  });

export const ROUTES: readonly RouteRow<(a: Asked) => Route>[] = [
  {
    method: "GET",
    path: "/tokens/approve",
    run: approve,
    action: "An agent's request for a token, to approve or deny",
    domain: "none",
    exempt: SIGN_IN,
  },
  {
    method: "POST",
    path: "/tokens/approve",
    run: approve,
    action: "Approve an agent's request for a token (/tokens/approve)",
    domain: "admin",
    exempt: `${SECRET} (it hands a new token to an outside agent)`,
  },
  { method: "POST", path: "/tokens/new", run: newToken, action: "Make an agent token (Settings)", domain: "admin", exempt: SECRET },
];

/** The approval page's form (a field that's missing is ""). */
const ApproveForm = Schema.Struct({ code: Field, answer: Field, scope: Field });
/** A new token, as the Settings dialog sends it (client/agent/settings-dialog.ts). */
const NewToken = Schema.Struct({
  label: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  doc: Schema.optionalKey(Schema.String),
  expires: Schema.optionalKey(Schema.String),
});

const SCOPE_NAMES: Record<Scope, string> = { document: "One document", documents: "All my documents", admin: "Admin", ops: "Ops" };

/** A document token's document, as a line shows it: its title and address, or "a document that's gone". */
async function docLabel(platform: Platform, ref: string | null): Promise<string> {
  const doc = ref ? await platform.directory.find(ref) : null;
  return doc ? `${esc(nameOf(doc).title)} <span class="addr">${esc(nameOf(doc).address)}</span>` : `<span class="never">a document that's gone</span>`;
}

const day = (t: number) => dateTag(t, "day");

/** The card on /tokens/approve: what the agent asks for, and Approve (if the person may give it) or Deny. */
async function approvalCard(
  platform: Platform,
  session: Session,
  code: string,
  waiting: { label: string; grant: { scope: Scope; docId: string | null; expires: number | null }; oauth: { redirectUri: string } | null }
): Promise<string> {
  const g = waiting.grant;
  const may = await platform.tokens.check({ login: session.login, name: session.name }, g).then(
    () => null,
    (e) => (e instanceof ScopeError ? e.message : "This request can't be approved.")
  );
  // The card's heading is the request itself; `more`: what else that scope means.
  const [what, more] =
    g.scope == "document"
      ? [
          `reading and editing one document: ${await docLabel(platform, g.docId)}.`,
          "It can do there what you can do, and nothing anywhere else.",
        ]
      : g.scope == "documents"
        ? ["reading and editing your documents.", ""]
        : g.scope == "ops"
          ? [
              "reading this server's deploy facts.",
              "The commit it runs, and its Cloudflare account, Worker, database and domains. It reads nothing else: no documents, and no admin power.",
            ]
          : [
              "reading and editing your documents, and admin power.",
              "Admin power is everything you can do in Erga, the server's settings, users, source and deploys included, while you're an admin.",
            ];
  // An admin request the person may approve: they choose documents only (the default) or admin power, on purpose.
  const choose = g.scope == "admin" && !may;
  const choice = choose
    ? `<fieldset class="choice"><legend>Give it</legend>
<label><input type="radio" name="scope" value="documents" checked><span><b>Documents only</b>: all your documents, but no admin power</span></label>
<label><input type="radio" name="scope" value="admin"><span><b>Admin power</b>: all your documents, and the server's settings, users, source and deploys, for ${ADMIN_DAYS} days at most</span></label></fieldset>`
    : "";
  const asked = g.expires ? day(g.expires) : "Never (until you revoke it)";
  // An admin token ends after ADMIN_DAYS at most (Tokens.check): the card says when each choice ends.
  const ends =
    g.scope != "admin"
      ? asked
      : choose
        ? `Documents only: ${asked}<br>Admin power: ${g.expires && g.expires < adminEnd(null) ? day(g.expires) : `${ADMIN_DAYS} days from now`}`
        : day(adminEnd(g.expires));
  return `<section class="card approve"><h2><b>${esc(waiting.label)}</b> wants a token for ${what}</h2>
${more ? `<p>${more}</p>` : ""}<dl class="grant">${choose ? "" : `<dt>Scope</dt><dd class="scope-${g.scope}">${SCOPE_NAMES[g.scope]}</dd>`}<dt>Expires</dt><dd>${ends}</dd></dl>
${
  waiting.oauth
    ? `<p>Approve only if you just added Erga to this app. Approve sends you back to <b>${esc(whereBack(waiting.oauth.redirectUri))}</b>, and the app gets the token.</p>`
    : `<p>Approve only if you initiated this and the code matches:</p>
<p class="code">${esc(code)}</p>`
}
${may ? `<p class="notice error">${esc(may)}</p>` : ""}
<form method="post" action="/tokens/approve"><input type="hidden" name="code" value="${esc(code)}">${choice}<div class="buttons">${may ? "" : `<button class="new" name="answer" value="approve">Approve</button>`}<button class="deny" name="answer" value="deny">Deny</button></div></form></section>`;
}

/** /tokens/approve: the request's card, or what became of it. No agent here: the person alone approves or denies. */
async function approvePage(session: Session, body: string) {
  return html(
    appPage(
      "Approve an agent",
      inlineStyle("tokens"),
      `${pageBars(session, [{ label: "Approve an agent" }], { agent: false })}<main>
  <header><div><h1>Approve an agent</h1></div></header>
  ${body}
</main>`
    ),
    200,
    NO_STORE
  );
}

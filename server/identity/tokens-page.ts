// A person's tokens, as pages (/tokens, server/app.ts sends them here): make one (a scope, an expiry), revoke one,
// and approve or deny an agent's request for one. And a token's expiry as given, which the API reads too.


import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { nameOf } from "../../document/names.ts";
import { appPage, ICON, pageBars, inlineScript, inlineStyle, page, safeNext } from "../pages/index.ts";
import { dateTag, esc } from "../../shared/html.ts";
import { type LiveRow, type LiveRows, type Platform, type Session, whoOf } from "../platform";
import { LABEL_MAX, normalCode, ScopeError, type AgentToken, type Scope } from "./tokens.ts";
import { mintTestToken } from "./sign-in.ts";
import { type Note, noteOf, readOnce, seeOther } from "./flash.ts";
import { callbackUrl, whereBack } from "./oauth.ts";
import { call, ctx, Field, form, html, NO_STORE, redirect, text, type Route } from "../http.ts";

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

/**
 * /tokens: the signed-in person's tokens (make one with a scope and an
 * optional expiry; a revoke is the operation revoke_token), approving or denying an agent's request
 * (/tokens/approve?code=), and, where the platform makes them, a test token
 * for running the test suite. /settings is the same page.
 */
export const tokensRoutes: Route = Effect.gen(function* () {
  const { request, platform, url } = yield* ctx;
  const path = url.pathname.replace(/\/+$/, "");
  const session = yield* call(() => platform.sessionOf(request));
  if (!session) return redirect(`/auth/sign-in?next=${encodeURIComponent(safeNext(path + url.search))}`);
  if (session.agent) return page("Not for agents", "Tokens are made and approved by people, signed in.", 403);
  if (session.test) return page("Not for test people", "Sign in as yourself to make a token.", 403);
  const post = request.method == "POST";
  // Only this site's own pages may make, revoke, approve or deny.
  if (post && request.headers.get("origin") != url.origin) return text("Forbidden", 403);
  const f = post ? yield* form(TokensForm).pipe(Effect.orDie) : Schema.decodeUnknownSync(TokensForm)({});
  const who = { login: session.login, name: session.name };
  const error = (message: string) => `<p class="notice error">${esc(message)}</p>`;
  // A POST answers 303 to a page, never with one (flash.ts): Back and Reload don't send the form again. Its note
  // is for this person only.
  const back = (location: string, note: Note) => seeOther(platform, request, location, { ...note, for: session.login });
  const formPage = (() => {
    const from = URL.canParse(request.headers.get("referer") ?? "") ? new URL(request.headers.get("referer")!) : null;
    return from?.origin == url.origin && /^\/(tokens|settings)\/?$/.test(from.pathname) ? from.pathname + from.search : "/tokens";
  })();
  const got = post ? null : yield* call(() => noteOf(platform, request));
  const note = got?.for == session.login ? got : {};
  const show = (o: Parameters<typeof tokensPage>[3]) =>
    Effect.map(
      call(() => tokensPage(platform, session, url, o)),
      (r) => readOnce(r, request)
    );
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

  if (path == "/tokens/approve") {
    const code = normalCode(post ? f.code : (url.searchParams.get("code") ?? ""));
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
        return yield* back("/tokens", { denied: waiting.label });
      }
      const r = yield* scoped(() => platform.tokens.approve(code, who));
      if ("refused" in r) return yield* back(`/tokens/approve?code=${encodeURIComponent(code)}`, { refused: r.refused });
      // MCP's sign-in: back to the app, with the code it trades for the token.
      if (r.value?.oauth)
        return redirect(callbackUrl(r.value.oauth.redirectUri, { code: r.value.oauth.code, state: r.value.oauth.state }), 303);
      return yield* back("/tokens", r.value ? { approved: r.value.info.label } : { error: "That request has expired." });
    }
    if (!waiting)
      return yield* show({
        notice: error(`That request (${code}) has expired, or was already approved or denied. Ask the agent to start again.`),
      });
    const refused = note.refused ? error(`${note.refused} The request is still waiting: deny it, or ask the agent for another scope.`) : "";
    return yield* show({ notice: refused + (yield* call(() => approvalCard(platform, session, code, waiting))) });
  }
  if (path == "/tokens/new" && post) {
    const scope = (f.scope || "documents") as Scope;
    const expires = expiryOf(f.expires);
    if (expires == "bad") return yield* back(formPage, { error: "That expiry isn't a date." });
    const r = yield* scoped(() => platform.tokens.mint(who, f.label || "Agent", { scope, docId: f.doc || null, expires }));
    return yield* back(formPage, "refused" in r ? { error: r.refused } : { made: r.value.info.id });
  }
  if (path != "/tokens" && path != "/settings") return page("Not found", "There's nothing here. <a href=\"/tokens\">Your tokens</a>.", 404);
  if (post) return yield* back(formPage, {});
  const made = note.made ? yield* call(() => platform.tokens.justMade(session.login, note.made)) : null;
  return yield* show({
    made: made ?? undefined,
    notice: note.error
      ? error(note.error)
      : note.denied
        ? `<p class="notice">Denied: <b>${esc(note.denied)}</b> gets no token.</p>`
        : note.approved
          ? `<p class="notice">Approved: <b>${esc(note.approved)}</b> has its token now. Go back to it. You can revoke it below at any time.</p>`
          : undefined,
  });
});

/** The form of each POST here (a field that's missing is ""). */
const TokensForm = Schema.Struct({ code: Field, answer: Field, scope: Field, expires: Field, label: Field, doc: Field });

const SCOPE_NAMES: Record<Scope, string> = { document: "One document", documents: "All my documents", admin: "Admin" };

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
  const may = await platform.tokens.check({ login: session.login, name: session.name }, g).then(() => null, (e) => (e instanceof ScopeError ? e.message : "This request can't be approved."));
  const what = g.scope == "document" ? `one document: ${await docLabel(platform, g.docId)}. It can do there what you can do, and nothing anywhere else.`
    : g.scope == "documents" ? "all your documents: everything you can do with documents, but no admin power."
    : "everything you can do in Erga, admin power included (the server's settings, its users, pushes to its source).";
  return `<section class="card approve"><h2>An agent asks to act as you</h2>
<p><b>${esc(waiting.label)}</b> wants a token for ${what}</p>
<dl class="grant"><dt>Scope</dt><dd class="scope-${g.scope}">${SCOPE_NAMES[g.scope]}</dd><dt>Expires</dt><dd>${g.expires ? day(g.expires) : "Never (until you revoke it)"}</dd></dl>
${
  waiting.oauth
    ? `<p>Approve only if you just added Erga to this app. Approve sends you back to <b>${esc(whereBack(waiting.oauth.redirectUri))}</b>, and the app gets the token.</p>`
    : `<p>Approve only if you started this and the code matches:</p>
<p class="code">${esc(code)}</p>`
}
${may ? `<p class="notice error">${esc(may)}</p>` : ""}
<form class="buttons" method="post" action="/tokens/approve"><input type="hidden" name="code" value="${esc(code)}">${may ? "" : `<button class="new" name="answer" value="approve">Approve</button>`}<button class="deny" name="answer" value="deny">Deny</button></form></section>`;
}

/**
 * A token's row, as the documents list's: its name (and whether it's the share button's), its scope, when it expires,
 * when it was last used, revoke on hover. The full page's, and the one an open page fetches when it changes (server/news/).
 */
async function tokenRow(platform: Platform, t: AgentToken): Promise<string> {
  const when = (at: number | null) => (at ? dateTag(at) : `<span class="never">Never</span>`);
  const scope =
    t.scope == "document"
      ? `<span class="scope">One document</span> ${await docLabel(platform, t.docId)}`
      : `<span class="scope">${SCOPE_NAMES[t.scope]}</span>`;
  return `  <li data-live="token:${esc(t.id)}" data-sort="${t.created}"${t.expires != null && t.expires <= Date.now() ? ` class="expired"` : ""}>
    <div class="name"><span class="title">${esc(t.label)}</span>${t.kind == "share" ? `<span class="note">${t.scope == "admin" ? "Admin pages" : "Share button"}</span>` : ""}</div>
    <div class="what">${scope}</div>
    ${t.expires ? (t.expires <= Date.now() ? `<span class="never">Expired</span>` : day(t.expires)) : `<span class="never">Never</span>`}
    ${when(t.lastUsed)}
    <div class="acts"><form data-label="${esc(t.label)}"><input type="hidden" name="id" value="${esc(t.id)}"><button class="act" aria-label="Revoke ${esc(t.label)}" data-tip="Revoke">${ICON.delete}</button></form></div>
  </li>`;
}

/** The rows of /settings that `keys` name ("token:<id>"), as they are now (null: gone), for an open page (server/news/). */
export const tokensRows: LiveRows = async (platform, session, keys) => {
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  for (const t of await platform.tokens.list(session.login))
    if (`token:${t.id}` in out) out[`token:${t.id}`] = { html: await tokenRow(platform, t), sort: t.created };
  return out;
};

async function tokensPage(
  platform: Platform,
  session: Session,
  url: URL,
  o: { notice?: string; made?: { token: string; info: AgentToken }; anchor?: string }
) {
  const origin = url.origin;
  const [list, docs, admin] = await Promise.all([
    platform.tokens.list(session.login), platform.docs.list(session.login), platform.directory.users.isAdmin(whoOf(session)),
  ]);
  const rows = (await Promise.all(list.map((t) => tokenRow(platform, t)))).join("\n");
  const m = o.made;
  const made = m ? `<section class="card made"><h2>${esc(m.info.label)}</h2>
<p>${SCOPE_NAMES[m.info.scope]}${m.info.scope == "document" ? `: ${await docLabel(platform, m.info.docId)}` : ""}. ${m.info.expires ? `Expires ${day(m.info.expires)}.` : "It lasts until you revoke it."} Copy it now: it isn't shown again.</p>
<pre class="secret">${esc(m.token)}</pre>
<p>Tell your agent:</p>
<pre>Erga's API is at ${esc(origin)}: read ${esc(origin)}/llms.txt first. My token is ${esc(m.token)}
(send it as "Authorization: Bearer &lt;token&gt;").</pre>
<p>Or add Erga to Claude Code:</p>
<pre>claude mcp add --transport http erga ${esc(origin)}/mcp --header "Authorization: Bearer ${esc(m.token)}"</pre>${m.info.scope == "admin" ? `
<p>To push to Erga's source with it, once:</p>
<pre>git remote set-url origin ${esc(origin)}/git/erga.git
printf 'protocol=${esc(url.protocol.replace(":", ""))}\\nhost=${esc(url.host)}\\nusername=token\\npassword=${esc(m.token)}\\n\\n' | git credential approve</pre>` : ""}</section>` : "";
  const test = await mintTestToken(platform, session.login);
  const testBlock = test ? `<section class="part">
  <h2>Test token</h2>
  <p class="sub">Runs the test suite here, as test people, on test documents only. Until ${day(test.expires.getTime())}.</p>
  <pre>ERGA_TEST_TOKEN=<span class="secret">${esc(test.token)}</span> bun run test:prod</pre>
</section>` : "";
  const docOptions = docs.map((d) => `<option value="${esc(d.id)}">${esc(d.title)} (/${esc(d.owner)}/${esc(d.slug)})</option>`).join("");
  const title = url.pathname.startsWith("/settings") ? "Settings" : "Tokens";
  const body = appPage(
    title,
    inlineStyle("tokens"),
    `${pageBars(session, [{ label: title }])}<main>
  <header><div><h1>${title}</h1></div></header>
  ${o.notice ?? ""}
  ${made}
  <section class="part">
  <h2>Your tokens</h2>
  <p class="sub">A token lets an agent or a script (Claude Code, Codex, git) act as you, within its scope. <a href="/llms.txt">Point agents here</a>.</p>
  <div class="labels" aria-hidden="true"${list.length ? "" : " hidden"}><span>Name</span><span>Scope</span><span>Expires</span><span>Last used</span><span></span></div>
  <ol class="rows" data-live-kind="token" data-live-view="tokens" data-live-at="${Date.now()}"${list.length ? "" : " hidden"}>\n${rows}\n  </ol>
  <p class="empty"${list.length ? " hidden" : ""}>No tokens yet.</p>
  <form class="add" method="post" action="/tokens/new">
    <h3>New token</h3>
    <label class="field">Name<input class="input" name="label" maxlength="${LABEL_MAX}" placeholder="What it's for: Claude Code on my laptop" autocomplete="off"></label>
    <fieldset><legend>Scope</legend>
      <label class="choice"><input type="radio" name="scope" value="document"${docs.length ? "" : " disabled"}> One document <small>only that document, with your rights there</small></label>
      <select class="doc-pick" name="doc" aria-label="The document"${docs.length ? "" : " disabled"}>${docOptions || `<option value="">You have no documents</option>`}</select>
      <label class="choice"><input type="radio" name="scope" value="documents" checked> All my documents <small>everything you can do with documents, no admin power</small></label>
      ${admin ? `<label class="choice"><input type="radio" name="scope" value="admin"> Admin <small>everything you can do, admin power and git push included</small></label>` : ""}
    </fieldset>
    <label class="field">Expires (optional)<input type="date" name="expires" min="${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}" aria-label="Expiry date"></label>
    <div class="buttons"><button class="pill">${ICON.plus}Make token</button></div>
  </form>
  </section>
  ${testBlock}
</main>
${inlineScript("tokens")}`
  );
  return html(body, 200, NO_STORE);
}

// A person's tokens, as pages (/tokens, server/app.ts sends them here): make one (a scope, an expiry), revoke one,
// and approve or deny an agent's request for one. And a token's expiry as given, which the API reads too.


import { nameOf } from "../../document/names.ts";
import { appPage, crumbs, ICON, inlineScript, inlineStyle, page, safeNext } from "../pages/index.ts";
import { dateTag, esc } from "../../shared/html.ts";
import { type Platform, type Session, whoOf } from "../platform";
import { LABEL_MAX, normalCode, ScopeError, type AgentToken, type Scope } from "./tokens.ts";
import { mintTestToken } from "./sign-in.ts";

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
 * optional expiry, revoke one), approving or denying an agent's request
 * (/tokens/approve?code=), and, where the platform makes them, a test token
 * for running the test suite. /settings is the same page.
 */
export async function tokensDoor(request: Request, platform: Platform): Promise<Response> {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "");
  const session = await platform.sessionOf(request);
  if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/sign-in?next=${encodeURIComponent(safeNext(path + url.search))}` } });
  if (session.agent) return page("Not for agents", "Tokens are made and approved by people, signed in.", 403);
  if (session.test) return page("Not for test people", "Sign in as yourself to make a token.", 403);
  const post = request.method == "POST";
  // Only this site's own pages may make, revoke, approve or deny.
  if (post && request.headers.get("origin") != url.origin) return new Response("Forbidden", { status: 403 });
  const form = post ? await request.formData() : null;
  const field = (k: string) => String(form?.get(k) ?? "");
  const who = { login: session.login, name: session.name };
  const origin = url.origin;
  const error = (message: string) => `<p class="notice error">${esc(message)}</p>`;

  if (path == "/tokens/approve") {
    const code = normalCode(post ? field("code") : url.searchParams.get("code") ?? "");
    const waiting = await platform.tokens.pending(code);
    if (!waiting) return tokensPage(platform, session, url, { notice: error(`That request (${code}) has expired, or was already approved or denied. Ask the agent to start again.`) });
    if (post && field("answer") == "deny") {
      await platform.tokens.deny(code);
      return tokensPage(platform, session, url, { notice: `<p class="notice">Denied: <b>${esc(waiting.label)}</b> gets no token.</p>` });
    }
    if (!post) return tokensPage(platform, session, url, { notice: await approvalCard(platform, session, code, waiting) });
    try {
      const info = await platform.tokens.approve(code, who);
      return tokensPage(platform, session, url, { notice: info ? `<p class="notice">Approved: <b>${esc(info.label)}</b> has its token now. Go back to it. You can revoke it below at any time.</p>` : error("That request has expired.") });
    } catch (e) {
      if (e instanceof ScopeError) return tokensPage(platform, session, url, { notice: error(`${e.message} The request is still waiting: deny it, or ask the agent for another scope.`) });
      throw e;
    }
  }
  if (path == "/tokens/new" && post) {
    const scope = (field("scope") || "documents") as Scope;
    const expires = expiryOf(field("expires"));
    if (expires == "bad") return tokensPage(platform, session, url, { notice: error("That expiry isn't a date.") });
    try {
      const { token, info } = await platform.tokens.mint(who, field("label") || "Agent", { scope, docId: field("doc") || null, expires });
      return tokensPage(platform, session, url, { made: { token, info } });
    } catch (e) {
      if (e instanceof ScopeError) return tokensPage(platform, session, url, { notice: error(e.message) });
      throw e;
    }
  }
  if (path == "/tokens/revoke" && post) {
    await platform.tokens.revoke(session.login, field("id"));
    return new Response(null, { status: 303, headers: { Location: "/tokens" } });
  }
  if (path != "/tokens" && path != "/settings") return page("Not found", "There's nothing here. <a href=\"/tokens\">Your tokens</a>.", 404);
  return tokensPage(platform, session, url, {});
}

const SCOPE_NAMES: Record<Scope, string> = { document: "One document", documents: "All my documents", admin: "Admin" };

/** A document token's document, as a line shows it: its title and address, or "a document that's gone". */
async function docLabel(platform: Platform, ref: string | null): Promise<string> {
  const doc = ref ? await platform.directory.find(ref) : null;
  return doc ? `${esc(nameOf(doc).title)} <span class="addr">${esc(nameOf(doc).address)}</span>` : `<span class="never">a document that's gone</span>`;
}

const day = (t: number) => dateTag(t, "day");

/** The card on /tokens/approve: what the agent asks for, and Approve (if the person may give it) or Deny. */
async function approvalCard(platform: Platform, session: Session, code: string, waiting: { label: string; grant: { scope: Scope; docId: string | null; expires: number | null } }): Promise<string> {
  const g = waiting.grant;
  const may = await platform.tokens.check({ login: session.login, name: session.name }, g).then(() => null, (e) => (e instanceof ScopeError ? e.message : "This request can't be approved."));
  const what = g.scope == "document" ? `one document: ${await docLabel(platform, g.docId)}. It can do there what you can do, and nothing anywhere else.`
    : g.scope == "documents" ? "all your documents: everything you can do with documents, but no admin power."
    : "everything you can do in Erga, admin power included (the server's settings, its users, pushes to its source).";
  return `<section class="card approve"><h2>An agent asks to act as you</h2>
<p><b>${esc(waiting.label)}</b> wants a token for ${what}</p>
<dl class="grant"><dt>Scope</dt><dd class="scope-${g.scope}">${SCOPE_NAMES[g.scope]}</dd><dt>Expires</dt><dd>${g.expires ? day(g.expires) : "Never (until you revoke it)"}</dd></dl>
<p>Approve only if you started this and the code matches:</p>
<p class="code">${esc(code)}</p>
${may ? `<p class="notice error">${esc(may)}</p>` : ""}
<form class="buttons" method="post" action="/tokens/approve"><input type="hidden" name="code" value="${esc(code)}">${may ? "" : `<button class="new" name="answer" value="approve">Approve</button>`}<button class="deny" name="answer" value="deny">Deny</button></form></section>`;
}

async function tokensPage(platform: Platform, session: Session, url: URL, o: { notice?: string; made?: { token: string; info: AgentToken }; anchor?: string }): Promise<Response> {
  const origin = url.origin;
  const [list, docs, admin] = await Promise.all([
    platform.tokens.list(session.login), platform.docs.list(session.login), platform.directory.users.isAdmin(whoOf(session)),
  ]);
  const when = (t: number | null) => (t ? dateTag(t) : `<span class="never">Never</span>`);
  const scopeCell = async (t: AgentToken) => t.scope == "document" ? `<span class="scope">One document</span> ${await docLabel(platform, t.docId)}` : `<span class="scope">${SCOPE_NAMES[t.scope]}</span>`;
  // Rows as the documents list's: its name (and whether it's the share button's), its scope, when it expires, when it was last used, revoke on hover.
  const rows = (await Promise.all(list.map(async (t) => `  <li${t.expires != null && t.expires <= Date.now() ? ` class="expired"` : ""}>
    <div class="name"><span class="title">${esc(t.label)}</span>${t.kind == "share" ? `<span class="note">${t.scope == "admin" ? "Admin pages" : "Share button"}</span>` : ""}</div>
    <div class="what">${await scopeCell(t)}</div>
    ${t.expires ? (t.expires <= Date.now() ? `<span class="never">Expired</span>` : day(t.expires)) : `<span class="never">Never</span>`}
    ${when(t.lastUsed)}
    <div class="acts"><form method="post" action="/tokens/revoke" data-label="${esc(t.label)}"><input type="hidden" name="id" value="${esc(t.id)}"><button class="act" aria-label="Revoke ${esc(t.label)}" data-tip="Revoke">${ICON.delete}</button></form></div>
  </li>`))).join("\n");
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
  const html = appPage(
    title,
    inlineStyle("tokens"),
    `${crumbs(session, [{ label: title }])}<main>
  <header><div><h1>${title}</h1></div></header>
  ${o.notice ?? ""}
  ${made}
  <section class="part">
  <h2>Your tokens</h2>
  <p class="sub">A token lets an agent or a script (Claude Code, Codex, git) act as you, within its scope. <a href="/llms.txt">Point agents here</a>.</p>
  ${list.length ? `<div class="labels" aria-hidden="true"><span>Name</span><span>Scope</span><span>Expires</span><span>Last used</span><span></span></div>
  <ol class="rows">\n${rows}\n  </ol>` : `<p class="empty">No tokens yet.</p>`}
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
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

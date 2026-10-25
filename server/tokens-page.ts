// A person's tokens, as pages (/tokens, server/app.ts sends them here): make one (a scope, an expiry), revoke one,
// and approve or deny an agent's request for one. And a token's expiry as given, which the API reads too.


import { nameOf } from "./directory/index.ts";
import { appPage, crumbs, esc, ICON, page, safeNext, TIMES_SCRIPT } from "./pages/index.ts";
import { type Platform, type Session, whoOf } from "./platform";
import { LABEL_MAX, mintTestToken, normalCode, ScopeError, type AgentToken, type Scope } from "./identity/index.ts";

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

const day = (t: number) => `<time class="day" datetime="${new Date(t).toISOString()}">${new Date(t).toISOString().slice(0, 10)}</time>`;

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
  const when = (t: number | null) => (t ? `<time datetime="${new Date(t).toISOString()}">${new Date(t).toISOString().slice(0, 10)}</time>` : `<span class="never">Never</span>`);
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
  const style = `
  .part { margin-bottom: 56px; }
  .part h2 { margin: 0; font-size: 17px; font-weight: 620; letter-spacing: -0.01em; color: var(--fg-strong); }
  .part > header { margin-bottom: 20px; align-items: flex-end; }
  .part > .sub { margin-bottom: 16px; }
  .part .sub a { color: inherit; text-decoration-color: var(--rule); text-underline-offset: 0.2em; }
  .labels, ol.rows > li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) 7rem 7rem 40px; align-items: center; column-gap: 16px; }
  .labels { padding-bottom: 8px; border-bottom: 1px solid var(--rule); font-size: 12px; font-weight: 500; color: var(--chrome); }
  ol.rows > li, ol.rows > li:first-child { border: 0; }
  ol.rows > li.expired { opacity: 0.55; }
  ol.rows { padding-top: 6px; margin-bottom: 20px; }
  .name { min-width: 0; display: flex; align-items: center; gap: 12px; padding: 11px 0; }
  .what { min-width: 0; font-size: 13px; color: var(--soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scope { font-weight: 550; color: var(--fg-strong); }
  .addr { color: var(--chrome); }
  .note { padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--soft); background: color-mix(in srgb, var(--chrome) 13%, transparent); }
  time, .never { margin: 0; text-align: left; font-size: 13px; color: var(--soft); }
  .acts { display: flex; justify-content: flex-end; }
  .acts .act { position: relative; }
  .acts .act[data-tip]::after { content: attr(data-tip); position: absolute; left: var(--tip-x, 100%); top: var(--tip-y, calc(100% + 6px)); transform: translateX(-100%); z-index: 40;
    white-space: pre; font: 400 12px/1.3 var(--font-text); letter-spacing: 0.01em; color: var(--soft); opacity: 0; pointer-events: none; }
  @media (hover: hover) { .acts .act[data-tip]:hover::after { opacity: 1; } }
  .empty { margin-bottom: 20px; padding: 32px 24px; }
  form.add { display: grid; gap: 14px; max-width: 560px; padding: 18px 20px; border: 1px solid var(--rule); border-radius: 12px; }
  form.add h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--fg-strong); }
  form.add label.field { display: grid; gap: 6px; font-size: 13px; font-weight: 500; color: var(--soft); }
  form.add fieldset { margin: 0; padding: 0; border: 0; display: grid; gap: 8px; }
  form.add legend { margin-bottom: 6px; font-size: 13px; font-weight: 500; color: var(--soft); }
  form.add .choice { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--fg-strong); }
  form.add .choice small { color: var(--soft); font-size: 12.5px; }
  form.add select, form.add input[type=date] { font: inherit; font-size: 14px; padding: 6px 8px; border: 1px solid var(--rule); border-radius: 8px; background: transparent; color: var(--fg-strong); max-width: 100%; }
  form.add .doc-pick { margin-left: 26px; }
  form.add .buttons { display: flex; }
  .card { margin: 0 0 24px; padding: 18px 20px; border: 1px solid var(--rule); border-radius: 12px; font-size: 14px; }
  .card h2 { margin: 0 0 8px; font-size: 15px; font-weight: 600; color: var(--fg-strong); }
  .card p { margin: 0 0 10px; }
  .made, .approve { border-color: var(--caret); }
  .card .buttons { display: flex; align-items: center; gap: 12px; }
  .card button.new, .card button.deny { font: inherit; font-size: 13.5px; font-weight: 550; }
  .card button.deny { padding: 6px 12px; border: 1px solid var(--rule); border-radius: 999px; background: transparent; color: var(--soft); cursor: pointer; }
  dl.grant { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 0 0 12px; font-size: 14px; }
  dl.grant dt { color: var(--soft); }
  dl.grant dd { margin: 0; font-weight: 550; color: var(--fg-strong); }
  dl.grant dd.scope-admin { color: #c2410c; }
  pre { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--chrome) 9%, transparent); font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; color: var(--fg-strong); }
  .secret { user-select: all; }
  .code { font: 600 26px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.08em; color: var(--fg-strong); }
  .notice { margin: 0 0 24px; padding: 12px 14px; border-radius: 10px; font-size: 14px; background: color-mix(in srgb, var(--caret) 10%, transparent); }
  .notice.error { background: color-mix(in srgb, #c2410c 12%, transparent); }
  @media (max-width: 620px) { .labels { display: none; } .labels, ol.rows > li { grid-template-columns: minmax(0, 1fr) auto 40px; } ol.rows .what, ol.rows > li > time:nth-of-type(2), ol.rows > li > .never:nth-of-type(2) { display: none; } }
`;
  const title = url.pathname.startsWith("/settings") ? "Settings" : "Tokens";
  const html = appPage(title, style, `${crumbs(session, [{ label: title }])}<main>
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
<script>
  ${TIMES_SCRIPT}
  for (const t of document.querySelectorAll("time.day")) t.textContent = new Date(t.dateTime).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  for (const f of document.querySelectorAll("form[data-confirm]")) f.addEventListener("submit", (e) => { if (!confirm(f.dataset.confirm)) e.preventDefault(); });
  for (const f of document.querySelectorAll("form[data-label]")) f.addEventListener("submit", (e) => { if (!confirm("Revoke \\u201c" + f.dataset.label + "\\u201d? Agents using it lose access at once.")) e.preventDefault(); });
  // Picking a document picks the one-document scope.
  const pick = document.querySelector(".doc-pick"), one = document.querySelector("input[name=scope][value=document]");
  pick?.addEventListener("change", () => { if (one && !one.disabled) one.checked = true; });
</script>`);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

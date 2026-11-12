// /admin/auth, the Authentication page: how people sign in on this server (client/inline/admin-auth.ts changes it).
// It shows what the sign-in reports (server/identity/settings.ts, authOps.status): the mode, and that mode's own
// parts: each OAuth provider's card, or the proxy in front.

import { inlineCall, link } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { type LiveRows, type Session, whoOf } from "../platform.ts";
import { byLine } from "../../shared/attribution.ts";
import { adminPage } from "./layout.ts";
import {
  authOps,
  PROVIDERS,
  type AuthStatus,
  type CheckState,
  type Provider,
  type ProvidersOn,
  type ProxyStatus,
  type SignInStatus,
} from "../identity/index.ts";
import { setAt } from "./parts.ts";

const STATE_LABEL: Record<CheckState, string> = {
  working: "Working",
  misconfigured: "Misconfigured",
  not_set_up: "Not set up",
  unknown: "Unknown",
};

const who_ = (by: string, via?: string | null) => esc(byLine(by, via));

/** A provider's app: what the check says, its values, what waits for a test, how to make an app, and the form to set one. */
function serverCard(s: AuthStatus, o: { editable: boolean; session: Session; on: boolean }): string {
  const provider = s.provider,
    name = PROVIDERS[provider].label,
    newApp = PROVIDERS[provider].newApp;
  const src = (from: "page" | "deploy") => (from == "page" ? "set here" : "from the deploy");
  const copy = (text: string) => `<button type="button" class="copy" data-copy="${esc(text)}" aria-label="Copy ${esc(text)}">Copy</button>`;
  const setBy = s.page ? ` by ${who_(s.page.updatedBy, s.page.updatedVia)}, ${esc(setAt(s.page.updated))}` : "";
  const none = `<span class="src">Not set</span>`;
  const rows = `<dl>
      <dt>Client ID</dt><dd>${s.inUse.clientId ? `<code class="client-id">${esc(s.inUse.clientId)}</code><span class="src">${src(s.inUse.source)}${s.inUse.source == "page" ? setBy : ""}</span>` : none}</dd>
      <dt>Client secret</dt><dd>${s.inUse.secretSet ? `<code>••••••••</code><span class="src">${src(s.inUse.source)}</span>` : none}</dd>
      <dt>Homepage URL</dt><dd><code>${esc(s.homepageUrl)}</code>${copy(s.homepageUrl)}</dd>
      <dt>Callback URL</dt><dd><code class="callback">${esc(s.callbackUrl)}</code>${copy(s.callbackUrl)}</dd>
    </dl>`;
  // The deploy's values are the way back in (server/identity/settings.ts, signInApp): one line says so where it has them.
  const deployHas = !!s.deploy.clientId && s.deploy.secretSet;
  const deployNote = s.dev
    ? ""
    : s.inUse.source == "page"
      ? `<p class="note deploy-note">${s.deploy.clientId ? `The deploy has client ID <code>${esc(s.deploy.clientId)}</code>${s.deploy.secretSet ? "" : ", with no secret"}.` : "The deploy has no client ID."} Clear goes back to the deploy's values${deployHas ? `; sign-in also falls back to them if these stop working` : ""}.</p>`
      : "";
  const devNote = s.dev
    ? `<p class="note">Local development signs everyone in without ${name}, so these values are not used here.</p>`
    : "";
  // A real sign-in is what checks the callback URL.
  const testUrl = `/auth/${provider}?app=pending&next=/admin/auth`;
  // A provider that's off: an admin's sign-in with the values in use checks them before anyone else uses them.
  const offTest =
    !o.on && s.inUse.clientId && !s.pending
      ? `<div class="pending"><p>Sign-in with ${name} is off. Test these values with your own sign-in before you turn it on.</p><div class="row"><a class="pill test-off" href="${esc(link(`/auth/${provider}?app=test&next=/admin/auth`, o.session))}">Test sign-in</a></div></div>`
      : "";
  const test =
    s.pending?.test && !s.pending.test.ok
      ? `<p class="failed">The last test sign-in failed, ${esc(setAt(s.pending.test.at))}: ${esc(s.pending.test.error ?? "")}</p>`
      : "";
  const pending = s.pending
    ? `<div class="pending">
      <p><b>New values wait for a test sign-in.</b> Client ID <code>${esc(s.pending.clientId)}</code>, set by ${who_(s.pending.updatedBy, s.pending.updatedVia)}, ${esc(setAt(s.pending.updated))}. ${s.pendingCheck ? esc(s.pendingCheck.summary) : ""} Until an admin signs in with them, sign-in uses the values above.</p>
      ${test}
      <div class="row"><a class="pill test" href="${esc(link(testUrl, o.session))}">Test sign-in</a>${o.editable ? `<button type="button" class="pill discard">Discard</button>` : ""}</div>
    </div>`
    : "";
  const reasons =
    s.check.reasons.length && s.check.state != "working"
      ? `<ul class="reasons">${s.check.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
      : "";
  const steps = s.setup
    ? `<details class="setup"${s.check.state == "not_set_up" ? " open" : ""}><summary>How to make ${s.check.state == "not_set_up" ? "its" : "a new"} ${name} OAuth ${PROVIDERS[provider].appWord}</summary><ol class="steps">${s.setup.map((x) => `<li>${esc(x).replace(esc(newApp), `<a href="${esc(newApp)}" target="_blank" rel="noopener">${esc(newApp)}</a>`)}</li>`).join("")}</ol></details>`
    : "";
  const cannot =
    !o.editable && !s.canStore ? `<p class="note">This server has no FACTORY_KEY, so only the deploy sets these values.</p>` : "";
  const form = o.editable
    ? `<form class="configure" method="post" action="${esc(link("/admin/auth", o.session))}">
      <p class="lede">${s.check.state == "working" ? `Replace with another app's values. They wait for a test sign-in before anyone else uses them.` : `Paste the app's values. ${name} checks them before sign-in uses them.`}</p>
      <input type="hidden" name="provider" value="${provider}">
      <label>Client ID<input class="input" name="clientId" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false" placeholder="${esc(PROVIDERS[provider].clientIdLike)}" required></label>
      <label>Client secret<input class="input" type="password" name="secret" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false" placeholder="Paste the secret" required></label>
      <div class="row"><button class="pill save">Save</button>${s.page ? `<button type="button" class="pill clear">Clear</button>` : ""}</div>
    </form>`
    : "";
  return `<section class="server" data-provider="${provider}" data-target="${esc(s.target ?? "")}" data-state="${s.check.state}">
    <p class="summary">${esc(s.check.summary)}</p>${reasons}
    ${rows}${deployNote}${devNote}${offTest}${pending}${steps}${cannot}${form}
    <p class="hint" role="status"></p>
  </section>`;
}

/**
 * One provider's card: its name, the check's state and the on/off switch in its header, then its app. The last provider
 * that's on can't be turned off: its switch is fixed, and the card says why.
 */
function providerSection(p: Provider, on: ProvidersOn, s: AuthStatus, session: Session): string {
  const label = PROVIDERS[p].label;
  const others = IDS.filter((id) => id != p);
  const last = on[p] && !others.some((id) => on[id]);
  const why = last
    ? `The only sign-in that is on. To turn it off, turn on ${others.map((id) => PROVIDERS[id].label).join(" or ")} first.`
    : "";
  return `<section class="provider" data-provider="${p}" data-live="auth:${p}" data-sort="${IDS.indexOf(p)}">
    <header><h3 class="provider-head">${label}</h3><span class="app-state ${s.check.state}">${esc(STATE_LABEL[s.check.state])}</span>
      <label class="switch" title="${esc(why || `Sign-in with ${label}: ${on[p] ? "on" : "off"}`)}"><input type="checkbox" role="switch" data-provider="${p}" aria-label="Sign-in with ${label}"${on[p] ? " checked" : ""}${last ? " disabled" : ""}><span class="track" aria-hidden="true"></span><span class="state">${on[p] ? "On" : "Off"}</span></label>
    </header>
    <p class="hint provider-hint" role="status">${esc(why)}</p>
    ${serverCard(s, { editable: s.canStore, session, on: on[p] })}
  </section>`;
}

const IDS = Object.keys(PROVIDERS) as Provider[];

/** Each provider's section, as its status is now; none in the proxy mode. */
function sections(session: Session, status: SignInStatus): Partial<Record<Provider, string>> {
  if (status.mode != "oauth") return {};
  return Object.fromEntries(IDS.map((id) => [id, providerSection(id, status.providers, status.apps[id], session)]));
}

/** The two modes, as the page names them (server/identity/mode.ts): the name, and what it is in one sentence. */
const MODES: Record<SignInStatus["mode"], { name: string; what: string }> = {
  oauth: { name: "OAuth sign-in", what: "Erga signs people in itself, with the providers that are on below." },
  proxy: {
    name: "Proxy sign-in",
    what: "A proxy in front of this server signs each person in, with your company's sign-in. Erga trusts the proxy's signed header.",
  },
};

/** The page's first card: the mode in use, and the other one. The deploy chooses the mode, so the page only shows it. */
function modeSection(mode: SignInStatus["mode"]): string {
  const other = mode == "oauth" ? "proxy" : "oauth";
  return `<section class="mode" data-mode="${mode}">
    <header><h3 class="provider-head">${MODES[mode].name}</h3><span class="app-state working">In use</span></header>
    <p class="summary">${esc(MODES[mode].what)}</p>
    <p class="note">The other mode is ${MODES[other].name}. The deploy chooses the mode (<code>bun erga setup</code>): this page can't change it.</p>
  </section>`;
}

/** The proxy mode's card: which proxy is in front, and the values that show a header is for this server. */
function proxySection(p: ProxyStatus): string {
  const rows = [...(p.header ? [{ name: "Header", value: p.header }] : []), ...p.values];
  return `<section class="mode proxy" data-proxy="${esc(p.kind ?? "")}">
    <header><h3 class="provider-head">${esc(p.label)}</h3><span class="app-state ${p.kind ? "working" : "misconfigured"}">${p.kind ? "In front" : "Misconfigured"}</span></header>
    <section class="server" data-state="${p.kind ? "working" : "misconfigured"}">
      <p class="summary">${p.kind ? "Each person signs in at the proxy before a request reaches this server." : "The deploy's value for the proxy (PROXY_SIGN_IN) isn't one this server can read: nobody can sign in."}</p>
      <dl>${rows.map((r) => `<dt>${esc(r.name)}</dt><dd><code>${esc(r.value)}</code></dd>`).join("")}</dl>
      <p class="note">The deploy sets these values. The proxy's own settings say who may pass it.</p>
    </section>
  </section>`;
}

/** /admin/auth: how people sign in on this server. */
export function authPage(session: Session, status: SignInStatus) {
  const s = sections(session, status);
  return adminPage({
    session,
    title: "Authentication",
    here: "auth",
    lede:
      status.mode == "oauth"
        ? "How people sign in, and the OAuth app behind each provider."
        : "How people sign in, and the proxy in front of this server.",
    body: `
  <section aria-labelledby="page-head" class="auth" data-live-kind="auth" data-live-view="auth" data-live-order="asc" data-live-at="${Date.now()}">
    ${modeSection(status.mode)}
    ${status.mode == "proxy" ? proxySection(status.proxy) : IDS.map((id) => s[id]).join("\n    ")}
  </section>
<script>${inlineCall("admin-auth")}</script>`,
  });
}

/** The sections of /admin/auth that `keys` name ("auth:<provider>"), as they are now, for an open page (server/news/). */
export const authRows: LiveRows = async (platform, session, keys, origin) => {
  const now = sections(session, await authOps(platform, origin).status(whoOf(session)));
  return Object.fromEntries(
    keys.map((k) => {
      const p = k.slice("auth:".length) as Provider;
      const html = now[p];
      return [k, html ? { html, sort: IDS.indexOf(p) } : null];
    })
  );
};

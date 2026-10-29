// /admin/auth, the Authentication page: how people sign in on this server (client/inline/admin-auth.ts changes it).

import { inlineCall, link } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import type { Session } from "../platform.ts";
import { byLine } from "../../shared/attribution.ts";
import { adminPage } from "./layout.ts";
import { PROVIDERS, type AuthOps, type AuthStatus, type CheckState, type Provider, type ProvidersOn } from "../identity/index.ts";
import { setAt } from "./parts.ts";

const STATE_LABEL: Record<CheckState, string> = {
  working: "Working",
  misconfigured: "Misconfigured",
  not_set_up: "Not set up",
  unknown: "Unknown",
};

const who_ = (by: string, via?: string | null) => esc(byLine(by, via));

/** A provider's card: its state, its app's values, what waits for a test, how to make an app, and the form to set one. */
function serverCard(s: AuthStatus, o: { label: string; editable: boolean; session: Session; on: boolean }): string {
  const host = new URL(s.origin).host;
  const provider = s.provider,
    name = PROVIDERS[provider].label;
  const head = `<header><h3>${esc(o.label)}<small>${esc(host)}</small></h3><span class="state ${s.check.state}">${esc(STATE_LABEL[s.check.state])}</span></header>`;
  const src = (from: "page" | "deploy") => (from == "page" ? "set on /admin/auth" : "from the deploy");
  const copy = (text: string) => `<button type="button" class="copy" data-copy="${esc(text)}" aria-label="Copy ${esc(text)}">Copy</button>`;
  const setBy = s.page ? ` · ${who_(s.page.updatedBy, s.page.updatedVia)}, ${esc(setAt(s.page.updated))}` : "";
  const rows = `<dl>
      <dt>Client ID</dt><dd>${s.inUse.clientId ? `<code class="client-id">${esc(s.inUse.clientId)}</code><span class="src">${src(s.inUse.source)}${s.inUse.source == "page" ? setBy : ""}</span>` : `<span class="src">Not set</span>`}</dd>
      <dt>Client secret</dt><dd>${s.inUse.secretSet ? `Set<span class="src">${src(s.inUse.source)} · never shown</span>` : `<span class="src">Not set</span>`}</dd>
      <dt>Homepage URL</dt><dd><code>${esc(s.homepageUrl)}</code>${copy(s.homepageUrl)}</dd>
      <dt>Callback URL</dt><dd><code class="callback">${esc(s.callbackUrl)}</code>${copy(s.callbackUrl)}</dd>
    </dl>`;
  // The deploy's values are the way back in (server/identity/settings.ts, signInApp): one line says so where it has them.
  const deployHas = !!s.deploy.clientId && s.deploy.secretSet;
  const deployNote = s.dev
    ? ""
    : s.inUse.source == "page"
      ? `<p class="note deploy-note">The deploy's values: ${s.deploy.clientId ? `client ID <code>${esc(s.deploy.clientId)}</code>` : "no client ID"}, ${s.deploy.secretSet ? "a secret" : "no secret"}. Clear goes back to them${deployHas ? `, and sign-in falls back to them if these stop working` : ""}.</p>`
      : deployHas
        ? `<p class="note deploy-note">If values saved here stop working, sign-in falls back to these, the deploy's.</p>`
        : "";
  const devNote = s.dev
    ? `<p class="note">Local development: everyone signs in as the dev login, without ${name}, so this server doesn't use these values. A hosted server does.</p>`
    : "";
  // A real sign-in is what checks the callback URL.
  const testUrl = `/auth/${provider}?app=pending&next=/admin/auth`;
  // A provider that's off: an admin's sign-in with the values in use checks them before anyone else uses them.
  const offTest =
    !o.on && s.inUse.clientId && !s.pending
      ? `<p class="note">Sign-in with ${name} is off. <a class="pill test-off" href="${esc(link(`/auth/${provider}?app=test&next=/admin/auth`, o.session))}">Test sign-in</a> checks these values with your own sign-in; then turn ${name} on with the switch beside its heading.</p>`
      : "";
  const test =
    s.pending?.test && !s.pending.test.ok
      ? `<p class="failed">The last test sign-in failed, ${esc(setAt(s.pending.test.at))}: ${esc(s.pending.test.error ?? "")}</p>`
      : "";
  const pending = s.pending
    ? `<div class="pending">
      <p><b>New values wait for a test sign-in.</b> Client ID <code>${esc(s.pending.clientId)}</code>, set by ${who_(s.pending.updatedBy, s.pending.updatedVia)}, ${esc(setAt(s.pending.updated))}. ${s.pendingCheck ? esc(s.pendingCheck.summary) : ""} Sign-in keeps the values in use until an admin signs in with the new ones.</p>
      ${test}
      <div class="row"><a class="pill test" href="${esc(link(testUrl, o.session))}">Test sign-in</a>${o.editable ? `<button type="button" class="pill discard">Discard</button>` : ""}</div>
    </div>`
    : "";
  const reasons =
    s.check.reasons.length && s.check.state != "working"
      ? `<ul class="reasons">${s.check.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
      : "";
  const steps = s.setup
    ? `<details class="setup"${s.check.state == "not_set_up" ? " open" : ""}><summary>How to make ${s.check.state == "not_set_up" ? "its" : "a new"} ${name} OAuth ${provider == "google" ? "client" : "app"}</summary><ol class="steps">${s.setup.map((x) => `<li>${esc(x).replace(/https:\/\/(github\.com\/settings\/applications\/new|console\.cloud\.google\.com\/apis\/credentials)/, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`)}</li>`).join("")}</ol></details>`
    : "";
  const cannot =
    !o.editable && !s.canStore
      ? `<p class="note">This server has no FACTORY_KEY to encrypt a secret with, so its values are set only in the deploy.</p>`
      : "";
  const form = o.editable
    ? `<form class="configure" method="post" action="${esc(link("/admin/auth", o.session))}">
      <p class="lede">${s.check.state == "working" ? `Paste another app's values to replace these. ${name} must accept them first, and they wait for a test sign-in before anyone else uses them.` : `Paste the app's values. ${name} must accept them first; then sign-in uses them at once.`}</p>
      <input type="hidden" name="provider" value="${provider}">
      <label>Client ID<input class="input" name="clientId" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${provider == "google" ? "1234…apps.googleusercontent.com" : "Ov23li…"}" required></label>
      <label>Client secret<input class="input" type="password" name="secret" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the secret" required></label>
      <div class="row"><button class="pill save">Save</button>${s.page ? `<button type="button" class="pill clear">Clear</button>` : ""}</div>
    </form>`
    : "";
  return `<section class="server" data-provider="${provider}" data-target="${esc(s.target ?? "")}" data-state="${s.check.state}">${head}
    <p class="summary">${esc(s.check.summary)}</p>${reasons}
    ${rows}${deployNote}${devNote}${offTest}${pending}${steps}${cannot}${form}
    <p class="hint" role="status"></p>
  </section>`;
}

/**
 * One provider's section: its heading with its on/off switch beside it, then its apps. The last provider that's on can't
 * be turned off: its switch is fixed, and the section says why.
 */
function providerSection(p: Provider, on: ProvidersOn, cards: string): string {
  const label = PROVIDERS[p].label,
    other = PROVIDERS[p == "github" ? "google" : "github"].label;
  const last = on[p] && !on[p == "github" ? "google" : "github"];
  const why = last ? `${label} is the only sign-in that's on, so it can't be turned off: turn on ${other} first.` : "";
  return `<section class="provider" data-provider="${p}">
    <header><h3 class="provider-head">${label}</h3>
      <label class="switch" title="${esc(why || `Sign-in with ${label}: ${on[p] ? "on" : "off"}`)}"><input type="checkbox" role="switch" data-provider="${p}" aria-label="Sign-in with ${label}"${on[p] ? " checked" : ""}${last ? " disabled" : ""}><span class="track" aria-hidden="true"></span><span class="state">${on[p] ? "On" : "Off"}</span></label>
    </header>
    <p class="hint provider-hint" role="status">${esc(why)}</p>
    ${cards}
  </section>`;
}

/** /admin/auth: how people sign in on this server. */
export function authPage(session: Session, status: Awaited<ReturnType<AuthOps["status"]>>) {
  const { here, google, providers } = status;
  const label = (s: AuthStatus) => (s.target ? `${s.target[0].toUpperCase()}${s.target.slice(1)} (this server)` : "This server");
  return adminPage({
    session,
    title: "Authentication",
    here: "auth",
    body: `
  <section aria-labelledby="auth-head" class="auth">
    <h2 id="auth-head">Authentication</h2>
    ${providerSection("github", providers, serverCard(here, { label: label(here), editable: here.canStore, session, on: providers.github }))}
    ${providerSection("google", providers, serverCard(google, { label: label(google), editable: google.canStore, session, on: providers.google }))}
  </section>
<script>${inlineCall("admin-auth", { action: link("/admin/auth", session) })}</script>`,
  });
}

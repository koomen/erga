// /admin/auth, the Sign-in page: everything that governs how people sign in on this server (client/inline/admin-auth.ts
// changes it). It shows what the sign-in reports (server/identity/settings.ts, authOps.status): the mode, and that
// mode's own parts: each OAuth provider's card; none with a gate in front. A secret that is set shows as its last 4
// characters, with Replace and Remove: the page never has the secret. Then what a new account gets: how its username is
// assigned (usernamesRow: a radio, with what each option requires under it), and the deploy's secrets that
// sign-in needs.

import { inlineCall, link, TIMES_SCRIPT } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { type LiveRow, type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import { type ConfigEntry, USERNAME_RULES, type UsernameRule } from "../directory/index.ts";
import { byLine } from "../../shared/attribution.ts";
import { adminPage } from "./layout.ts";
import {
  authOps,
  PROVIDERS,
  type AuthStatus,
  type CheckState,
  type Provider,
  type ProvidersOn,
  RULE_ABOUT,
  RULE_LABEL,
  ruleNow,
  type SignInStatus,
  usernameFacts,
  type UsernameFacts,
  whyNot,
} from "../identity/index.ts";
import { setAt } from "./parts.ts";
import { chip, deploySection, lockedBadge, PAGE_SETTINGS, setLine, settingLiveRows, settingsSection } from "./settings.ts";

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
      <dt>Client secret</dt><dd>${s.inUse.secretSet ? `${s.inUse.secretLast4 ? `<code class="masked" aria-label="The secret ends in ${esc(s.inUse.secretLast4)}">•••• ${esc(s.inUse.secretLast4)}</code>` : ""}<span class="src">${src(s.inUse.source)}</span>` : none}</dd>
      <dt>Homepage URL</dt><dd><code>${esc(s.homepageUrl)}</code>${copy(s.homepageUrl)}</dd>
      <dt>Callback URL</dt><dd><code class="callback">${esc(s.callbackUrl)}</code>${copy(s.callbackUrl)}</dd>
    </dl>`;
  // The deploy's values are the way back in (server/identity/settings.ts, signInApp): one line says so where it has them.
  const deployNote = s.dev
    ? ""
    : s.inUse.source == "page"
      ? `<p class="note deploy-note">Remove goes back to the deploy's values: ${s.deploy.clientId ? `client ID <code>${esc(s.deploy.clientId)}</code>${s.deploy.secretSet ? "" : ", with no secret"}` : "no client ID"}.</p>`
      : "";
  const devNote = s.dev ? `<p class="note">Local development does not use these values.</p>` : "";
  // A real sign-in is what checks the callback URL.
  const testUrl = `/auth/${provider}?app=pending&next=/admin/auth`;
  // A provider that's off: an admin's sign-in with the values in use checks them before anyone else uses them.
  const offTest =
    !o.on && s.inUse.clientId && !s.pending
      ? `<div class="pending"><p>Test these values before you turn ${name} on.</p><div class="row"><a class="pill test-off" href="${esc(link(`/auth/${provider}?app=test&next=/admin/auth`, o.session))}">Test sign-in</a></div></div>`
      : "";
  const test =
    s.pending?.test && !s.pending.test.ok
      ? `<p class="failed">The last test sign-in failed, ${esc(setAt(s.pending.test.at))}: ${esc(s.pending.test.error ?? "")}</p>`
      : "";
  const pending = s.pending
    ? `<div class="pending">
      <p><b>New values wait for a test sign-in.</b> Client ID <code>${esc(s.pending.clientId)}</code>, set by ${who_(s.pending.updatedBy, s.pending.updatedVia)}, ${esc(setAt(s.pending.updated))}. ${s.pendingCheck ? esc(s.pendingCheck.summary) : ""}</p>
      ${test}
      <div class="row"><a class="pill test" href="${esc(link(testUrl, o.session))}">Test sign-in</a>${o.editable ? `<button type="button" class="pill discard">Discard</button>` : ""}</div>
    </div>`
    : "";
  const reasons =
    s.check.reasons.length && s.check.state != "working" && s.check.state != "not_set_up"
      ? `<ul class="reasons">${s.check.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
      : "";
  const steps = s.setup
    ? `<details class="setup"${s.check.state == "not_set_up" ? " open" : ""}><summary>How to make ${s.check.state == "not_set_up" ? "its" : "a new"} ${name} OAuth ${PROVIDERS[provider].appWord}</summary><ol class="steps">${s.setup.map((x) => `<li>${esc(x).replace(esc(newApp), `<a href="${esc(newApp)}" target="_blank" rel="noopener">${esc(newApp)}</a>`)}</li>`).join("")}</ol></details>`
    : "";
  const cannot =
    !o.editable && !s.canStore ? `<p class="note">This server has no SECRETS_KEY, so only the deploy sets these values.</p>` : "";
  // With values in use, the form to set others is closed until Replace; Remove takes the page's values off.
  const closed = !!s.inUse.clientId;
  const form = o.editable
    ? `${closed ? `<div class="row secret-row"><button type="button" class="pill replace">Replace</button>${s.page ? `<button type="button" class="pill clear">Remove</button>` : ""}</div>` : ""}
    <form class="configure" method="post" action="${esc(link("/admin/auth", o.session))}"${closed ? " hidden" : ""}>
      ${closed ? `<p class="lede">Another ${PROVIDERS[provider].appWord}'s values, in the place of these. They save when both are here.</p>` : ""}
      <input type="hidden" name="provider" value="${provider}">
      <label>Client ID<input class="input" name="clientId" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false" placeholder="${esc(PROVIDERS[provider].clientIdLike)}" required></label>
      <label>Client secret<input class="input" type="password" name="secret" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false" placeholder="Paste the secret" required></label>
    </form>`
    : "";
  return `<section class="server" data-provider="${provider}" data-state="${s.check.state}">
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
  const why = last ? `To turn this off, turn on ${others.map((id) => PROVIDERS[id].label).join(" or ")} first.` : "";
  return `<section class="provider" data-provider="${p}" data-live="auth:${p}" data-sort="${IDS.indexOf(p)}">
    <header><h3 class="provider-head">${label}</h3><span class="app-state ${s.check.state}">${esc(STATE_LABEL[s.check.state])}</span>
      <label class="switch" title="${esc(why || `Sign-in with ${label}: ${on[p] ? "on" : "off"}`)}"><input type="checkbox" role="switch" data-provider="${p}" aria-label="Sign-in with ${label}"${on[p] ? " checked" : ""}${last ? " disabled" : ""}><span class="track" aria-hidden="true"></span><span class="state">${on[p] ? "On" : "Off"}</span></label>
    </header>
    <p class="hint provider-hint" role="status">${esc(why)}</p>
    ${serverCard(s, { editable: s.canStore, session, on: on[p] })}
  </section>`;
}

const IDS = Object.keys(PROVIDERS) as Provider[];

/** Each provider's section, as its status is now; none with a gate in front. */
function sections(session: Session, status: SignInStatus): Partial<Record<Provider, string>> {
  if (status.mode != "oauth") return {};
  return Object.fromEntries(IDS.map((id) => [id, providerSection(id, status.providers, status.apps[id], session)]));
}

/** The two modes, as the page names them (server/identity/mode.ts): the name, and what it is in one sentence. */
const MODES: Record<SignInStatus["mode"], { name: string; what: string }> = {
  oauth: { name: "OAuth sign-in", what: "Erga signs people in with the providers below." },
  gate: {
    name: "Single sign-on",
    what: "A gate in front of this server signs people in with your organization's sign-in, before any request reaches the server.",
  },
};

/** The page's first card: the mode in use, and the other one. The deploy chooses the mode, so the page only shows it. */
function modeSection(mode: SignInStatus["mode"]): string {
  return `<section class="mode" data-mode="${mode}">
    <header><h3 class="provider-head">${MODES[mode].name}</h3><span class="app-state working">In use</span></header>
    <p class="summary">${esc(MODES[mode].what)}</p>
    <p class="note">The deploy sets the mode.</p>
  </section>`;
}

const USERNAMES = "setting:usernames";

/**
 * How a new account gets its username: the setting `usernames`, as a radio. Under each option, what it does and what
 * it requires; one whose requirements do not hold now can't be chosen. The option that is checked is the rule that
 * names a new account now (ruleNow): choose, while the rule that is set can't apply.
 */
export function usernamesRow(e: ConfigEntry, facts: UsernameFacts): string {
  const now = ruleNow(e.value as UsernameRule, facts);
  const about = (rule: UsernameRule) => esc(RULE_ABOUT[rule]).replace("access limited to", `<a href="/admin/access">access limited to</a>`);
  const options = USERNAME_RULES.map((rule: UsernameRule) => {
    const no = whyNot(rule, facts);
    return `<label class="choice${no ? " off" : ""}"><input type="radio" name="value" value="${rule}"${now == rule ? " checked" : ""}${no || e.locked ? " disabled" : ""}><span class="what">${esc(RULE_LABEL[rule])}<small class="why">${about(rule)}</small></span></label>`;
  }).join("\n        ");
  return `  <li class="setting usernames" data-key="usernames" data-control="radio" data-live="${USERNAMES}" data-sort="-1">
    <div class="about">
      <div class="head"><span class="key" id="usernames-label" title="usernames">${esc(e.label!)}</span>${lockedBadge(e)}</div>
      <form class="choices" role="radiogroup" aria-labelledby="usernames-label">
        ${options}
      </form>
      <p class="desc">${esc(e.description!)}</p>
      ${setLine(e)}
    </div>
    <p class="hint" role="status"></p>
  </li>`;
}

/** The row as the server is now. */
const usernamesNow = async (platform: Platform) =>
  usernamesRow(await platform.directory.config.entry("usernames"), await usernameFacts(platform));

/** /admin/auth: how people sign in on this server. */
export async function authPage(platform: Platform, session: Session, status: SignInStatus) {
  const s = sections(session, status);
  const [accounts, deployed] = await Promise.all([
    usernamesNow(platform).then((first) => settingsSection(platform, session, PAGE_SETTINGS.auth, "auth-settings", { first })),
    platform.directory.credentials.deployed(whoOf(session)),
  ]);
  return adminPage({
    session,
    title: "Sign-in",
    here: "auth",
    body: `
  <section aria-labelledby="page-head" class="auth" data-live-kind="auth" data-live-view="auth" data-live-order="asc" data-live-at="${Date.now()}">
    ${modeSection(status.mode)}
    ${IDS.map((id) => s[id] ?? "").join("\n    ")}
  </section>
  <section class="new-accounts" aria-labelledby="accounts-head">
    <h3 class="sub-head" id="accounts-head">New accounts</h3>
    ${accounts}
  </section>${deploySection(deployed, ["SESSION_SECRET", "SECRETS_KEY", "GITHUB_CLIENT_SECRET"])}
<script>${TIMES_SCRIPT}${inlineCall("admin-auth")}${inlineCall("admin-settings", { chip: chip("LOGIN", false) })}</script>`,
  });
}

/** The page's setting rows ("setting:<key>"), as they are now, for an open page (server/news/). */
export const authSettingsRows: LiveRows = async (platform, session, keys) => {
  const rows: Record<string, LiveRow> = {
    ...Object.fromEntries(keys.map((k) => [k, null])),
    ...(await settingLiveRows(platform, session, keys, PAGE_SETTINGS.auth)),
  };
  if (!keys.includes(USERNAMES)) return rows;
  const { users, rules, config } = platform.directory;
  await users.mustAdmin(whoOf(session));
  // As the database has them now: the change was likely made in another isolate, whose memory this one doesn't share.
  rules.forget();
  config.forget();
  return { ...rows, [USERNAMES]: { html: await usernamesNow(platform), sort: -1 } };
};

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

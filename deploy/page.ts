// The deploy page, /deploy (worker/deploy.ts): connect Cloudflare, choose
// where the new server goes (and buy a domain, if you like, after seeing the
// price), give it a GitHub app to sign in with, deploy, and watch each step.
// One page; its script asks /deploy/api/* and redraws.

import { appPage, crumbs, esc } from "../server/routes";

export interface DeployPageConfig {
  login: string;
  name: string;
  /** "Authorize with Cloudflare" is offered (the server has an OAuth client, or it's the mock). */
  oauth: boolean;
  mock: boolean;
  release: { version: string; built: string } | null;
  tokenUrl: string;
  tokenUrlRegistrar: string;
  permissions: { key: string; type: string; why: string }[];
  /** An error to show as the page opens (back from Cloudflare's OAuth). */
  error: string;
}

const STYLE = `
  main { max-width: 760px; }
  .steps { list-style: none; margin: 28px 0 0; padding: 0; counter-reset: step; }
  .step { position: relative; padding: 18px 0 22px 44px; border-top: 1px solid var(--rule); }
  .step::before { counter-increment: step; content: counter(step); position: absolute; left: 0; top: 18px; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
    font-size: 13px; font-weight: 650; color: var(--soft); border: 1px solid var(--rule); }
  .step.done::before { content: "✓"; color: var(--bg); background: var(--fg-strong); border-color: var(--fg-strong); }
  .step.current::before { color: var(--bg); background: var(--caret); border-color: var(--caret); }
  .step h2 { margin: 2px 0 6px; font-size: 16.5px; font-weight: 600; color: var(--fg-strong); display: flex; gap: 10px; align-items: baseline; }
  .step h2 .change { margin-left: auto; font-size: 13px; font-weight: 500; }
  .step .summary { margin: 0; font-size: 14px; color: var(--soft); }
  .step:not(.current) .body { display: none; }
  .step.current .summary { display: none; }
  .step.later { opacity: 0.55; }
  p.lede, .body p { margin: 0 0 12px; font-size: 14px; color: var(--fg); }
  .muted { color: var(--soft); font-size: 13px; }
  a { color: var(--caret); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0 0 12px; }
  .row .input { flex: 1; min-width: 200px; }
  label.field { display: block; margin: 0 0 12px; font-size: 13px; color: var(--soft); }
  label.field .input, label.field select { display: block; width: 100%; margin-top: 4px; }
  label.field select { height: 34px; }
  .choice { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; margin: 0 0 8px; border: 1px solid var(--rule); border-radius: 10px; cursor: pointer; }
  .choice:has(input:checked) { border-color: var(--caret); background: color-mix(in srgb, var(--caret) 5%, transparent); }
  .choice input { margin-top: 3px; }
  .choice b { color: var(--fg-strong); font-weight: 600; }
  .choice .muted { display: block; margin-top: 2px; }
  .choice select, .choice .input { margin-top: 6px; }
  fieldset { border: 0; margin: 0 0 14px; padding: 0; }
  legend { padding: 0; margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--fg-strong); }
  ul.perms { margin: 0 0 12px; padding-left: 18px; font-size: 13.5px; }
  ul.perms li { margin: 2px 0; }
  code, .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; }
  .copy { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; padding: 6px 6px 6px 10px; border: 1px solid var(--rule); border-radius: 8px; font-size: 13px; }
  .copy span { color: var(--soft); min-width: 120px; }
  .copy code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-strong); }
  .copy button { flex: none; }
  .small { height: 28px; padding: 0 10px; font-size: 12.5px; }
  .error { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; font-size: 13.5px; color: #9a3412; background: color-mix(in srgb, #ea580c 10%, var(--bg)); border: 1px solid color-mix(in srgb, #ea580c 35%, var(--rule)); }
  .error:empty { display: none; }
  @media (prefers-color-scheme: dark) { .error { color: #fdba74; } }
  details { margin: 6px 0 12px; }
  summary { cursor: pointer; font-size: 13.5px; color: var(--caret); }
  ol.offers { list-style: none; margin: 8px 0 0; padding: 0; }
  ol.offers li { display: flex; align-items: center; gap: 10px; padding: 8px 2px; border-bottom: 1px solid var(--rule); font-size: 14px; }
  ol.offers li .name { flex: 1; font-weight: 500; color: var(--fg-strong); }
  ol.offers li .why { color: var(--soft); font-size: 13px; }
  ol.offers li .price { font-feature-settings: "tnum"; }
  dl.review { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0 0 16px; font-size: 14px; }
  dl.review dt { color: var(--soft); }
  dl.review dd { margin: 0; color: var(--fg-strong); overflow-wrap: anywhere; }
  ol.progress { list-style: none; margin: 8px 0 14px; padding: 0; }
  ol.progress li { display: grid; grid-template-columns: 22px 1fr; gap: 2px 10px; padding: 7px 0; font-size: 14px; }
  ol.progress li .icon { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid var(--rule); box-sizing: border-box; margin-top: 2px; display: grid; place-items: center; font-size: 11px; }
  ol.progress li.running .icon { border-color: var(--caret); border-top-color: transparent; animation: spin 0.8s linear infinite; }
  ol.progress li.done .icon, ol.progress li.skipped .icon { background: var(--fg-strong); border-color: var(--fg-strong); color: var(--bg); }
  ol.progress li.skipped .icon { opacity: 0.4; }
  ol.progress li.failed .icon { background: #ea580c; border-color: #ea580c; color: #fff; }
  ol.progress li.pending { color: var(--soft); }
  ol.progress li .detail { grid-column: 2; font-size: 12.5px; color: var(--soft); overflow-wrap: anywhere; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .live { margin: 0 0 14px; padding: 16px; border-radius: 12px; border: 1px solid var(--rule); }
  .live h3 { margin: 0 0 6px; font-size: 18px; color: var(--fg-strong); }
  dialog p { margin: 0 0 12px; }
  dialog .price { font-size: 22px; font-weight: 650; color: var(--fg-strong); }
  dialog label.check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; color: var(--fg); margin: 0 0 14px; }
  dialog label.check input { flex: none; width: auto; padding: 0; margin: 2px 0 0; }
  dialog button:disabled { opacity: 0.45; cursor: default; }
  @media (max-width: 520px) { .step { padding-left: 36px; } dl.review { grid-template-columns: 1fr; } dl.review dt { margin-top: 6px; } }
`;

export function deployPage(c: DeployPageConfig): string {
  const perms = c.permissions.map((p) => `<li><b>${esc(label(p.key))}</b> (${p.type == "read" ? "read" : "edit"}): ${esc(p.why)}</li>`).join("");
  const body = `${crumbs(null, [{ label: "Deploy" }])}<main>
  <header><div><h1>Deploy your own Erga</h1><p class="sub">A copy of this server on your own Cloudflare account, with you (${esc(c.login)}) as its admin: the same Worker, database and settings${c.release ? ` (release <code>${esc(c.release.version)}</code>)` : ""}.</p></div></header>
  ${c.release ? "" : `<p class="error">This server has no release to deploy yet: it's made when the server is deployed (<code>bun deploy/release.ts</code>).</p>`}
  <p class="error" id="top-error">${esc(c.error)}</p>
  <ol class="steps">
    <li class="step" id="s-connect" data-step="connect">
      <h2>Connect Cloudflare <a class="change" href="#" data-goto="connect" hidden>Change</a></h2>
      <p class="summary" id="sum-connect"></p>
      <div class="body">
        ${c.oauth ? `<p>Sign in to Cloudflare and let Erga deploy to your account. You choose the account on Cloudflare's page, and can take the access back there afterwards; Erga gives it back by itself when the deploy is done.</p>
        <p class="row"><a class="new" id="oauth" href="/deploy/auth/cloudflare">Authorize with Cloudflare</a></p>
        <details id="token-details"><summary>Or use an API token</summary>` : `<p>Erga needs an API token for your account to deploy with. Cloudflare's OAuth isn't set up on this server yet, so make a token with the link below: it opens Cloudflare's "Create API token" page with exactly the permissions the deploy needs filled in. Create it, copy it, and paste it here.</p><div>`}
          <p class="row"><a class="pill" id="token-link" href="${esc(c.tokenUrl)}" target="_blank" rel="noopener">Create the token on Cloudflare ↗</a>
          <label class="muted"><input type="checkbox" id="with-registrar"> Include buying a domain</label></p>
          <p class="muted">The token gets:</p>
          <ul class="perms">${perms}</ul>
          <div class="row"><input class="input mono" id="token" type="password" placeholder="Paste the token" autocomplete="off" spellcheck="false" aria-label="Cloudflare API token"><button class="new" id="connect">Connect</button></div>
        ${c.oauth ? "</details>" : "</div>"}
        <p class="muted">Erga keeps the token only while you deploy: sealed, in this browser's deploy session, never logged and never in its database. It's forgotten when the deploy is done (or two hours after you connect), and you can delete the token on Cloudflare afterwards.</p>
        <p class="error" id="connect-error"></p>
      </div>
    </li>
    <li class="step later" id="s-where" data-step="where">
      <h2>Where it goes <a class="change" href="#" data-goto="where" hidden>Change</a></h2>
      <p class="summary" id="sum-where"></p>
      <div class="body">
        <label class="field" id="account-field">Cloudflare account<select id="account"></select></label>
        <div id="sub-new" hidden><label class="field">Your account has no workers.dev subdomain yet: choose one (it's yours for all your Workers)<input class="input mono" id="subdomain" placeholder="your-name" autocomplete="off" spellcheck="false"></label></div>
        <fieldset><legend>The app's address</legend>
          <label class="choice"><input type="radio" name="app" value="workers.dev" checked><span><b id="app-wd">erga.…workers.dev</b><span class="muted">Free, and works straight away.</span></span></label>
          <label class="choice" id="app-domain-choice"><input type="radio" name="app" value="domain"><span><b>A domain of yours</b><span class="muted">One of the domains in your Cloudflare account (a custom domain on the Worker).</span>
            <span class="row"><select id="app-zone" aria-label="Domain for the app"></select><input class="input mono" id="app-host" placeholder="erga.example.com" aria-label="Hostname for the app" autocomplete="off" spellcheck="false"></span></span></label>
        </fieldset>
        <fieldset><legend>Where documents' pages run</legend>
          <p class="muted">A page's own scripts never run on the app's address, so they can't act as whoever views them. erga.dev gives each document an origin of its own on a second domain (erga-pages.dev).</p>
          <label class="choice"><input type="radio" name="pages" value="shared" checked><span><b id="pages-wd">erga-pages.…workers.dev</b><span class="muted">One address every document's pages share (workers.dev has no wildcards). Pages stay away from the app, but not from each other: fine to try Erga out, or for people who trust each other.</span></span></label>
          <label class="choice" id="pages-zone-choice"><input type="radio" name="pages" value="zone"><span><b>A second domain of yours</b><span class="muted">Each document gets its own origin under it, as on erga.dev (a wildcard route and DNS record). Not the app's domain.</span>
            <span class="row"><select id="pages-zone" aria-label="Domain for documents' pages"></select></span></span></label>
        </fieldset>
        <details id="buy"><summary>Get a new domain</summary>
          <p class="muted">Search Cloudflare Registrar. Nothing is bought until you've seen the price and confirmed it. ${c.oauth ? "" : "Your token needs the Registrar permission (tick “Include buying a domain” when you make it)."} Or buy one on <a href="https://dash.cloudflare.com/?to=/:account/domains/register" target="_blank" rel="noopener">Cloudflare's Registrar page ↗</a> and reload.</p>
          <div class="row"><input class="input" id="q" placeholder="a name, like myerga" autocomplete="off" spellcheck="false" aria-label="Domain to search for"><button class="pill" id="search">Search</button></div>
          <p class="error" id="buy-error"></p>
          <ol class="offers" id="offers"></ol>
        </details>
        <p class="error" id="where-error"></p>
        <p class="row"><button class="new" id="where-next">Continue</button></p>
      </div>
    </li>
    <li class="step later" id="s-github" data-step="github">
      <h2>Signing in with GitHub <a class="change" href="#" data-goto="github" hidden>Change</a></h2>
      <p class="summary" id="sum-github"></p>
      <div class="body">
        <p>People sign in to your Erga with GitHub, through a GitHub OAuth app of your own. Make one (it's free, and takes a minute): <a class="pill small" id="gh-new" href="https://github.com/settings/applications/new" target="_blank" rel="noopener">New OAuth app on GitHub ↗</a>, with:</p>
        <div class="copy"><span>Application name</span><code id="gh-name">Erga</code><button class="pill small" data-copy="gh-name">Copy</button></div>
        <div class="copy"><span>Homepage URL</span><code id="gh-home"></code><button class="pill small" data-copy="gh-home">Copy</button></div>
        <div class="copy"><span>Callback URL</span><code id="gh-callback"></code><button class="pill small" data-copy="gh-callback">Copy</button></div>
        <p class="muted">Register it, then copy its Client ID, and press "Generate a new client secret" and copy that.</p>
        <label class="field">Client ID<input class="input mono" id="gh-id" autocomplete="off" spellcheck="false"></label>
        <label class="field">Client secret<input class="input mono" id="gh-secret" type="password" autocomplete="off" spellcheck="false"></label>
        <label class="field">Anthropic API key (optional: turns on the agent in the editor; add it later as a secret if you like)<input class="input mono" id="anthropic" type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false"></label>
        <p class="error" id="github-error"></p>
        <p class="row"><button class="new" id="github-next">Continue</button></p>
      </div>
    </li>
    <li class="step later" id="s-deploy" data-step="deploy">
      <h2>Deploy</h2>
      <p class="summary" id="sum-deploy"></p>
      <div class="body">
        <div id="review-box">
          <dl class="review" id="review"></dl>
          <p class="error" id="deploy-error"></p>
          <p class="row"><button class="new" id="go"${c.release ? "" : " disabled"}>Deploy to Cloudflare</button></p>
        </div>
        <div id="run-box" hidden>
          <div class="live" id="live" hidden></div>
          <ol class="progress" id="progress"></ol>
          <p class="error" id="run-error"></p>
          <p class="row" id="run-actions" hidden><button class="new" id="retry">Try again</button><button class="pill" id="restart">Change something</button></p>
        </div>
      </div>
    </li>
  </ol>
</main>
<dialog id="confirm-buy">
  <h2>Buy <span id="buy-name"></span>?</h2>
  <p class="price" id="buy-price"></p>
  <p class="muted" id="buy-renewal"></p>
  <p>Cloudflare charges your account's default payment method now. A registration can't be refunded once it goes through.</p>
  <label class="check"><input type="checkbox" id="buy-ok"> I want to buy this domain for this price</label>
  <p class="error" id="confirm-error"></p>
  <div class="buttons"><button id="buy-cancel">Cancel</button><button class="primary" id="buy-go" disabled>Buy</button></div>
</dialog>
<script>${SCRIPT.replace("__CONFIG__", JSON.stringify({ login: c.login, mock: c.mock, tokenUrl: c.tokenUrl, tokenUrlRegistrar: c.tokenUrlRegistrar }).replace(/</g, "\\u003c"))}</script>`;
  return appPage("Deploy your own", STYLE, body);
}

const LABELS: Record<string, string> = { account_settings: "Account Settings", workers_scripts: "Workers Scripts", d1: "D1", workers_routes: "Workers Routes", zone: "Zone", dns: "DNS", registrar_domains: "Registrar: Domains" };
const label = (key: string) => LABELS[key] ?? key;

/** Local development only: a stand-in for Cloudflare's consent page. */
export function mockConsentPage(url: URL): Response {
  const back = new URL(url.searchParams.get("redirect_uri") ?? "/deploy", url);
  if (back.origin != url.origin) return new Response("Bad redirect", { status: 400 });
  const yes = new URL(back), no = new URL(back);
  yes.searchParams.set("code", "mock-code"); yes.searchParams.set("state", url.searchParams.get("state") ?? "");
  no.searchParams.set("error", "access_denied"); no.searchParams.set("state", url.searchParams.get("state") ?? "");
  return new Response(appPage("Pretend Cloudflare", `main { max-width: 480px; } .scopes { font-size: 13px; color: var(--soft); overflow-wrap: anywhere; }`, `<main>
  <header><div><h1>Pretend Cloudflare</h1><p class="sub">Stands in for Cloudflare's consent page in local development.</p></div></header>
  <p><b>Erga</b> would like to deploy to <b>Ada's account</b>.</p>
  <p class="scopes">Scopes: ${esc(url.searchParams.get("scope") ?? "")}</p>
  <p class="row" style="display:flex;gap:8px"><a class="new" id="authorize" href="${esc(yes.pathname + yes.search)}">Authorize</a><a class="pill" href="${esc(no.pathname + no.search)}">Cancel</a></p>
</main>`), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const SCRIPT = `
const C = __CONFIG__;
const $ = (id) => document.getElementById(id);
const S = { info: null, accounts: [], account: null, sub: null, createSub: false, zones: [], plan: null, step: "connect", polling: false };
const order = ["connect", "where", "github", "deploy"];

async function api(path, body) {
  const r = await fetch("/deploy/api/" + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const answer = r ? await r.json().catch(() => null) : null;
  if (!r) throw new Error("Couldn't reach Erga: check your connection and try again.");
  if (!answer || answer.ok === false) throw new Error((answer && answer.error) || "Something went wrong (" + r.status + "). Try again.");
  return answer;
}
const say = (id, text) => { $(id).textContent = text || ""; };
const busy = (button, on, text) => { if (on) { button.dataset.label = button.textContent; button.textContent = text; } else if (button.dataset.label) button.textContent = button.dataset.label; button.disabled = on; };

function go(step) {
  S.step = step;
  const at = order.indexOf(step);
  for (const s of order) {
    const li = $("s-" + s), i = order.indexOf(s);
    li.classList.toggle("current", i == at);
    li.classList.toggle("done", i < at);
    li.classList.toggle("later", i > at);
    li.querySelector(".change") && (li.querySelector(".change").hidden = !(i < at) || !!(S.info && S.info.run && S.info.run.status != "failed"));
  }
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-goto]");
  if (a) { e.preventDefault(); if (a.dataset.goto == "connect") { api("forget", {}).catch(() => {}); S.info = { connected: false }; } go(a.dataset.goto); }
  const c = e.target.closest("[data-copy]");
  if (c) { navigator.clipboard.writeText($(c.dataset.copy).textContent).then(() => { c.textContent = "Copied"; setTimeout(() => (c.textContent = "Copy"), 1200); }); }
});

$("with-registrar") && $("with-registrar").addEventListener("change", (e) => { $("token-link").href = e.target.checked ? C.tokenUrlRegistrar : C.tokenUrl; });
$("connect").addEventListener("click", async () => {
  say("connect-error");
  busy($("connect"), true, "Checking…");
  try {
    const r = await api("connect", { token: $("token").value });
    $("token").value = "";
    await loaded({ connected: true, via: "token", accounts: r.accounts, run: null });
  } catch (e) { say("connect-error", e.message); }
  busy($("connect"), false);
});
$("token").addEventListener("keydown", (e) => { if (e.key == "Enter") $("connect").click(); });

/** After connecting: the accounts, then the chosen one's subdomain and domains. */
async function loaded(info) {
  S.info = info; S.accounts = info.accounts || [];
  $("sum-connect").textContent = "Connected " + (info.via == "oauth" ? "with Cloudflare's authorization" : "with an API token") + ": " + S.accounts.map((a) => a.name).join(", ");
  $("account").innerHTML = S.accounts.map((a) => '<option value="' + a.id + '">' + esc(a.name) + "</option>").join("");
  $("account-field").hidden = S.accounts.length < 2;
  await chooseAccount(S.accounts[0] && S.accounts[0].id);
  if (info.run) return showRun(info.run);
  go("where");
}
$("account").addEventListener("change", (e) => chooseAccount(e.target.value));
async function chooseAccount(id) {
  if (!id) return;
  S.account = id;
  say("where-error");
  try {
    const r = await api("account", { accountId: id });
    S.sub = r.subdomain; S.zones = r.zones.filter((z) => z.status == "active" || z.status == "pending");
  } catch (e) { say("where-error", e.message); S.sub = null; S.zones = []; }
  $("sub-new").hidden = !!S.sub;
  const zones = S.zones.map((z) => '<option value="' + z.id + '">' + esc(z.name) + "</option>").join("");
  const none = '<option value="">No domains in this account yet</option>';
  $("app-zone").innerHTML = zones || none; $("pages-zone").innerHTML = zones || none;
  if (S.zones[1]) $("pages-zone").value = S.zones[1].id;
  for (const id of ["app-domain-choice", "pages-zone-choice"]) $(id).querySelector("input").disabled = !S.zones.length;
  zoneChanged();
  names();
}
function sub() { return S.sub || $("subdomain").value.trim().toLowerCase() || "your-subdomain"; }
function names() {
  $("app-wd").textContent = "erga." + sub() + ".workers.dev";
  $("pages-wd").textContent = "erga-pages." + sub() + ".workers.dev";
}
$("subdomain").addEventListener("input", names);
function zoneChanged() {
  const z = S.zones.find((z) => z.id == $("app-zone").value);
  if (z && (!$("app-host").value || !$("app-host").dataset.touched)) $("app-host").value = z.name;
}
$("app-zone").addEventListener("change", () => { $("app-host").dataset.touched = ""; zoneChanged(); document.querySelector('input[name=app][value=domain]').checked = true; });
$("app-host").addEventListener("input", () => { $("app-host").dataset.touched = "1"; document.querySelector('input[name=app][value=domain]').checked = true; });
$("pages-zone").addEventListener("change", () => { document.querySelector('input[name=pages][value=zone]').checked = true; });

function where() {
  const appKind = document.querySelector("input[name=app]:checked").value;
  const pagesKind = document.querySelector("input[name=pages]:checked").value;
  const zone = (id) => S.zones.find((z) => z.id == id);
  const app = appKind == "domain" ? { kind: "domain", zoneId: $("app-zone").value, zoneName: (zone($("app-zone").value) || {}).name || "", hostname: $("app-host").value.trim().toLowerCase() } : { kind: "workers.dev" };
  const pages = pagesKind == "zone" ? { kind: "zone", zoneId: $("pages-zone").value, zoneName: (zone($("pages-zone").value) || {}).name || "" } : { kind: "shared" };
  return { accountId: S.account, workerName: "erga", subdomain: sub(), createSubdomain: !S.sub, app, pages };
}
const appUrl = (w) => "https://" + (w.app.kind == "domain" ? w.app.hostname : w.workerName + "." + w.subdomain + ".workers.dev");
const pagesAt = (w) => w.pages.kind == "zone" ? "<document>." + w.pages.zoneName : w.workerName + "-pages." + w.subdomain + ".workers.dev";
$("where-next").addEventListener("click", () => {
  say("where-error");
  const w = where();
  if (!S.sub && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test($("subdomain").value.trim().toLowerCase())) return say("where-error", "Choose a workers.dev subdomain: lowercase letters, digits and dashes.");
  if (w.app.kind == "domain" && !(w.app.hostname == w.app.zoneName || w.app.hostname.endsWith("." + w.app.zoneName))) return say("where-error", "The app's address must be " + w.app.zoneName + " or a name under it.");
  if (w.app.kind == "domain" && w.pages.kind == "zone" && w.app.zoneId == w.pages.zoneId) return say("where-error", "Documents' pages need a different domain from the app's: pick another, or the shared pages address.");
  S.where = w;
  $("sum-where").textContent = appUrl(w) + " · pages on " + pagesAt(w);
  const home = appUrl(w);
  $("gh-home").textContent = home; $("gh-callback").textContent = home + "/auth/github/callback";
  const gh = new URL("https://github.com/settings/applications/new");
  gh.searchParams.set("oauth_application[name]", "Erga"); gh.searchParams.set("oauth_application[url]", home); gh.searchParams.set("oauth_application[callback_url]", home + "/auth/github/callback");
  $("gh-new").href = gh.toString();
  go("github");
});

// Buying a domain: search, see the price, confirm it, buy.
$("search").addEventListener("click", async () => {
  say("buy-error"); $("offers").innerHTML = "";
  busy($("search"), true, "Searching…");
  try {
    const r = await api("domains/search", { accountId: S.account, q: $("q").value });
    $("offers").innerHTML = r.offers.length ? r.offers.map((o, i) => '<li><span class="name">' + esc(o.name) + "</span>" + (o.registrable
      ? '<span class="price">' + esc(o.price + " " + o.currency) + '</span><span class="why">/ year</span><button class="pill small" data-buy="' + i + '">Buy…</button>'
      : '<span class="why">' + esc(o.reason || "not available") + "</span>") + "</li>").join("") : '<li class="why">Nothing found: try another name.</li>';
    S.offers = r.offers;
  } catch (e) { say("buy-error", e.message); }
  busy($("search"), false);
});
$("q").addEventListener("keydown", (e) => { if (e.key == "Enter") $("search").click(); });
$("offers").addEventListener("click", (e) => {
  const b = e.target.closest("[data-buy]");
  if (!b) return;
  const o = S.offers[+b.dataset.buy];
  S.buying = o;
  $("buy-name").textContent = o.name;
  $("buy-price").textContent = o.price + " " + o.currency;
  $("buy-renewal").textContent = "for the first year; it renews at " + o.renewal + " " + o.currency + " a year (auto-renew starts off: turn it on in your dashboard).";
  $("buy-ok").checked = false; $("buy-go").disabled = true; $("buy-go").textContent = "Buy for " + o.price + " " + o.currency; say("confirm-error");
  $("confirm-buy").showModal();
});
$("buy-ok").addEventListener("change", (e) => { $("buy-go").disabled = !e.target.checked; });
$("buy-cancel").addEventListener("click", () => $("confirm-buy").close());
$("buy-go").addEventListener("click", async () => {
  const o = S.buying;
  if (!$("buy-ok").checked) return;
  busy($("buy-go"), true, "Buying…"); $("buy-cancel").disabled = true;
  try {
    const r = await api("domains/register", { accountId: S.account, name: o.name, price: o.price, currency: o.currency });
    $("confirm-buy").close();
    await chooseAccount(S.account);
    const z = S.zones.find((z) => z.name == o.name);
    if (z) { $("app-zone").value = z.id; $("app-host").dataset.touched = ""; zoneChanged(); document.querySelector('input[name=app][value=domain]').checked = true; }
    $("offers").innerHTML = '<li><span class="name">' + esc(o.name) + '</span><span class="why">' + (r.completed ? "Registered: it's yours, and chosen as the app's address." : "Registration in progress: it shows up in your domains when it's done.") + "</span></li>";
    $("buy").open = true;
  } catch (e) { say("confirm-error", e.message); }
  busy($("buy-go"), false); $("buy-cancel").disabled = false;
});

$("github-next").addEventListener("click", () => {
  say("github-error");
  const id = $("gh-id").value.trim(), secret = $("gh-secret").value.trim(), key = $("anthropic").value.trim();
  if (!/^[A-Za-z0-9._-]{8,64}$/.test(id)) return say("github-error", "Paste your GitHub OAuth app's Client ID.");
  if (secret.length < 20) return say("github-error", "Paste the client secret (press “Generate a new client secret” on the app's page).");
  if (key && !key.startsWith("sk-")) return say("github-error", "An Anthropic API key starts with sk-; leave it empty to go without the agent.");
  $("sum-github").textContent = "GitHub app " + id + (key ? ", with the agent" : ", without the agent");
  const w = S.where;
  $("review").innerHTML = [
    ["Account", (S.accounts.find((a) => a.id == w.accountId) || {}).name],
    ["Address", appUrl(w)],
    ["Documents' pages", pagesAt(w) + (w.pages.kind == "shared" ? " (shared)" : " (one origin each)")],
    ["Worker", w.workerName + (w.createSubdomain ? ", on a new workers.dev subdomain " + w.subdomain : "")],
    ["Database", "D1, “erga”"],
    ["Admin", C.login + " (you)"],
    ["Sign-in", "GitHub app " + id],
    ["Agent", key ? "on (your Anthropic key)" : "off"],
  ].map(([k, v]) => "<dt>" + esc(k) + "</dt><dd>" + esc(v || "") + "</dd>").join("");
  go("deploy");
});

$("go").addEventListener("click", async () => {
  say("deploy-error");
  const plan = { ...S.where, admin: C.login, githubClientId: $("gh-id").value.trim(), githubClientSecret: $("gh-secret").value.trim(), anthropicKey: $("anthropic").value.trim() || undefined };
  S.plan = plan;
  busy($("go"), true, "Starting…");
  try { const r = await api("start", { plan }); showRun(r.run); } catch (e) { say("deploy-error", e.message); }
  busy($("go"), false);
});
$("retry").addEventListener("click", async () => {
  say("run-error"); $("run-actions").hidden = true;
  try { const r = await api("start", { plan: S.plan }); showRun(r.run); } catch (e) { say("run-error", e.message); $("run-actions").hidden = false; }
});
$("restart").addEventListener("click", () => { $("run-box").hidden = true; $("review-box").hidden = false; S.info.run = null; go("where"); });

const ICONS = { done: "✓", skipped: "–", failed: "!", running: "", pending: "" };
function showRun(run) {
  S.info = { ...(S.info || {}), run };
  go("deploy");
  for (const s of ["connect", "where", "github"]) if (!$("sum-" + s).textContent) $("sum-" + s).textContent = s == "where" ? run.summary.app + " · pages on " + run.summary.pages : "Done";
  $("review-box").hidden = true; $("run-box").hidden = false;
  $("progress").innerHTML = run.steps.map((s) => '<li class="' + s.status + '" data-id="' + s.id + '"><span class="icon">' + ICONS[s.status] + "</span><span>" + esc(s.title) + "</span>" + (s.detail ? '<span class="detail">' + esc(s.detail) + "</span>" : "") + "</li>").join("");
  say("run-error", run.status == "failed" ? run.error : "");
  $("run-actions").hidden = run.status != "failed";
  $("sum-deploy").textContent = run.status == "running" ? "Deploying…" : run.status == "done" ? "Deployed" : "Stopped";
  if (run.status == "done") {
    const tokenWay = S.info.via != "oauth";
    $("live").hidden = false;
    $("live").innerHTML = "<h3>Your Erga is live</h3><p><a class='new' id='open-new' href='" + esc(run.result.url) + "' target='_blank' rel='noopener'>Open " + esc(run.result.url.replace("https://", "")) + " ↗</a></p>"
      + "<p>Sign in there with GitHub as <b>" + esc(C.login) + "</b>: you're its admin, and add everyone else on its Admin page. Its front page is made the first time it's opened, yours to edit.</p>"
      + "<p class='muted'>" + (tokenWay
        ? "Erga has forgotten your Cloudflare token. You can delete it now: <a href='https://dash.cloudflare.com/profile/api-tokens' target='_blank' rel='noopener'>API Tokens on Cloudflare ↗</a> (it's called “Erga deploy”)."
        : "Erga has forgotten its access to your account and given it back to Cloudflare. <a href='https://dash.cloudflare.com/?to=/profile/access-management/authorization' target='_blank' rel='noopener'>Your OAuth authorizations ↗</a>.") + "</p>";
  }
  if (run.status == "running" && !S.polling) poll();
}
async function poll() {
  S.polling = true;
  while (true) {
    await new Promise((r) => setTimeout(r, 700));
    const info = await api("session").catch(() => null);
    if (!info || !info.run) continue;
    S.info = { ...S.info, ...info };
    showRun(info.run);
    if (info.run.status != "running") break;
  }
  S.polling = false;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

go("connect");
api("session").then((info) => { if (info.connected || info.run) return loaded(info); }).catch(() => {});
`;

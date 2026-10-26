// The deploy page, /deploy (on the control Worker): connect Cloudflare,
// choose where the new Erga goes (and buy a domain, if you like, after seeing
// the price), and
// beside it, which keeps it up to date. One page; its script asks
// /deploy/api/* and redraws.

import { appPage, crumbs, inlineScript, inlineStyle } from "../../server/pages/index.ts";
import { esc } from "../../shared/html.ts";
import { TARGETS } from "../../deploy/targets.ts";

export interface DeployPageConfig {
  login: string;
  name: string;
  /** "Authorize with Cloudflare" is offered (the server has an OAuth client, or it's the mock). */
  oauth: boolean;
  mock: boolean;
  /** The release the install deploys: stable's latest from the store (from "stable"), or the server's own in local development. */
  release: { version: string; built: string; from: string } | null;
  /** The control Worker's name beside the app's (erga-control), for the page's words. */
  controlWorker: string;
  tokenUrl: string;
  tokenUrlRegistrar: string;
  permissions: { key: string; type: string; why: string }[];
  /** An error to show as the page opens (back from Cloudflare's OAuth). */
  error: string;
}


export function deployPage(c: DeployPageConfig): string {
  const perms = c.permissions.map((p) => `<li><b>${esc(label(p.key))}</b> (${p.type == "read" ? "read" : "edit"}): ${esc(p.why)}</li>`).join("");
  const body = `${crumbs(null, [{ label: "Deploy" }])}<main>
  <header><div><h1>Install your own Erga</h1><p class="sub">Erga on your own Cloudflare account, with you (${esc(c.login)}) as its admin: the app, and a small control Worker beside it that keeps it up to date with Erga's releases${c.release ? ` (release <code>${esc(c.release.version)}</code>, ${esc(c.release.from == "stable" ? "the latest on stable" : `from ${c.release.from}`)})` : ""}.</p></div></header>
  ${c.release ? "" : `<p class="error">There's no release to install yet: an admin promotes one to stable on the Ops page first.</p>`}
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
          <p class="muted">A page's own scripts never run on the app's address, so they can't act as whoever views them. ${esc(TARGETS.production.host)} gives each document an origin of its own on a second domain (${esc(TARGETS.production.pages.domain)}).</p>
          <label class="choice"><input type="radio" name="pages" value="shared" checked><span><b id="pages-wd">erga-pages.…workers.dev</b><span class="muted">One address every document's pages share (workers.dev has no wildcards). Pages stay away from the app, but not from each other: fine to try Erga out, or for people who trust each other.</span></span></label>
          <label class="choice" id="pages-zone-choice"><input type="radio" name="pages" value="zone"><span><b>A second domain of yours</b><span class="muted">Each document gets its own origin under it, as on ${esc(TARGETS.production.host)} (a wildcard route and DNS record). Not the app's domain.</span>
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
    <li class="step later" id="s-agent" data-step="agent">
      <h2>Sign-in and the agent <a class="change" href="#" data-goto="agent" hidden>Change</a></h2>
      <p class="summary" id="sum-agent"></p>
      <div class="body">
        <p>People sign in to your Erga with GitHub, through Erga's own GitHub App (${esc(TARGETS.production.host)} relays the sign-in to your server). Nothing to make, nothing to paste. On its Ops page you can connect a GitHub repository of yours the same way.</p>
        <label class="field">Anthropic API key (optional: turns on the agent in the editor; add it later as a secret if you like)<input class="input mono" id="anthropic" type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false"></label>
        <p class="error" id="agent-error"></p>
        <p class="row"><button class="new" id="agent-next">Continue</button></p>
      </div>
    </li>
    <li class="step later" id="s-deploy" data-step="deploy">
      <h2>Deploy</h2>
      <p class="summary" id="sum-deploy"></p>
      <div class="body">
        <div id="review-box">
          <dl class="review" id="review"></dl>
          <p class="error" id="deploy-error"></p>
          <p class="row"><button class="new" id="go"${c.release ? "" : " disabled"}>Install on Cloudflare</button></p>
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
${inlineScript("install", { login: c.login, mock: c.mock, tokenUrl: c.tokenUrl, tokenUrlRegistrar: c.tokenUrlRegistrar, controlWorker: c.controlWorker, release: c.release })}`;
  return appPage("Install your own", inlineStyle("install"), body);
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


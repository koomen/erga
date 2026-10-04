#!/usr/bin/env bun
// /deploy end to end, in headless Chrome, against a dev server whose
// Cloudflare is pretend (ERGA_DEPLOY_MOCK=1, deploy/mock.ts): nothing real
// is deployed or bought. An admin authorizes with (pretend) Cloudflare's
// OAuth, buys a domain after confirming its price, puts the app on it and
// documents' pages on a second domain, fills in a GitHub app, deploys and
// watches every step; then what the mock was asked for is checked (the mock
// is for tests only: the page itself never mentions it). Another
// connects with a pasted token, on workers.dev, and the deploy fails at a
// step, saying why. Who may open the page (deploy_page) last. Screenshots of
// each step land in tests/cdp.ts's SHOTS (deploy-*.png).
//
//   bun tests/deploy.ts

import { existsSync } from "fs";
import { join } from "path";
import { Browser, ROOT, SHOTS, type Page } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);

// The release /deploy deploys (deploy/release.ts), made if this checkout has none.
if (!existsSync(join(ROOT, ".site/release/release.json"))) {
  if (!existsSync(join(ROOT, ".site/page.js"))) expect(Bun.spawnSync([join(ROOT, "site.sh")], { cwd: ROOT }).exitCode == 0, "site.sh");
  const made = Bun.spawnSync(["bun", join(ROOT, "deploy/release.ts")], { cwd: ROOT });
  expect(made.exitCode == 0, "the release builds", made.stderr.toString());
}

const browser = await Browser.launch();
const host = await startHost(null, { env: { ERGA_DEPLOY_MOCK: "1" } });
/** A screenshot, the step being worked on (or `at`) scrolled to the top. */
const shot = async (p: Page, name: string, at = ".step.current") => {
  await p.eval(`(() => { const el = document.querySelector(${JSON.stringify(at)}); if (el && el.id != "s-connect") el.scrollIntoView({ block: "start" }); return true; })()`);
  await p.settle();
  await p.screenshot(join(SHOTS, `deploy-${name}.png`));
};
/** Sets an input's value as typing would. */
const fill = (p: Page, id: string, value: string) => p.eval(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const click = (p: Page, selector: string) => p.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no " + ${JSON.stringify(selector)}); el.click(); return true; })()`);
const text = (p: Page, selector: string) => p.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
const current = (p: Page) => p.eval<string>(`document.querySelector(".step.current")?.dataset.step ?? ""`);

try {
  // ---------------------------------------------------------------- OAuth, a new domain, the full deploy
  const p = await browser.page(await browser.context());
  await p.open(`${host.root}/auth/github?next=/deploy`, { width: 1000, height: 1100, scale: 2 });
  await until(() => p.eval(`location.pathname == "/deploy" && !!document.getElementById("oauth")`), 15_000, "/deploy opens for an admin");
  expect(!(await p.eval(`document.body.innerText`)).match(/experimental|pretend|mock/i), "no experimental or mock notices on the page");
  expect((await text(p, ".crumbs .brand")) == "Erga" && (await text(p, ".crumbs .here")) == "Deploy", "breadcrumbs: Erga, then Deploy", await text(p, ".crumbs"));
  expect(await p.eval(`(() => { const r = document.querySelector(".crumbs").getBoundingClientRect(); return r.top < 40 && r.left < 40; })()`), "in the upper left");
  await shot(p, "1-connect");
  ok("/deploy opens, with its breadcrumbs in the upper left, and no experimental or mock notices");

  // A token that isn't one: refused, plainly.
  await click(p, "#token-details summary");
  await fill(p, "token", "this-is-not-a-real-token-at-all");
  await click(p, "#connect");
  await until(async () => (await text(p, "#connect-error")).includes("didn't accept the token"), 10_000, "a bad token is refused, saying why", () => text(p, "#connect-error"));
  ok("a bad token is refused in plain words");

  // OAuth: to (pretend) Cloudflare's consent page and back.
  await click(p, "#oauth");
  await until(() => p.eval(`location.pathname == "/deploy/mock/consent" && !!document.getElementById("authorize")`), 10_000, "the bounce goes to Cloudflare's consent page");
  const scopes = await text(p, ".scopes");
  expect(scopes.includes("workers-scripts.write") && scopes.includes("d1.write"), "it asks for the deploy's scopes", scopes);
  await shot(p, "2-consent");
  await click(p, "#authorize");
  await until(async () => (await p.eval(`location.pathname`)) == "/deploy" && (await current(p)) == "where", 15_000, "back from Cloudflare, connected, on to where it goes", () => p.eval(`document.body.innerText.slice(0, 1500)`));
  expect((await text(p, "#sum-connect")).includes("Cloudflare's authorization"), "connected with Cloudflare's authorization", await text(p, "#sum-connect"));
  expect((await text(p, "#app-wd")) == "erga.ada-mock.workers.dev", "the workers.dev address is the account's", await text(p, "#app-wd"));
  ok("Authorize with Cloudflare: the bounce, consent, and back connected");

  // A new domain: search, see the price, confirm, buy.
  await click(p, "#buy summary");
  await fill(p, "q", "myerga");
  await click(p, "#search");
  await until(() => p.eval(`document.querySelectorAll("#offers li").length == 4`), 10_000, "search shows offers");
  const offers = await text(p, "#offers");
  expect(offers.includes("myerga.com") && offers.includes("10.44 USD") && offers.includes("can't be registered through the API"), "with prices, and why one can't be had", offers);
  await shot(p, "3-domain-search", "#buy");
  await click(p, "[data-buy='0']");
  await until(() => p.eval(`document.getElementById("confirm-buy").open`), 5000, "buying asks first");
  expect((await text(p, "#buy-price")) == "10.44 USD" && (await p.eval(`document.getElementById("buy-go").disabled`)), "showing the price, with Buy off until it's confirmed");
  await click(p, "#buy-go");
  let state = await p.eval<any>(`fetch("/deploy/api/mock").then((r) => r.json())`);
  expect(state.registrations.length == 0, "nothing bought without the confirmation", state.registrations);
  await click(p, "#buy-ok");
  await shot(p, "4-confirm-price");
  await click(p, "#buy-go");
  await until(async () => (await text(p, "#offers")).includes("Registered"), 10_000, "bought, and chosen as the app's domain", () => text(p, "#confirm-error"));
  expect(await p.eval(`document.querySelector("input[name=app][value=domain]").checked && document.getElementById("app-host").value == "myerga.com"`), "the new domain is the app's address");
  state = await p.eval<any>(`fetch("/deploy/api/mock").then((r) => r.json())`);
  expect(state.registrations.length == 1 && state.registrations[0].domain == "myerga.com" && state.registrations[0].price == "10.44", "one registration, at the confirmed price", state.registrations);
  ok("a domain is bought only after its price is shown and confirmed");

  // Documents' pages on a second domain.
  await p.eval(`(() => { const s = document.getElementById("pages-zone"); s.value = [...s.options].find((o) => o.textContent == "ada-pages.net").value; s.dispatchEvent(new Event("change")); return true; })()`);
  await fill(p, "app-host", "write.myerga.com");
  await shot(p, "5-where");
  await click(p, "#where-next");
  await until(async () => (await current(p)) == "github", 5000, "on to GitHub", () => text(p, "#where-error"));
  expect((await text(p, "#gh-callback")) == "https://write.myerga.com/auth/github/callback", "the GitHub app's callback is the new address's", await text(p, "#gh-callback"));
  expect((await p.eval<string>(`document.getElementById("gh-new").href`)).includes("oauth_application%5Bcallback_url%5D=https%3A%2F%2Fwrite.myerga.com"), "and the link to make one is filled in");
  await click(p, "#github-next");
  expect((await text(p, "#github-error")).includes("Client ID"), "it asks for the GitHub app's ID first");
  await fill(p, "gh-id", "Ov23liMockClientId");
  await fill(p, "gh-secret", "0123456789abcdef0123456789abcdef01234567");
  await shot(p, "6-github");
  await click(p, "#github-next");
  await until(async () => (await current(p)) == "deploy", 5000, "on to deploying");
  const review = await text(p, "#review");
  expect(review.includes("https://write.myerga.com") && review.includes("<document>.ada-pages.net") && review.includes("tester (you)"), "the review says where it goes and who's admin", review);
  await shot(p, "7-review");
  ok("where it goes, and a GitHub app, with the callback filled in");

  // Deploy, watching the steps go by.
  await click(p, "#go");
  await until(() => p.eval(`document.querySelectorAll("#progress li.done").length >= 2 && !!document.querySelector("#progress li.running, #progress li.pending")`), 20_000, "the steps show as they go", () => text(p, "#s-deploy"));
  await shot(p, "8-deploying", "#s-deploy");
  await until(() => p.eval(`!document.getElementById("live").hidden`), 60_000, "the deploy finishes", () => text(p, "#run-box"));
  expect(await p.eval(`document.querySelectorAll("#progress li.done").length == 8`), "every step done", await text(p, "#progress"));
  const live = await text(p, "#live");
  expect(live.includes("write.myerga.com") && live.includes("given it back to Cloudflare"), "it says where it's live, and that the access was given back", live);
  await shot(p, "9-live", "#s-deploy");
  state = await p.eval<any>(`fetch("/deploy/api/mock").then((r) => r.json())`);
  const b = Object.fromEntries(state.scripts.erga.metadata.bindings.map((x: any) => [x.name, x]));
  expect(b.ADMINS.text == "tester" && b.PAGES_DOMAIN.text == "ada-pages.net" && b.GITHUB_CLIENT_ID.text == "Ov23liMockClientId", "the Worker's settings are the new server's own", b);
  expect(!JSON.stringify(state).includes("0123456789abcdef0123456789abcdef01234567"), "no secret is kept in the clear");
  expect(state.domains.some((d: any) => d.hostname == "write.myerga.com") && state.routes[Object.keys(state.routes)[0]][0].pattern == "*.ada-pages.net/*", "the custom domain and the pages route", state);
  expect(state.revoked == 1, "the OAuth token revoked at the end", state.revoked);
  const after = await p.eval<any>(`fetch("/deploy/api/session").then((r) => r.json())`);
  expect(after.connected == false && after.run.status == "done", "the token forgotten, the run kept", after);
  ok("deployed: every step, the new server's settings, its domains, and the token gone");

  // ---------------------------------------------------------------- a pasted token, workers.dev, a failure
  const q = await browser.page(await browser.context());
  await q.open(`${host.root}/auth/github?next=/deploy`, { width: 1000, height: 1000, scale: 2 });
  await until(() => q.eval(`location.pathname == "/deploy" && !!document.getElementById("token")`), 15_000, "/deploy again");
  await click(q, "#token-details summary");
  await click(q, "#with-registrar");
  expect((await q.eval<string>(`document.getElementById("token-link").href`)).includes("registrar"), "the token link can include buying a domain");
  await fill(q, "token", "mock-fail-worker");
  await click(q, "#connect");
  await until(async () => (await current(q)) == "where", 10_000, "connected with a pasted token", () => text(q, "#connect-error"));
  await click(q, "#where-next");
  await fill(q, "gh-id", "Ov23liMockClientId");
  await fill(q, "gh-secret", "0123456789abcdef0123456789abcdef01234567");
  await click(q, "#github-next");
  await click(q, "#go");
  await until(async () => (await text(q, "#run-error")).length > 0, 30_000, "the deploy fails at a step");
  const failure = await text(q, "#run-error");
  expect(/^Stopped at “Upload the Worker, with its settings and secrets”\. Cloudflare had a problem on its side while we tried to upload the Worker \(Cloudflare said: An unknown error has occurred \[code 10013\]\)/.test(failure), "saying at which step, and what Cloudflare said", failure);
  expect(await q.eval(`document.querySelector("#progress li.failed")?.dataset.id == "worker" && !document.getElementById("run-actions").hidden`), "marking the step, and offering to try again");
  await shot(q, "10-failed", "#s-deploy");
  const kept = await q.eval<any>(`fetch("/deploy/api/session").then((r) => r.json())`);
  expect(kept.connected == true, "the token is kept to try again (until it's done, or two hours)", kept);
  ok("a failed step says why, plainly, and offers to try again");

  // ---------------------------------------------------------------- who may open it
  const signIn = async (login: string) => {
    const r = await fetch(`${host.root}/auth/github?as=${login}&next=/deploy`, { redirect: "manual" });
    return r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="))!;
  };
  const bo = await signIn("bo");
  const asBo = await fetch(`${host.root}/deploy`, { headers: { Cookie: bo }, redirect: "manual" });
  expect(asBo.status == 200, "by default anyone signed in may (deploy_page: users)", asBo.status);
  const admins = await p.eval<number>(`fetch("/admin/settings", { method: "POST", body: new URLSearchParams({ key: "deploy_page", value: '"admins"' }) }).then((r) => r.status)`);
  expect(admins == 200, "an admin limits it to admins", admins);
  const notBo = await fetch(`${host.root}/deploy`, { headers: { Cookie: bo }, redirect: "manual" });
  expect(notBo.status == 404, "then someone who isn't an admin gets not found", notBo.status);
  const api = await fetch(`${host.root}/deploy/api/session`, { headers: { Cookie: bo } });
  expect(api.status == 404, "and so does its API", api.status);
  // (Locally, a request with no cookie is DEV_LOGIN, an admin: but only this site's pages may post.)
  const elsewhere = await fetch(`${host.root}/deploy/api/connect`, { method: "POST", headers: { Origin: "https://elsewhere.example", "Content-Type": "application/json" }, body: JSON.stringify({ token: "mock-token" }) });
  expect(elsewhere.status == 403, "a post from another site is refused", elsewhere.status);
  const off = await p.eval<number>(`fetch("/admin/settings", { method: "POST", body: new URLSearchParams({ key: "deploy_page", value: '"off"' }) }).then((r) => r.status)`);
  expect(off == 200, "an admin turns it off", off);
  const closed = await p.eval<number>(`fetch("/deploy").then((r) => r.status)`);
  expect(closed == 404, "off, it's gone for admins too", closed);
  await p.eval(`fetch("/admin/settings", { method: "POST", body: new URLSearchParams({ key: "deploy_page", value: '"users"' }) }).then((r) => r.status)`);
  const open = await fetch(`${host.root}/deploy`, { headers: { Cookie: bo }, redirect: "manual" });
  expect(open.status == 200, "set back to users, anyone signed in may again", open.status);
  ok("anyone signed in by default; admins limits it; off hides it");
} finally {
  await host.dispose();
  browser.close();
}

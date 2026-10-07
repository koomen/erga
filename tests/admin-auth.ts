#!/usr/bin/env bun
// The Authentication page (/admin/auth; auth-apps.ts, worker/auth-settings.ts)
// in the real Worker: two dev servers play production and staging
// (ERGA_DEPLOY_TARGET, the mock's shared DEPLOY_HOOK_SECRET), each pointed at
// the other (ERGA_PEER_ORIGIN), and a stand-in GitHub answers the live checks
// (ERGA_GITHUB_ORIGIN). Production has its app; staging has none, as today.
//
//   - the peer route: 404 without the secret on production, refused by
//     staging's admins-only guard without it, and the status with it (never a
//     secret); a server takes values only from the one it copies its data from;
//   - the page, in headless Chrome: production working, staging not set up
//     with the steps to make its app; a wrong secret changes nothing; the right
//     values set staging's app from production's page;
//   - lockout: new values for a working app wait for a test sign-in, and can
//     be discarded; a clear that would stop sign-in is refused unless forced;
//   - the change log on both servers, never with the secret;
//   - the admin agent's tools, with an admin token: the status of both, and
//     clearing.
//
//   bun tests/admin-auth.ts
// covers: auth-apps.ts worker/auth-settings.ts worker/auth.ts worker/admins-only.ts worker/pipeline.ts admin.ts admin-layout.ts server-tools.ts cloudflare.config.ts

import { join } from "path";
import { Browser, SHOTS } from "./cdp";
import { freePort, startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const HOOK = "mock-hook-secret-0123456789abcdef";
const PROD_APP = { clientId: "Ov23ctkY7oLarHcPA97b", secret: `prod-secret-${crypto.randomUUID()}` };
const STAGING_APP = { clientId: "Ov23liStagingApp00001", secret: `staging-secret-${crypto.randomUUID()}` };
const NEW_PROD_APP = { clientId: "Ov23liNewProdApp00002", secret: `new-prod-secret-${crypto.randomUUID()}` };
const apps = [PROD_APP, STAGING_APP, NEW_PROD_APP];

// GitHub's token endpoint, as it answers a code that can't be real.
const github = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const b = (await req.json().catch(() => ({}))) as { client_id?: string; client_secret?: string };
    const app = apps.find((a) => a.clientId == b.client_id);
    if (!app) return Response.json({ error: "Not Found" }, { status: 404 });
    if (app.secret != b.client_secret) return Response.json({ error: "incorrect_client_credentials" });
    return Response.json({ error: "bad_verification_code" });
  },
});
const GITHUB = `http://127.0.0.1:${github.port}`;

const prodPort = freePort(), stagingPort = freePort();
const [prod, staging] = await Promise.all([
  startHost(null, { port: prodPort, env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "production", GITHUB_CLIENT_SECRET: PROD_APP.secret, ERGA_GITHUB_ORIGIN: GITHUB, ERGA_PEER_ORIGIN: `http://127.0.0.1:${stagingPort}` } }),
  startHost(null, { port: stagingPort, env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "staging", ERGA_GITHUB_CLIENT_ID: "", ERGA_GITHUB_ORIGIN: GITHUB, ERGA_PEER_ORIGIN: `http://127.0.0.1:${prodPort}` } }),
]);
const P = prod.root, S = staging.root;
const form = (root: string, fields: Record<string, string>) => fetch(`${root}/admin/auth`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams(fields) });
const status = async (root: string) => (await (await fetch(`${root}/admin/auth/status`)).json()) as { here: any; other: any };
let browser: Browser | null = null;

try {
  // ---------------------------------------------------------------- the peer route, and staging's guard
  const signedOut = (port: number) => ({ Cookie: `erga_signed_out_${port}=1` });
  let r = await fetch(`${P}/api/sign-in/status`, { headers: signedOut(prodPort) });
  expect(r.status == 404, "production: /api/sign-in/status without the secret is not found", r.status);
  r = await fetch(`${S}/api/sign-in/status`, { headers: { ...signedOut(stagingPort), Authorization: "Bearer not-the-secret-0123456789abcdef" } });
  expect(r.status == 403 && ((await r.json()) as { adminsOnly?: boolean }).adminsOnly == true, "staging: without the secret, its admins-only guard refuses", r.status);
  r = await fetch(`${S}/api/sign-in/status`, { headers: { ...signedOut(stagingPort), Authorization: `Bearer ${HOOK}` } });
  let text = await r.text();
  const theirs = JSON.parse(text).status;
  expect(r.status == 200 && theirs.target == "staging" && theirs.check.state == "not_set_up" && theirs.inUse.clientId == null && theirs.takesFrom == "production", "staging: with the secret, past the guard, its status: no app", text.slice(0, 400));
  r = await fetch(`${P}/api/sign-in/status`, { headers: { ...signedOut(prodPort), Authorization: `Bearer ${HOOK}` } });
  text = await r.text();
  expect(r.status == 200 && JSON.parse(text).status.check.state == "working" && !text.includes(PROD_APP.secret), "production: with the secret, working, and never the secret", text.slice(0, 400));
  r = await fetch(`${P}/api/sign-in/github`, { method: "POST", headers: { Authorization: `Bearer ${HOOK}`, "Content-Type": "application/json" }, body: JSON.stringify({ do: "clear", by: "mallory" }) });
  expect(r.status == 403, "production takes no sign-in values from another server", r.status);
  r = await fetch(`${S}/api/sign-in/github`, { method: "POST", headers: { ...signedOut(stagingPort), "Content-Type": "application/json" }, body: JSON.stringify({ do: "clear" }) });
  expect(r.status == 403, "staging: a change without the secret is refused by the guard", r.status);
  ok("the peer route: not found without the secret, staging's guard lets it through only with it, and production takes values from nobody");

  // ---------------------------------------------------------------- the page, in headless Chrome
  browser = await Browser.launch();
  const p = await browser.page();
  await p.open(`${P}/admin/auth`, { width: 1280, height: 1500 });
  await until(() => p.eval<boolean>(`document.querySelectorAll("section.server").length == 2`), 15_000, "the page shows both servers");
  const card = (server: string, expr: string) => p.eval<any>(`(() => { const c = document.querySelector('section.server[data-server="${server}"]'); return ${expr}; })()`);
  expect(await card("here", `c.dataset.state`) == "working" && await card("here", `c.querySelector(".client-id").textContent`) == PROD_APP.clientId, "production: working, with its client ID");
  expect(await card("here", `c.querySelector(".callback").textContent`) == `${P}/auth/github/callback`, "production: the callback URL");
  expect(await card("other", `c.dataset.state`) == "not_set_up", "staging: not set up");
  const steps = await card("other", `c.querySelector("details.setup").open && c.querySelector("ol.steps").textContent`);
  expect(typeof steps == "string" && steps.includes("https://github.com/settings/applications/new") && steps.includes(`${S}/auth/github/callback`) && steps.includes("--name erga-staging"), "staging: the steps to make its app, with its URLs", steps);
  expect(await p.eval<string>(`document.querySelector('.admin-side a[aria-current="page"]').textContent.trim()`) == "Authentication", "the sidebar marks Authentication");
  await p.screenshot(join(SHOTS, "admin-auth-before.png"));
  // A wrong secret: GitHub refuses it, and nothing changes.
  const fill = (clientId: string, secret: string) => card("other", `(() => { const f = c.querySelector("form.configure"); f.elements.clientId.value = ${JSON.stringify(clientId)}; f.elements.secret.value = ${JSON.stringify(secret)}; f.querySelector(".save").click(); })()`);
  await fill(STAGING_APP.clientId, `wrong-${STAGING_APP.secret}`);
  await until(async () => /The client secret is wrong\. .*Nothing changed\./.test(await card("other", `c.querySelector(".hint").textContent`)), 10_000, "a wrong secret: the page says why, and that nothing changed", () => card("other", `c.querySelector(".hint").textContent + " | errors: " + JSON.stringify(window.__errs ?? null)`).then((t) => [t, p.errors]));
  expect((await status(S)).here.inUse.clientId == null, "staging still has no app");
  await fill(STAGING_APP.clientId, STAGING_APP.secret);
  await until(async () => (await card("other", `c?.dataset.state`)) == "working", 15_000, "the right values: staging works, after the page reloads");
  expect(await card("other", `c.querySelector(".client-id").textContent`) == STAGING_APP.clientId, "staging's card: its new client ID");
  const html = await p.eval<string>("document.documentElement.outerHTML");
  expect(!html.includes(STAGING_APP.secret) && !html.includes(PROD_APP.secret), "the page never has a secret");
  await p.screenshot(join(SHOTS, "admin-auth.png"));
  expect(p.errors.length == 0, "no errors on the page", p.errors);
  const own = (await status(S)).here;
  expect(own.inUse.clientId == STAGING_APP.clientId && own.inUse.source == "page" && own.page.updatedBy == "tester", "staging uses the values, set from production's page by the admin", own);
  ok(`in Chrome: production working, staging not set up with its steps; a wrong secret changes nothing; the right values set staging's app from production's page (screenshots in ${SHOTS})`);

  // ---------------------------------------------------------------- lockout: a working app's new values wait for a test sign-in
  r = await form(P, { do: "save", server: "here", clientId: NEW_PROD_APP.clientId, secret: NEW_PROD_APP.secret });
  const saved = (await r.json()) as { result?: { kept: string } };
  expect(r.status == 200 && saved.result?.kept == "pending", "production's new values wait, as its app works", saved);
  let here = (await status(P)).here;
  expect(here.inUse.clientId == PROD_APP.clientId && here.pending?.clientId == NEW_PROD_APP.clientId && here.pendingCheck?.state == "working", "sign-in keeps the values that work; the new ones wait, checked", here);
  const signIn = await fetch(`${P}/auth/github?next=/docs`, { redirect: "manual" });
  expect(signIn.status == 302, "local sign-in still works (it skips GitHub here)");
  r = await form(P, { do: "discard", server: "here" });
  expect(((await r.json()) as { result: { discarded: boolean } }).result.discarded, "Discard drops them");
  here = (await status(P)).here;
  expect(here.pending == null && here.inUse.clientId == PROD_APP.clientId, "and production is as it was");
  // Clearing staging's values would leave it with the deploy's: none.
  r = await form(P, { do: "clear", server: "other" });
  const refused = (await r.json()) as { error?: string };
  expect(r.status == 400 && /Clearing would stop sign-in for everyone/.test(refused.error ?? ""), "clearing staging's values is refused: the deploy has none", refused);
  expect((await status(S)).here.inUse.source == "page", "staging keeps its values");
  r = await form(P, { do: "save", server: "here", clientId: "Ov23liNoSuchApp000009", secret: "x".repeat(40) });
  expect(r.status == 400 && /no OAuth app with this client ID/.test(((await r.json()) as { error: string }).error), "a client ID GitHub doesn't know is refused");
  ok("lockout: new values wait for a test sign-in while the app works, Discard drops them, and a clear that stops sign-in or values GitHub refuses are refused");

  // ---------------------------------------------------------------- the change log, on both servers
  const prodLog = await (await fetch(`${P}/admin/changes`)).text();
  const stagingLog = await (await fetch(`${S}/admin/changes`)).text();
  expect(prodLog.includes(`staging's GitHub app in use: client ID <code>${STAGING_APP.clientId}</code>`) && prodLog.includes("waits for a test sign-in") && prodLog.includes("new values discarded"), "production's change log: staging's app set, its own new values waiting, then discarded");
  expect(stagingLog.includes(`staging's GitHub app in use: client ID <code>${STAGING_APP.clientId}</code>`), "staging's change log: its app set", stagingLog.match(/sign-in[^]{0,200}/)?.[0]);
  for (const s of [PROD_APP.secret, STAGING_APP.secret, NEW_PROD_APP.secret]) expect(!prodLog.includes(s) && !stagingLog.includes(s), "no secret in either change log");
  ok("the change log on both servers says who changed which app, never a secret");

  // ---------------------------------------------------------------- the admin agent's tools, with an admin token
  const tokensPage = await (await fetch(`${P}/tokens/new`, { method: "POST", headers: { Origin: P }, body: new URLSearchParams({ label: "Auth test", scope: "admin" }) })).text();
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(tokensPage)?.[1] ?? "";
  expect(token, "an admin token");
  const tool = async (name: string, args: unknown = {}) => (await (await fetch(`${P}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) })).json()) as { ok: boolean; content?: { text: string }[]; error?: string };
  const read = await tool("get_sign_in_status");
  const out = read.content?.map((c) => c.text).join("") ?? "";
  const parsed = JSON.parse(out);
  expect(read.ok && parsed.thisServer.state == "working" && parsed.otherServer.state == "working" && parsed.otherServer.clientIdFrom == "/admin/auth", "get_sign_in_status: both servers", out.slice(0, 400));
  expect(!out.includes(STAGING_APP.secret) && !out.includes(PROD_APP.secret), "and never a secret");
  const pendingOnly = await tool("clear_sign_in_app", { server: "other", what: "pending" });
  expect(pendingOnly.ok && JSON.parse(pendingOnly.content![0].text).discarded == false, "clear_sign_in_app what=pending: nothing waits on staging", pendingOnly);
  const clear = await tool("clear_sign_in_app", { server: "other" });
  expect(!clear.ok && /force/.test(clear.error ?? ""), "clear_sign_in_app: refused, as sign-in on staging would stop", clear);
  const forced = await tool("clear_sign_in_app", { server: "other", force: true });
  expect(forced.ok && JSON.parse(forced.content![0].text).cleared == true, "with force: cleared", forced);
  expect((await status(S)).here.check.state == "not_set_up", "staging is back to the deploy's values: none");
  const tools = (await (await fetch(`${P}/api/ext/tools`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { tools?: { name: string }[] } | { name: string }[];
  const names = (Array.isArray(tools) ? tools : tools.tools ?? []).map((t) => t.name);
  expect(names.includes("get_sign_in_status") && names.includes("clear_sign_in_app") && !names.some((n) => /^(set|save)_sign_in/.test(n)), "the tools read and clear; none sets a secret", names);
  ok("the admin agent's tools: the status of both servers, discarding, and a clear that asks for force first");

  console.log("\nadmin-auth: all passed");
} finally {
  browser?.close();
  github.stop(true);
  await Promise.all([prod.stop(), staging.stop()]);
}

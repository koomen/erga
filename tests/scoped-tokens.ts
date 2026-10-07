#!/usr/bin/env bun
// Scoped tokens (tokens.ts) end to end, on a dev server of its own:
//
//   - Git: a push with no token gets 401 (saying to make a token at
//     /tokens), with a documents token 403, with a non-admin's admin token
//     (made while they were an admin) 403, with an admin's admin token in;
//   - a document token over HTTP: its document, and nothing else;
//   - the device flow with a scope: the approval page shows it, Deny and
//     Approve;
//   - /tokens in headless Chrome: make a one-document token with an expiry,
//     shown once, then listed with its scope, document and expiry; the Admin
//     scope offered to an admin only.
//
// Screenshots land in tests/cdp.ts's SHOTS.
//
//   bun tests/scoped-tokens.ts [--keep]     (--keep leaves the server running)
// covers: tokens.ts worker/auth.ts source/http.ts server-api.ts admin.ts

import { join } from "node:path";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const keep = process.argv.includes("--keep");
const host = await startHost(null, { port: keep ? Number(process.env.PORT) || undefined : undefined });
const root = host.root;
const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });

/** Signs in as someone (no `as`: DEV_LOGIN, "tester", an admin): their session cookie. */
async function signIn(as: string | null): Promise<string> {
  const r = await get(`/auth/github?${as ? `as=${as}&` : ""}next=/docs`);
  return r.headers.getSetCookie().map((x) => x.split(";")[0]).find((x) => /^erga_session(_\d+)?=/.test(x))!;
}
/** Makes a token at /tokens: the token, or the page's error. */
async function mint(cookie: string, fields: Record<string, string>): Promise<{ token: string; page: string }> {
  const page = await (await get("/tokens/new", { method: "POST", headers: { Cookie: cookie, Origin: root }, body: new URLSearchParams(fields) })).text();
  return { token: /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1] ?? "", page };
}
const tool = async (token: string, name: string, args: unknown = {}) => {
  const r = await fetch(`${root}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const body = (await r.json()) as { content?: { text: string }[]; error?: string };
  return { status: r.status, text: body.content?.[0]?.text ?? body.error ?? "" };
};
const push = (auth?: string) => get("/git/erga.git/info/refs?service=git-receive-pack", auth ? { headers: { Authorization: `Basic ${btoa(`anyone:${auth}`)}` } } : {});

let browser: Browser | null = null;
try {
  const tester = await signIn(null), bo = await signIn("Bo");
  // ---- Git: who may push
  let r = await push();
  expect(r.status == 401 && (await r.text()).includes(`${root}/tokens`), "a push with no token: 401, saying where to make one", r.status);
  const admin = await mint(tester, { label: "Git", scope: "admin" });
  expect(admin.token, "an admin makes an admin token", admin.page.slice(0, 300));
  const docs = await mint(tester, { label: "Docs", scope: "documents" });
  r = await push(docs.token);
  expect(r.status == 403 && (await r.text()).includes("admin scope"), "a push with a documents token: 403", r.status);
  expect((await mint(bo, { label: "Bo's", scope: "admin" })).page.includes("Only an admin can make an admin token"), "a user can't make an admin token");
  expect((await tool(admin.token, "set_user_role", { login: "bo", role: "admin" })).status == 200, "the admin makes Bo an admin, with the admin token");
  const bos = await mint(bo, { label: "Bo's git", scope: "admin" });
  expect(bos.token && (await push(bos.token)).status == 200, "Bo, an admin, pushes with his admin token");
  expect((await tool(admin.token, "set_user_role", { login: "bo", role: "user" })).status == 200, "and is made a user again");
  r = await push(bos.token);
  expect(r.status == 403 && (await r.text()).includes("Only admins"), "a push with a non-admin's admin token: 403", r.status);
  r = await push(admin.token);
  expect(r.status == 200 && (r.headers.get("content-type") ?? "").includes("git-receive-pack"), "a push with an admin's admin token: in", r.status);
  ok("git push: no token 401, a documents token 403, a non-admin's admin token 403, an admin's admin token in");

  // ---- A document token
  const made = await (await fetch(`${root}/api/publish`, { method: "POST", headers: { Authorization: `Bearer ${docs.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Scoped one", files: { "index.html": "<h1>Scoped one</h1>" } }) })).json() as { id: string; address: string };
  const other = await (await fetch(`${root}/api/publish`, { method: "POST", headers: { Authorization: `Bearer ${docs.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Scoped two", files: { "index.html": "<h1>Scoped two</h1>" } }) })).json() as { id: string; address: string };
  expect(made.id && other.id, "a documents token publishes two documents", [made, other]);
  const one = await mint(tester, { label: "One", scope: "document", doc: made.id });
  expect((await tool(one.token, "read", { document: made.id, path: "index.html" })).text.includes("Scoped one"), "a document token reads its document");
  expect((await tool(one.token, "read", { document: other.id, path: "index.html" })).status == 403, "and not another");
  expect((await tool(one.token, "list_documents")).status == 403 && (await tool(one.token, "create_document")).status == 403, "nor lists or makes documents");
  expect((await get(`/api/docs/${other.id}/versions`, { headers: { Authorization: `Bearer ${one.token}` } })).status == 404, "nor reads another's versions");
  expect((await get(other.address, { headers: { Authorization: `Bearer ${one.token}` } })).status == 403, "nor opens another's page");
  ok("a document token reaches its document only");

  // ---- The device flow, with a scope
  const ask = async (body: object) => (await (await fetch(`${root}/api/auth/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as { code: string; user_code: string; approve_url: string };
  const poll = (code: string) => fetch(`${root}/api/auth/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  const denied = await ask({ label: "Denied agent", scope: "admin" });
  await get("/tokens/approve", { method: "POST", headers: { Cookie: tester, Origin: root }, body: new URLSearchParams({ code: denied.user_code, answer: "deny" }) });
  expect((await poll(denied.code)).status == 410, "denied: the agent's poll hears it's gone");
  const asked = await ask({ label: "Claude Code", scope: "document", doc: made.address, expires: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) });
  const approvePath = new URL(asked.approve_url).pathname + new URL(asked.approve_url).search;
  const approvePage = await (await get(approvePath, { headers: { Cookie: tester } })).text();
  expect(approvePage.includes("One document") && approvePage.includes("Scoped one") && approvePage.includes("Expires") && approvePage.includes(">Deny<") && approvePage.includes(">Approve<"), "the approval page shows the scope, the document and the expiry, with Approve and Deny", approvePage.slice(0, 600));

  // ---- /tokens and the approval page in headless Chrome (the browser is DEV_LOGIN, an admin)
  browser = await Browser.launch();
  const p = await browser.page();
  await p.open(root + approvePath, { width: 1100, height: 900, clear: false });
  await p.screenshot(join(SHOTS, "tokens-approve.png"));
  await p.eval(`document.querySelector("button[value=approve]").click()`);
  await until(() => p.eval<boolean>(`document.body.innerText.includes("Approved")`), 10_000, "approved in the browser");
  const got = (await (await poll(asked.code)).json()) as { token?: string };
  expect(got.token && (await tool(got.token, "whoami")).text.includes('"scope": "document"'), "the agent collects a document token", got);
  ok("the device flow carries the scope; the person sees it, and denies or approves");

  await p.navigate(`${root}/tokens`);
  await until(() => p.eval<boolean>(`!!document.querySelector("form.add")`), 10_000, "/tokens opens");
  const offered = await p.eval<string[]>(`[...document.querySelectorAll("input[name=scope]")].map((i) => i.value)`);
  expect(offered.join() == "document,documents,admin", "an admin is offered every scope", offered);
  await p.eval(`(() => {
    document.querySelector("input[name=label]").value = "Chrome made";
    const pick = document.querySelector(".doc-pick");
    pick.value = ${JSON.stringify(made.id)};
    pick.dispatchEvent(new Event("change"));
    document.querySelector("input[name=expires]").value = ${JSON.stringify(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10))};
    document.querySelector("form.add").requestSubmit();
  })()`);
  await until(() => p.eval<boolean>(`!!document.querySelector(".card.made pre.secret")`), 10_000, "the new token is shown");
  const shown = await p.eval<{ card: string; row: string }>(`({ card: document.querySelector(".card.made").innerText, row: [...document.querySelectorAll("ol.rows > li")].find((li) => li.innerText.includes("Chrome made"))?.innerText ?? "" })`);
  expect(shown.card.includes("One document") && shown.card.includes("Scoped one") && shown.card.includes("Expires"), "shown once, with its scope, document and expiry", shown.card);
  expect(shown.row.includes("One document") && shown.row.includes("Scoped one") && !shown.row.includes("Never\nNever"), "listed with its scope, its document and its expiry", shown.row);
  const rows = await p.eval<string>(`document.querySelector("ol.rows").innerText`);
  expect(rows.includes("Admin") && rows.includes("All my documents"), "the list shows every token's scope", rows);
  await p.screenshot(join(SHOTS, "tokens-page.png"));
  expect(p.errors.length == 0, "no errors in the console", p.errors);
  // Bo, a user, isn't offered the admin scope.
  await p.navigate(`${root}/tokens?user=Bo`);
  const forBo = await p.eval<string[]>(`[...document.querySelectorAll("input[name=scope]")].map((i) => i.value)`);
  expect(forBo.join() == "document,documents", "a user isn't offered the admin scope", forBo);
  ok(`in Chrome: /tokens makes a one-document token with an expiry, shows it once and lists it; Admin only for admins (screenshots in ${SHOTS})`);
  console.log("\nscoped-tokens: all passed");
} finally {
  browser?.close();
  if (!keep) await host.stop();
}

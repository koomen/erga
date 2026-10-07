#!/usr/bin/env bun
// The admin pages' shared layout (admin-layout.ts), and who may reach them,
// on a dev server of its own:
//
//   - every admin page (/admin, /admin/changes, /admin/users, /admin/factory, /admin/keys)
//     has the breadcrumb (Erga › Admin › the page), Share with agent and the
//     sidebar (Settings, Change log, Users, Factory), and no "Admin" title or back link;
//   - the old addresses redirect: /admin/source and /source to /admin/factory,
//     GET /admin/settings to /admin;
//   - someone who isn't an admin, though deploy_page lets them use /deploy,
//     gets nothing from any /admin route nor any admin API; nor does an
//     agent token, nor someone signed out;
//   - in headless Chrome: the sidebar collapses and expands with an
//     animation, the factory's board gets the width, the state survives a
//     reload (with no animation then), Share with agent opens its card on
//     every page, and on a phone the links are a row.
//
//   bun tests/admin-layout.ts [--keep]   (--keep: leave the server running)

import { join } from "path";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const keep = process.argv.includes("--keep");

const host = await startHost(null, { port: keep ? Number(process.env.PORT) || undefined : undefined });
const root = host.root;
const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });
const form = (path: string, fields: Record<string, string>) => get(path, { method: "POST", headers: { Origin: root }, body: new URLSearchParams(fields) });
let browser: Browser | null = null;

try {
  // ---- the layout, on every admin page (tester: local development's admin)
  const pages: [string, string, string | null][] = [["/admin", "Settings", "Settings"], ["/admin/changes", "Change log", "Change log"], ["/admin/users", "Users", "Users"], ["/admin/factory", "Factory", "Factory"], ["/admin/keys", "Keys", null]];
  for (const [path, title, current] of pages) {
    const r = await get(path);
    const html = await r.text();
    expect(r.status == 200, `${path} opens`, r.status);
    const crumbs = /<nav class="crumbs"[^]*?<\/nav>/.exec(html)?.[0] ?? "";
    expect(crumbs.includes(">Erga</a>") && crumbs.includes('href="/admin">Admin</a>') && crumbs.includes(`aria-current="page">${title}</h1>`), `${path}: the breadcrumb, Erga › Admin › ${title}`, crumbs);
    const side = /<nav class="admin-side"[^]*?<\/nav>/.exec(html)?.[0] ?? "";
    const links = [...side.matchAll(/<a href="([^"]+)"( aria-current="page")?>[^]*?<span class="label">([^<]+)<\/span>/g)].map((m) => `${m[3]} ${m[1]}${m[2] ? " *" : ""}`);
    expect(links.join() == ["Settings /admin", "API keys /admin/api-keys", "Change log /admin/changes", "Users /admin/users", "Factory /admin/factory"].map((l) => l.startsWith(current ?? "-") ? `${l} *` : l).join(), `${path}: the sidebar's links, this page's marked`, links);
    expect(html.includes('id="btn-share"') && html.includes('<script src="/admin-share.js" defer>'), `${path}: Share with agent in the header`);
    expect(html.includes('<aside class="admin-agent" id="agent"') && html.includes('id="agent-fab"') && html.includes('id="agent-close"') && html.includes('<script src="/factory-agent.js" defer>'), `${path}: the admin's agent, with its collapse button and its round button`);
    expect(!html.includes('class="back"') && !/<h1>Admin/.test(html) && !html.includes("‹ Documents"), `${path}: no "Admin" title and no back link`);
  }
  expect((await get("/admin-share.js")).status == 200, "admin-share.js is served");
  ok("every admin page: the breadcrumb, Share with agent, the agent and the sidebar, and no old title or back link");

  for (const [from, to] of [["/admin/source", "/admin/factory"], ["/source", "/admin/factory"], ["/admin/deploys", "/admin/factory"], ["/admin/settings", "/admin"]]) {
    const r = await get(from);
    expect(r.status == 302 && r.headers.get("location") == to, `${from} redirects to ${to}`, { status: r.status, location: r.headers.get("location") });
  }
  ok("the old addresses redirect: /admin/source and /source to /admin/factory");

  // ---- the deploy permission isn't admin: Mallory may use /deploy, and nothing of the admins'
  expect((await form("/admin/settings", { key: "deploy_page", value: JSON.stringify("users") })).ok, "deploy_page: users (anyone signed in)");
  expect((await get("/deploy?user=Mallory")).status == 200, "Mallory, a user, may open /deploy");
  const as = (who: string) => (path: string, init: RequestInit = {}) => get(path + (path.includes("?") ? "&" : "?") + `user=${who}`, init);
  const mallory = as("Mallory");
  const refused: [string, Response][] = [];
  for (const path of ["/admin", "/admin/changes", "/admin/users", "/admin/factory", "/admin/keys", "/admin/settings", "/admin/anything"]) refused.push([`GET ${path}`, await mallory(path)]);
  refused.push(
    ["POST /admin/settings", await mallory("/admin/settings", { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "factory", value: '"on"' }) })],
    ["POST /admin/users", await mallory("/admin/users", { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ do: "add", login: "mallory", role: "admin" }) })],
    ["GET /api/admin/keys", await mallory("/api/admin/keys")],
    ["GET /api/source/branches", await mallory("/api/source/branches")],
    ["POST /api/source/merge", await mallory("/api/source/merge", { method: "POST", headers: { Origin: root, "Content-Type": "application/json" }, body: "{}" })],
    ["GET /api/deploys", await mallory("/api/deploys")],
    ["GET /api/factory/tasks", await mallory("/api/factory/tasks")],
    ["POST /api/factory/tokens", await mallory("/api/factory/tokens", { method: "POST", headers: { Origin: root, "Content-Type": "application/json" }, body: "{}" })],
  );
  for (const [what, r] of refused) {
    const body = await r.text();
    const page = what.startsWith("GET /admin");
    expect(page ? r.status == 404 : [401, 403, 404].includes(r.status), `${what}: Mallory is refused (${page ? "not found" : "401, 403 or 404"})`, { status: r.status, body: body.slice(0, 200) });
    expect(!body.includes('class="admin-side"') && !body.includes("delete_docs_after_hours"), `${what}: and sees nothing of it`);
  }
  const role = (await (await get("/admin/users")).text()).match(/data-login="mallory"[^]*?<\/li>/)?.[0] ?? "";
  expect(!role.includes('value="admin" selected'), "Mallory is still not an admin", role);
  // Signed out: a page sends you to sign in; a POST is refused.
  const out = { Cookie: "erga_signed_out=1" };
  for (const path of ["/admin", "/admin/changes", "/admin/users", "/admin/factory"]) {
    const r = await get(path, { headers: out });
    expect(r.status == 302 && (r.headers.get("location") ?? "").startsWith("/auth/github?next="), `signed out, GET ${path} goes to sign in`, { status: r.status, location: r.headers.get("location") });
  }
  expect((await get("/admin/users", { method: "POST", headers: { ...out, Origin: root }, body: new URLSearchParams({ do: "add", login: "x" }) })).status == 401, "signed out, POST /admin/users: 401");
  // An admin's agent token never opens an admin page.
  const tokensPage = await (await form("/tokens/new", { label: "Admin layout test" })).text();
  const agentToken = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(tokensPage)?.[1] ?? "";
  expect(agentToken, "an agent token, to try");
  for (const path of ["/admin", "/admin/changes", "/admin/users", "/admin/factory"]) {
    const r = await get(path, { headers: { ...out, Authorization: `Bearer ${agentToken}` } });
    expect(r.status == 302 || r.status == 404, `GET ${path} with an admin's agent token: no page`, r.status);
  }
  ok("deploy_page lets a user deploy, and never into an admin page or API; signed out and agent tokens are refused too");

  // ---- in headless Chrome
  browser = await Browser.launch();
  const p = await browser.page();
  await p.open(`${root}/admin/factory`, { width: 1400, height: 900, scale: 2 });
  await until(() => p.eval<boolean>(`!!document.getElementById("side-toggle") && !!document.querySelector("#tasks .column, #tasks section, #tasks")`), 10_000, "the Factory page opens");
  const widths = () => p.eval<{ side: number; main: number; closed: boolean; expanded: string | null; label: string }>(`({ side: document.getElementById("admin-side").getBoundingClientRect().width, main: document.querySelector("main").getBoundingClientRect().width,
    closed: document.documentElement.classList.contains("side-closed"), expanded: document.getElementById("side-toggle").getAttribute("aria-expanded"), label: document.getElementById("side-toggle").getAttribute("aria-label") })`);
  const open = await widths();
  expect(open.side > 150 && !open.closed && open.expanded == "true", "the sidebar starts open, with its labels", open);
  await p.screenshot(join(SHOTS, "admin-factory-sidebar-open.png"));
  await p.eval(`document.getElementById("side-toggle").click()`);
  await new Promise((r) => setTimeout(r, 90));
  const mid = await widths();
  expect(mid.side < open.side && mid.side > 52, "it collapses with an animation (part-way after 90 ms)", mid);
  await until(async () => (await widths()).side == 52, 3000, "it ends as a rail of icons");
  const closed = await widths();
  expect(closed.closed && closed.expanded == "false" && closed.label == "Expand the sidebar" && closed.main >= open.main + open.side - 52 - 1, "collapsed: the board gets the width", { open, closed });
  await p.screenshot(join(SHOTS, "admin-factory-sidebar-closed.png"));
  // Remembered: another admin page opens collapsed, at once, with no animation.
  await p.navigate(`${root}/admin/users`);
  await until(() => p.eval<boolean>(`!!document.getElementById("admin-side")`), 10_000, "/admin/users opens");
  const again = await widths();
  expect(again.closed && again.side == 52, "the state is remembered on the next page, collapsed from the start", again);
  await p.eval(`document.getElementById("side-toggle").click()`);
  await until(async () => (await widths()).side > 150, 3000, "it expands again");
  expect(await p.eval<string>(`localStorage.getItem("erga:admin-sidebar")`) == "open", "and remembers that");
  // Share with agent, from the header, on a page that isn't the factory's.
  await p.eval(`document.getElementById("btn-share").click()`);
  await until(() => p.eval<boolean>(`!!document.getElementById("share") && !document.getElementById("share").hidden && document.getElementById("btn-share").getAttribute("aria-expanded") == "true"`), 5000, "Share with agent opens its card on /admin/users");
  await until(() => p.eval<boolean>(`document.getElementById("share-prompt").value.includes("erga_factory_") || document.getElementById("share-status").textContent.length > 0`), 10_000, "the card gets a token, or says why not");
  await p.screenshot(join(SHOTS, "admin-users-share.png"));
  expect(p.errors.length == 0, "no errors in the console", p.errors);
  // The agent: open beside the page; collapsed to a round button in the lower left (its button, Esc, ⌘J), remembered.
  const agent = () => p.eval<{ width: number; mainLeft: number; closed: boolean; fab: { left: number; bottom: number; opacity: string }; inert: boolean; expanded: string | null }>(`(() => { const f = document.getElementById("agent-fab"), fb = f.getBoundingClientRect();
    return { width: document.getElementById("agent").getBoundingClientRect().width, mainLeft: document.querySelector("main").getBoundingClientRect().left, closed: document.documentElement.classList.contains("agent-closed"),
      fab: { left: fb.left, bottom: fb.bottom, opacity: getComputedStyle(f).opacity }, inert: document.getElementById("agent").inert, expanded: f.getAttribute("aria-expanded") }; })()`);
  await until(async () => (await p.eval<string>(`document.getElementById("agent-model").textContent`)).length > 0, 10_000, "the agent panel connects on /admin/users");
  const agentOpen = await agent();
  expect(!agentOpen.closed && agentOpen.width >= 300 && !agentOpen.inert && agentOpen.expanded == "true", "the agent is open beside the page on /admin/users", agentOpen);
  await p.eval(`document.getElementById("agent-close").click()`);
  await until(async () => (await agent()).width == 0 && (await agent()).fab.opacity == "1", 3000, "it collapses to its round button");
  const agentClosed = await agent();
  expect(agentClosed.closed && agentClosed.inert && agentClosed.fab.left <= 24 && agentClosed.fab.bottom >= 900 - 24 && agentClosed.mainLeft < agentOpen.mainLeft, "collapsed: a round button in the lower left, and the page takes the room", { agentOpen, agentClosed });
  await p.screenshot(join(SHOTS, "admin-agent-collapsed.png"));
  await p.navigate(`${root}/admin/changes`);
  await until(() => p.eval<boolean>(`!!document.getElementById("agent-fab")`), 10_000, "/admin/changes opens");
  expect((await agent()).closed, "the next admin page opens with it collapsed");
  await p.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }))`);
  await until(async () => (await agent()).width >= 300, 3000, "⌘J expands it");
  expect(await p.eval<string>(`document.activeElement?.id ?? ""`) == "agent-input" && await p.eval<string>(`localStorage.getItem("erga:admin-agent")`) == "open", "with the box focused, and remembered");
  await p.eval(`document.getElementById("agent-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  await until(async () => (await agent()).closed, 3000, "Esc in the panel collapses it");
  await p.eval(`document.getElementById("agent-fab").click()`);
  await until(async () => (await agent()).width >= 300, 3000, "the round button expands it again");
  await p.screenshot(join(SHOTS, "admin-agent-open.png"));
  expect(p.errors.length == 0, "no errors in the console", p.errors);
  // A phone: the links in a row above the page, with their labels.
  await p.open(`${root}/admin`, { width: 390, height: 844, scale: 2, clear: false });
  await until(() => p.eval<boolean>(`!!document.getElementById("admin-side")`), 10_000, "/admin opens on a phone");
  const row = await p.eval<{ tops: number[]; toggle: string; fits: boolean }>(`({ tops: [...document.querySelectorAll(".admin-side a")].map((a) => Math.round(a.getBoundingClientRect().top)), toggle: getComputedStyle(document.getElementById("side-toggle")).display, fits: document.documentElement.scrollWidth <= innerWidth })`);
  expect(new Set(row.tops).size == 1 && row.toggle == "none" && row.fits, "a phone: the links in one row, no toggle, no sideways scroll", row);
  expect(await p.eval<boolean>(`document.documentElement.classList.contains("agent-closed")`), "a phone starts with the agent collapsed, so the page shows");
  await p.screenshot(join(SHOTS, "admin-phone.png"));
  ok(`in Chrome: the sidebar collapses and expands with an animation, is remembered, Share with agent opens, the agent collapses to a round button and back, and a phone has a row (screenshots in ${SHOTS})`);
  console.log("\nadmin-layout: all passed");
} finally {
  browser?.close();
  if (!keep) await host.stop();
}

#!/usr/bin/env bun
// The settings a deploy fixes (server.config.ts, ERGA_SERVER_CONFIG) reach
// the Worker (cloudflare.config.ts → SERVER_CONFIG → worker/d1.ts) and win:
// a dev server started with delete_docs_after_hours locked to 3 says so on /docs and
// gives a new document 3 hours, and /admin shows it read-only ("Locked"),
// refusing a change; without the lock an admin sets it there, and the change
// log (/admin/changes) lists it, for admins only. A value the
// settings won't take stops the server from starting, saying why.
// Screenshots of /admin both ways land in tests/cdp.ts's SHOTS.
//
//   bun tests/server-config.ts
// covers: server.config.ts config.ts worker/d1.ts admin.ts directory.ts

import { join } from "path";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };

const browser = await Browser.launch();
/** /admin in headless Chrome, signed in as the dev server's DEV_LOGIN (an admin). */
async function adminPage(root: string) {
  const p = await browser.page(await browser.context());
  await p.open(`${root}/auth/github?next=/admin`, { width: 1100, height: 720, scale: 2 });
  await until(() => p.eval<boolean>(`location.pathname == "/admin" && !!document.querySelector('li.setting[data-key="delete_docs_after_hours"]')`), 10_000, "the admin page opens");
  const row = (expr: string) => p.eval(`(() => { const li = document.querySelector('li.setting[data-key="delete_docs_after_hours"]'); return ${expr}; })()`);
  return { p, row };
}

const host = await startHost(null, { env: { ERGA_SERVER_CONFIG: JSON.stringify({ delete_docs_after_hours: 3 }) } });
try {
  const login = `cfg${Date.now().toString(36)}`;
  const signedIn = await fetch(`${host.root}/auth/github?as=${login}&next=/docs`, { redirect: "manual" });
  const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="));
  expect(cookie, "signed in", signedIn.status);
  const get = (path: string) => fetch(host.root + path, { redirect: "manual", headers: { Cookie: cookie } });

  const empty = await (await get("/docs")).text();
  expect(empty.includes("goes away after 3 hours"), "/docs gives the deployed delete_docs_after_hours", empty.slice(0, 2000));
  ok("the deploy's delete_docs_after_hours (3) reaches the server");

  const made = await get("/new");
  expect(made.status == 302, "/new makes a document", made.status);
  const listed = await (await get("/docs")).text();
  expect(/deleted in [23]h/.test(listed) && listed.includes("deleted 3 hours after"), "a new document goes in 3 hours", listed.match(/<span class="note"[^]*?<\/span>/)?.[0]);
  ok("a new document gets the deployed 3 hours");

  // /admin: shown read-only with its deployed value, and a change is refused.
  const { p, row } = await adminPage(host.root);
  expect(await row(`li.querySelector(".badge")?.textContent`) == "Locked", "/admin badges it as locked by the deploy");
  expect(await row(`li.querySelector("[name=value]").disabled && li.querySelector("[name=value]").value == "3" && !li.querySelector(".save")`), "its input shows 3, disabled, with no Save");
  const refused = await p.eval<{ status: number; error: string }>(`fetch("/admin/settings", { method: "POST", body: new URLSearchParams({ key: "delete_docs_after_hours", value: "48" }) }).then(async (r) => ({ status: r.status, error: (await r.json()).error }))`);
  expect(refused.status == 403 && /fixed by the deploy.*stays 3/.test(refused.error), "a change from the admin page is refused, saying why", refused);
  await p.screenshot(join(SHOTS, "admin-locked.png"));
  ok("/admin shows the locked setting read-only, and refuses a change");
} finally {
  await host.dispose();
}

// Without the lock, the same setting is the admins': set on /admin, it says who set it.
const open = await startHost(null);
try {
  const { p, row } = await adminPage(open.root);
  expect(await row(`!li.querySelector(".badge") && !li.querySelector("[name=value]").disabled`), "unlocked, it's editable");
  await row(`(li.querySelector("[name=value]").value = "36", li.querySelector("[name=value]").dispatchEvent(new Event("input")), li.querySelector("form").requestSubmit(), true)`);
  await until(() => row(`/^Last set at \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC by tester$/.test(li?.querySelector(".set")?.textContent) && li.querySelector("[name=value]").value == "36"`), 10_000, "the page reloads with the value set");
  await p.settle();
  ok("unlocked, an admin sets it on /admin, and the line under it says when and who set it");

  // The other settings have real controls: switches, selects, no Reset where the control picks the default; no Factory section.
  const at = (key: string, expr: string) => p.eval<any>(`(() => { const li = document.querySelector('li.setting[data-key="${key}"]'); return ${expr}; })()`);
  expect(await at("factory", `li.dataset.control == "switch" && li.querySelector("input[type=checkbox][role=switch]") && !li.querySelector("[name=value]").checked && !li.querySelector(".save")`), "factory is an off switch, with no Save");
  expect(await at("factory_fast", `li.querySelector("input[role=switch]").checked`), "factory_fast is a switch, on");
  expect(JSON.stringify(await at("factory_model", `[...li.querySelectorAll("select[name=value] option")].map((o) => o.value)`)) == '["opus","sonnet","haiku"]', "factory_model is a select of its models");
  expect(JSON.stringify(await at("deploy_page", `[...li.querySelectorAll("select[name=value] option")].map((o) => o.value)`)) == '["off","admins","users"]', "deploy_page is a select of who");
  expect(await p.eval(`!document.getElementById("factory-title")`), "no separate Factory section");
  await p.settle();
  await at("factory", `(li.querySelector("[name=value]").click(), true)`);
  await until(() => at("factory", `li?.querySelector("[name=value]").checked && /by tester$/.test(li.querySelector(".set")?.textContent)`), 10_000, "turning the factory switch on saves it, and the page reloads");
  await p.settle();
  await at("factory_model", `(li.querySelector("select").value = "sonnet", li.querySelector("select").dispatchEvent(new Event("change")), true)`);
  await until(() => at("factory_model", `li?.querySelector("select").value == "sonnet" && /by tester$/.test(li.querySelector(".set")?.textContent)`), 10_000, "picking sonnet saves it");
  await p.settle();
  const landing = await (await p.eval<any>(`fetch("/admin/settings", { method: "POST", body: new URLSearchParams({ key: "landing_document", value: "null" }) }).then((r) => r.status)`));
  expect(landing == 200, "landing_document set to none", landing);
  await p.eval(`location.reload()`);
  await until(() => at("landing_document", `!!li?.querySelector(".set")`), 10_000, "the page reloads");
  for (const key of ["factory", "factory_model", "factory_fast", "landing_document"]) expect(await at(key, `!li.querySelector(".reset")`), `no Reset on ${key}`);
  expect(await at("delete_docs_after_hours", `!!li.querySelector(".reset")`), "Reset stays on delete_docs_after_hours");
  await p.settle();
  await p.screenshot(join(SHOTS, "admin-set.png"));
  ok("switches, selects and no Reset for the factory and landing document settings");

  // The change log, a page of its own (/admin/changes): newest first, when, who, and from what to what.
  await p.eval(`fetch("/admin/settings", { method: "POST", body: new URLSearchParams({ key: "factory_fast", value: '"off"' }) }).then((r) => r.ok)`);
  await p.eval(`fetch("/admin/settings", { method: "POST", body: new URLSearchParams({ key: "delete_docs_after_hours", reset: "1" }) }).then((r) => r.ok)`);
  await p.eval("location.reload(), true");
  await until(() => at("factory_fast", `!!li && !li.querySelector("[name=value]").checked`), 10_000, "/admin shows the new value");
  expect(await p.eval<boolean>(`!document.querySelector("ol.changes, #changes")`), "/admin itself has no change log");
  await p.eval(`location.href = "/admin/changes", true`);
  await until(() => p.eval<boolean>(`location.pathname == "/admin/changes" && document.querySelector("h1")?.textContent == "Change log"`), 10_000, "/admin/changes opens, titled Change log");
  const side = await p.eval<string[]>(`[...document.querySelectorAll(".admin-side a")].map((a) => a.textContent + " " + a.getAttribute("href") + (a.getAttribute("aria-current") ? " *" : ""))`);
  expect(JSON.stringify(side.slice(0, 3)) == JSON.stringify(["Settings /admin", "API keys /admin/api-keys", "Change log /admin/changes *"]), "the sidebar has Change log after Settings and API keys, marked as this page", side);
  await until(() => p.eval<boolean>(`document.querySelectorAll("ol.changes > li.change").length == 5`), 10_000, "the change log lists the 5 changes");
  const log = await p.eval<string[]>(`[...document.querySelectorAll("ol.changes > li.change")].map((li) => li.querySelector(".by").textContent + ": " + li.querySelector(".what").textContent.replace(/\\s+/g, " ").trim())`);
  // The changes made above, newest first, each once (landing_document was none already: no change, no version).
  expect(JSON.stringify(log) == JSON.stringify(["tester: delete_docs_after_hours 36 → 24 reset", "tester: factory_fast “on” → “off”", "tester: factory_model “opus” → “sonnet”", "tester: factory “off” → “on”", "tester: delete_docs_after_hours 24 → 36"]), "newest first, each once, with who and from what to what", log);
  await until(() => p.eval<boolean>(`!!document.querySelector("ol.changes time[title]")`), 5_000, "the times are shown");
  const times = await p.eval<string[]>(`[...document.querySelectorAll("ol.changes time[datetime]")].map((t) => t.textContent + "|" + t.title)`);
  expect(times.every((t) => t.startsWith("just now|") && t.length > 10), "each says when", times);
  await p.settle();
  await p.screenshot(join(SHOTS, "admin-changes.png"));
  // Only admins: someone signed in who isn't one gets nothing.
  const other = await fetch(`${open.root}/auth/github?as=plain${Date.now().toString(36)}&next=/docs`, { redirect: "manual" });
  const theirs = other.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="));
  const notAdmin = await fetch(`${open.root}/admin/changes`, { redirect: "manual", headers: { Cookie: theirs! } });
  expect(notAdmin.status == 404 && !(await notAdmin.text()).includes("factory_model"), "someone who isn't an admin can't see it", notAdmin.status);
  const signedOut = await fetch(`${open.root}/admin/changes`, { redirect: "manual", headers: { Cookie: "erga_signed_out=1" } });
  expect(signedOut.status == 302 && signedOut.headers.get("location")?.includes("next=%2Fadmin%2Fchanges"), "someone signed out is sent to sign in", signedOut.status);
  ok("/admin/changes lists the settings' changes, newest first, with when, who and what; only for admins");
} finally {
  await open.dispose();
  browser.close();
}

// A deploy config the settings won't take: the server doesn't start, and says why.
const bad = await startHost(null, { env: { ERGA_SERVER_CONFIG: JSON.stringify({ delete_docs_after_hours: "soon" }) } }).then(
  async (h) => { await h.dispose(); return null; },
  (e: Error) => e.message,
);
expect(bad && /delete_docs_after_hours to "soon", but it must be a whole number/.test(bad), "a bad deploy config stops the server, saying why", bad?.slice(-1500));
ok("a bad deploy config fails at start, saying why");

console.log(`\n${checks.length} checks passed`);
process.exit(0);

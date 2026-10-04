#!/usr/bin/env bun
// The settings a deploy fixes (server.config.ts, ERGA_SERVER_CONFIG) reach
// the Worker (cloudflare.config.ts → SERVER_CONFIG → worker/d1.ts) and win:
// a dev server started with unedited_hours locked to 3 says so on /docs and
// gives a new document 3 hours, and /admin shows it read-only ("Locked by the
// deploy"), refusing a change; without the lock an admin sets it there. A
// value the settings won't take stops the server from starting, saying why.
// Screenshots of /admin both ways land in tests/cdp.ts's SHOTS.
//
//   bun tests/server-config.ts

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
  await until(() => p.eval<boolean>(`location.pathname == "/admin" && !!document.querySelector('li.setting[data-key="unedited_hours"]')`), 10_000, "the admin page opens");
  const row = (expr: string) => p.eval(`(() => { const li = document.querySelector('li.setting[data-key="unedited_hours"]'); return ${expr}; })()`);
  return { p, row };
}

const host = await startHost(null, { env: { ERGA_SERVER_CONFIG: JSON.stringify({ unedited_hours: 3 }) } });
try {
  const login = `cfg${Date.now().toString(36)}`;
  const signedIn = await fetch(`${host.root}/auth/github?as=${login}&next=/docs`, { redirect: "manual" });
  const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="));
  expect(cookie, "signed in", signedIn.status);
  const get = (path: string) => fetch(host.root + path, { redirect: "manual", headers: { Cookie: cookie } });

  const empty = await (await get("/docs")).text();
  expect(empty.includes("goes away after 3 hours"), "/docs gives the deployed unedited_hours", empty.slice(0, 2000));
  ok("the deploy's unedited_hours (3) reaches the server");

  const made = await get("/new");
  expect(made.status == 302, "/new makes a document", made.status);
  const listed = await (await get("/docs")).text();
  expect(/deleted in [23]h/.test(listed) && listed.includes("deleted 3 hours after"), "a new document goes in 3 hours", listed.match(/<span class="note"[^]*?<\/span>/)?.[0]);
  ok("a new document gets the deployed 3 hours");

  // /admin: shown read-only with its deployed value, and a change is refused.
  const { p, row } = await adminPage(host.root);
  expect(await row(`li.querySelector(".badge")?.textContent`) == "Locked by the deploy", "/admin badges it as locked by the deploy");
  expect(await row(`li.querySelector("[name=value]").disabled && li.querySelector("[name=value]").value == "3" && !li.querySelector(".save")`), "its input shows 3, disabled, with no Save");
  const refused = await p.eval<{ status: number; error: string }>(`fetch("/admin/settings", { method: "POST", body: new URLSearchParams({ key: "unedited_hours", value: "48" }) }).then(async (r) => ({ status: r.status, error: (await r.json()).error }))`);
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
  await until(() => row(`li?.querySelector(".meta")?.textContent.includes("Set by tester") && li.querySelector("[name=value]").value == "36"`), 10_000, "the page reloads with the value set");
  await p.settle();
  await p.screenshot(join(SHOTS, "admin-set.png"));
  ok("unlocked, an admin sets it on /admin, and it says who set it");
} finally {
  await open.dispose();
  browser.close();
}

// A deploy config the settings won't take: the server doesn't start, and says why.
const bad = await startHost(null, { env: { ERGA_SERVER_CONFIG: JSON.stringify({ unedited_hours: "soon" }) } }).then(
  async (h) => { await h.dispose(); return null; },
  (e: Error) => e.message,
);
expect(bad && /unedited_hours to "soon", but it must be a whole number/.test(bad), "a bad deploy config stops the server, saying why", bad?.slice(-1500));
ok("a bad deploy config fails at start, saying why");

console.log(`\n${checks.length} checks passed`);
process.exit(0);

#!/usr/bin/env bun
// The admin pages as one page (src/page/admin-nav.ts), in headless Chrome, on a dev server of its own:
//
//   - a link in the sidebar or the breadcrumb shows the other admin page without a load: the same document,
//     the agent panel's very elements, its conversation and a reply on its way (the scripted model, slowed
//     down) carry on, and the address, the title, the breadcrumb and the sidebar's mark follow;
//   - back and forward go between the pages, without a load; a reload and a deep link open the page whole;
//   - the Factory page's board stops what it keeps running when another page shows (its board API goes),
//     and works again when it comes back; saving a setting shows the page again in place;
//   - no errors in the console.
//
//   bun tests/admin-nav.ts [--keep]   (--keep: leave the server running)

import { join } from "path";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const keep = process.argv.includes("--keep");

const host = await startHost(null, { port: keep ? Number(process.env.PORT) || undefined : undefined, env: { ERGA_AGENT_MODEL: "script" }, processEnv: { ERGA_FACTORY_RUNNER: "sim" } });
const root = host.root;
let browser: Browser | null = null;

try {
  browser = await Browser.launch();
  const p = await browser.page();
  await p.open(`${root}/admin`, { width: 1400, height: 900, scale: 2 });
  await until(() => p.eval<boolean>(`!!document.querySelector("li.setting") && document.getElementById("agent-model").textContent.length > 0`), 15_000, "/admin opens, and the agent panel connects");
  const state = () => p.eval<{ path: string; title: string; crumb: string; marked: string | null; same: boolean; log: boolean; reply: string; busy: boolean; panes: boolean }>(`({
    path: location.pathname + location.search, title: document.title, crumb: document.querySelector(".crumbs .here").textContent,
    marked: document.querySelector('.admin-side a[aria-current="page"]')?.getAttribute("href") ?? null,
    same: window.__erga_mark === 1, log: document.getElementById("agent-log") === window.__erga_log,
    reply: [...document.querySelectorAll("#agent-log .msg-assistant")].map((e) => e.innerText).join(" | "),
    busy: document.getElementById("agent-fab").classList.contains("busy"), panes: !!document.getElementById("admin-panes") })`);
  // A mark on this document and on the panel's log: a load would lose both.
  await p.eval(`window.__erga_mark = 1; window.__erga_log = document.getElementById("agent-log"); true`);

  // A reply on its way: the scripted model waits 2.5 s before it answers.
  await p.eval(`(() => { const i = document.getElementById("agent-input"); i.value = '@script [{"delay": 2500, "text": "Answered across the pages."}]'; i.dispatchEvent(new Event("input")); document.getElementById("agent-send").click(); return true; })()`);
  await until(async () => (await state()).busy, 5000, "the agent starts on the reply");
  const click = (sel: string) => p.eval(`document.querySelector(${JSON.stringify(sel)}).click(), true`);
  await click('.admin-side a[href="/admin/users"]');
  await until(async () => (await state()).crumb == "Users" && !!(await p.eval(`document.querySelector("ol.users")`)), 5000, "the sidebar's Users link shows Users");
  let s = await state();
  expect(s.path == "/admin/users" && s.title == "Users · Erga" && s.marked == "/admin/users" && s.same && s.log, "Users: its address, title, breadcrumb and mark; the same document and agent panel", s);
  expect(s.busy, "the reply is still on its way", s);
  await click('.admin-side a[href="/admin/changes"]');
  await until(async () => (await state()).crumb == "Change log", 5000, "Change log shows");
  await until(async () => (await state()).reply.includes("Answered across the pages."), 10_000, "the reply arrives, in the same panel", state);
  s = await state();
  expect(s.same && s.log && !s.busy && s.path == "/admin/changes", "the reply finished on another page than the one it was asked from, with no load", s);
  await p.screenshot(join(SHOTS, "admin-nav-reply.png"));
  ok("the sidebar's links change the page in place: the agent panel and its reply carry on");

  // Back and forward, without a load.
  await p.eval(`history.back(), true`);
  await until(async () => (await state()).crumb == "Users", 5000, "back: Users");
  await p.eval(`history.back(), true`);
  await until(async () => (await state()).crumb == "Settings", 5000, "back: Settings");
  s = await state();
  expect(s.path == "/admin" && s.marked == "/admin" && s.same && !!(await p.eval(`document.querySelector("li.setting")`)), "back twice: Settings, with no load", s);
  await p.eval(`history.forward(), true`);
  await until(async () => (await state()).crumb == "Users", 5000, "forward: Users");
  expect((await state()).same, "forward: with no load");
  ok("back and forward go between the pages, with no load");

  // The Factory page's board, and leaving it: its board API goes with it.
  await click('.admin-side a[href="/admin/factory"]');
  await until(() => p.eval<boolean>(`!!window.ergaBoard && !!document.querySelector('#tasks [data-col="queued"]')`), 10_000, "the Factory page's board runs");
  expect((await state()).same, "Factory: with no load");
  await p.screenshot(join(SHOTS, "admin-nav-factory.png"));
  await click(".crumbs a.here-link");
  await until(async () => (await state()).crumb == "Settings", 5000, "the breadcrumb's Admin shows Settings");
  expect(await p.eval<boolean>(`!window.ergaBoard && !document.body.dataset.tab`), "the board's API and the tab are gone with the page");
  await click('.admin-side a[href="/admin/factory"]');
  await until(() => p.eval<boolean>(`!!window.ergaBoard && !!document.querySelector('#tasks [data-col="queued"]') && document.getElementById("live").textContent == "live"`), 10_000, "the board runs again, live");
  await click('.admin-side a[href="/admin"]');
  await until(async () => (await state()).crumb == "Settings", 5000, "Settings again");

  // A setting saved: the page shows again in place (a new row for it, the switch flipped, no load).
  const flip = async (to: boolean) => {
    await p.eval(`(() => { const li = document.querySelector('li.setting[data-key="factory"]'); window.__erga_row = li; li.querySelector("input[type=checkbox]").click(); return true; })()`);
    await until(() => p.eval<boolean>(`(() => { const li = document.querySelector('li.setting[data-key="factory"]'); return li != window.__erga_row && li.querySelector("input[type=checkbox]").checked == ${to}; })()`), 5000, "the setting saves, and the page shows it again");
  };
  const was = await p.eval<boolean>(`document.querySelector('li.setting[data-key="factory"] input[type=checkbox]').checked`);
  await flip(!was);
  expect((await state()).same && (await p.eval<string>(`document.querySelector('li.setting[data-key="factory"] .set')?.textContent ?? ""`)).includes("Last set"), "saving a setting shows the page again, with no load");
  await flip(was);
  expect(p.errors.length == 0, "no errors in the console", p.errors);
  ok("the Factory page's board stops when it goes and runs again when it comes back; a saved setting shows in place");

  // A reload, and a deep link: the page whole, as the server makes it.
  await p.navigate(`${root}/admin/users`);
  await until(() => p.eval<boolean>(`!!document.querySelector("ol.users")`), 10_000, "a deep link to /admin/users opens it");
  await until(async () => (await state()).reply.includes("Answered across the pages."), 10_000, "the panel loads the conversation so far", state);
  s = await state();
  expect(!s.same && s.crumb == "Users" && s.marked == "/admin/users" && s.reply.includes("Answered across the pages."), "a deep link: Users, whole, with the conversation so far", s);
  await p.navigate(`${root}/admin/changes`);
  await until(async () => (await state()).crumb == "Change log", 10_000, "a deep link to /admin/changes");
  // A page shown in place, then reloaded: the server makes that page.
  await p.eval(`window.__erga_mark = 1; window.__erga_log = document.getElementById("agent-log"); true`);
  await click('.admin-side a[href="/admin/factory"]');
  await until(() => p.eval<boolean>(`!!window.ergaBoard`), 10_000, "Factory, in place");
  await p.eval(`location.reload(), true`);
  await until(() => p.eval<boolean>(`!window.__erga_mark && !!window.ergaBoard && location.pathname == "/admin/factory" && document.querySelector('.admin-side a[aria-current="page"]')?.getAttribute("href") == "/admin/factory"`), 10_000, "a reload opens Factory whole");
  expect(p.errors.length == 0, "no errors in the console", p.errors);
  ok("a deep link and a reload open the page whole");
  console.log("\nadmin-nav: all passed");
} finally {
  browser?.close();
  if (!keep) await host.stop();
}

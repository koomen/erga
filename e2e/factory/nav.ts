// The admin pages as one page (src/page/admin-nav.ts; tests/admin-nav.ts), on the worker's factory server (the
// agent panel's scripted model). A mark on the document and on the agent panel's log tells a page shown in place
// (both kept) from a load (both gone).

import { servers, until, type Page } from "../fixtures";

export type NavState = { path: string; title: string; crumb: string; marked: string | null; same: boolean; log: boolean; reply: string; busy: boolean };

export const navState = (p: Page) => p.evaluate(`({
  path: location.pathname + location.search, title: document.title, crumb: document.querySelector(".crumbs .here")?.textContent ?? "",
  marked: document.querySelector('.admin-side a[aria-current="page"]')?.getAttribute("href") ?? null,
  same: window.__erga_mark === 1, log: !!window.__erga_log && document.getElementById("agent-log") === window.__erga_log,
  reply: [...document.querySelectorAll("#agent-log .msg-assistant")].map((e) => e.innerText).join(" | "),
  busy: document.getElementById("agent-fab").classList.contains("busy") })`) as Promise<NavState>;

export const mark = (p: Page) => p.evaluate(`window.__erga_mark = 1; window.__erga_log = document.getElementById("agent-log"); true`);
export const click = (p: Page, sel: string) => p.evaluate(`document.querySelector(${JSON.stringify(sel)}).click(), true`);

/** Something for the agent to say, with a word of its own (the worker's server keeps one conversation for every test). */
export const words = (what: string) => `${what} ${crypto.randomUUID().slice(0, 8)}.`;

/** Asks the scripted model to say `text`, after `delay` ms. */
export const ask = (p: Page, text: string, delay = 0) => p.evaluate(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify(`@script ${JSON.stringify([{ ...(delay ? { delay } : {}), text }])}`)}; i.dispatchEvent(new Event("input")); document.getElementById("agent-send").click(); return true; })()`);

/** /admin (Settings) in the tab, the agent panel connected, and marked. */
export async function admin(page: Page) {
  const s = await servers.factory();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${s.root}/admin`);
  await until(() => page.evaluate(`!!document.querySelector("li.setting") && document.getElementById("agent-model").textContent.length > 0`), 10_000, "/admin opens, and the agent panel connects");
  await mark(page);
  return s;
}

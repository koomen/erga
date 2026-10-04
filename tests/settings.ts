#!/usr/bin/env bun
// Document settings (src/page/settings.ts), in headless Chrome: the gear and
// its popover (lazy-loaded, anchored to the gear, Escape, a click outside,
// the keyboard), Latest and Manual, the published-version picker's windows,
// live updates, the homepage's switch, deploy status and Redeploy, errors,
// read-only, a phone, and a page with a dark background.
//
// Until the versions and homepage backends (tasks #33, #34) are in, the
// server runs with their stand-in (dev/settings-stub.ts, ERGA_STUB_SETTINGS),
// whose /__erga/stub/settings sets each state up. Screenshots land in
// tests/cdp.ts's SHOTS.
//
//   bun tests/settings.ts

import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, type Page, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };

const host = await startHost(null, { processEnv: { ERGA_STUB_SETTINGS: "1" } });
const root = host.root;
const browser = await Browser.launch();
/** A document's editor (its address and /edit; #edit once task #30 lands). */
const editor = (address: string) => `${root}${address}/edit`;
const stub = (doc: string, set: Record<string, unknown>) => fetch(`${root}/__erga/stub/settings`, { method: "POST", body: JSON.stringify({ doc, deployMs: 700, describeMs: 600, ...set }) }).then((r) => r.json());
const versionsOf = (doc: string) => fetch(`${root}/api/docs/${doc}/versions`).then((r) => r.json()) as Promise<{ published: { mode: string; version: { n: number } }; current: { n: number } }>;

async function newDoc(): Promise<{ address: string; id: string }> {
  const at = (await fetch(`${root}/new`, { redirect: "manual" })).headers.get("location")!;
  const address = at.replace(/\/edit$/, "").replace(/#edit$/, "");
  const { id } = (await (await fetch(`${root}${address}/api/name`)).json()) as { id: string };
  return { address, id };
}
const rect = (p: Page, sel: string) => p.eval<{ x: number; y: number; w: number; h: number; top: number; right: number; bottom: number; left: number } | null>(
  `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left } : null; })()`);
async function clickOn(p: Page, sel: string) {
  await p.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: "nearest" }), true`);
  const r = await rect(p, sel);
  expect(r, `${sel} is on the page`);
  await p.click(r.x, r.y);
}
const isOpen = (p: Page) => p.eval<boolean>(`!!document.getElementById("doc-settings") && !document.getElementById("doc-settings").hidden`);
const text = (p: Page, sel: string) => p.eval<string>(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? ""`);
/** The open menu's rows: version numbers, and "…N" for a row of N more. */
const menuRows = (p: Page) => p.eval<string>(`[...document.querySelectorAll(".ds-menu [role=option]")].map((o) => o.id.startsWith("ds-ver-") ? o.id.slice(7) : "…" + (o.textContent.match(/\\d+/) || [""])[0]).join(" ")`);
async function openSettings(p: Page) {
  // The editor's controls fade in as it comes up: click once they're there.
  await until(() => p.eval<boolean>(`(() => { const g = document.getElementById("btn-settings"), r = g?.getBoundingClientRect(); return !!r?.width && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("#btn-settings") == g && getComputedStyle(g.closest(".chrome")).opacity == "1"; })()`), 15_000, "the gear can be clicked");
  if (!(await isOpen(p))) await clickOn(p, "#btn-settings");
  await until(() => isOpen(p), 10_000, "the settings open");
  await until(async () => (await text(p, "#ds-mode")) != "Loading…", 10_000, "the versions load");
}
/** A publish has finished saving (the menus are off limits while it saves). */
const saved = (p: Page) => until(async () => (await p.eval<string | null>(`document.getElementById("ds-mode").getAttribute("aria-disabled")`)) == null, 5_000, "the publish is saved");
async function closeSettings(p: Page) {
  if (await isOpen(p)) { await p.key("Escape"); await p.key("Escape"); }
  await until(async () => !(await isOpen(p)), 5_000, "the settings close");
}

try {
  const a = await newDoc();
  await stub(a.id, { versions: 47, published: 12 });
  const ctx = await browser.context();
  const p = await browser.page(ctx);
  await p.open(editor(a.address), { width: 1200, height: 820, scale: 2, agent: false });
  await until(() => rect(p, "#btn-settings"), 15_000, "the gear shows");

  // Lazy: nothing of the settings until the gear is reached for.
  expect(!(await p.eval<boolean>(`!!window.ergaSettings || !!document.querySelector('script[src="/settings.js"]')`)), "the settings' code isn't loaded with the editor");
  const gear = (await rect(p, "#btn-settings"))!;
  await p.mouse("mouseMoved", gear.x, gear.y);
  await until(() => p.eval<boolean>("!!window.ergaSettings"), 5_000, "hovering the gear loads the settings' code");
  ok("the settings' code loads only when the gear is reached for");

  // Open: a popover hanging from the gear, not a dialog in the middle.
  await openSettings(p);
  const pop = (await rect(p, "#doc-settings"))!;
  expect(pop.top > gear.bottom && pop.top - gear.bottom < 20 && Math.abs(pop.right - gear.right) < 24, "the popover hangs from the gear", { pop, gear });
  expect((await p.eval<string>(`document.getElementById("btn-settings").getAttribute("aria-expanded")`)) == "true", "the gear says it's open");
  expect((await text(p, "#ds-mode")) == "Manual" && (await text(p, "#ds-pick")).startsWith("v12"), "Manual, with version 12 published", await text(p, "#ds-pick"));
  expect((await text(p, "#ds-explain")).includes("35 newer versions aren't published"), "it says how many newer versions aren't published", await text(p, "#ds-explain"));
  const listed = await p.eval<string[]>(`[...document.querySelectorAll("#ds-list li")].map((li) => li.textContent.replace(/\\s+/g, " ").trim())`);
  expect(listed.length == 10 && listed[0].startsWith("v47") && listed[0].includes("Current") && /ago/.test(listed[0]), "the latest ten versions, each with its number, description, time and authors, the current one marked", listed);
  await p.screenshot(join(SHOTS, "settings-manual.png"));
  await p.key("Escape");
  await until(async () => !(await isOpen(p)), 3_000, "Escape closes it");
  expect((await p.eval<string>("document.activeElement?.id")) == "btn-settings", "and focus goes back to the gear");
  await p.key("Enter");
  await until(() => isOpen(p), 3_000, "Enter on the gear opens it again");
  // A click into the page (another document) closes it.
  await p.click(300, 500);
  await until(async () => !(await isOpen(p)), 3_000, "a click outside closes it");
  ok("the popover hangs from the gear; Escape, a click outside and the keyboard open and close it");

  // The picker: the latest ten, a row for the 25 between, version 12 and the three before it, a row for the 8 older.
  await openSettings(p);
  await clickOn(p, "#ds-pick");
  await until(async () => (await menuRows(p)).includes("9"), 5_000, "the picker has the versions before the published one");
  expect((await menuRows(p)) == "47 46 45 44 43 42 41 40 39 38 …25 12 11 10 9 …8", "far back: the latest ten, the gap, the published version and the three before it", await menuRows(p));
  expect((await p.eval<string>(`document.querySelector(".ds-menu [aria-selected=true]")?.id`)) == "ds-ver-12", "the published version is checked");
  await Bun.sleep(200); // the menu's fade-in
  await p.screenshot(join(SHOTS, "settings-picker-far-back.png"));
  await clickOn(p, "#ds-more-id38".replace("id38", (await p.eval<string>(`document.querySelector(".ds-menu [id^=ds-more-]").id.slice(8)`))));
  await until(async () => (await menuRows(p)).includes("…15"), 5_000, "the gap's row loads ten more");
  expect(await isOpen(p) && (await p.eval<boolean>("!!document.querySelector('.ds-menu')")), "and the picker stays open");
  // Pick version 11 with the keyboard: the menu's focus starts on version 12.
  await p.eval(`document.querySelector(".ds-menu").focus(), true`);
  const at = await p.eval<number>(`[...document.querySelectorAll(".ds-menu [role=option]")].findIndex((o) => o.classList.contains("active"))`);
  const want = await p.eval<number>(`[...document.querySelectorAll(".ds-menu [role=option]")].findIndex((o) => o.id == "ds-ver-11")`);
  for (let i = at; i < want; i++) await p.key("ArrowDown");
  await p.key("Enter");
  await until(async () => (await versionsOf(a.id)).published.version.n == 11, 5_000, "version 11 is published");
  await until(async () => (await text(p, "#ds-pick")).startsWith("v11"), 5_000, "the picker shows version 11");
  expect(!(await p.eval<boolean>("!!document.querySelector('.ds-menu')")) && (await p.eval<string>("document.activeElement?.id")) == "ds-pick", "the menu closes, focus back on its button");
  await saved(p);
  ok("the picker: published far back, a row for the gap that loads more, the few before it, picked with the keyboard");

  // Latest and back to Manual, with the keyboard.
  await p.eval(`document.getElementById("ds-mode").focus(), true`);
  await p.key("ArrowDown");
  await until(() => p.eval<boolean>("!!document.getElementById('ds-menu-mode')"), 3_000, "ArrowDown opens the publishing menu", () => p.eval(`({ active: document.activeElement?.id, dis: document.getElementById("ds-mode").getAttribute("aria-disabled"), menus: document.querySelectorAll(".ds-menu").length, open: !document.getElementById("doc-settings").hidden })`));
  await Bun.sleep(200); // the menu's fade-in
  await p.screenshot(join(SHOTS, "settings-mode-menu.png"));
  await p.key("Home");
  await p.key("Enter");
  await until(async () => (await versionsOf(a.id)).published.mode == "latest", 5_000, "Latest is saved");
  await until(async () => (await text(p, "#ds-mode")) == "Latest" && (await p.eval<boolean>(`document.getElementById("ds-pick-field").hidden`)), 3_000, "Latest: no picker");
  await saved(p);
  expect((await text(p, "#ds-explain")).includes("up to the keystroke"), "Latest says viewers see every change");
  expect(!(await rect(p, "#ds-pick")), "and the picker isn't drawn");
  const top = await p.eval<string>(`document.querySelector("#ds-list li")?.textContent`);
  expect(top.includes("Current") && top.includes("Published"), "the current version is the published one", top);
  await p.screenshot(join(SHOTS, "settings-latest.png"));
  await p.key("ArrowDown");
  await p.key("End");
  await p.key("Enter");
  await until(async () => { const v = await versionsOf(a.id); return v.published.mode == "manual" && v.published.version.n == 47; }, 5_000, "Manual starts on what viewers see: the current version");
  await clickOn(p, "#ds-pick");
  await until(async () => (await menuRows(p)).startsWith("47"), 5_000, "the picker opens");
  expect((await menuRows(p)) == "47 46 45 44 43 42 41 40 39 38 …37", "published is current: the latest ten and a row for the rest", await menuRows(p));
  await p.key("Escape");
  ok("Latest and Manual by keyboard; switching to Manual keeps what viewers see");

  // Live: a new version shows at once, described a moment later.
  await stub(a.id, { cut: 1 });
  await until(async () => (await p.eval<string>(`document.querySelector("#ds-list li")?.textContent`)).includes("v48"), 5_000, "a new version shows up live");
  expect((await p.eval<string>(`document.querySelector("#ds-list li .ds-desc")?.textContent`)).includes("Describing"), "with a quiet placeholder for its description");
  await p.screenshot(join(SHOTS, "settings-describing.png"));
  await until(async () => !(await p.eval<string>(`document.querySelector("#ds-list li .ds-desc")?.textContent`)).includes("Describing"), 5_000, "its description arrives live");
  expect((await text(p, "#ds-explain")).includes("1 newer version isn't published"), "and Manual says it isn't published", await text(p, "#ds-explain"));
  ok("versions update live: a new one, then its description");

  // Publish the current version: one click, in Manual, when it isn't the published one.
  expect(await p.eval<boolean>(`!document.getElementById("ds-pub-current").hidden`) && (await text(p, "#ds-pub-current")) == "Publish the current version (v48)", "Manual with a newer version: a button publishes the current one", await text(p, "#ds-pub-current"));
  await p.screenshot(join(SHOTS, "settings-publish-current.png"));
  await clickOn(p, "#ds-pub-current");
  await until(async () => (await versionsOf(a.id)).published.version.n == 48, 5_000, "the current version is published");
  await until(async () => (await text(p, "#ds-pick")).startsWith("v48") && (await p.eval<boolean>(`document.getElementById("ds-pub-current").hidden`)), 5_000, "the picker shows it, and the button goes, as current is now published");
  await saved(p);
  ok("Publish the current version: shown in Manual when the current version isn't published, gone once it is");

  // Edit on a version: on hover at once, and on keyboard focus; a copy of it becomes the current version.
  expect(!(await p.eval<boolean>(`!!document.querySelector('#ds-list li[data-n="48"] .ds-edit')`)), "the current version has no Edit");
  const edit = (n: number) => `#ds-list li[data-n="${n}"] .ds-edit`;
  const shown = (sel: string) => p.eval<string>(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).opacity`);
  expect((await shown(edit(45))) == "0", "Edit is hidden until the pointer comes");
  const v45 = (await rect(p, `#ds-list li[data-n="45"]`))!;
  await p.mouse("mouseMoved", v45.left + 60, v45.y);
  expect((await shown(edit(45))) == "1" && (await shown(edit(44))) == "0", "on hover, that version's Edit shows at once, with no fade", await shown(edit(45)));
  await p.screenshot(join(SHOTS, "settings-edit-hover.png"));
  await p.mouse("mouseMoved", 300, 600);
  await p.key("Tab"); // a key first, so focus after it shows as keyboard focus
  await p.eval(`document.querySelector(${JSON.stringify(edit(44))}).focus(), true`);
  expect((await shown(edit(44))) == "1", "and on keyboard focus");
  await p.key("Enter");
  await until(async () => (await versionsOf(a.id)).current.n == 49, 5_000, "Edit makes a copy the current version");
  await until(async () => (await p.eval<string>(`document.querySelector("#ds-list li")?.textContent`)).includes("Restored version 44"), 5_000, "the restored version shows at the top of the list", () => p.eval(`document.querySelector("#ds-list li")?.textContent`));
  const first = await p.eval<string>(`document.querySelector("#ds-list li")?.textContent`);
  expect(first.startsWith("v49") && first.includes("Current"), "as the current version", first);
  expect((await text(p, "#ds-pick")).startsWith("v48"), "Manual: the published version doesn't change");
  await p.screenshot(join(SHOTS, "settings-restored.png"));
  await stub(a.id, { error: "The version store is down for maintenance." });
  await p.mouse("mouseMoved", v45.left + 60, (await rect(p, `#ds-list li[data-n="46"]`))!.y);
  await clickOn(p, edit(46));
  await until(async () => (await text(p, "#ds-hist-error")).startsWith("Couldn't restore version 46: The version store is down"), 5_000, "a failed restore says why", () => text(p, "#ds-hist-error"));
  await p.screenshot(join(SHOTS, "settings-restore-error.png"));
  await stub(a.id, { error: null });
  ok("Edit: on hover at once and on focus, not on the current version; a copy becomes the current version, live; a failure says why");

  // Fewer than ten versions in all; published one older.
  const b = await newDoc();
  await stub(b.id, { versions: 6, published: 2 });
  const p2 = await browser.page(ctx);
  await p2.open(editor(b.address), { width: 1200, height: 820, scale: 2, agent: false, clear: false });
  await until(() => rect(p2, "#btn-settings"), 15_000, "the gear shows");
  await openSettings(p2);
  await clickOn(p2, "#ds-pick");
  await until(async () => (await menuRows(p2)).length > 0, 5_000, "the picker opens");
  expect((await menuRows(p2)) == "6 5 4 3 2 1", "fewer than ten: all of them", await menuRows(p2));
  await stub(b.id, { versions: 47, published: 46 });
  await until(async () => (await menuRows(p2)) == "47 46 45 44 43 42 41 40 39 38 …37", 5_000, "published one older: the latest ten (the picker follows live)", () => menuRows(p2));
  await p2.key("Escape");
  ok("the picker with fewer than ten versions, and with the published one just older");

  // The homepage: not it yet; turn it on, it deploys; Redeploy; a failure; scheduled after a publish.
  await openSettings(p);
  await until(() => p.eval<boolean>(`!document.getElementById("ds-home").hidden`), 5_000, "an admin sees the homepage section");
  expect((await p.eval<string>(`document.getElementById("ds-home-switch").getAttribute("aria-checked")`)) == "false", "it isn't the homepage");
  expect(!(await rect(p, "#ds-redeploy")), "so no deploy status or Redeploy is drawn");
  await clickOn(p, "#ds-home-switch");
  await until(async () => (await text(p, "#ds-status")).includes("Deploying"), 3_000, "turning it on deploys", () => p.eval(`({ s: document.getElementById("ds-status").textContent, sw: document.getElementById("ds-home-switch").outerHTML, err: document.getElementById("ds-home-error").textContent, dep: document.getElementById("ds-deploy").hidden })`));
  await p.screenshot(join(SHOTS, "settings-home-deploying.png"));
  await until(async () => (await text(p, "#ds-status")).startsWith("Deployed at"), 5_000, "then it says when it deployed", () => text(p, "#ds-status"));
  await p.screenshot(join(SHOTS, "settings-home-deployed.png"));
  await clickOn(p, "#ds-redeploy");
  await until(async () => (await text(p, "#ds-status")).includes("Deploying") && (await p.eval<string>(`document.getElementById("ds-redeploy").getAttribute("aria-disabled")`)) == "true", 3_000, "Redeploy now deploys, and can't be pressed again meanwhile");
  await until(async () => (await text(p, "#ds-status")).startsWith("Deployed at"), 5_000, "and finishes");
  await stub(a.id, { failNext: true });
  await clickOn(p, "#ds-redeploy");
  await until(async () => (await text(p, "#ds-status")).startsWith("Failed:"), 5_000, "a failed deploy says why", () => text(p, "#ds-status"));
  await p.screenshot(join(SHOTS, "settings-home-failed.png"));
  await stub(a.id, { scheduleMs: 4 * 60_000 });
  await clickOn(p, "#ds-pick");
  await until(() => p.eval<boolean>("!!document.getElementById('ds-ver-45')"), 5_000, "the picker opens");
  await clickOn(p, "#ds-ver-45");
  await until(async () => (await text(p, "#ds-status")).startsWith("Scheduled for"), 5_000, "publishing another version schedules a deploy", () => text(p, "#ds-status"));
  expect((await text(p, "#ds-status")).includes("in 4 minutes"), "and says when", await text(p, "#ds-status"));
  await p.screenshot(join(SHOTS, "settings-home-scheduled.png"));
  await stub(a.id, { admin: false });
  await until(async () => (await p.eval<string>(`document.getElementById("ds-home-switch").getAttribute("aria-disabled")`)) == "true" && (await text(p, "#ds-home-explain")) != "", 5_000, "when it can't be set, the switch is off limits and says why");
  await stub(a.id, { admin: true });
  ok("the homepage: the switch, Deploying then Deployed at, Redeploy now, Failed, Scheduled for, and a switch that can't be set; all live");

  // Errors, in plain words, where they happen.
  await stub(a.id, { error: "The version store is down for maintenance." });
  await clickOn(p, "#ds-pick");
  await until(() => p.eval<boolean>("!!document.getElementById('ds-ver-44')"), 5_000, "the picker opens");
  await clickOn(p, "#ds-ver-44");
  await until(async () => (await text(p, "#ds-pub-error")).includes("The version store is down"), 5_000, "a failed publish says why", () => text(p, "#ds-pub-error"));
  expect((await text(p, "#ds-pick")).startsWith("v45"), "and the picker goes back to what's published", await text(p, "#ds-pick"));
  await p.screenshot(join(SHOTS, "settings-error.png"));
  await closeSettings(p);
  await clickOn(p, "#btn-settings");
  await until(async () => /^Couldn't (load|refresh) the versions: The version store is down/.test(await text(p, "#ds-pub-error")), 5_000, "a failed load says so", () => text(p, "#ds-pub-error"));
  await stub(a.id, { error: null });
  await closeSettings(p);
  ok("errors show inline, in plain words, and a failed publish rolls back");

  // Read-only: someone who can't edit sees what's published and why they can't change it.
  await stub(a.id, { canEdit: false });
  await openSettings(p);
  expect((await p.eval<string>(`document.getElementById("ds-mode").getAttribute("aria-disabled")`)) == "true", "the publishing menu is read-only");
  expect((await text(p, "#ds-explain")).startsWith("Only the document's editors can change what's published"), "and says why", await text(p, "#ds-explain"));
  await clickOn(p, "#ds-mode");
  expect(!(await p.eval<boolean>("!!document.querySelector('.ds-menu')")), "clicking it opens nothing");
  await p.screenshot(join(SHOTS, "settings-read-only.png"));
  await stub(a.id, { canEdit: true });
  await closeSettings(p);
  ok("read-only for someone who can't edit, saying why");

  // A phone: a sheet from the bottom.
  const phone = await browser.page(ctx);
  await phone.open(editor(a.address), { width: 390, height: 780, scale: 3, agent: false, clear: false });
  await until(() => rect(phone, "#btn-settings"), 15_000, "the gear shows on a phone");
  const row = await phone.eval<number>(`document.querySelector(".chrome-top").scrollWidth - document.querySelector(".chrome-top").clientWidth`);
  expect(row <= 0, "the top row still fits", row);
  await openSettings(phone);
  const [vw, vh] = await phone.eval<[number, number]>("[innerWidth, innerHeight]");
  await until(async () => Math.round((await rect(phone, "#doc-settings"))!.bottom) == vh, 3_000, "the sheet slides up");
  const sheet = (await rect(phone, "#doc-settings"))!;
  expect(Math.round(sheet.bottom) == vh && sheet.left == 0 && Math.round(sheet.w) == vw, "on a phone it's a sheet from the bottom", { sheet, vw, vh });
  await phone.screenshot(join(SHOTS, "settings-phone.png"));
  await clickOn(phone, "#ds-pick");
  const m = (await rect(phone, ".ds-menu"))!;
  expect(m.left >= 0 && m.right <= vw && m.top >= 0 && m.bottom <= vh, "its menus fit the screen", m);
  await Bun.sleep(200); // the menu's fade-in
  await phone.screenshot(join(SHOTS, "settings-phone-picker.png"));
  ok("a phone: a sheet from the bottom, its menus on screen");

  // A page with a dark background: the popover takes its colours, as the controls do.
  const folder = mkdtempSync(join(tmpdir(), "erga-dark-"));
  writeFileSync(join(folder, "index.html"), `<!doctype html><html><head><title>Night</title><style>body{background:#14161c;color:#e8e8ee;font:18px/1.6 Georgia,serif;max-width:36rem;margin:15vh auto}</style></head><body><h1>Night notes</h1><p>A page with a dark background.</p></body></html>`);
  const dark = await host.open(folder);
  const darkId = ((await (await fetch(`${root}${new URL(dark).pathname}/api/name`)).json()) as { id: string }).id;
  await stub(darkId, { versions: 30, published: 4, isHome: true, deploy: { state: "deployed", at: new Date(Date.now() - 3_600_000).toISOString(), version: 4 } });
  const pd = await browser.page(ctx);
  await pd.open(editor(new URL(dark).pathname), { width: 1200, height: 820, scale: 2, agent: false, clear: false, dark: true });
  await until(() => rect(pd, "#btn-settings"), 15_000, "the gear shows");
  await until(() => pd.eval<boolean>(`document.documentElement.classList.contains("page-dark")`), 10_000, "the editor sees the page is dark");
  await openSettings(pd);
  const bg = await pd.eval<string>(`getComputedStyle(document.getElementById("doc-settings")).backgroundColor`);
  const lum = (bg.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).reduce((s, c) => s + c, 0) / 3;
  expect(lum < 90, "on a dark page the popover is dark", bg);
  await clickOn(pd, "#ds-pick");
  await Bun.sleep(200); // the menu's fade-in
  await pd.screenshot(join(SHOTS, "settings-dark.png"));
  ok("a dark page: the popover is dark too");

  expect(p.errors.length == 0 && p2.errors.length == 0 && phone.errors.length == 0 && pd.errors.length == 0, "no errors in the pages", [...p.errors, ...p2.errors, ...phone.errors, ...pd.errors]);
} finally {
  browser.close();
  await host.dispose();
}
console.log(`\n${checks.length} checks passed (screenshots in ${SHOTS})`);

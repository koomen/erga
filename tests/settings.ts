#!/usr/bin/env bun
// Document settings (src/page/settings.ts), in headless Chrome, against a
// real dev server (its versions, publishing and homepage: versions.ts,
// worker/doc-host.ts, worker/home.ts): the gear and its popover
// (lazy-loaded, anchored to the gear, Escape, a click outside, the
// keyboard); Latest and Manual, with the viewer showing what's published;
// the published-version picker's windows; Publish the current version (and
// edits not yet in a version); Edit on an old version, live in the open
// editor; descriptions arriving (the fallback, as the scripted model writes
// none); the homepage's switch, `blocked`, a publish scheduling a deploy,
// Redeploy now and the deploy's status, while / serves the published version;
// errors; read-only; a phone; and a page with a dark background.
//
// Its state is real: documents made with /new, their versions cut by edits
// (a participant in the room, as an editor's tab is) and publishes. The
// editor is always opened at its #edit address. Screenshots land in
// tests/cdp.ts's SHOTS.
//
//   bun tests/settings.ts

import { join } from "path";
import { Browser, type Page, SHOTS } from "./cdp";
import { startHost } from "./host";
import { Participant } from "./suite/client";
import { expect, until } from "./suite/harness";
import type { Doc } from "./suite/target";
import { F } from "./tab";

const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };

// A version is cut once edits pause for IDLE; the homepage deploys DELAY after its published version changes.
const IDLE = 1200, DELAY = 5000;
const host = await startHost(null, { env: { ERGA_AGENT_MODEL: "script", ERGA_WRITE_DELAY_MS: "50", ERGA_VERSION_IDLE_MS: String(IDLE), ERGA_HOME_DELAY_MS: String(DELAY), ERGA_HOME_RECHECK_MS: "0" } });
const root = host.root;
const browser = await Browser.launch();

interface V { id: string; n: number; description: string | null; authors: string[] }
interface State { current: V; published: { mode: string; version: V }; versions: V[]; total: number; canEdit: boolean; pending: boolean }
interface HomeState { isHome: boolean; canSet: boolean; blocked: string | null; deploy: { state: string; version: number | null; at: string | null } }
const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });
const post = (path: string, body?: unknown) => get(path, { method: "POST", headers: { Origin: root, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const versionsOf = async (id: string) => (await (await get(`/api/docs/${id}/versions`)).json()) as State;
const homeOf = async (id: string) => (await (await get(`/api/docs/${id}/home`)).json()) as HomeState;
const share = (id: string, login: string, role: string) => get("/docs/share", { method: "POST", body: new URLSearchParams({ id, login, role }), headers: { Origin: root } });
/** A document's editor: its address and #edit. */
const editor = (address: string, user?: string) => `${root}${address}${user ? `?user=${user}` : ""}#edit`;

/** A page whose heading says which draft it is: each version of the documents here has its own. */
const page = (title: string, n: number, style = "body{font:18px/1.6 Georgia,serif;max-width:36rem;margin:12vh auto;padding:0 20px}") =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title><style>${style}</style></head>\n<body><h1>${title}</h1>\n<p id="draft">Draft ${n}</p>\n<p>Each version of this page says which draft it is.</p>\n</body></html>\n`;

/** A document, as the owner (DEV_LOGIN, "tester"), with a participant in its room to edit it. */
async function newDoc(title: string, style?: string): Promise<{ address: string; id: string; ada: Participant; draft(n: number): void; versions(upTo: number): Promise<void>; text(): string }> {
  const at = (await get("/new")).headers.get("location")!;
  const address = at.replace(/(\/edit|#edit)$/, "");
  const { id } = (await (await get(`${address}/api/name`)).json()) as { id: string };
  const wsRoot = root.replace(/^http/, "ws");
  const doc = { base: `${root}/d/${id}`, path: "index.html", roomUrl: `${wsRoot}/d/${id}/api/room`, roomName: "doc", headers: {}, headersFor: () => ({}) } as unknown as Doc;
  const ada = await Participant.join(doc, "tester");
  let first = true;
  const draft = (n: number) => ada.edit((t) => {
    if (first) { t.delete(0, t.length); t.insert(0, page(title, n, style)); first = false; return; }
    const s = t.toString(), m = /Draft \d+/.exec(s)!;
    t.delete(m.index, m[0].length);
    t.insert(m.index, `Draft ${n}`);
  });
  return {
    address, id, ada, draft,
    text: () => ada.str(),
    /** Cuts versions up to `upTo`, each its own draft: an edit, then a publish (which cuts what's pending at once), in "latest" mode. */
    async versions(upTo: number) {
      for (let n = (await versionsOf(id)).total + 1; n <= upTo; n++) {
        draft(n);
        await until(async () => (await versionsOf(id)).pending, 5000, `the edit for version ${n} reaches the room`);
        expect((await post(`/api/docs/${id}/publish`, { mode: "latest" })).ok, `publishing (cutting) version ${n}`);
      }
      const s = await versionsOf(id);
      expect(s.total == upTo && s.current.n == upTo, `the document has ${upTo} versions`, s);
      // Its address follows its title (the page's first heading) once it's no longer blank: the one it had at first is the next blank document's.
      await until(async () => (this.address = ((await (await get(`/d/${id}/api/name`)).json()) as { address: string }).address) != address, 5000, "the document takes its title's address");
    },
  };
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
const firstRow = (p: Page) => p.eval<string>(`document.querySelector("#ds-list li")?.textContent ?? ""`);
/** The open menu's rows: version numbers, and "…N" for a row of N more. */
const menuRows = (p: Page) => p.eval<string>(`[...document.querySelectorAll(".ds-menu [role=option]")].map((o) => o.id.startsWith("ds-ver-") ? o.id.slice(7) : "…" + (o.textContent.match(/\\d+/) || [""])[0]).join(" ")`);
async function openSettings(p: Page) {
  // The editor's controls fade in as it comes up: click once they're there.
  await until(() => p.eval<boolean>(`(() => { const g = document.getElementById("btn-settings"), r = g?.getBoundingClientRect(); return !!r?.width && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("#btn-settings") == g && getComputedStyle(g.closest(".chrome")).opacity == "1"; })()`), 15_000, "the gear can be clicked");
  if (!(await isOpen(p))) await clickOn(p, "#btn-settings");
  await until(() => isOpen(p), 10_000, "the settings open");
  await until(async () => !["Loading…", ""].includes(await text(p, "#ds-mode")), 10_000, "the versions load");
}
/** A publish has finished saving (the menus are off limits while it saves). */
const saved = (p: Page) => until(async () => (await p.eval<string | null>(`document.getElementById("ds-mode").getAttribute("aria-disabled")`)) == null, 5_000, "the publish is saved");
async function closeSettings(p: Page) {
  if (await isOpen(p)) { await p.key("Escape"); await p.key("Escape"); }
  await until(async () => !(await isOpen(p)), 5_000, "the settings close");
}
/** What the document's viewer shows (its page, in the frame), opened afresh. */
async function viewerShows(v: Page, address: string, want: string, not: string[] = [], user?: string) {
  await v.navigate(`${root}${address}${user ? `?user=${user}` : ""}`);
  const shown = () => v.inPage<string>(`document.getElementById("draft")?.textContent ?? ""`);
  await until(async () => (await shown()).some((t) => t == want), 10_000, `the viewer shows "${want}"`, shown);
  const all = (await v.inPage<string>("document.body.innerText")).join("\n");
  for (const n of not) expect(!all.includes(n), `and not "${n}"`, all);
}
/** What / serves now: the homepage's deployed page. */
const front = async () => (await (await get("/")).text());
/** Every status line the homepage section showed, from now on (a deploy can be quick: each one is caught as it's drawn). */
const watchStatus = (p: Page) => p.eval(`(() => { window.__seen = []; window.__locked = []; const el = document.getElementById("ds-status"), btn = document.getElementById("ds-redeploy"); const note = () => { const t = el.textContent.trim(); if (t && window.__seen.at(-1) != t) { window.__seen.push(t); window.__locked.push(btn.getAttribute("aria-disabled") == "true"); } }; note(); new MutationObserver(note).observe(el, { childList: true, subtree: true, characterData: true }); return true; })()`);
/** Whether Redeploy now was off limits each time the status said Deploying. */
const lockedWhileDeploying = (p: Page) => p.eval<boolean>(`window.__seen.some((t) => t.startsWith("Deploying")) && window.__seen.every((t, i) => !t.startsWith("Deploying") || window.__locked[i])`);
const seen = (p: Page) => p.eval<string[]>("window.__seen ?? []");
/** Requests to the server's API that fail as if the network were down (`patterns`), or none. */
const block = async (p: Page, patterns: string[]) => { await p.send("Network.enable"); await p.send("Network.setBlockedURLs", { urls: patterns }); };

try {
  // ---------------------------------------------------------------- a document with 47 versions, published as "latest"
  const a = await newDoc("Field notes");
  await a.versions(47);
  ok("a real document with 47 versions, cut by edits");

  const ctx = await browser.context();
  const p = await browser.page(ctx);
  const viewer = await browser.page(ctx);
  await viewer.open(`${root}${a.address}`, { width: 1000, height: 700, agent: false });
  await p.open(editor(a.address), { width: 1200, height: 820, scale: 2, agent: false, clear: false });
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
  expect((await text(p, "#ds-mode")) == "Latest" && (await text(p, "#ds-explain")).includes("up to the keystroke"), "Latest: viewers see every change", await text(p, "#ds-explain"));
  const listed = await p.eval<string[]>(`[...document.querySelectorAll("#ds-list li")].map((li) => li.textContent.replace(/\\s+/g, " ").trim())`);
  expect(listed.length == 10 && listed[0].startsWith("v47") && listed[0].includes("Current") && listed[0].includes("Published") && listed[0].includes("Edited index.html") && listed[0].includes("tester"), "the latest ten versions, each with its number, description, time and author; the current one marked, and published", listed);
  expect((await text(p, "#ds-total")) == "47 in all", "and how many in all", await text(p, "#ds-total"));
  await p.screenshot(join(SHOTS, "settings-latest.png"));
  await p.key("Escape");
  await until(async () => !(await isOpen(p)), 3_000, "Escape closes it");
  expect((await p.eval<string>("document.activeElement?.id")) == "btn-settings", "and focus goes back to the gear");
  await p.key("Enter");
  await until(() => isOpen(p), 3_000, "Enter on the gear opens it again");
  // A click into the page (another document) closes it.
  await p.click(300, 500);
  await until(async () => !(await isOpen(p)), 3_000, "a click outside closes it");
  ok("the popover hangs from the gear; Escape, a click outside and the keyboard open and close it");

  // Latest to Manual, with the keyboard: Manual starts on what viewers see, the current version.
  await viewerShows(viewer, a.address, "Draft 47");
  await openSettings(p);
  await p.eval(`document.getElementById("ds-mode").focus(), true`);
  await p.key("ArrowDown");
  await until(() => p.eval<boolean>("!!document.getElementById('ds-menu-mode')"), 3_000, "ArrowDown opens the publishing menu");
  await Bun.sleep(200); // the menu's fade-in
  await p.screenshot(join(SHOTS, "settings-mode-menu.png"));
  await p.key("End");
  await p.key("Enter");
  await until(async () => { const v = await versionsOf(a.id); return v.published.mode == "manual" && v.published.version.n == 47; }, 5_000, "Manual is saved, on the current version");
  await until(async () => (await text(p, "#ds-mode")) == "Manual" && (await text(p, "#ds-pick")).startsWith("v47"), 3_000, "the popover says Manual, version 47");
  await saved(p);
  // Then an old version, picked from the menu: the viewer shows it.
  await clickOn(p, "#ds-pick");
  await until(async () => (await menuRows(p)).startsWith("47"), 5_000, "the picker opens");
  expect((await menuRows(p)) == "47 46 45 44 43 42 41 40 39 38 …37", "published is current: the latest ten and a row for the rest", await menuRows(p));
  await clickOn(p, `.ds-menu [id^=ds-more-]`);
  await until(async () => (await menuRows(p)).includes("28"), 5_000, "the row loads ten more", () => menuRows(p));
  await p.eval(`document.getElementById("ds-ver-30").scrollIntoView({ block: "nearest" }), true`);
  await clickOn(p, "#ds-ver-30");
  await until(async () => (await versionsOf(a.id)).published.version.n == 30, 5_000, "version 30 is published");
  await saved(p);
  await viewerShows(viewer, a.address, "Draft 30", ["Draft 47"]);
  expect((await text(p, "#ds-explain")).includes("17 newer versions aren't published"), "it says how many newer versions aren't published", await text(p, "#ds-explain"));
  ok("Latest to Manual by keyboard keeps what viewers see; picking an old version, the viewer shows it");

  // Far back: version 12. The picker shows the latest ten, a row for the gap, version 12 and the three before it, a row for the 8 older.
  expect((await post(`/api/docs/${a.id}/publish`, { mode: "manual", versionId: "v12" })).ok, "publishing version 12");
  await until(async () => (await text(p, "#ds-pick")).startsWith("v12"), 5_000, "the popover follows a publish made elsewhere, live");
  await viewerShows(viewer, a.address, "Draft 12", ["Draft 30", "Draft 47"]);
  await clickOn(p, "#ds-pick");
  await until(async () => (await menuRows(p)).includes(" 9 "), 5_000, "the picker has the versions before the published one");
  expect((await menuRows(p)) == "47 46 45 44 43 42 41 40 39 38 …25 12 11 10 9 …8", "far back: the latest ten, the gap, the published version and the three before it", await menuRows(p));
  expect((await p.eval<string>(`document.querySelector(".ds-menu [aria-selected=true]")?.id`)) == "ds-ver-12", "the published version is checked");
  await Bun.sleep(200);
  await p.screenshot(join(SHOTS, "settings-picker-far-back.png"));
  await clickOn(p, `.ds-menu [id^=ds-more-]`);
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
  await viewerShows(viewer, a.address, "Draft 11");
  await p.screenshot(join(SHOTS, "settings-manual.png"));
  ok("the picker: published far back, a row for the gap that loads more, the few before it, picked with the keyboard; the viewer follows");

  // Live: an edit becomes a new version once the edits pause, and its description arrives (the fallback: "Edited index.html").
  a.draft(48);
  await until(async () => (await firstRow(p)).includes("v48"), IDLE * 5, "a new version shows up live", () => firstRow(p));
  await until(async () => (await firstRow(p)).includes("Edited index.html"), 5_000, "its description arrives live", () => firstRow(p));
  expect((await text(p, "#ds-explain")).includes("37 newer versions aren't published"), "and Manual says it isn't published", await text(p, "#ds-explain"));
  await viewerShows(viewer, a.address, "Draft 11", ["Draft 48"]);
  ok("versions update live: a new one, then its description; Manual: viewers still see the published version");

  // Publish the current version: one click, in Manual, when it isn't the published one.
  expect(await p.eval<boolean>(`!document.getElementById("ds-pub-current").hidden`) && (await text(p, "#ds-pub-current")) == "Publish the current version (v48)", "Manual with a newer version: a button publishes the current one", await text(p, "#ds-pub-current"));
  await p.screenshot(join(SHOTS, "settings-publish-current.png"));
  await clickOn(p, "#ds-pub-current");
  await until(async () => (await versionsOf(a.id)).published.version.n == 48, 5_000, "the current version is published");
  await until(async () => (await text(p, "#ds-pick")).startsWith("v48") && (await p.eval<boolean>(`document.getElementById("ds-pub-current").hidden`)), 5_000, "the picker shows it, and the button goes, as current is now published");
  await saved(p);
  await viewerShows(viewer, a.address, "Draft 48", ["Draft 11"]);
  // Edits not yet in a version: the button publishes them too, up to the keystroke.
  await closeSettings(p);
  a.draft(49);
  await until(async () => (await versionsOf(a.id)).pending, 3_000, "the edit is pending");
  await openSettings(p);
  await until(async () => (await text(p, "#ds-pub-current")) == "Publish the latest edits", 3_000, "edits not in a version yet: the button publishes them", () => text(p, "#ds-pub-current"));
  expect((await text(p, "#ds-explain")).includes("The latest edits aren't published"), "and it says so", await text(p, "#ds-explain"));
  await clickOn(p, "#ds-pub-current");
  await until(async () => { const v = await versionsOf(a.id); return v.published.version.n == 49 && v.current.n == 49 && !v.pending; }, 5_000, "the edits are cut into version 49, and published");
  await saved(p);
  await viewerShows(viewer, a.address, "Draft 49", ["Draft 48"]);
  ok("Publish the current version: the viewer shows the current state, up to the keystroke; the button goes once it's published");

  // Edit on a version: on hover at once, and on keyboard focus; a copy of it becomes the current version, live in the editor.
  expect(!(await p.eval<boolean>(`!!document.querySelector('#ds-list li[data-n="49"] .ds-edit')`)), "the current version has no Edit");
  const edit = (n: number) => `#ds-list li[data-n="${n}"] .ds-edit`;
  const shown = (sel: string) => p.eval<string>(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).opacity`);
  expect((await shown(edit(45))) == "0", "Edit is hidden until the pointer comes");
  const v45 = (await rect(p, `#ds-list li[data-n="45"]`))!;
  await p.mouse("mouseMoved", v45.left + 60, v45.y);
  expect((await shown(edit(45))) == "1" && (await shown(edit(44))) == "0", "on hover, that version's Edit shows at once, with no fade", await shown(edit(45)));
  await p.screenshot(join(SHOTS, "settings-edit-hover.png"));
  const inEditor = () => p.frame<string>(`${F}?.getElementById("draft")?.textContent ?? ""`);
  expect((await inEditor()) == "Draft 49", "the editor shows draft 49", await inEditor());
  await p.mouse("mouseMoved", 300, 600);
  await p.key("Tab"); // a key first, so focus after it shows as keyboard focus
  await p.eval(`document.querySelector(${JSON.stringify(edit(44))}).focus(), true`);
  expect((await shown(edit(44))) == "1", "and on keyboard focus");
  await p.key("Enter");
  await until(async () => (await versionsOf(a.id)).current.n == 50, 5_000, "Edit makes a copy the current version");
  await until(async () => (await firstRow(p)).includes("Restored version 44"), 5_000, "the restored version shows at the top of the list", () => firstRow(p));
  const first = await firstRow(p);
  expect(first.startsWith("v50") && first.includes("Current") && first.includes("tester"), "as the current version, by the person", first);
  await until(async () => (await inEditor()) == "Draft 44", 5_000, "the open editor shows the restored content, live", inEditor);
  expect(a.text().includes("Draft 44"), "and so does everyone in the room");
  expect((await text(p, "#ds-pick")).startsWith("v49"), "Manual: the published version doesn't change");
  await viewerShows(viewer, a.address, "Draft 49", ["Draft 44"]);
  await p.screenshot(join(SHOTS, "settings-restored.png"));
  ok("Edit: on hover at once and on focus, not on the current version; a copy becomes the current version, live in the editor; the published version stays");

  // Errors, in plain words, where they happen (the network fails, for that request).
  await block(p, ["*/restore"]);
  await p.mouse("mouseMoved", v45.left + 60, (await rect(p, `#ds-list li[data-n="46"]`))!.y);
  await clickOn(p, edit(46));
  await until(async () => (await text(p, "#ds-hist-error")).startsWith("Couldn't restore version 46: Couldn't reach the server"), 5_000, "a failed restore says why", () => text(p, "#ds-hist-error"));
  expect((await versionsOf(a.id)).current.n == 50, "and nothing changed");
  await p.screenshot(join(SHOTS, "settings-restore-error.png"));
  await block(p, ["*/publish"]);
  await clickOn(p, "#ds-pick");
  await until(() => p.eval<boolean>("!!document.getElementById('ds-ver-44')"), 5_000, "the picker opens");
  await clickOn(p, "#ds-ver-44");
  await until(async () => (await text(p, "#ds-pub-error")).includes("Couldn't change what's published: Couldn't reach the server"), 5_000, "a failed publish says why", () => text(p, "#ds-pub-error"));
  await until(async () => (await text(p, "#ds-pick")).startsWith("v49"), 3_000, "and the picker goes back to what's published", () => text(p, "#ds-pick"));
  expect((await versionsOf(a.id)).published.version.n == 49, "the server agrees");
  await p.screenshot(join(SHOTS, "settings-error.png"));
  await closeSettings(p);
  await block(p, ["*/versions"]);
  await clickOn(p, "#btn-settings");
  await until(async () => /^Couldn't (load|refresh) the versions: Couldn't reach the server/.test(await text(p, "#ds-pub-error")), 5_000, "a failed load says so", () => text(p, "#ds-pub-error"));
  await block(p, []);
  await closeSettings(p);
  ok("errors show inline, in plain words, and a failed publish rolls back");

  // Fewer than ten versions in all, and the picker following live as versions come.
  const b = await newDoc("Small notes");
  await b.versions(6);
  expect((await post(`/api/docs/${b.id}/publish`, { mode: "manual", versionId: "v2" })).ok, "publishing version 2");
  const p2 = await browser.page(ctx);
  await p2.open(editor(b.address), { width: 1200, height: 820, scale: 2, agent: false, clear: false });
  await until(() => rect(p2, "#btn-settings"), 15_000, "the gear shows");
  await openSettings(p2);
  await clickOn(p2, "#ds-pick");
  await until(async () => (await menuRows(p2)).length > 0, 5_000, "the picker opens");
  expect((await menuRows(p2)) == "6 5 4 3 2 1", "fewer than ten: all of them", await menuRows(p2));
  await b.versions(47);
  expect((await post(`/api/docs/${b.id}/publish`, { mode: "manual", versionId: "v46" })).ok, "publishing version 46");
  await until(async () => (await menuRows(p2)) == "47 46 45 44 43 42 41 40 39 38 …37", 8_000, "published one older: the latest ten (the picker follows live)", () => menuRows(p2));
  await p2.key("Escape");
  await closeSettings(p2);
  ok("the picker with fewer than ten versions, and with the published one just older, following live");

  // ---------------------------------------------------------------- the homepage
  // A document someone who isn't an admin may edit can't be the homepage: the section says why.
  await share(a.id, "bo", "editor");
  // (Bo, an editor for now, opens the editor: it stays open after Bo becomes a viewer, below.)
  const pb = await browser.page(await browser.context());
  await pb.open(editor(a.address, "Bo"), { width: 1200, height: 820, scale: 2, agent: false });
  await until(() => rect(pb, "#btn-settings"), 15_000, "Bo's editor shows the gear");
  await openSettings(p);
  await until(() => p.eval<boolean>(`!document.getElementById("ds-home").hidden`), 5_000, "an admin sees the homepage section");
  await until(async () => (await text(p, "#ds-home-explain")).includes("Only admins may edit the front page"), 5_000, "blocked: it says why", () => text(p, "#ds-home-explain"));
  expect((await text(p, "#ds-home-explain")).includes("bo may edit this document"), "and who", await text(p, "#ds-home-explain"));
  expect((await p.eval<string>(`document.getElementById("ds-home-switch").getAttribute("aria-disabled")`)) == "true", "and the switch is off limits");
  await Bun.sleep(300); // the popover's fade-in
  await p.screenshot(join(SHOTS, "settings-home-blocked.png"));
  await clickOn(p, "#ds-home-switch");
  await Bun.sleep(300);
  expect(!(await homeOf(a.id)).isHome, "clicking it changes nothing");
  await share(a.id, "bo", "viewer");
  await closeSettings(p);
  ok("the homepage: a document others may edit can't be it, and the section says why (blocked)");

  // A document of three versions, made the homepage with the switch: it deploys, at once, its published version.
  const h = await newDoc("Front page");
  await h.versions(3);
  const ph = await browser.page(ctx);
  await ph.open(editor(h.address), { width: 1200, height: 820, scale: 2, agent: false, clear: false });
  await until(() => rect(ph, "#btn-settings"), 15_000, "the gear shows");
  await openSettings(ph);
  await until(() => ph.eval<boolean>(`!document.getElementById("ds-home").hidden`), 5_000, "the homepage section shows");
  expect((await ph.eval<string>(`document.getElementById("ds-home-switch").getAttribute("aria-checked")`)) == "false", "it isn't the homepage");
  expect(!(await rect(ph, "#ds-redeploy")), "so no deploy status or Redeploy is drawn");
  await watchStatus(ph);
  await clickOn(ph, "#ds-home-switch");
  await until(async () => (await homeOf(h.id)).isHome, 5_000, "it's the homepage");
  await until(async () => (await text(ph, "#ds-status")).startsWith("Deployed at") && (await text(ph, "#ds-status")).includes("version 3"), 10_000, "it deploys, and says which version is live", () => seen(ph));
  expect((await seen(ph)).some((s) => s.startsWith("Deploying")), "Deploying first, then Deployed", await seen(ph));
  expect((await front()).includes("Draft 3"), "/ serves the published version (latest: version 3)");
  await ph.screenshot(join(SHOTS, "settings-home-deployed.png"));
  ok("the homepage switch: the document becomes the homepage and deploys at once; Deploying, then Deployed with the version; / serves it");

  // Manual, then an edit: a new version that isn't published, so / doesn't change and no deploy is scheduled.
  expect((await post(`/api/docs/${h.id}/publish`, { mode: "manual", versionId: "v3" })).ok, "Manual, version 3");
  await until(async () => (await text(ph, "#ds-mode")) == "Manual", 5_000, "the popover says Manual");
  // (Going to Manual on the same version changes nothing viewers see; a deploy may still be scheduled for it: let it run.)
  await until(async () => (await homeOf(h.id)).deploy.state == "deployed", DELAY * 3, "nothing left to deploy");
  h.draft(4);
  await until(async () => (await versionsOf(h.id)).current.n == 4, IDLE * 5, "the edit becomes version 4");
  await until(async () => (await text(ph, "#ds-pub-current")) == "Publish the current version (v4)", 5_000, "the popover offers to publish it");
  expect((await homeOf(h.id)).deploy.state == "deployed", "an edit in Manual schedules no deploy", await homeOf(h.id));
  expect((await front()).includes("Draft 3") && !(await front()).includes("Draft 4"), "/ serves the published version, not the unpublished edit");
  // Publish the current version: the deploy is scheduled DELAY later, then runs by itself.
  await watchStatus(ph);
  await clickOn(ph, "#ds-pub-current");
  await until(async () => (await text(ph, "#ds-status")).startsWith("Scheduled for"), 5_000, "publishing schedules a deploy", () => seen(ph));
  expect((await text(ph, "#ds-status")).includes("version 3"), "and says which version is live until then", await text(ph, "#ds-status"));
  const scheduled = await homeOf(h.id);
  expect(scheduled.deploy.state == "scheduled", "the server agrees", scheduled);
  await ph.screenshot(join(SHOTS, "settings-home-scheduled.png"));
  expect((await front()).includes("Draft 3"), "until it runs, / serves the version deployed before");
  await until(async () => (await text(ph, "#ds-status")).startsWith("Deployed at") && (await text(ph, "#ds-status")).includes("version 4"), DELAY * 4, "the scheduled deploy runs, and says version 4 is live", () => seen(ph));
  expect((await front()).includes("Draft 4"), "/ serves version 4");
  console.log(`     the statuses shown: ${(await seen(ph)).map((s) => s.replace(/\d+:\d+(:\d+)?\s*(AM|PM)?/gi, "…")).join(" | ")}`);
  ok("a publish schedules the homepage's deploy; it runs by itself and the status shows version 4 live; / serves it");

  // Redeploy now, with an unpublished edit: it deploys the published version, at once, and / still doesn't have the edit.
  h.draft(5);
  await until(async () => (await versionsOf(h.id)).current.n == 5, IDLE * 5, "the edit becomes version 5");
  await watchStatus(ph);
  await clickOn(ph, "#ds-redeploy");
  await until(async () => (await text(ph, "#ds-status")).startsWith("Deployed at") && (await seen(ph)).length >= 2, 10_000, "Redeploy now deploys, and finishes", () => seen(ph));
  expect(await lockedWhileDeploying(ph), "Deploying first, and Redeploy now can't be pressed again meanwhile", await seen(ph));
  expect((await text(ph, "#ds-status")).includes("version 4"), "the published version is live: 4, not the unpublished 5", await text(ph, "#ds-status"));
  expect((await front()).includes("Draft 4") && !(await front()).includes("Draft 5"), "/ serves the published version, not the unpublished edit");
  await closeSettings(ph);
  ok("Redeploy now: Deploying, then Deployed with the published version; / never serves unpublished edits");

  // ---------------------------------------------------------------- read-only
  // Bo, who may only view now (an editor's tab still open from before): the settings say what's published, and change nothing.
  // (Someone who may only view doesn't get the editor at all at its #edit address: the viewer instead.)
  await openSettings(pb);
  await until(async () => (await pb.eval<string>(`document.getElementById("ds-mode").getAttribute("aria-disabled")`)) == "true", 5_000, "the publishing menu is read-only");
  expect((await text(pb, "#ds-explain")).startsWith("Only the document's editors can change what's published. Viewers see version 49"), "and says why, and what viewers see", await text(pb, "#ds-explain"));
  expect(!(await pb.eval<boolean>(`!!document.querySelector("#ds-list .ds-edit")`)) && (await pb.eval<boolean>(`document.getElementById("ds-pub-current").hidden`)), "no Edit, no Publish");
  expect(await pb.eval<boolean>(`document.getElementById("ds-home").hidden`), "and no homepage section: Bo isn't an admin, and it isn't the homepage");
  await clickOn(pb, "#ds-mode");
  expect(!(await pb.eval<boolean>("!!document.querySelector('.ds-menu')")), "clicking it opens nothing");
  await pb.screenshot(join(SHOTS, "settings-read-only.png"));
  await closeSettings(pb);
  const fresh = await browser.page(await browser.context());
  await fresh.open(editor(a.address, "Bo"), { width: 1000, height: 700, agent: false });
  await until(async () => (await fresh.inPage<string>(`document.getElementById("draft")?.textContent ?? ""`)).some((t) => t == "Draft 49"), 10_000, "a viewer at the editor's address gets the viewer, with the published version");
  expect(!(await rect(fresh, "#btn-settings")), "and no editor");
  fresh.close();
  // The known gap: the room (the editor's live text) answers a viewer too, read-only, with the current state, not the published one.
  const wsRoot = root.replace(/^http/, "ws");
  const boRoom = await Participant.join({ base: `${root}/d/${a.id}`, path: "index.html", roomUrl: `${wsRoot}/d/${a.id}/api/room`, roomName: "doc", headers: {}, headersFor: () => ({}) } as unknown as Doc, "Bo").catch(() => null);
  const gap = boRoom ? boRoom.str() : "";
  console.log(`     the known gap: a viewer's room connection ${boRoom ? `syncs and reads "${/Draft \d+/.exec(gap)?.[0]}"` : "is refused"} (published: Draft 49; current: Draft 44)`);
  boRoom?.disconnect();
  // Over the API, too: a viewer may read, not publish, restore or deploy.
  const boApi = (path: string, method = "GET") => get(`${path}?user=Bo`, { method, headers: { Origin: root, "Content-Type": "application/json" }, body: method == "POST" ? JSON.stringify({ mode: "latest" }) : undefined });
  const boState = (await (await boApi(`/api/docs/${a.id}/versions`)).json()) as State;
  expect(boState.canEdit === false && boState.published.version.n == 49, "a viewer reads the versions, told they can't edit", boState);
  expect((await boApi(`/api/docs/${a.id}/publish`, "POST")).status == 403 && (await boApi(`/api/docs/${a.id}/versions/v3/restore`, "POST")).status == 403 && (await boApi(`/api/docs/${a.id}/home`, "POST")).status == 403, "and can't publish, restore or choose the homepage");
  ok("read-only for someone who can't edit: what's published and why they can't change it; the API refuses them too");

  // ---------------------------------------------------------------- a phone
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
  await Bun.sleep(200);
  await phone.screenshot(join(SHOTS, "settings-phone-picker.png"));
  ok("a phone: a sheet from the bottom, its menus on screen");

  // ---------------------------------------------------------------- a page with a dark background
  const d = await newDoc("Night notes", "body{background:#14161c;color:#e8e8ee;font:18px/1.6 Georgia,serif;max-width:36rem;margin:15vh auto}");
  await d.versions(8);
  expect((await post(`/api/docs/${d.id}/publish`, { mode: "manual", versionId: "v4" })).ok, "publishing version 4");
  const pd = await browser.page(ctx);
  await pd.open(editor(d.address), { width: 1200, height: 820, scale: 2, agent: false, clear: false, dark: true });
  await until(() => rect(pd, "#btn-settings"), 15_000, "the gear shows");
  await until(() => pd.eval<boolean>(`document.documentElement.classList.contains("page-dark")`), 10_000, "the editor sees the page is dark");
  await openSettings(pd);
  const bg = await pd.eval<string>(`getComputedStyle(document.getElementById("doc-settings")).backgroundColor`);
  const lum = (bg.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).reduce((s, c) => s + c, 0) / 3;
  expect(lum < 90, "on a dark page the popover is dark", bg);
  await clickOn(pd, "#ds-pick");
  await Bun.sleep(200);
  await pd.screenshot(join(SHOTS, "settings-dark.png"));
  ok("a dark page: the popover is dark too");

  const errors = [p, p2, ph, pb, phone, pd].flatMap((x) => x.errors).filter((e) => !/ERR_BLOCKED_BY_CLIENT|Failed to fetch/.test(e));
  expect(errors.length == 0, "no errors in the pages", errors);
  for (const x of [a, b, h, d]) x.ada.disconnect();
} catch (e) {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  console.error(host.output().slice(-3000));
  process.exitCode = 1;
} finally {
  browser.close();
  await host.dispose();
}
if (!process.exitCode) console.log(`\n${checks.length} checks passed (screenshots in ${SHOTS})`);
process.exit(process.exitCode ?? 0);

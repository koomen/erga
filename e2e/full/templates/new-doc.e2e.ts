// New documents from a template: /new?template=<id> makes each template's document and refuses
// one that isn't there; the + button in the viewer, the editor, the documents page and (signed out) the homepage opens the picker,
// in the app's typeface, and picking a template makes the document and opens it in the editor.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { expect, servers, settle, test, until } from "../../helpers/fixtures";
import { ROOT } from "../../helpers/env";
import { TEMPLATES } from "../../../server/pages/index.ts";
import { editorReady, idOf, newDoc, openTab } from "./templates";

await servers.main();

// The picker's root: the page's own document, or the homepage's controls' shadow root when it's served directly.
const ROOT_OF = `(document.querySelector("erga-controls")?.shadowRoot ?? document)`;
const ROWS = ["Document", "Slides", "Canvas", "Project"];

const picker = (page: Page) => page.evaluate(`(() => {
  const r = ${ROOT_OF}, menu = r.querySelector(".erga-new-menu");
  return { open: !!menu && !menu.hidden,
    expanded: r.querySelector('.erga-new-btn[aria-expanded="true"]')?.getAttribute("aria-label") ?? null,
    rows: [...(menu?.querySelectorAll("a") ?? [])].filter((a) => a.getClientRects().length).map((a) => a.querySelector("b").textContent.trim()) };
})()`) as Promise<{ open: boolean; rows: string[]; expanded: string | null }>;

/** Clicks the middle of the first visible element matching `selector` (in the picker's root). */
async function clickOn(page: Page, selector: string) {
  const r = await until(() => page.evaluate(`(() => { const e = [...${ROOT_OF}.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getClientRects().length && getComputedStyle(e).visibility != "hidden"); const r = e?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`) as Promise<{ x: number; y: number } | null>, 5000, `${selector} on the page`);
  await page.mouse.click(r!.x, r!.y);
  await settle(page);
}

/** Every option and group heading in Inter (loaded, not a fallback), 14px, 600. */
async function sameTypeface(page: Page) {
  await expect.poll(() => page.evaluate(() => document.fonts.load("600 14px Inter").then((f) => f.some((x) => x.family.replace(/["']/g, "") == "Inter" && x.status == "loaded")))).toBe(true);
  const t = await page.evaluate(`(() => {
    const els = [...${ROOT_OF}.querySelectorAll(".erga-new-menu a b")];
    const font = (e) => { const c = getComputedStyle(e); return c.fontFamily + " " + c.fontSize + " " + c.fontWeight + " " + c.fontStyle; };
    return { fonts: [...new Set(els.map(font))], family: els.length ? getComputedStyle(els[0]).fontFamily : "" };
  })()`) as { fonts: string[]; family: string };
  expect(t.fonts.length).toBe(1);
  expect(t.family).toMatch(/^"?Inter"?,/);
  expect(t.fonts[0]).toMatch(/ 14px 600 normal$/);
}

const fileOf = async (root: string, address: string) => (await fetch(`${root}/d/${await idOf(address)}/doc/index.html`)).text();
const template = (files: string) => readFileSync(join(ROOT, files, "index.html"), "utf8");

test("/new?template=<id> makes each template's document, Document (id page) first; an unknown one (or the demo page) is a 404", async () => {
  const s = await servers.main();
  const page = await newDoc(s, "page");
  expect(page.status).toBe(302);
  expect(page.location).toMatch(/[?&]edit=?$/);
  expect(TEMPLATES[0].id).toBe("page");
  expect(await fileOf(s.root, page.address)).toBe(template("assets/templates/doc"));
  for (const t of TEMPLATES.slice(1)) expect(await fileOf(s.root, (await newDoc(s, t.id)).address), t.name).toBe(template(t.files));
  expect((await newDoc(s, "nope")).status).toBe(404);
  expect((await newDoc(s, "demo")).status).toBe(404);
});

test("the viewer's + opens the picker, in one typeface; Escape closes it; Document makes a blank document and opens it in the editor", async ({
  tab,
}) => {
  const s = await servers.main();
  const { address } = await newDoc(s, "page");
  const page = tab.page;
  await openTab(tab, address);
  await clickOn(page, ".erga-view-buttons .erga-new-btn");
  const m = await picker(page);
  expect(m).toEqual({ open: true, rows: ROWS, expanded: "New document" });
  // No icons: names and their lines only.
  const icons = (await page.evaluate(
    `[...${ROOT_OF}.querySelectorAll(".erga-new-menu a")].some((a) => a.querySelector("svg"))`
  )) as boolean;
  expect(icons).toBe(false);
  await sameTypeface(page);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await picker(page)).open).toBe(false);
  await clickOn(page, ".erga-view-buttons .erga-new-btn");
  await clickOn(page, '.erga-new-menu a[data-template="page"]');
  const from = new URL(address).pathname;
  await expect.poll(() => page.evaluate(() => location.search)).toBe("?edit");
  await expect.poll(() => page.evaluate(() => location.pathname)).not.toBe(from);
  expect(await fileOf(s.root, s.root + await page.evaluate(() => location.pathname))).toBe(template("assets/templates/doc"));
});

test("the editor's + opens the picker under it, in the window, in one typeface, with Clone last under a line; Document makes a blank document and opens it", async ({
  tab,
}) => {
  const s = await servers.main();
  const { address } = await newDoc(s, "page");
  const page = tab.page;
  await openTab(tab, `${address}?edit`);
  await editorReady(page);
  // The viewer's controls fade out over the editor's for 200 ms after it is ready, and take clicks meanwhile
  // (server/pages/viewer.ts, `.erga-editor-ready :is(.erga-view-buttons, .erga-account)`): a click on + then hits the viewer's
  // Clone button and makes a copy. Click once + itself is what a click there reaches (the old test paused 500 ms).
  // The editor's own controls open out of the pencil as it comes up, moving the + aside: it's clicked once they're open.
  await expect.poll(() => page.evaluate(() => document.getElementById("edit-group")!.classList.contains("settled"))).toBe(true);
  await expect.poll(() => page.evaluate(() => { const b = document.querySelector("#btn-new")!, r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  await clickOn(page, "#btn-new");
  const m = await picker(page);
  expect(m.open).toBe(true);
  expect(m.rows).toEqual([...ROWS, "Clone"]);
  expect(m.expanded).toBe("New document");
  // Clone: the viewer's Clone address (your own copy of this document), under a line.
  const clone = await page.evaluate(() => {
    const a = document.querySelector<HTMLAnchorElement>(".erga-new-clone")!,
      sep = a.previousElementSibling!,
      u = new URL(a.href);
    return {
      href: u.pathname + u.search,
      line: sep.matches("hr") && sep.getClientRects().length > 0,
      text: a.querySelector("span")!.textContent,
    };
  });
  expect(clone).toEqual({ href: `/new?from=${await idOf(address)}`, line: true, text: "Your own copy of this document." });
  await sameTypeface(page);
  const place = await page.evaluate(() => ({ menu: document.querySelector(".erga-new-menu")!.getBoundingClientRect().toJSON(), btn: document.querySelector("#btn-new")!.getBoundingClientRect().toJSON(), w: innerWidth }));
  expect(place.menu.top).toBeGreaterThan(place.btn.bottom);
  expect(place.menu.right).toBeLessThanOrEqual(place.w);
  await clickOn(page, '.erga-new-menu a[data-template="page"]');
  const from = new URL(address).pathname;
  await expect.poll(() => page.evaluate(() => location.pathname != "" && location.search == "?edit" && location.pathname)).not.toBe(from);
});

test("the documents page's New opens the same picker under it, without icons; Project makes a project and opens it", async ({ tab }) => {
  const s = await servers.main();
  const page = tab.page;
  await openTab(tab, `${s.root}/docs`);
  await clickOn(page, "header .erga-new-btn");
  const m = await picker(page);
  expect(m).toEqual({ open: true, rows: ROWS, expanded: "New document" });
  expect(await page.evaluate(() => [...document.querySelectorAll(".erga-new-menu a")].some((a) => a.querySelector("svg")))).toBe(false);
  await sameTypeface(page);
  const place = await page.evaluate(() => ({
    menu: document.querySelector(".erga-new-menu")!.getBoundingClientRect().toJSON(),
    btn: document.querySelector("header .erga-new-btn")!.getBoundingClientRect().toJSON(),
    w: innerWidth,
  }));
  expect(place.menu.top).toBeGreaterThan(place.btn.bottom);
  expect(place.menu.right).toBeLessThanOrEqual(place.w);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await picker(page)).open).toBe(false);
  await clickOn(page, "header .erga-new-btn");
  // (Not clickOn: the page leaves at once, before its settle.)
  await page.click('.erga-new-menu a[data-template="project"]');
  await expect
    .poll(() => {
      const u = new URL(page.url());
      return u.pathname != "/docs" && u.search == "?edit";
    })
    .toBe(true);
  expect(await fileOf(s.root, s.root + new URL(page.url()).pathname)).toBe(template("assets/templates/project"));
});

test("signed out, the homepage's + opens the menu, and a template goes to sign-in and comes back to make it", async ({ tab }) => {
  const s = await servers.main();
  const out = (await fetch(`${s.root}/auth/logout`, { method: "POST", headers: { Origin: s.root }, redirect: "manual" })).headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const page = tab.page;
  await page.goto(`${s.root}/auth/logout`);
  await openTab(tab, `${s.root}/`);
  await clickOn(page, ".erga-view-buttons .erga-new-btn");
  const m = await picker(page);
  expect(m.open).toBe(true);
  expect(m.rows).toEqual(ROWS);
  await sameTypeface(page);
  const href = await page.evaluate(`${ROOT_OF}.querySelector('.erga-new-menu a[data-template="page"]').getAttribute("href")`) as string;
  const r = await fetch(s.root + href, { redirect: "manual", headers: { Cookie: out } });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe(`/auth/sign-in?next=${encodeURIComponent("/new?template=page")}`);
});

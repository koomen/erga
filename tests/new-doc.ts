#!/usr/bin/env bun
// New documents from a template (templates.ts): the + button, in the viewer,
// on the front page and in the editor, opens the picker (Page, Design doc and the
// Presentation group, with Slides, Canvas presentation and the Solar system tour), every option and group heading in the app's typeface
// (Inter), at one size and weight; picking a template makes the document from
// it and opens it in the editor; signed out, it asks you to sign in first.
// /new?template=<id> makes each template, and refuses one that isn't there.
//
// Screenshots land in tests/cdp.ts's SHOTS.
//
//   bun tests/new-doc.ts

import { readFileSync } from "fs";
import { join } from "path";
import { Browser, type Page, ROOT, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";
import { TEMPLATES } from "../templates";

const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };

const host = await startHost(null);
const root = host.root;
const browser = await Browser.launch();
const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });
const idOf = async (at: string) => ((await (await get(`${at.replace(/#edit$/, "")}/api/name`)).json()) as { id: string }).id;

// The picker's root: the page's own document, or the front page's controls' shadow root (home.ts) when it's served directly.
const ROOT_OF = `(document.querySelector("erga-controls")?.shadowRoot ?? document)`;
const picker = (p: Page) => p.eval<{ open: boolean; rows: string[]; note: string; expanded: string | null }>(`(() => {
  const r = ${ROOT_OF}, menu = r.querySelector(".erga-new-menu");
  return { open: !!menu && !menu.hidden, note: menu?.querySelector(".erga-new-note")?.textContent ?? "",
    expanded: r.querySelector('.erga-new-btn[aria-expanded="true"]')?.getAttribute("aria-label") ?? null,
    rows: [...(menu?.querySelectorAll("a b, .erga-new-group-name, .erga-new-empty") ?? [])].map((e) => e.textContent.trim()) };
})()`);
const clickOn = async (p: Page, selector: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(`(() => { const e = [...${ROOT_OF}.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getClientRects().length && getComputedStyle(e).visibility != "hidden"); const r = e?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  expect(r, `${selector} is on the page`);
  await p.click(r.x, r.y);
  await p.settle();
};
const ROWS = "Page,Design doc,Presentation,Slides,Canvas presentation,Solar system tour";
/** Every option's and group heading's typeface, size and weight, as the page shows them (Inter loaded, not a fallback). */
const typeface = async (p: Page) => {
  await until(() => p.eval<boolean>(`document.fonts.load("600 14px Inter").then((f) => f.some((x) => x.family.replace(/["']/g, "") == "Inter" && x.status == "loaded"))`), 5000, "Inter loads");
  return p.eval<{ fonts: string[]; family: string }>(`(() => {
    const els = [...${ROOT_OF}.querySelectorAll(".erga-new-menu a b, .erga-new-group-name")];
    const font = (e) => { const c = getComputedStyle(e); return c.fontFamily + " " + c.fontSize + " " + c.fontWeight + " " + c.fontStyle; };
    return { fonts: [...new Set(els.map(font))], family: els.length ? getComputedStyle(els[0]).fontFamily : "" };
  })()`);
};
const sameTypeface = async (p: Page, where: string) => {
  const t = await typeface(p);
  expect(t.fonts.length == 1 && /^"?Inter"?,/.test(t.family) && t.fonts[0].endsWith(" 14px 600 normal"), `${where}: every option and group heading in Inter, 14px, 600`, t);
};

try {
  // The server: each template makes its document; one that isn't there is refused.
  const page = await get("/new?template=page");
  const pageAt = page.headers.get("location")!;
  expect(page.status == 302 && pageAt.endsWith("#edit"), "/new?template=page opens the new document in the editor", pageAt);
  expect((await (await get(`/d/${await idOf(pageAt)}/doc/index.html`)).text()) == readFileSync(join(ROOT, "templates/doc/index.html"), "utf8"), "Page is templates/doc");
  for (const t of TEMPLATES.slice(1)) {
    const made = (await get(`/new?template=${t.id}`)).headers.get("location")!;
    expect((await (await get(`/d/${await idOf(made)}/doc/index.html`)).text()) == readFileSync(join(ROOT, t.files, "index.html"), "utf8"), `${t.name} is ${t.files}`, made);
  }
  expect((await get("/new?template=nope")).status == 404 && (await get("/new?template=demo")).status == 404, "an unknown template is refused (the demo page is no template: Clone copies it)");
  expect(TEMPLATES[0].id == "page", "the first template is the blank page, as /new makes");
  ok("/new?template=<id> makes each template's document; an unknown one is a 404");

  const p = await browser.page();
  // The viewer.
  await p.open(root + pageAt.replace(/#edit$/, ""), { width: 1100, height: 720, scale: 2 });
  await until(async () => !!(await p.eval<boolean>(`!!document.querySelector(".erga-view-buttons .erga-new-btn")`)), 5000, "the viewer has +");
  await clickOn(p, ".erga-view-buttons .erga-new-btn");
  let m = await picker(p);
  expect(m.open && m.rows.join() == ROWS && m.expanded == "New document" && !m.note, "+ opens the picker: Page, Design doc and the Presentation group, with Slides, Canvas presentation and the Solar system tour", m);
  await sameTypeface(p, "the viewer");
  await p.screenshot(join(SHOTS, "new-doc-viewer.png"));
  await p.key("Escape");
  expect(!(await picker(p)).open, "Escape closes it");
  await clickOn(p, ".erga-view-buttons .erga-new-btn");
  await clickOn(p, '.erga-new-menu a[data-template="page"]');
  await until(async () => (await p.eval<string>("location.hash")) == "#edit" && (await p.eval<string>("location.pathname")) != pageAt.replace(/#edit$/, ""), 10_000, "picking Page opens a new document in the editor");
  const madeAt = await p.eval<string>("location.pathname");
  expect((await (await get(`/d/${await idOf(madeAt)}/doc/index.html`)).text()) == readFileSync(join(ROOT, "templates/doc/index.html"), "utf8"), "made from templates/doc", madeAt);
  ok("the viewer's + opens the picker, in one typeface; Page makes a blank document and opens it in the editor");

  // The editor.
  await p.open(root + pageAt, { width: 1100, height: 720, scale: 2, agent: false });
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && !!document.querySelector("#btn-new")?.getClientRects().length`), 15_000, "the editor shows +");
  await Bun.sleep(500); // the editor puts the caret in the page once it is ready, which would close a menu opened that instant
  await clickOn(p, "#btn-new");
  m = await picker(p);
  expect(m.open && m.rows.join() == ROWS && m.expanded == "New document", "the editor's + opens the picker", m);
  await sameTypeface(p, "the editor");
  const place = await p.eval<{ menu: DOMRect; btn: DOMRect }>(`({ menu: document.querySelector(".erga-new-menu").getBoundingClientRect().toJSON(), btn: document.querySelector("#btn-new").getBoundingClientRect().toJSON() })`);
  expect(place.menu.top > place.btn.bottom && place.menu.right <= 1100, "under the button, in the window", place);
  await p.screenshot(join(SHOTS, "new-doc-editor.png"));
  await clickOn(p, '.erga-new-menu a[data-template="page"]');
  await until(async () => (await p.eval<string>("location.pathname + location.hash")) != pageAt && (await p.eval<string>("location.hash")) == "#edit", 10_000, "picking Page opens a new document in the editor");
  ok("the editor's + opens the picker under it, in one typeface; Page makes a blank document and opens it");

  // Signed out, on the front page: the picker says you sign in first, and a template goes to sign-in, back to /new for it.
  const outCookie = (await get("/auth/logout", { method: "POST", headers: { Origin: root } })).headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
  await p.navigate(root + "/auth/logout");
  await p.open(root + "/", { width: 1100, height: 720, scale: 2, clear: false });
  await until(async () => !!(await p.eval<boolean>(`!!${ROOT_OF}.querySelector(".erga-new-btn")`)), 10_000, "the front page has +");
  await clickOn(p, ".erga-view-buttons .erga-new-btn");
  m = await picker(p);
  expect(m.open && m.rows.join() == ROWS && /sign in first/.test(m.note), "signed out, the picker says you sign in first", m);
  await sameTypeface(p, "the front page");
  await p.screenshot(join(SHOTS, "new-doc-signed-out.png"));
  const href = await p.eval<string>(`${ROOT_OF}.querySelector('.erga-new-menu a[data-template="page"]').getAttribute("href")`);
  const out = await get(href, { headers: { Cookie: outCookie } });
  expect(out.status == 302 && out.headers.get("location") == `/auth/github?next=${encodeURIComponent("/new?template=page")}`, "signed out, a template asks you to sign in, and comes back to make it", out.headers.get("location"));
  ok("signed out, the front page's + says you sign in first, and a template goes to sign-in and back");
  if (p.errors.length) throw new Error("errors on the page: " + p.errors.join("\n"));
} finally {
  browser.close();
  await host.dispose();
}
console.log(`\n${checks.length} checks passed (screenshots in ${SHOTS})`);

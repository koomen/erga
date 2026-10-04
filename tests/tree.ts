#!/usr/bin/env bun
// A document's pages, as a tree (src/page/tree.ts, built as pages-tree.js), in
// headless Chrome, in both places it shows:
//
//   - the editor: the document's title (top left) opens it; the document is
//     its root row, its other pages, folders and files under it; the page
//     you're on is marked; the root row's pencil renames the document;
//   - Documents: each document's chevron opens its pages beneath its row.
//
// And what it does: folders open and close, New page and New folder (at
// the top level and in a folder) name the new one in place (.html added),
// rename in place, Move to… and drag and drop, delete (a folder asks first),
// the server's errors shown in its words, read-only for viewers, the keys,
// light, dark and a phone. pages-tree.js isn't loaded until the tree is opened.
//
// The dev server answers the tree's API from dev/tree-stub.ts (ERGA_TREE_STUB=1),
// so the test can set any tree. Screenshots land in tests/cdp.ts's SHOTS.
//
//   bun tests/tree.ts

import { cpSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, type Page, SHOTS, ROOT } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const dir = mkdtempSync(join(tmpdir(), "erga-multi-"));
cpSync(join(ROOT, "tests/fixtures/multi"), dir, { recursive: true });
const host = await startHost(dir, { processEnv: { ERGA_TREE_STUB: "1" } });
const browser = await Browser.launch();
const info = (await (await fetch(`${host.base}/api/doc`)).json()) as { docName: { id: string; address: string } };
const id = info.docName.id, address = info.docName.address;
const stub = (body: object) => fetch(`${host.root}/__erga/tree-stub/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const tree = async () => ((await (await fetch(`${host.root}/api/docs/${id}/tree`)).json()) as { entries: { path: string; type: string }[] }).entries.map((e) => e.path).sort();

/** The rows the tree shows: [path, label, depth, current]. */
const rows = (p: Page) => p.eval<[string, string, number, boolean][]>(`[...document.querySelectorAll(".et-row[data-path]")].map((r) => [r.dataset.path, r.querySelector(".et-name").textContent, +r.getAttribute("aria-level"), r.getAttribute("aria-current") == "page"])`);
const paths = async (p: Page) => (await rows(p)).map((r) => r[0]);
const centre = async (p: Page, selector: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  expect(r, `${selector} is on the page`);
  return r;
};
const clickOn = async (p: Page, selector: string) => { const r = await centre(p, selector); await p.click(r.x, r.y); };
const row = (path: string) => `.et-row[data-path="${path}"]`;
/** Hovers a row (its buttons show), then clicks one of them. */
const act = async (p: Page, path: string, which: string) => {
  const r = await centre(p, row(path));
  await p.mouse("mouseMoved", r.x, r.y);
  await clickOn(p, `${row(path)} [data-act="${which}"]`);
};
const menuItem = async (p: Page, label: string) => {
  const ok = await p.eval<boolean>(`(() => { const b = [...document.querySelectorAll('.et-menu [role="menuitem"]')].find((b) => b.textContent.trim() == ${JSON.stringify(label)}); if (b) b.setAttribute("data-pick", ""); return !!b; })()`);
  expect(ok, `the menu has ${label}`, await p.eval(`[...document.querySelectorAll('.et-menu [role="menuitem"]')].map((b) => b.textContent).join(", ")`));
  await clickOn(p, ".et-menu [data-pick]");
};
const focused = (p: Page) => p.eval<string | null>(`document.activeElement?.closest?.("[data-path]")?.dataset.path ?? (document.activeElement?.classList.contains("et-input") ? "input" : document.activeElement?.tagName ?? null)`);

/**
 * How a document's page rendered, from inside the frame showing it (`doc` names its document there): its
 * stylesheet (../../style.css: the body's width), its image (../../assets/owl.svg) and its font (fonts/field.woff2,
 * named by the stylesheet), all from folders above it.
 */
const rendered = (doc: string) => `(async () => {
  const d = ${doc};
  if (!d || d.readyState != "complete" || !d.getElementById("owl")) return null;
  await d.fonts.ready;
  const img = d.getElementById("owl");
  return { width: d.defaultView.getComputedStyle(d.body).maxWidth, image: img.complete ? img.naturalWidth : 0,
    font: [...d.fonts].some((f) => f.family.replace(/["']/g, "") == "Field" && f.status == "loaded") };
})()`;
/** The editor at an address: <address>#edit. */
const editor = (address: string) => address + "#edit";
/** Where the tree sent the tab: its address with #edit (in the editor) or without (the viewer). */
const wentTo = (went: string[], want: string) => went.some((u) => { const x = new URL(u); return x.pathname + x.hash == want; });
const renderedRight = (r: { width: string; image: number; font: boolean } | null) => !!r && r.width == "608px" && r.image == 120 && r.font;

try {
  const ctx = await browser.context();
  const p = await browser.page(ctx);

  // ------------------------------------------------------------ a nested document renders whole
  // A document two folders down (blog/drafts/owls.html) uses the shared stylesheet, an image and a font from
  // folders above it, by relative paths. The viewer's frame shows it as the server serves it.
  const viewer = await (await fetch(host.base)).text();
  const frameSrc = /<iframe id="frame"[^>]* (?:data-)?src="([^"]+)"/.exec(viewer)![1].replaceAll("&amp;", "&");
  await p.open(frameSrc.replace(/view=[^&]*/, `view=${encodeURIComponent("blog/drafts/owls.html")}`), { width: 900, height: 700 });
  let look: { width: string; image: number; font: boolean } | null = null;
  await until(async () => renderedRight(look = await p.eval(rendered(`document.getElementById("view")?.contentDocument`))), 10_000, "the nested document, as the viewer's frame shows it, has its stylesheet, image and font").catch(() => { throw new Error(JSON.stringify(look)); });
  // At its own address, in the viewer and the editor: once task #30 routes a document's pages (until then, said and skipped).
  const nestedAt = `${host.base}/blog/drafts/owls`;
  if ((await fetch(nestedAt, { redirect: "manual" })).status == 200) {
    await p.open(nestedAt, { width: 900, height: 700, clear: false });
    await until(async () => (await p.inPage<boolean>(`!!document.getElementById("owl")`)).some(Boolean), 10_000, "the viewer shows it at its address");
    await until(async () => (await p.inFrames(rendered(`document.querySelector("iframe.on")?.contentDocument`))).some(renderedRight), 10_000, "rendered whole in the viewer at its address");
    await p.open(editor(nestedAt), { width: 900, height: 700, clear: false, agent: false });
    await until(async () => renderedRight(await p.frame(rendered(`document.getElementById("page")?.contentDocument`))), 15_000, "and in the editor, which resolves its links from its folder");
    ok("a nested document renders whole (stylesheet, image, font from folders above it): in the viewer's frame, and at its address in the viewer and the editor");
  } else ok("a nested document renders whole in the viewer's frame (stylesheet, image, font from folders above it); at its own address, viewer and editor wait for task #30's routes");

  // ------------------------------------------------------------ the editor
  await p.open(editor(host.base), { width: 1200, height: 760, scale: 2, agent: false });
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden`), 20_000, "the editor is up with its title");
  expect(!(await p.eval<boolean>(`!!window.ergaTree || !!document.querySelector('script[src="/pages-tree.js"]')`)), "pages-tree.js isn't loaded until it's wanted");
  await clickOn(p, "#doc-title");
  await until(() => p.eval<boolean>(`document.querySelectorAll(".et-row[data-path]").length > 0`), 10_000, "the tree shows");
  let r = await rows(p);
  expect(r[0][0] == "index.html" && r[0][1] == "Field guide" && r[0][2] == 1 && r[0][3], "the root row is the document, by its title, marked as the page you're on", r);
  expect(JSON.stringify(r.slice(1).map((x) => [x[0], x[2]])) == JSON.stringify([["blog", 2], ["about.html", 2], ["contact.html", 2]]), "its other documents sit under it, folders first; no stylesheet, font or image, nor folders of only those (assets/, fonts/)", r);
  expect(r.find((x) => x[0] == "about.html")?.[1] == "About us", "a page shows by its title, read from the room", r);
  expect(await p.eval<boolean>(`document.getElementById("doc-title").getAttribute("aria-expanded") == "true" && !document.getElementById("pages").hidden`), "the title says it's open");
  expect((await focused(p)) == "index.html", "focus goes to the page you're on");
  ok("the title opens the tree: the document, its pages under it, titles, the page you're on");

  // Open and close a folder: by click, and by key.
  await clickOn(p, row("blog"));
  expect((await paths(p)).join() == "index.html,blog,blog/drafts,blog/index.html,blog/spring-migration.html,about.html,contact.html", "clicking a folder opens it", await paths(p));
  await p.key("ArrowLeft");
  expect(!(await paths(p)).includes("blog/drafts"), "← closes it");
  await p.key("ArrowRight");
  await p.key("ArrowRight");
  expect((await focused(p)) == "blog/drafts", "→ opens it, → again goes into it", await focused(p));
  await p.key("ArrowDown");
  await p.key("ArrowDown");
  expect((await focused(p)) == "blog/spring-migration.html", "↓ moves down");
  await p.key("Home");
  expect((await focused(p)) == "index.html", "Home goes to the first");
  await p.key("End");
  expect((await focused(p)) == "contact.html", "End to the last");
  ok("folders open and close by click and by key; ↑ ↓ ← → Home End move");
  await p.screenshot(join(SHOTS, "tree-editor.png"));

  // New folder, at the top level (the foot), then a document in it (its + menu).
  await clickOn(p, ".et-foot .et-add:nth-child(2)");
  expect((await focused(p)) == "input", "New folder asks for its name, in place");
  await p.type("notes");
  await p.screenshot(join(SHOTS, "tree-new-folder.png"));
  await p.key("Enter");
  await until(async () => (await tree()).includes("notes"), 5000, "the folder is made");
  await until(async () => (await focused(p)) == "notes", 3000, "and is focused");
  await act(p, "notes", "add");
  await menuItem(p, "New page");
  await p.type("Ideas");
  expect(!(await p.eval<string>(`document.getElementById("pages").textContent`)).includes(".html"), "no .html anywhere: they're pages, not files");
  await p.key("Enter");
  await until(async () => (await tree()).includes("notes/ideas.html"), 5000, "the document is made: its name as an address has it, then .html");
  await until(async () => (await rows(p)).some((x) => x[0] == "notes/ideas.html" && x[1] == "Ideas" && x[2] == 3), 3000, "inside the folder, which opened, by its name");
  // A name that's taken, or has a slash, is refused before it goes anywhere.
  await clickOn(p, ".et-foot .et-add:nth-child(1)");
  await p.type("about");
  await p.key("Enter");
  expect(await p.eval<boolean>(`/already a page called “About”/.test(document.querySelector(".et-msg.error")?.textContent ?? "")`), "a taken name says so, in place", await p.eval(`document.querySelector(".et-msg")?.textContent`));
  await p.key("Escape");
  expect(!(await p.eval<boolean>(`!!document.querySelector(".et-input")`)), "Escape drops it", await p.eval(`document.getElementById("pages").hidden`));
  ok("New folder and New page, at the top level and in a folder, named in place; a taken name says so");

  // Rename in place (F2), and the server's own words when it refuses.
  // Clicking a page opens it, at its address in the editor.
  const went: string[] = [];
  p.onEvent("Page.frameNavigated", (e) => { if (!e.frame.parentId) went.push((e.frame.unreachableUrl ?? e.frame.url) + (e.frame.urlFragment ?? "")); });
  await clickOn(p, row("contact.html"));
  await until(async () => wentTo(went, `${address}/contact#edit`), 5000, "clicking a page goes to its address in the editor");
  ok("clicking a page opens it in the editor (its address, then #edit: …/contact#edit)");
  await p.navigate(editor(host.base));
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden`), 20_000, "the editor is back");
  await clickOn(p, "#doc-title");
  await until(() => p.eval<boolean>(`document.querySelectorAll(".et-row[data-path]").length > 3`), 10_000, "the tree shows again");
  expect((await paths(p)).includes("notes/ideas.html"), "folders stay open as they were, for the tab");
  await p.eval(`document.querySelector(${JSON.stringify(row("contact.html"))}).focus(), true`);
  await p.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "F2", code: "F2", windowsVirtualKeyCode: 113 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "F2", code: "F2", windowsVirtualKeyCode: 113 });
  expect(await p.eval<boolean>(`document.activeElement?.value == "Contact"`), "F2 renames in place: its name, readable, no .html", await p.eval(`document.activeElement?.value`));
  await p.eval(`document.activeElement.select(), true`);
  await p.type("write-to-us");
  await p.key("Enter");
  await until(async () => (await tree()).includes("write-to-us.html") && !(await tree()).includes("contact.html"), 5000, "renamed");
  await stub({ fail: "That name is taken by a page another agent just made." });
  await act(p, "about.html", "more");
  await menuItem(p, "Rename page");
  await p.type("-x");
  await p.key("Enter");
  await until(() => p.eval<boolean>(`(document.querySelector(".et-msg.error")?.textContent ?? "").includes("another agent just made")`), 5000, "the server's error, in place");
  await p.key("Escape");
  ok("rename in place (F2, or the menu); the server's refusal shows in its own words");

  // Move to…, and drag and drop.
  await act(p, "write-to-us.html", "more");
  // A document has pages: the tree says "page" for them, never "document", and folders stay folders.
  const menu = await p.eval<string[]>(`[...document.querySelectorAll('.et-menu [role="menuitem"]')].map((b) => b.textContent.trim())`);
  expect(JSON.stringify(menu) == JSON.stringify(["Open in a new tab", "Rename page", "Move page to…", "Delete page"]), "a page's menu says page", menu);
  const words = await p.eval<string>(`document.getElementById("pages").textContent + " " + [...document.querySelectorAll("#pages [aria-label], #pages [placeholder], #pages [title]")].map((e) => (e.getAttribute("aria-label") ?? "") + " " + (e.getAttribute("placeholder") ?? "") + " " + (e.getAttribute("title") ?? "")).join(" ")`);
  expect(words.includes("New page") && !/\bdocuments?\b/i.test(words.replace(/Rename this document, or change its address/g, "")), "the tree says page, not document (only the root row's rename names the document)", words);
  await Bun.sleep(200);
  await p.screenshot(join(SHOTS, "tree-page-menu.png"));
  await menuItem(p, "Move page to…");
  await menuItem(p, "notes");
  await until(async () => (await tree()).includes("notes/write-to-us.html"), 5000, "Move to… moves it into the folder");
  await p.eval(`(() => {
    const from = document.querySelector(${JSON.stringify(row("about.html"))}), to = document.querySelector(${JSON.stringify(row("blog"))});
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    window.__dropShown = to.classList.contains("drop");
    to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    from.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
  })(), true`);
  await until(async () => (await tree()).includes("blog/about.html"), 5000, "dropping it on a folder moves it there");
  await until(() => p.eval<boolean>(`/Moved\. “About us” finds its styles, images and links by where it was/.test(document.querySelector(".et-banner.note")?.textContent ?? "")`), 3000, "a move to another folder warns that its relative links may break");
  await p.screenshot(join(SHOTS, "tree-move-warning.png"));
  expect(await p.eval<boolean>(`window.__dropShown`), "the folder lights up under it");
  ok("Move to… and drag and drop move pages into folders");

  // Delete: a page at once, a folder after asking.
  await act(p, "notes/ideas.html", "more");
  await menuItem(p, "Delete page");
  await until(async () => !(await tree()).includes("notes/ideas.html"), 5000, "a page is deleted");
  await act(p, "notes", "more");
  await menuItem(p, "Delete folder");
  expect(await p.eval<boolean>(`/Delete the folder “notes” and the page in it\\?/.test(document.querySelector(".et-row.confirm")?.textContent ?? "")`), "a folder asks first, in its row", await p.eval(`document.querySelector(".et-row.confirm")?.textContent`));
  await Bun.sleep(200);
  await p.screenshot(join(SHOTS, "tree-delete-folder.png"));
  await p.key("Escape");
  expect((await tree()).includes("notes"), "Escape keeps it");
  await p.eval(`document.querySelector(${JSON.stringify(row("notes"))}).focus(), true`);
  await p.key("Delete");
  await clickOn(p, ".et-row.confirm .et-btn.danger");
  await until(async () => !(await tree()).some((x) => x.startsWith("notes")), 5000, "Delete, confirmed, deletes it and what's in it");
  expect(!(await p.eval<boolean>(`!!document.querySelector('${row("index.html")} [data-act="more"]')`)), "the root document can't be deleted or moved: it has no menu");
  ok("delete: a page at once, a folder after a question in its row; the root document stays");

  // The root row's pencil renames the document (the title and address card).
  await act(p, "index.html", "rename");
  expect(await p.eval<boolean>(`!document.getElementById("naming").hidden && document.getElementById("pages").hidden && document.activeElement.id == "naming-title"`), "the root row's pencil opens the title and address card");
  await p.key("Escape");
  ok("renaming the document: the pencil on its row");

  // Esc closes it; the page under it is tinted (dark on a dark page).
  await clickOn(p, "#doc-title");
  await until(() => p.eval<boolean>(`!document.getElementById("pages").hidden`), 3000, "open again");
  await p.key("Escape");
  expect(await p.eval<boolean>(`document.getElementById("pages").hidden && document.activeElement.id == "doc-title"`), "Escape closes it, back on the title");
  ok("Escape closes it");

  // Live: another tab (or an agent) changes the tree; it follows (a file arriving in the room reads it again).
  await clickOn(p, "#doc-title");
  await stub({ entries: [...(await (await fetch(`${host.root}/api/docs/${id}/tree`)).json()).entries, { path: "faq.html", type: "page" }] });
  await Bun.write(join(dir, "faq.html"), "<!doctype html><title>Questions</title><h1>Questions</h1>");
  await until(async () => (await rows(p)).some((x) => x[0] == "faq.html" && x[1] == "Questions"), 10_000, "a page made elsewhere shows, by its title");
  ok("it follows changes made elsewhere");

  // Read-only.
  await stub({ canEdit: false });
  await p.navigate(editor(host.base));
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden`), 20_000, "the editor is back");
  await clickOn(p, "#doc-title");
  await until(() => p.eval<boolean>(`document.querySelectorAll(".et-row[data-path]").length > 3`), 10_000, "the tree shows");
  expect(await p.eval<boolean>(`!document.querySelector(".et-act, .et-foot:not([hidden]), [draggable=true]")`), "for someone who may only view: no add, rename, move or delete");
  await p.screenshot(join(SHOTS, "tree-readonly.png"));
  await stub({ canEdit: true });
  ok("read-only: no controls");

  // A phone.
  await p.open(editor(host.base), { width: 390, height: 760, scale: 2, clear: false, agent: false });
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden`), 20_000, "the editor, on a phone");
  await clickOn(p, "#doc-title");
  await until(() => p.eval<boolean>(`document.querySelectorAll(".et-row[data-path]").length > 3`), 10_000, "the tree shows");
  const fits = await p.eval<boolean>(`(() => { const r = document.getElementById("pages").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`);
  expect(fits, "on a phone it fits the screen");
  await Bun.sleep(300); // it pops in
  await p.screenshot(join(SHOTS, "tree-phone.png"));
  ok("at phone width");

  // ------------------------------------------------------------ Documents
  await p.open(`${host.root}/docs`, { width: 1100, height: 760, scale: 2, clear: false });
  expect(!(await p.eval<boolean>(`!!window.ergaTree`)), "Documents doesn't load pages-tree.js until asked");
  await clickOn(p, "button.twist");
  await until(() => p.eval<boolean>(`document.querySelectorAll("#pages-${id} .et-row[data-path]").length > 0`), 10_000, "the document's pages show beneath it");
  r = await rows(p);
  expect(r[0][0] == "blog" && r[0][2] == 1 && !r.some((x) => x[0] == "index.html"), "its pages start at the top level: the row above is the document", r);
  expect(await p.eval<boolean>(`document.querySelector("button.twist").getAttribute("aria-expanded") == "true"`), "the chevron says it's open");
  await clickOn(p, ".et-foot .et-add:nth-child(2)");
  await p.type("archive");
  await p.key("Enter");
  await until(async () => (await tree()).includes("archive"), 5000, "a folder made from Documents");
  await p.screenshot(join(SHOTS, "tree-docs.png"));
  await p.open(`${host.root}/docs`, { width: 1100, height: 760, scale: 2, clear: false, dark: true });
  await until(() => p.eval<boolean>(`document.querySelectorAll("#pages-${id} .et-row[data-path]").length > 0`), 10_000, "it stays open for the tab");
  const dark = await p.eval<string>(`getComputedStyle(document.querySelector(".et-row.folder .et-name")).color`);
  expect(dark != "rgb(28, 28, 31)", "dark, it takes the page's dark colours", dark);
  await p.screenshot(join(SHOTS, "tree-docs-dark.png"));
  await clickOn(p, `#pages-${id} ${row("faq.html")}`);
  await until(async () => wentTo(went, `${address}/faq#edit`), 5000, "a page opens in the editor, for an editor");
  ok("Documents: a document's chevron shows its pages beneath it; light, dark; New folder; a page opens");

  expect(!p.errors.length, "no script errors", p.errors);
  console.log(`\nall passing. Screenshots: ${SHOTS}`);
} finally {
  browser.close();
  await host.dispose();
}

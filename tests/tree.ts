#!/usr/bin/env bun
// A document's pages, as a tree (src/page/tree.ts, built as tree.js), in
// headless Chrome, in both places it shows:
//
//   - the editor: the document's title (top left) opens it; the document is
//     its root row, its other pages, folders and files under it; the page
//     you're on is marked; the root row's pencil renames the document;
//   - Documents: each document's chevron opens its pages beneath its row.
//
// And what it does: folders open and close, New document and New folder (at
// the top level and in a folder) name the new one in place (.html added),
// rename in place, Move to… and drag and drop, delete (a folder asks first),
// the server's errors shown in its words, read-only for viewers, the keys,
// light, dark and a phone. tree.js isn't loaded until the tree is opened.
//
// Until task #30's real API lands, the dev server answers it from
// dev/tree-stub.ts (ERGA_TREE_STUB=1). Screenshots land in tests/cdp.ts's SHOTS.
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

try {
  // ------------------------------------------------------------ the editor
  const ctx = await browser.context();
  const p = await browser.page(ctx);
  await p.open(`${host.base}/edit`, { width: 1200, height: 760, scale: 2, agent: false });
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden`), 20_000, "the editor is up with its title");
  expect(!(await p.eval<boolean>(`!!window.ergaTree || !!document.querySelector('script[src="/tree.js"]')`)), "tree.js isn't loaded until it's wanted");
  await clickOn(p, "#doc-title");
  await until(() => p.eval<boolean>(`document.querySelectorAll(".et-row[data-path]").length > 0`), 10_000, "the tree shows");
  let r = await rows(p);
  expect(r[0][0] == "index.html" && r[0][1] == "Field guide" && r[0][2] == 1 && r[0][3], "the root row is the document, by its title, marked as the page you're on", r);
  expect(JSON.stringify(r.slice(1).map((x) => [x[0], x[2]])) == JSON.stringify([["blog", 2], ["about.html", 2], ["contact.html", 2], ["style.css", 2]]), "its other pages sit under it: folders first, then pages, then files", r);
  expect(r.find((x) => x[0] == "about.html")?.[1] == "About us", "a page shows by its title, read from the room", r);
  expect(await p.eval<boolean>(`document.getElementById("doc-title").getAttribute("aria-expanded") == "true" && !document.getElementById("pages").hidden`), "the title says it's open");
  expect((await focused(p)) == "index.html", "focus goes to the page you're on");
  ok("the title opens the tree: the document, its pages under it, titles, the page you're on");

  // Open and close a folder: by click, and by key.
  await clickOn(p, row("blog"));
  expect((await paths(p)).join() == "index.html,blog,blog/drafts,blog/index.html,blog/spring-migration.html,about.html,contact.html,style.css", "clicking a folder opens it", await paths(p));
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
  expect((await focused(p)) == "style.css", "End to the last");
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
  await menuItem(p, "New document");
  await p.type("Ideas");
  expect(await p.eval<boolean>(`document.querySelector(".et-row.editing .et-ext")?.textContent == ".html"`), "a document's name shows .html after it");
  await p.key("Enter");
  await until(async () => (await tree()).includes("notes/Ideas.html"), 5000, "the document is made, .html added");
  await until(async () => (await rows(p)).some((x) => x[0] == "notes/Ideas.html" && x[2] == 3), 3000, "inside the folder, which opened");
  // A name that's taken, or has a slash, is refused before it goes anywhere.
  await clickOn(p, ".et-foot .et-add:nth-child(1)");
  await p.type("about");
  await p.key("Enter");
  expect(await p.eval<boolean>(`/already something called “about.html”/.test(document.querySelector(".et-msg.error")?.textContent ?? "")`), "a taken name says so, in place", await p.eval(`document.querySelector(".et-msg")?.textContent`));
  await p.key("Escape");
  expect(!(await p.eval<boolean>(`!!document.querySelector(".et-input")`)), "Escape drops it", await p.eval(`document.getElementById("pages").hidden`));
  ok("New folder and New document, at the top level and in a folder, named in place; a taken name says so");

  // Rename in place (F2), and the server's own words when it refuses.
  // Clicking a page opens it, at its address in the editor (task #30 serves it; until then the address is what's checked).
  const went: string[] = [];
  p.onEvent("Page.frameNavigated", (e) => { if (!e.frame.parentId) went.push(e.frame.unreachableUrl ?? e.frame.url); });
  await clickOn(p, row("contact.html"));
  await until(async () => went.some((u) => new URL(u).pathname == `${address}/contact/edit`), 5000, "clicking a page goes to its address in the editor");
  ok("clicking a page opens it in the editor (its address: …/contact/edit)");
  await p.navigate(`${host.base}/edit`);
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden`), 20_000, "the editor is back");
  await clickOn(p, "#doc-title");
  await until(() => p.eval<boolean>(`document.querySelectorAll(".et-row[data-path]").length > 3`), 10_000, "the tree shows again");
  expect((await paths(p)).includes("notes/Ideas.html"), "folders stay open as they were, for the tab");
  await p.eval(`document.querySelector(${JSON.stringify(row("contact.html"))}).focus(), true`);
  await p.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "F2", code: "F2", windowsVirtualKeyCode: 113 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "F2", code: "F2", windowsVirtualKeyCode: 113 });
  expect(await p.eval<boolean>(`document.activeElement?.value == "contact"`), "F2 renames in place, the name without .html", await p.eval(`document.activeElement?.value`));
  await p.eval(`document.activeElement.select(), true`);
  await p.type("write-to-us");
  await p.key("Enter");
  await until(async () => (await tree()).includes("write-to-us.html") && !(await tree()).includes("contact.html"), 5000, "renamed");
  await stub({ fail: "That name is taken by a page another agent just made." });
  await act(p, "about.html", "more");
  await menuItem(p, "Rename");
  await p.type("-x");
  await p.key("Enter");
  await until(() => p.eval<boolean>(`(document.querySelector(".et-msg.error")?.textContent ?? "").includes("another agent just made")`), 5000, "the server's error, in place");
  await p.key("Escape");
  ok("rename in place (F2, or the menu); the server's refusal shows in its own words");

  // Move to…, and drag and drop.
  await act(p, "write-to-us.html", "more");
  await menuItem(p, "Move to…");
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
  expect(await p.eval<boolean>(`window.__dropShown`), "the folder lights up under it");
  ok("Move to… and drag and drop move pages into folders");

  // Delete: a page at once, a folder after asking.
  await act(p, "notes/Ideas.html", "more");
  await menuItem(p, "Delete");
  await until(async () => !(await tree()).includes("notes/Ideas.html"), 5000, "a page is deleted");
  await act(p, "notes", "more");
  await menuItem(p, "Delete");
  expect(await p.eval<boolean>(`/Delete “notes” and the item in it\\?/.test(document.querySelector(".et-row.confirm")?.textContent ?? "")`), "a folder asks first, in its row", await p.eval(`document.querySelector(".et-row.confirm")?.textContent`));
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
  await p.navigate(`${host.base}/edit`);
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden`), 20_000, "the editor is back");
  await clickOn(p, "#doc-title");
  await until(() => p.eval<boolean>(`document.querySelectorAll(".et-row[data-path]").length > 3`), 10_000, "the tree shows");
  expect(await p.eval<boolean>(`!document.querySelector(".et-act, .et-foot:not([hidden]), [draggable=true]")`), "for someone who may only view: no add, rename, move or delete");
  await p.screenshot(join(SHOTS, "tree-readonly.png"));
  await stub({ canEdit: true });
  ok("read-only: no controls");

  // A phone.
  await p.open(`${host.base}/edit`, { width: 390, height: 760, scale: 2, clear: false, agent: false });
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
  expect(!(await p.eval<boolean>(`!!window.ergaTree`)), "Documents doesn't load tree.js until asked");
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
  await until(async () => went.some((u) => new URL(u).pathname == `${address}/faq/edit`), 5000, "a page opens in the editor, for an editor");
  ok("Documents: a document's chevron shows its pages beneath it; light, dark; New folder; a page opens");

  expect(!p.errors.length, "no script errors", p.errors);
  console.log(`\nall passing. Screenshots: ${SHOTS}`);
} finally {
  browser.close();
  await host.dispose();
}

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
// rename in place, Move to… and drag and drop (with the warning about relative
// links), delete (a folder asks first), the server's errors shown in its
// words, the keys, light, dark and a phone. The editor and Documents load
// pages-tree.js once they are up; the viewer never does.
//
// All against the real server, on a real document: tests/fixtures/multi, linked
// from disk, so every change lands in its files. Documents, not files: the tree
// never shows its stylesheet, font or image, while agents (the token API) see
// them all. Live: a second tab's changes, an agent's new page and move, and a
// file arriving on disk show in the tree without a reload, in the editor and on
// Documents. A viewer sees it read-only. A document two folders down renders
// with the stylesheet, image and font from the folders above it, in the viewer
// and the editor at its own address. Screenshots land in tests/cdp.ts's SHOTS.
//
//   bun tests/tree.ts
// covers: src/page/tree.ts tree.ts

import { cpSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, type Page, SHOTS, ROOT } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const dir = mkdtempSync(join(tmpdir(), "erga-multi-"));
cpSync(join(ROOT, "tests/fixtures/multi"), dir, { recursive: true });
const host = await startHost(dir);
const browser = await Browser.launch();
const info = (await (await fetch(`${host.base}/api/doc`)).json()) as { docName: { id: string; address: string } };
const id = info.docName.id, address = info.docName.address;
const tree = async () => ((await (await fetch(`${host.root}/api/docs/${id}/tree`)).json()) as { entries: { path: string; type: string }[] }).entries.map((e) => e.path).sort();

// Signed in (locally, /auth/github?as= signs in anyone), and an agent token for the API's tools, as the document's owner.
async function signIn(as: string | null) {
  const r = await fetch(`${host.root}/auth/github?${as ? `as=${as}&` : ""}next=/docs`, { redirect: "manual" });
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="));
  if (!cookie) throw new Error(`signing in: ${r.status}`);
  return cookie;
}
const owner = await signIn(null);
let tokenPage = "";
for (let tries = 0; tries < 5 && !tokenPage.includes('class="secret"'); tries++) {
  if (tries) await Bun.sleep(1000);
  tokenPage = await (await fetch(`${host.root}/tokens/new`, { method: "POST", redirect: "manual", headers: { Cookie: owner, Origin: host.root }, body: new URLSearchParams({ label: "Tree test" }) })).text();
}
const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(tokenPage)?.[1] ?? "";
expect(token, "an agent token", tokenPage.slice(0, 200));
/** One of the agents' tools, over the token API, on this document. */
async function agentTool(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${host.root}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ document: id, ...args }) });
  const body = (await r.json()) as { ok: boolean; content?: { text?: string }[]; error?: string };
  expect(body.ok, `the agent's ${name}`, body);
  return body.content?.map((c) => c.text ?? "").join("\n") ?? "";
}
/** What a person never sees in the tree: a document's stylesheets, scripts, fonts, images and data, and folders of only those. */
const NOT_DOCUMENTS = /\.(css|js|mjs|json|svg|png|jpe?g|gif|webp|woff2?|ttf|otf|txt|csv)$|^(assets|fonts)$/i;

/** The rows the tree shows: [path, label, depth, current]. */
const rows = (p: Page) => p.eval<[string, string, number, boolean][]>(`[...document.querySelectorAll(".et-row[data-path]")].map((r) => [r.dataset.path, r.querySelector(".et-name").textContent, +r.getAttribute("aria-level"), r.getAttribute("aria-current") == "page"])`);
const paths = async (p: Page) => (await rows(p)).map((r) => r[0]);
const centre = async (p: Page, selector: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  expect(r, `${selector} is on the page`);
  return r;
};
const clickOn = async (p: Page, selector: string) => { const r = await centre(p, selector); await p.click(r.x, r.y); };
// The tree draws its rows again after each change, and when the server says the tree changed (a moment later, and
// later still on a busy machine). If that happens between a press and its release, they land on different rows, and
// the browser sends no click. So a click on a row that must open a menu or a page is tried again until it does.
/**
 * A click on a row that leaves the page, until `gone`. No settling after it: Page.click's evaluate fails once the page
 * navigates, as it may at once on a busy machine.
 */
const clickToGo = async (p: Page, selector: string, gone: () => boolean, what: string) => {
  for (let tries = 0; ; tries++) {
    const r = await centre(p, selector);
    await p.mouse("mouseMoved", r.x, r.y);
    await p.mouse("mousePressed", r.x, r.y, { clickCount: 1, buttons: 1 });
    await p.mouse("mouseReleased", r.x, r.y, { clickCount: 1 });
    try { return await until(gone, 2500, what); }
    catch (e) { if (tries == 2) throw e; }
  }
};
const row = (path: string) => `.et-row[data-path="${path}"]`;
/** Hovers a row (its buttons show), then clicks one of them; a menu button until its menu opens. */
const act = async (p: Page, path: string, which: string) => {
  const press = async () => {
    const r = await centre(p, row(path));
    await p.mouse("mouseMoved", r.x, r.y);
    await clickOn(p, `${row(path)} [data-act="${which}"]`);
  };
  if (which == "rename") return press();
  for (let tries = 0; ; tries++) {
    await press();
    try { return await until(() => p.eval<boolean>(`!!document.querySelector(".et-menu")`), 2000, `${which} on ${path} opens its menu`); }
    catch (e) { if (tries == 2) throw e; }
  }
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
  // At its own address, in the viewer and the editor (which resolves its links from its folder).
  const nestedAt = `${host.base}/blog/drafts/owls`;
  expect((await fetch(nestedAt, { redirect: "manual" })).status == 200, "the nested document has an address of its own");
  await p.open(nestedAt, { width: 900, height: 700, clear: false });
  await until(async () => (await p.inPage<boolean>(`!!document.getElementById("owl")`)).some(Boolean), 10_000, "the viewer shows it at its address");
  await until(async () => (await p.inFrames(rendered(`document.querySelector("iframe.on")?.contentDocument`))).some(renderedRight), 10_000, "rendered whole in the viewer at its address");
  await p.screenshot(join(SHOTS, "tree-nested-viewer.png"));
  await Bun.sleep(300);
  expect(!(await p.eval<boolean>(`!!window.ergaTree || !!document.querySelector('script[src="/pages-tree.js"]')`)), "the viewer never loads pages-tree.js");
  await p.open(editor(nestedAt), { width: 900, height: 700, clear: false, agent: false });
  await until(async () => renderedRight(await p.frame(rendered(`document.getElementById("page")?.contentDocument`))), 15_000, "and in the editor, which resolves its links from its folder");
  expect(await p.eval<string>(`window.ergaPage.pagePath`) == "blog/drafts/owls.html", "the editor edits blog/drafts/owls.html");
  await p.screenshot(join(SHOTS, "tree-nested-editor.png"));
  ok("a nested document renders whole (stylesheet, image, font from folders above it): in the viewer's frame, and at its address in the viewer and the editor");

  // ------------------------------------------------------------ the editor
  await p.open(editor(host.base), { width: 1200, height: 760, scale: 2, agent: false });
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden`), 20_000, "the editor is up with its title");
  await until(() => p.eval<boolean>(`!!window.ergaTree && !!document.querySelector("#pages[hidden] #pages-tree .et-row[data-path]")`), 10_000, "the editor loads pages-tree.js once it is up, and mounts the tree, still closed");
  // The page in its frame up as well, editable: on a busy machine it can still be starting, and as it starts it can take
  // the focus (into its frame) from a card opened meanwhile. That race is the editor's, not the tree's: here, wait it out.
  await until(() => p.frame<boolean>(`!!document.getElementById("page")?.contentDocument?.querySelector("[data-erga-id]")`), 20_000, "the page is editable in its frame");
  await clickOn(p, "#doc-title");
  await until(() => p.eval<boolean>(`document.querySelectorAll(".et-row[data-path]").length > 0`), 10_000, "the tree shows");
  let r = await rows(p);
  expect(r[0][0] == "index.html" && r[0][1] == "Field guide" && r[0][2] == 1 && r[0][3], "the root row is the document, by its title, marked as the page you're on", r);
  expect(JSON.stringify(r.slice(1).map((x) => [x[0], x[2]])) == JSON.stringify([["blog", 2], ["about.html", 2], ["contact.html", 2]]), "its other documents sit under it, folders first; no stylesheet, font or image, nor folders of only those (assets/, fonts/)", r);
  // Documents, not files: the server lists every file (agents see them all); the tree shows none of the others.
  const all = await tree();
  expect(["style.css", "assets", "assets/owl.svg", "fonts", "fonts/field.woff2"].every((f) => all.includes(f)), "the server's tree lists every file and folder", all);
  const ls = await agentTool("ls", {}), found = await agentTool("find", { pattern: "**/*" });
  expect(ls.includes("style.css") && ls.includes("assets/") && ls.includes("fonts/") && found.includes("assets/owl.svg") && found.includes("fonts/field.woff2"), "an agent sees them all (ls, find)", { ls, found });
  expect(r.find((x) => x[0] == "about.html")?.[1] == "About us", "a page shows by its title, read from the room", r);
  expect(await p.eval<boolean>(`document.getElementById("doc-title").getAttribute("aria-expanded") == "true" && !document.getElementById("pages").hidden`), "the title says it's open");
  expect((await focused(p)) == "index.html", "focus goes to the page you're on", await p.eval(`(() => { const a = document.activeElement; return { focused: a?.outerHTML.slice(0, 200), path: a?.closest?.("[data-path]")?.dataset.path ?? null }; })()`));
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
  await clickToGo(p, row("contact.html"), () => wentTo(went, `${address}/contact#edit`), "clicking a page goes to its address in the editor");
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
  // The server refuses names the tree lets through (a # in a folder's name): its words show, in place.
  await act(p, "notes", "more");
  await menuItem(p, "Rename folder");
  await p.eval(`document.activeElement.select(), true`);
  await p.type("notes#1");
  await p.key("Enter");
  await until(() => p.eval<boolean>(`/can't contain/.test(document.querySelector(".et-msg.error")?.textContent ?? "")`), 5000, "the server's error, in place", () => p.eval(`document.querySelector(".et-banner, .et-msg")?.textContent`));
  await p.key("Escape");
  expect((await tree()).includes("notes"), "and nothing changed");
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
  expect((await rows(p)).some((x) => x[0] == "blog/about.html" && x[1] == "About us"), "the moved document keeps its title", await rows(p));
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

  // Live: a file arriving on disk, another tab, an agent. The tree follows each without a reload.
  await clickOn(p, "#doc-title");
  await until(() => p.eval<boolean>(`!document.getElementById("pages").hidden`), 3000, "open again");
  await Bun.write(join(dir, "faq.html"), "<!doctype html><title>Questions</title><h1>Questions</h1>");
  await until(async () => (await rows(p)).some((x) => x[0] == "faq.html" && x[1] == "Questions"), 10_000, "a page arriving on disk shows, by its title");
  // A second tab, in the editor too: what it does shows in the first.
  const p2 = await browser.page(ctx);
  await p2.open(editor(host.base), { width: 1000, height: 700, clear: false, agent: false });
  await until(() => p2.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden`), 20_000, "the second tab's editor is up");
  await clickOn(p2, "#doc-title");
  await until(() => p2.eval<boolean>(`document.querySelectorAll(".et-row[data-path]").length > 2`), 10_000, "the second tab's tree shows");
  await clickOn(p2, ".et-foot .et-add:nth-child(1)");
  await p2.type("Field notes");
  await p2.key("Enter");
  await until(async () => (await tree()).includes("field-notes.html"), 5000, "the second tab makes a page");
  await until(async () => (await rows(p)).some((x) => x[0] == "field-notes.html" && x[1] == "Field notes"), 10_000, "the first tab shows it, live");
  await act(p2, "field-notes.html", "more");
  await menuItem(p2, "Move page to…");
  await menuItem(p2, "blog");
  await until(async () => (await rows(p)).some((x) => x[0] == "blog/field-notes.html") && !(await paths(p)).includes("field-notes.html"), 10_000, "a move in the second tab shows in the first", () => paths(p));
  ok("two tabs: a page made and moved in one shows in the other, live");
  // An agent (over the token API) makes a page and moves one: the tree shows both, live, by their titles.
  await agentTool("new_page", { path: "blog/owl-calls" });
  await agentTool("write", { path: "blog/owl-calls.html", content: "<!doctype html><title>Owl calls</title><link rel=stylesheet href=../style.css><h1>Owl calls</h1>" });
  await until(async () => (await rows(p)).some((x) => x[0] == "blog/owl-calls.html" && x[1] == "Owl calls"), 10_000, "an agent's new page shows, by its title", () => rows(p));
  await agentTool("mv", { from: "faq.html", to: "blog/faq.html" });
  await until(async () => (await paths(p)).includes("blog/faq.html") && !(await paths(p)).includes("faq.html"), 10_000, "an agent's move shows", () => paths(p));
  // And an agent making a stylesheet or an image: the server lists it, the tree doesn't.
  await agentTool("write", { path: "blog/blog.css", content: "h1 { letter-spacing: 0.01em; }" });
  await until(async () => (await tree()).includes("blog/blog.css"), 5000, "the agent's stylesheet is there");
  await Bun.sleep(500);
  expect(!(await paths(p)).some((x) => NOT_DOCUMENTS.test(x.split("/").pop()!) || NOT_DOCUMENTS.test(x)), "and the tree still shows only documents and their folders", await paths(p));
  ok("an agent's new page and move show in the tree, live; its stylesheet doesn't");
  // The page you're on, moved in another tab: the editor follows it to its new address, and the tree marks it there.
  await p2.navigate(`${host.base}?pages#edit`);
  await until(() => p2.eval<boolean>(`document.querySelectorAll(".et-row[data-path]").length > 2`), 20_000, "?pages opens the tree straight away");
  await p.navigate(`${host.base}/blog/owl-calls?pages#edit`);
  await until(async () => (await rows(p)).some((x) => x[0] == "blog/owl-calls.html" && x[3]), 20_000, "the tree marks the page you're on, in its folder, which opened");
  await agentTool("mv", { from: "blog/owl-calls.html", to: "owl-calls.html" });
  await until(async () => (await p.eval<string>(`location.pathname + location.hash`).catch(() => "")) == `${address}/owl-calls#edit`, 15_000, "the editor follows its page to its new address");
  await until(async () => (await rows(p).catch(() => [])).some((x) => x[0] == "owl-calls.html" && x[3]), 20_000, "and the tree marks it there");
  p2.close();
  ok("the page you're on, moved elsewhere: the editor and its tree follow it");

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
  await until(() => p.eval<boolean>(`!!window.ergaTree && !document.querySelector(".et")`), 10_000, "Documents loads pages-tree.js once the list is up, and shows no tree until asked");
  const twist = `button.twist[data-id="${id}"]`, sub = `#pages-${id}`;
  await clickOn(p, twist);
  await until(() => p.eval<boolean>(`document.querySelectorAll("${sub} .et-row[data-path]").length > 0`), 10_000, "the document's pages show beneath it");
  r = await rows(p);
  expect(r[0][0] == "blog" && r[0][2] == 1 && !r.some((x) => x[0] == "index.html"), "its pages start at the top level: the row above is the document", r);
  expect(!r.some((x) => NOT_DOCUMENTS.test(x[0])), "documents and their folders only, here too", r);
  expect(r.find((x) => x[0] == "owl-calls.html")?.[1] == "Owl calls", "a page shows by its title, as the server gives it", r);
  expect(await p.eval<boolean>(`document.querySelector(${JSON.stringify(twist)}).getAttribute("aria-expanded") == "true"`), "the chevron says it's open");
  // New folder, New document, rename, move (it always warns here: Documents can't read the page's links), delete.
  await clickOn(p, `${sub} .et-foot .et-add:nth-child(2)`);
  await p.type("archive");
  await p.key("Enter");
  await until(async () => (await tree()).includes("archive"), 5000, "a folder made from Documents");
  await clickOn(p, `${sub} .et-foot .et-add:nth-child(1)`);
  await p.type("Old news");
  await p.key("Enter");
  await until(async () => (await tree()).includes("old-news.html"), 5000, "a page made from Documents");
  await until(async () => (await rows(p)).some((x) => x[0] == "old-news.html"), 3000, "it shows");
  await act(p, "old-news.html", "more");
  await menuItem(p, "Rename page");
  await p.eval(`document.activeElement.select(), true`);
  await p.type("Older news");
  await p.key("Enter");
  await until(async () => (await tree()).includes("older-news.html") && !(await tree()).includes("old-news.html"), 5000, "renamed from Documents");
  await until(async () => (await rows(p)).some((x) => x[0] == "older-news.html"), 3000, "it shows renamed");
  await act(p, "older-news.html", "more");
  await menuItem(p, "Move page to…");
  await menuItem(p, "archive");
  await until(async () => (await tree()).includes("archive/older-news.html"), 5000, "moved from Documents");
  await until(() => p.eval<boolean>(`/Moved\. .* finds its styles, images and links by where it was/.test(document.querySelector("${sub} .et-banner.note")?.textContent ?? "")`), 3000, "with the warning about its relative links");
  await p.screenshot(join(SHOTS, "tree-docs.png"));
  await act(p, "archive", "more");
  await menuItem(p, "Delete folder");
  await clickOn(p, `${sub} .et-row.confirm .et-btn.danger`);
  await until(async () => !(await tree()).some((x) => x.startsWith("archive")), 5000, "a folder deleted from Documents, with what's in it");
  // Live here too: an agent's new page shows without a reload.
  await agentTool("new_page", { path: "colophon" });
  await until(async () => (await rows(p)).some((x) => x[0] == "colophon.html"), 15_000, "an agent's new page shows on Documents, without a reload", () => rows(p));
  await agentTool("rm", { path: "colophon.html" });
  await until(async () => !(await rows(p)).some((x) => x[0] == "colophon.html"), 15_000, "and goes when the agent deletes it");
  await p.open(`${host.root}/docs`, { width: 1100, height: 760, scale: 2, clear: false, dark: true });
  await until(() => p.eval<boolean>(`document.querySelectorAll("${sub} .et-row[data-path]").length > 0`), 10_000, "it stays open for the tab");
  // Fast: closed and opened again, its pages are there at once; on the next visit too (each tree's last answer is kept for
  // the tab), and the area under the row shows at once in any case.
  const reopen = `(async () => { const b = document.querySelector(${JSON.stringify(twist)}); b.click(); await new Promise((r) => setTimeout(r, 0));
    return { box: !!document.querySelector("${sub}:not([hidden])"), rows: document.querySelectorAll("${sub} .et-row[data-path]").length }; })()`;
  await clickOn(p, twist);
  expect(await p.eval<boolean>(`document.querySelector("${sub}").hidden`), "the chevron closes it");
  let again = await p.eval<{ box: boolean; rows: number }>(reopen);
  expect(again.box && again.rows > 0, "opened again, its pages show at once", again);
  await p.eval(`sessionStorage.removeItem("erga:docs-open"), true`);
  await p.navigate(`${host.root}/docs`);
  await until(() => p.eval<boolean>(`!!window.ergaTree`), 10_000, "the tree's script loads once the list is up");
  again = await p.eval<{ box: boolean; rows: number }>(reopen);
  expect(again.box && again.rows > 0, "on the next visit, its pages show at once too", again);
  ok("Documents: a document's pages show at once when opened again, and on the next visit");
  const dark = await p.eval<string>(`getComputedStyle(document.querySelector(".et-row.folder .et-name")).color`);
  expect(dark != "rgb(28, 28, 31)", "dark, it takes the page's dark colours", dark);
  await p.screenshot(join(SHOTS, "tree-docs-dark.png"));
  await clickToGo(p, `${sub} ${row("owl-calls.html")}`, () => wentTo(went, `${address}/owl-calls#edit`), "a page opens in the editor, for an editor");
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready")`).catch(() => false), 20_000, "the editor is up");
  ok("Documents: a document's chevron shows its pages beneath it; New folder and New page, rename, move (with the warning), delete; live; light, dark; a page opens");

  // ------------------------------------------------------------ a viewer
  // Ada may only view it: on Documents and in the editor, the tree has no controls, and its pages open in the viewer.
  // (A document linked from disk starts shared with anyone signed in, to edit: that goes first.)
  const share = (login: string, role: string) => fetch(`${host.root}/docs/share`, { method: "POST", redirect: "manual", headers: { Cookie: owner, Origin: host.root }, body: new URLSearchParams({ id, login, role }) });
  expect((await share("*", "none")).ok && (await share("ada", "viewer")).ok, "shared with Ada, to view, and nobody else");
  const ada = await signIn("ada");
  const adaTree = (await (await fetch(`${host.root}/api/docs/${id}/tree`, { headers: { Cookie: ada } })).json()) as { canEdit: boolean };
  expect(adaTree.canEdit === false, "the server tells Ada she can't change it", adaTree);
  const adaCtx = await browser.context();
  const v = await browser.page(adaCtx);
  await v.open(`${host.root}/auth/github?as=ada&next=/docs`, { width: 1100, height: 760, scale: 2 });
  await until(() => v.eval<boolean>(`!!document.querySelector(${JSON.stringify(twist)})`), 10_000, "Ada's Documents lists the document", () => v.eval("location.href"));
  await clickOn(v, twist);
  await until(() => v.eval<boolean>(`document.querySelectorAll("${sub} .et-row[data-path]").length > 1`), 10_000, "Ada sees its pages");
  expect(await v.eval<boolean>(`!document.querySelector("${sub} .et-act, ${sub} .et-foot:not([hidden]), ${sub} [draggable=true]")`), "for someone who may only view: no add, rename, move or delete");
  expect(await v.eval<boolean>(`document.querySelector(${JSON.stringify(`${sub} ${row("owl-calls.html")} a`)}).getAttribute("href").endsWith("/owl-calls")`), "and its pages open in the viewer (no #edit)");
  await v.screenshot(join(SHOTS, "tree-readonly.png"));
  await v.eval(`(() => { const r = document.querySelector(${JSON.stringify(sub + " " + row("owl-calls.html"))}); r.focus(); r.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); r.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })); })(), true`);
  await Bun.sleep(300);
  expect((await tree()).includes("owl-calls.html") && !(await v.eval<boolean>(`!!document.querySelector(".et-input, .et-row.confirm")`)), "Delete and F2 do nothing for a viewer");
  ok("a viewer sees the tree read-only: no controls, no keys that change it, pages open in the viewer");

  expect(!p.errors.length, "no script errors", p.errors);
  console.log(`\nall passing. Screenshots: ${SHOTS}`);
} finally {
  browser.close();
  await host.dispose();
}

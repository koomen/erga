#!/usr/bin/env bun
// The front page is a document like any other (the landing_document
// setting), and the server makes it itself (front.ts, seedLanding): on a
// fresh database, the first request for / makes it from the repo's
// landing/ (built into the Worker), with no deploy step.
//
//   - On a fresh dev server, the first requests for /, all at once, make one
//     landing document, DEV_LOGIN's /tester/landing, and / shows it in a
//     frame on the document's own pages origin, with Edit and Clone; the
//     other bootstrap admins may edit it too; /new?from=landing copies it.
//   - Its owner edits it in the editor (headless Chrome), and / shows the edit.
//   - Someone who isn't an admin sees it without Edit.
//   - Deleted, the next / makes it again from landing/.
//   - A document an admin chooses is the front page, and nothing is made.
//
// Screenshots of / and the editor land in tests/cdp.ts's SHOTS.
//
//   bun tests/landing.ts

import { readFileSync } from "fs";
import { join } from "path";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { F, frameAt } from "./tab";
import { expect, until } from "./suite/harness";

const ROOT = new URL("../", import.meta.url).pathname;
const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };
const landingHtml = readFileSync(join(ROOT, "landing/index.html"), "utf8");

const host = await startHost(null);
const root = host.root;
const browser = await Browser.launch();
const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });
/** The id of the document / frames, from its pages origin. */
const frameOf = (html: string) => /<iframe id="frame" class="erga-view" (?:data-)?src="http:\/\/([a-z0-9]{8})-([a-z0-9-]+)\.localhost/.exec(html);
const landingSetting = async () => (await (await get("/admin")).text()).match(/data-key="landing_document"[\s\S]*?name="value"[^>]*value="([^"]*)"/)?.[1] ?? "";
try {
  // A fresh database: nothing's set, and the first requests for /, at once, make one document.
  const fronts = await Promise.all(Array.from({ length: 8 }, () => get("/").then((r) => r.text())));
  const ids = new Set(fronts.map((f) => frameOf(f)?.[1]));
  expect(ids.size == 1 && !ids.has(undefined), "concurrent first requests for / all show one document", [...ids]);
  const front = fronts[0];
  const id = frameOf(front)![1];
  expect(frameOf(front)![2] == "tester", "DEV_LOGIN's document", front.slice(0, 800));
  const list = await (await get("/docs")).text();
  expect((list.match(/href="\/tester\/landing(-\d+)?\#edit"/g) ?? []).length == 1, "one landing document in its owner's list", list.slice(0, 2000));
  expect(front.includes("<title>Erga</title>") && front.includes('href="/new?from=landing"') && front.includes('href="/tester/landing#edit"'), "titled by it, with Clone and, for its editor, Edit", front.slice(0, 1500));
  expect((await (await get(`/d/${id}/doc/index.html`)).text()) == landingHtml, "the repo's landing/index.html");
  expect((await landingSetting()) == "/tester/landing", "landing_document names it", await landingSetting());
  const shared = await (await get(`/docs/share?id=${id}`)).json() as { permissions: { login: string; role: string }[] };
  expect(shared.permissions.some((p) => p.login == "koomen" && p.role == "editor"), "the other bootstrap admins may edit it", shared);
  ok("on a fresh server, the first / (eight at once) makes one landing document, /tester/landing, from landing/");

  // In a real browser: the front page shows the document, with Edit and Clone over it.
  const p = await browser.page(await browser.context());
  await p.open(`${root}/`, { width: 1200, height: 800, scale: 2 });
  await until(async () => (await p.inPage<string>(`document.querySelector("h1")?.textContent ?? ""`)).some((t) => t == "Erga"), 15_000, "the landing page renders in its frame");
  expect(await p.eval<boolean>(`!!document.querySelector("a.erga-clone-button[href='/new?from=landing']") && !!document.querySelector("a.erga-edit-button[href='/tester/landing#edit']")`), "with Edit and Clone over it");
  await p.screenshot(join(SHOTS, "landing-front.png"));
  ok("in headless Chrome, / renders the landing document with Edit and Clone");

  // Its owner edits it in the editor, and / shows the edit.
  await p.open(`${root}/tester/landing#edit`, { width: 1200, height: 800, scale: 2, clear: false, agent: false });
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready")`), 20_000, "the editor is ready");
  await until(() => p.frame<boolean>(`${F}.querySelector("h1")?.getAttribute("contenteditable") == "true"`), 20_000, "the editor makes the heading editable");
  const f = await frameAt(p);
  const at = await p.frame<{ x: number; y: number }>(`(() => { const r = ${F}.querySelector("h1").getBoundingClientRect(); return { x: ${f.x} + r.right - 2, y: ${f.y} + r.top + r.height / 2 }; })()`);
  await p.click(at.x, at.y);
  await Bun.sleep(100);
  await p.type(" home");
  await until(async () => (await (await get(`/d/${id}/doc/index.html`)).text()).includes("<h1>Erga home</h1>"), 10_000, "the edit is saved");
  await p.screenshot(join(SHOTS, "landing-editor.png"));
  let after = "";
  await until(async () => (after = await (await get("/")).text()).includes("<title>Erga home</title>"), 10_000, "/ follows the edit", () => after.slice(0, 600));
  expect(frameOf(after)?.[1] == id, "the same document");
  ok("its owner edits it in the editor, and / shows the edit");

  // Someone who isn't an admin sees it, without Edit.
  const ada = await (await get("/?user=Ada")).text();
  expect(frameOf(ada)?.[1] == id && !ada.includes("erga-edit-button") && ada.includes("erga-clone-button"), "Ada sees it with Clone, without Edit", ada.slice(0, 1500));
  ok("someone who isn't an admin sees it, without Edit");

  // Clone makes your own copy of it.
  const made = await get("/new?from=landing");
  const to = made.headers.get("location") ?? "";
  expect(made.status == 302 && to.startsWith("/tester/") && to.endsWith("#edit"), "/new?from=landing makes a document, and opens its editor", { status: made.status, to });
  ok("/new?from=landing copies it");

  // Deleted, the next / makes it again from landing/.
  const del = await get("/docs/delete", { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ id }) });
  expect(del.status == 303, "its owner deletes it", del.status);
  const again = await (await get("/")).text();
  const id2 = frameOf(again)?.[1];
  expect(id2 && id2 != id && again.includes('href="/tester/landing#edit"'), "/ makes a new one at /tester/landing", again.slice(0, 800));
  expect((await (await get(`/d/${id2}/doc/index.html`)).text()) == landingHtml, "a fresh copy of landing/");
  ok("deleted, the landing document is made again on the next /");

  // An admin's choice: one of their documents is the front page, and nothing is made.
  const mine = await (await get("/new")).headers.get("location")!;
  const mineId = ((await (await get(`${mine.replace(/#edit$/, "")}/api/name`)).json()) as { id: string }).id;
  const set = await get("/admin/settings", { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "landing_document", value: JSON.stringify(mine.replace(/#edit$/, "")) }) });
  expect(set.ok, "the admin sets landing_document to one of theirs", await set.text());
  const chosen = await (await get("/")).text();
  expect(frameOf(chosen)?.[1] == mineId, "/ shows the admin's choice", chosen.slice(0, 800));
  const docsNow = await (await get("/docs")).text();
  expect((docsNow.match(/href="\/tester\/landing(-\d+)?\#edit"/g) ?? []).length == 1, "and nothing more is made", docsNow.slice(0, 2000));
  ok("a landing document an admin chose is respected");
} finally {
  browser.close();
  await host.dispose();
}
console.log(`\n${checks.length} checks passed (screenshots in ${SHOTS})`);

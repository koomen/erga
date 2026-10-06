#!/usr/bin/env bun
// The factory board's cards on /admin/factory, compact: a board of fixture tasks (the page's
// /api/factory requests answered over DevTools, so no VM runs), in headless Chrome.
//
//   bun tests/factory-cards.ts [--html FILE]
//
// - A long title stays on one line, cut with an ellipsis; the full title is its tooltip.
// - No branch name on a card (the detail still has it).
// - The last update is a short time on the title's line ("5m"), its date in a tooltip.
// - A plain card (no thumbnails, no error) is at most two lines of text and a row of buttons.
// - The thumbnails stay.
// - Every card has Preview, Start, Restart, Discard and Merge, in that order, on one row; the ones that don't apply
//   are off (a dashed border), with a tooltip that says why.
// - Each column is in id order, oldest first, so a card moves only when its status changes.
// - The detail view shows the screenshots first, three in a row; a click enlarges one to the modal's width, a
//   second click puts it back (factory-detail-shots.png, factory-detail-shot-big.png).
// - The left and right arrow keys go to the previous and next screenshot, around at the ends: along the grid (the
//   focus moves; Enter enlarges) and in the enlarged view (factory-detail-shot-keys.png). Escape shrinks it and
//   leaves the view open. In the instructions the arrows move the cursor.
// - Live updates of the open task don't disturb what the user does in its detail view: the instructions keep
//   the focus, the cursor, the selection and the text typed while the updates arrive; a dependency's kind keeps
//   its choice (factory-detail-typing.png).
// Screenshots land in tests/cdp.ts's SHOTS (factory-cards.png, factory-cards-dark.png). --html saves the board as one
// static page (styles and images inlined, no scripts), to look at without a server.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const slug = (id: number, title: string) => `task/${id}-` + title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const shot = (file: string) => ({ file, caption: file, at: ago(3) });
let n = 0;
const t = (title: string, status: string, min: number, log: string, extra: Record<string, unknown> = {}) => {
  const id = ++n;
  return { id, title, description: "The ask.", status, branch: slug(id, title), base: "0123456789abcdef", log: [{ at: ago(min), message: log }], screenshots: [],
    updatedAt: ago(min), createdAt: ago(min + 30), url: null, error: null, vm: status == "queued" ? null : "vm-" + id, startAfter: [], mergeAfter: [], ...extra };
};
const tasks = [
  t("Say hello on the front page", "merged", 300, "merged", { mergedAt: ago(290), mergeCommit: "fedcba9876543210" }),
  t("Builder: concurrent builds don't collide", "merged", 30, "merged", { mergedAt: ago(25), mergeCommit: "fedcba9876543211" }),
  t("Make factory task cards on /admin/factory more compact and easier to scan", "working", 2, "Reading the code"),
  t("Tests run in the factory VM without lsof", "working", 12, "Running tests/factory.ts under a time limit of 180 seconds"),
  t("Dark mode for the outline panel", "failed", 45, "failed", { error: "The build failed: src/page/outline.ts(12,3): Property 'x' does not exist." }),
  t("Show word counts in the document list, with a total for each folder", "complete", 70, "ready to merge", { url: "http://localhost:4400/", screenshots: [shot("a.png"), shot("b.png"), shot("c.png"), shot("d.png")] }),
  t("Faster first paint on the reader page", "complete", 8, "ready to merge", { url: "http://localhost:4401/", blockedBy: { start: [], merge: [3], stuck: [], reason: ["merges after #3"] } }),
  t("Keyboard shortcuts help dialog", "queued", 1, "queued"),
  t("Export a document as EPUB, with the cover image and the table of contents", "queued", 4, "queued", { startAfter: [6], blockedBy: { start: [6], merge: [], stuck: [], reason: ["waits for #6 to merge"] } }),
  t("Resolve the merge with staging", "needs agent", 3, "Merging origin/staging into the branch", { error: "conflicts merging origin/staging: README.md" }),
];
const info = { enabled: true, vms: { runner: "sim" }, claude: { signedIn: true, canStore: true } };
// The events: none, until the typing test sends task #6's updates, one each time the page reconnects (every 150 ms).
let updates = 0, sending = false;
const update = () => {
  const task = tasks[5];
  task.log.push({ at: new Date().toISOString(), message: "update " + ++updates });
  task.updatedAt = new Date().toISOString();
  return "retry: 150\n\ndata: " + JSON.stringify({ type: "task", task }) + "\n\n";
};
const host = await startHost(null);
const browser = await Browser.launch();
try {
  const p = await browser.page(await browser.context());
  // The thumbnails' image: a small page, as a task's screenshot would show one.
  await p.open(`data:text/html,<body style="margin:0;padding:24px;font:32px sans-serif;background:linear-gradient(135deg,%23dfe9f5,%23f7efe3)"><h1>Preview</h1><p>A page of the task.</p></body>`, { width: 480, height: 300 });
  const png = Buffer.from((await p.send("Page.captureScreenshot", { format: "png" })).data, "base64");
  // The detail view's screenshots: each its own page, so the grid shows which is which.
  const pngs: Record<string, Buffer> = {};
  for (const [i, f] of ["a", "b", "c", "d"].entries()) {
    await p.open(`data:text/html,<body style="margin:0;padding:24px;font:32px sans-serif;background:hsl(${i * 70 + 200},45%,88%)"><h1>Screenshot ${f.toUpperCase()}</h1><p>A page of the task, step ${i + 1}.</p></body>`, { width: 800, height: 500 });
    pngs[f + ".png"] = Buffer.from((await p.send("Page.captureScreenshot", { format: "png" })).data, "base64");
  }
  await p.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/factory*" }] });
  p.onEvent("Fetch.requestPaused", ({ requestId, request }) => {
    const path = new URL(request.url).pathname.replace(/^\/api\/factory/, "");
    const reply = (body: string | Uint8Array, type: string) => p.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(body).toString("base64") }).catch(() => {});
    if (path == "/events") reply(sending ? update() : "retry: 150\n\n", "text/event-stream");
    else if (path.startsWith("/shots/")) reply(pngs[path.slice(7)] ?? png, "image/png");
    else if (path == "/tasks") reply(JSON.stringify(tasks), "application/json");
    else if (path == "") reply(JSON.stringify(info), "application/json");
    else p.send("Fetch.continueRequest", { requestId }).catch(() => {});
  });
  for (const dark of [false, true]) {
    await p.open(`${host.root}/admin/factory`, { width: 1400, height: 900, scale: 2, dark });
    const deadline = Date.now() + 15_000;
    while (!(await p.eval(`document.querySelectorAll("#board .card").length`)) && Date.now() < deadline) await Bun.sleep(50);
    await p.eval(`document.getElementById("tasks").scrollIntoView()`);
    await Bun.sleep(300);
    await p.screenshot(join(SHOTS, dark ? "factory-cards-dark.png" : "factory-cards.png"));
    // An off Merge reads as off, as the other off buttons do: the same faint text, in light and dark.
    const [merge, start] = await p.eval<string[]>(`["merge", "start"].map((k) => getComputedStyle(document.querySelector("[data-open='3'] [data-btn='" + k + "']")).color)`);
    expect(merge == start, `an off Merge has the off text (${dark ? "dark" : "light"})`, { merge, start });
  }
  const cards = await p.eval<{ id: number; text: string; titleLines: number; titleTip: string; titleCut: boolean; time: string; timeTip: string; height: number; thumbs: number; lineH: number }[]>(`[...document.querySelectorAll("#board .card")].map((c) => {
    const title = c.querySelector(".title"), time = c.querySelector(".when");
    const lineH = parseFloat(getComputedStyle(title).lineHeight) || title.getBoundingClientRect().height;
    return { id: Number(c.dataset.open), text: c.innerText, titleLines: Math.round(title.getBoundingClientRect().height / lineH), titleTip: title.title, titleCut: title.scrollWidth > title.clientWidth,
      time: time?.textContent ?? "", timeTip: time?.title ?? "", height: c.getBoundingClientRect().height, thumbs: c.querySelectorAll(".thumbs img").length, lineH };
  })`);
  // Merged tasks leave the board; every other task has a card.
  expect(cards.length == tasks.filter((x) => x.status != "merged").length, "every task on the board has a card", cards.length);
  const card = (id: number) => cards.find((c) => c.id == id)!;
  const long = card(3);
  expect(long.titleLines == 1 && long.titleCut, "a long title stays on one line, cut", long);
  expect(long.titleTip == tasks[2].title, "its full title is the tooltip", long.titleTip);
  ok("a long title: one line with an ellipsis, the full title in a tooltip");
  for (const c of cards) expect(!c.text.includes("task/"), "no branch name on a card", c.text);
  ok("no branch names on the cards");
  expect(card(3).time == "2m" && card(4).time == "12m" && card(5).time == "45m" && /\d/.test(card(5).timeTip), "the last update: a short time, its date in a tooltip", cards.map((c) => [c.time, c.timeTip]));
  ok("the last update is a short time on the title's line");
  const plain = card(4);
  // The title's line, the last update's line, and the buttons: about 70px at 12-14px type.
  expect(plain.height <= 80, "a plain card is short", plain.height);
  ok(`a plain card is ${Math.round(plain.height)}px high`);
  // Every card: the same five buttons, in one order, on one row inside the card, Merge on the right. The ones that don't
  // apply are off, with a tooltip that says why.
  const rows = await p.eval<{ id: number; keys: string[]; oneRow: boolean; inside: boolean; mergeRight: boolean; on: string[]; offUntitled: string[] }[]>(`[...document.querySelectorAll("#board .card")].map((c) => {
    const bs = [...c.querySelectorAll(".actions > *")], box = c.getBoundingClientRect(), r = bs.map((e) => e.getBoundingClientRect());
    const merge = r.at(-1), pad = parseFloat(getComputedStyle(c).paddingRight);
    return { id: Number(c.dataset.open), keys: bs.map((e) => e.dataset.btn), oneRow: r.every((x) => Math.abs(x.top - r[0].top) < 1), inside: r.every((x) => x.left >= box.left && x.right <= box.right),
      mergeRight: Math.abs(box.right - pad - 1 - merge.right) < 3 || Math.abs(box.right - pad - merge.right) < 3,
      on: bs.filter((e) => !e.disabled).map((e) => e.dataset.btn), offUntitled: bs.filter((e) => e.disabled && !e.title).map((e) => e.dataset.btn) };
  })`);
  for (const r of rows) {
    expect(r.keys.join() == "preview,start,restart,discard,merge", "the five buttons, in order", r);
    expect(r.oneRow && r.inside, "they fit on one row, inside the card", r);
    expect(r.mergeRight, "Merge is on the right", r);
    expect(!r.offUntitled.length, "an off button says why", r);
  }
  ok("every card: Preview, Start, Restart, Discard, Merge, on one row, Merge on the right; an off button says why");
  const enabled = (id: number) => rows.find((r) => r.id == id)!.on.join();
  expect(enabled(3) == "discard" && enabled(4) == "discard", "a working task: only Discard", rows);
  expect(enabled(5) == "restart,discard", "a failed task: Restart and Discard", enabled(5));
  expect(enabled(6) == "preview,restart,discard,merge", "a task ready to merge: all but Start", enabled(6));
  expect(enabled(7) == "preview,restart,discard", "a ready task whose Merge waits for #3: Merge off", enabled(7));
  expect(enabled(8) == "start,discard" && enabled(9) == "discard", "queued: Start, unless it waits for another task", [enabled(8), enabled(9)]);
  expect(enabled(10) == "discard", "needs agent: only Discard", enabled(10));
  ok("the buttons that work: only Discard while working; Restart once failed or ready; Merge when it can merge");
  const offLook = await p.eval<{ border: string; cursor: string }>(`(() => { const s = getComputedStyle(document.querySelector("[data-open='3'] [data-btn='merge']")); return { border: s.borderStyle, cursor: s.cursor }; })()`);
  expect(offLook.border == "dashed" && offLook.cursor == "not-allowed", "an off button looks off", offLook);
  ok("an off button looks off: a dashed border, no fill");
  // Discard's text is black (the page's ink), not red; in light mode at least.
  await p.open(`${host.root}/admin/factory`, { width: 1400, height: 900 });
  for (const end = Date.now() + 15_000; !(await p.eval(`document.querySelectorAll("#board .card").length`)) && Date.now() < end;) await Bun.sleep(50);
  const discard = await p.eval<string>(`getComputedStyle(document.querySelector("[data-open='5'] [data-act='arm']")).color`);
  expect(discard == "rgb(13, 13, 15)", "Discard's text is black", discard);
  ok("Discard's text is black");
  expect(card(6).thumbs == 3, "the thumbnails stay (the last three)", card(6));
  ok("the thumbnails stay");
  // Each column in id order (oldest first), not by last update: #7 updated after #6, yet stays below it.
  const order = await p.eval<number[][]>(`[...document.querySelectorAll("#board .col")].map((c) => [...c.querySelectorAll(".card")].map((e) => Number(e.dataset.open)))`);
  for (const ids of order) expect(ids.every((id, i) => !i || ids[i - 1] < id), "each column is in id order", order);
  ok("each column is in id order, oldest first");
  // The detail view: the screenshots first, three in a row, a click to enlarge one and a click to put it back.
  await p.eval(`document.querySelector("#board .card[data-open='6']").click()`);
  await Bun.sleep(300);
  const detail = () => p.eval<{ first: string; boxes: { x: number; y: number; w: number; h: number; big: boolean }[]; dlgW: number; dlgH: number }>(`(() => {
    const d = document.getElementById("dlg"), r = d.getBoundingClientRect();
    return { first: d.querySelector(".dlg section h4")?.textContent, dlgW: r.width, dlgH: r.height,
      boxes: [...d.querySelectorAll(".shots figure")].map((f) => { const b = f.querySelector("img").getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, big: f.classList.contains("big") }; }) };
  })()`);
  let d = await detail();
  expect(d.first == "Screenshots", "the screenshots are the detail view's first section", d.first);
  expect(d.boxes.length == 4 && d.boxes[0].y == d.boxes[1].y && d.boxes[1].y == d.boxes[2].y && d.boxes[3].y > d.boxes[0].y && Math.abs(d.boxes[3].x - d.boxes[0].x) < 1, "three screenshots in a row, the fourth on the next row", d.boxes);
  ok("the detail view: the screenshots first, three in a row");
  await p.screenshot(join(SHOTS, "factory-detail-shots.png"));
  await p.eval(`document.querySelectorAll("#dlg .shots figure img")[1].click()`);
  await Bun.sleep(300);
  d = await detail();
  const big = d.boxes.find((b) => b.big);
  expect(d.boxes[1].big && d.boxes.filter((b) => b.big).length == 1, "a click enlarges that screenshot", d.boxes);
  expect(big && big.w > d.dlgW - 60 && big.h > d.dlgH / 2, "the enlarged screenshot fills the modal's width", { big, w: d.dlgW, h: d.dlgH });
  ok(`a click enlarges a screenshot: ${Math.round(big!.w)}x${Math.round(big!.h)}px in a ${Math.round(d.dlgW)}px modal`);
  await p.screenshot(join(SHOTS, "factory-detail-shot-big.png"));
  // A live update redraws the view; the screenshot stays enlarged.
  await p.eval(`window.ergaBoard.open(6)`);
  expect((await detail()).boxes[1].big, "a redraw keeps the screenshot enlarged");
  await p.eval(`document.querySelector("#dlg .shots figure.big img").click()`);
  await Bun.sleep(300);
  d = await detail();
  expect(d.boxes.every((b) => !b.big) && d.boxes[0].y == d.boxes[2].y, "a second click puts it back in the grid", d.boxes);
  ok("a second click shrinks it back into the grid");
  // The arrow keys: along the grid (the focus moves), around at the ends; in the enlarged view, the enlarged one
  // changes; Escape shrinks it and leaves the view open; in the instructions they move the cursor.
  const state = () => p.eval<{ focus: string | null; big: string | null; open: boolean }>(`({ focus: document.activeElement.dataset?.file ?? null,
    big: document.querySelector("#dlg .shots figure.big")?.dataset.file ?? null, open: document.getElementById("dlg").open })`);
  const keys = async (...ks: string[]) => { for (const k of ks) await p.key(k); await Bun.sleep(50); return state(); };
  let s = await keys("ArrowRight");
  expect(s.focus == "a.png" && !s.big, "Right goes to the first screenshot", s);
  s = await keys("ArrowRight", "ArrowRight", "ArrowRight");
  expect(s.focus == "d.png" && !s.big, "Right moves along the grid", s);
  s = await keys("ArrowRight");
  expect(s.focus == "a.png", "Right goes around from the last to the first", s);
  s = await keys("ArrowLeft");
  expect(s.focus == "d.png", "Left goes around from the first to the last", s);
  ok("the arrow keys move along the screenshots, around at the ends");
  s = await keys("Enter");
  expect(s.big == "d.png" && s.focus == "d.png", "Enter enlarges the screenshot with the focus", s);
  s = await keys("ArrowRight");
  expect(s.big == "a.png" && s.focus == "a.png", "Right in the enlarged view goes around to the first", s);
  s = await keys("ArrowRight");
  expect(s.big == "b.png", "Right enlarges the next one", s);
  await p.screenshot(join(SHOTS, "factory-detail-shot-keys.png"));
  s = await keys("ArrowLeft", "ArrowLeft");
  expect(s.big == "d.png", "Left goes around to the last", s);
  ok("the arrow keys change the enlarged screenshot, around at the ends");
  s = await keys("Escape");
  expect(s.open && !s.big && s.focus == "d.png", "Escape shrinks it, and the detail view stays open", s);
  ok("Escape shrinks the enlarged screenshot");
  await p.eval(`(() => { const t = document.getElementById("instructions"); t.value = "abc"; t.focus(); t.setSelectionRange(3, 3); })()`);
  await keys("ArrowLeft", "ArrowLeft");
  const caret = await p.eval<{ focus: string; at: number; big: boolean }>(`({ focus: document.activeElement.id, at: document.getElementById("instructions").selectionStart, big: !!document.querySelector("#dlg .shots figure.big") })`);
  expect(caret.focus == "instructions" && caret.at == 1 && !caret.big, "in the instructions, the arrows move the cursor", caret);
  await p.eval(`document.getElementById("instructions").value = ""`);
  ok("in the instructions, the arrow keys move the cursor, not the screenshots");
  // Typing in the instructions while live updates of the task arrive: the focus, the cursor, the selection and
  // the text stay, and what is typed next lands where the cursor is.
  const box = await p.eval<{ x: number; y: number }>(`(() => { const t = document.getElementById("instructions"); t.scrollIntoView({ block: "center" }); const r = t.getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20 }; })()`);
  await p.click(box.x, box.y);
  await p.type("Make the button ");
  sending = true;
  const waitFor = async (n: number) => {
    const end = updates + n;
    for (const stop = Date.now() + 10_000; updates < end && Date.now() < stop;) await Bun.sleep(20);
    await p.eval(`new Promise((r) => setTimeout(r, 50))`);
    expect(updates >= end, `${n} live updates arrive`, updates);
  };
  await waitFor(1);
  await p.type("blue", 120);
  await waitFor(2);
  const field = () => p.eval<{ focus: string; value: string; sel: number[]; log: string }>(`(() => { const t = document.getElementById("instructions"); return { focus: document.activeElement.id, value: t.value, sel: [t.selectionStart, t.selectionEnd], log: document.getElementById("task-log").textContent }; })()`);
  let f = await field();
  expect(f.log.includes("update " + (updates - 1)), "the detail view shows the updates", f.log);
  expect(f.focus == "instructions" && f.value == "Make the button blue" && f.sel.join() == "20,20", "the instructions keep the focus, the text and the cursor", f);
  ok(`typing through ${updates} live updates: the focus, the text and the cursor stay`);
  await p.eval(`document.getElementById("instructions").setSelectionRange(5, 8)`);
  await waitFor(2);
  f = await field();
  expect(f.focus == "instructions" && f.sel.join() == "5,8", "a selection stays through an update", f);
  await p.type("a");
  expect((await field()).value == "Make a button blue", "the next key replaces the selection", await field());
  ok("a selection stays through live updates; the next key replaces it");
  await p.eval(`(() => { const k = document.getElementById("dep-kind"); k.value = "mergeAfter"; document.getElementById("instructions").focus(); })()`);
  await waitFor(2);
  const kind = await p.eval<string>(`document.getElementById("dep-kind").value`);
  expect(kind == "mergeAfter", "a dependency's kind keeps its choice through an update", kind);
  ok("the dependency's kind keeps its choice through live updates");
  sending = false;
  await p.screenshot(join(SHOTS, "factory-detail-typing.png"));
  await p.eval(`document.querySelector("#dlg [data-act=close]").click()`);
  expect(!p.errors.length, "no errors in the page", p.errors);
  const html = process.argv[process.argv.indexOf("--html") + 1];
  if (process.argv.includes("--html") && html) {
    await p.open(`${host.root}/admin/factory`, { width: 1400, height: 900 });
    while (!(await p.eval(`document.querySelectorAll("#board .card").length`))) await Bun.sleep(50);
    await Bun.sleep(300);
    writeFileSync(html, await p.eval<string>(`(async () => {
      const css = [...document.styleSheets].map((sheet) => { try { return [...sheet.cssRules].map((r) => r.cssText).join("\\n"); } catch { return ""; } }).join("\\n");
      const doc = document.documentElement.cloneNode(true);
      doc.querySelectorAll("script, link[rel=stylesheet], style, link[rel=modulepreload]").forEach((e) => e.remove());
      const style = document.createElement("style"); style.textContent = css; doc.querySelector("head").append(style);
      return "<!doctype html>\\n" + doc.outerHTML;
    })()`).then((page) => page.replace(/src="\/api\/factory\/shots\/[^"]*"/g, `src="data:image/png;base64,${png.toString("base64")}"`)));
    ok(`the board, as a static page: ${html}`);
  }
} finally {
  await browser.close();
  await host.stop();
}

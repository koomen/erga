#!/usr/bin/env bun
// The factory board's cards on /admin/source, compact: a board of fixture tasks (the page's
// /api/factory requests answered over DevTools, so no VM runs), in headless Chrome.
//
//   bun tests/factory-cards.ts [--html FILE]
//
// - A long title stays on one line, cut with an ellipsis; the full title is its tooltip.
// - No branch name on a card (the detail still has it).
// - The last update is a short time on the title's line ("5m"), its date in a tooltip.
// - A plain card (no thumbnails, no error) is at most two lines of text and a row of buttons.
// - The thumbnails stay.
// - Each column is in id order, oldest first, so a card moves only when its status changes.
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
  t("Make factory task cards on /admin/source more compact and easier to scan", "working", 2, "Reading the code"),
  t("Tests run in the factory VM without lsof", "working", 12, "Running tests/factory.ts under a time limit of 180 seconds"),
  t("Dark mode for the outline panel", "failed", 45, "failed", { error: "The build failed: src/page/outline.ts(12,3): Property 'x' does not exist." }),
  t("Show word counts in the document list, with a total for each folder", "complete", 70, "ready to merge", { url: "http://localhost:4400/", screenshots: [shot("a.png"), shot("b.png")] }),
  t("Faster first paint on the reader page", "complete", 8, "ready to merge", { url: "http://localhost:4401/", blockedBy: { start: [], merge: [3], stuck: [], reason: ["merges after #3"] } }),
  t("Keyboard shortcuts help dialog", "queued", 1, "queued"),
  t("Export a document as EPUB, with the cover image and the table of contents", "queued", 4, "queued", { startAfter: [6], blockedBy: { start: [6], merge: [], stuck: [], reason: ["waits for #6 to merge"] } }),
  t("Resolve the merge with staging", "needs agent", 3, "Merging origin/staging into the branch", { error: "conflicts merging origin/staging: README.md" }),
];
const info = { enabled: true, vms: { runner: "sim" }, claude: { signedIn: true, canStore: true } };
const host = await startHost(null);
const browser = await Browser.launch();
try {
  const p = await browser.page(await browser.context());
  // The thumbnails' image: a small page, as a task's screenshot would show one.
  await p.open(`data:text/html,<body style="margin:0;padding:24px;font:32px sans-serif;background:linear-gradient(135deg,%23dfe9f5,%23f7efe3)"><h1>Preview</h1><p>A page of the task.</p></body>`, { width: 480, height: 300 });
  const png = Buffer.from((await p.send("Page.captureScreenshot", { format: "png" })).data, "base64");
  await p.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/factory*" }] });
  p.onEvent("Fetch.requestPaused", ({ requestId, request }) => {
    const path = new URL(request.url).pathname.replace(/^\/api\/factory/, "");
    const reply = (body: string | Uint8Array, type: string) => p.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(body).toString("base64") }).catch(() => {});
    if (path == "/events") reply("retry: 600000\n\n", "text/event-stream");
    else if (path.startsWith("/shots/")) reply(png, "image/png");
    else if (path == "/tasks") reply(JSON.stringify(tasks), "application/json");
    else if (path == "") reply(JSON.stringify(info), "application/json");
    else p.send("Fetch.continueRequest", { requestId }).catch(() => {});
  });
  for (const dark of [false, true]) {
    await p.open(`${host.root}/admin/source`, { width: 1400, height: 900, scale: 2, dark });
    const deadline = Date.now() + 15_000;
    while (!(await p.eval(`document.querySelectorAll("#board .card").length`)) && Date.now() < deadline) await Bun.sleep(50);
    await p.eval(`document.getElementById("tasks").scrollIntoView()`);
    await Bun.sleep(300);
    await p.screenshot(join(SHOTS, dark ? "factory-cards-dark.png" : "factory-cards.png"));
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
  expect(await p.eval(`(() => { const b = [...document.querySelectorAll("[data-open='6'] .actions > *")].map((e) => e.getBoundingClientRect().top); return b.length == 4 && b.every((y) => y == b[0]); })()`), "Preview, Merge, Restart and Discard fit on one row");
  ok("Preview, Merge, Restart and Discard fit on one row");
  // Restart on a failed task and on one ready to merge, and nowhere else.
  const restarts = await p.eval<number[]>(`[...document.querySelectorAll("#board [data-act='restart']")].map((b) => Number(b.dataset.id)).sort((a, b) => a - b)`);
  expect(JSON.stringify(restarts) == JSON.stringify([5, 6, 7]), "Restart on the failed and the ready tasks only", restarts);
  ok("Restart on the failed and the ready tasks only");
  // Discard's text is black (the page's ink), not red; in light mode at least.
  await p.open(`${host.root}/admin/source`, { width: 1400, height: 900 });
  for (const end = Date.now() + 15_000; !(await p.eval(`document.querySelectorAll("#board .card").length`)) && Date.now() < end;) await Bun.sleep(50);
  const discard = await p.eval<string>(`getComputedStyle(document.querySelector("[data-open='5'] [data-act='arm']")).color`);
  expect(discard == "rgb(13, 13, 15)", "Discard's text is black", discard);
  ok("Discard's text is black");
  expect(card(6).thumbs == 2, "the thumbnails stay", card(6));
  ok("the thumbnails stay");
  // Each column in id order (oldest first), not by last update: #7 updated after #6, yet stays below it.
  const order = await p.eval<number[][]>(`[...document.querySelectorAll("#board .col")].map((c) => [...c.querySelectorAll(".card")].map((e) => Number(e.dataset.open)))`);
  for (const ids of order) expect(ids.every((id, i) => !i || ids[i - 1] < id), "each column is in id order", order);
  ok("each column is in id order, oldest first");
  expect(!p.errors.length, "no errors in the page", p.errors);
  const html = process.argv[process.argv.indexOf("--html") + 1];
  if (process.argv.includes("--html") && html) {
    await p.open(`${host.root}/admin/source`, { width: 1400, height: 900 });
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

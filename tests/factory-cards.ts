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
// - A card shows only the steps that work for its state, the main one (Merge, or else Preview) filled and on the
//   right, or a round spinner while a merge or a start runs (a task starts by itself: there is no Start); no off
//   buttons. They fit inside the card, apart, with whole labels, at four narrow columns and at two (factory-card-states[-narrow][-dark].png: the board alone).
// - The detail view keeps all four, Preview, Restart, Discard and Merge; an off one (a dashed border) says why.
// - Discard asks first ("Discard branch?"), on the card too.
// - Each column is in id order, oldest first, so a card moves only when its status changes.
// - The detail view shows the screenshots first, three in a row; a click enlarges one to the modal's width, a
//   second click puts it back (factory-detail-shots.png, factory-detail-shot-big.png).
// - A task that is working or needs agent, with no new log line in 5 minutes, is stalled: a badge on its card and in
//   its detail view says how long it has been quiet (factory-stalled.png); a new log line clears it.
// - The left and right arrow keys go to the previous and next screenshot, around at the ends: along the grid (the
//   focus moves; Enter enlarges) and in the enlarged view (factory-detail-shot-keys.png). Escape shrinks it and
//   leaves the view open. In the instructions the arrows move the cursor.
// - Live updates of the open task don't disturb what the user does in its detail view: the instructions keep
//   the focus, the cursor, the selection and the text typed while the updates arrive; a dependency's kind keeps
//   its choice (factory-detail-typing.png).
// Screenshots land in tests/cdp.ts's SHOTS (factory-cards.png, factory-cards-dark.png). --html saves the board as one
// static page (styles and images inlined, no scripts), to look at without a server.
// covers: factory/page.ts src/page/factory-agent.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, type Page, SHOTS } from "./cdp";
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
  t("Keyboard shortcuts help dialog", "queued", 1, "queued", { starting: true }),
  t("Export a document as EPUB, with the cover image and the table of contents", "queued", 4, "queued", { startAfter: [6], blockedBy: { start: [6], merge: [], stuck: [], reason: ["waits for #6 to merge"] } }),
  t("Resolve the merge with staging", "needs agent", 3, "Merging origin/staging into the branch", { error: "conflicts merging origin/staging: README.md" }),
  t("Spell check in the editor", "merging", 1, "Merging origin/staging into the branch", { url: "http://localhost:4402/" }),
];
const info = { enabled: true, vms: { runner: "sim" }, claude: { signedIn: true, canStore: true } };
// The events: none, until the typing test sends task #6's updates, one each time the page reconnects (every 150 ms).
let updates = 0, sending = false;
// Other events, sent one each time the page reconnects (the stalled test's new log line).
const pending: string[] = [];
const update = () => {
  const task = tasks[5];
  task.log.push({ at: new Date().toISOString(), message: "update " + ++updates });
  task.updatedAt = new Date().toISOString();
  return "retry: 150\n\ndata: " + JSON.stringify({ type: "task", task }) + "\n\n";
};
/** The board alone (a card in each state), in SHOTS. */
const boardShot = async (p: Page, file: string) => {
  const r = await p.eval<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.getElementById("board").getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
  const png = await p.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...r, scale: 1 } });
  writeFileSync(join(SHOTS, file), Buffer.from(png.data, "base64"));
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
    if (path == "/events") reply(sending ? update() : pending.length ? "retry: 150\n\ndata: " + pending.shift() + "\n\n" : "retry: 150\n\n", "text/event-stream");
    else if (path.startsWith("/shots/")) reply(pngs[path.slice(7)] ?? png, "image/png");
    else if (path == "/tasks") reply(JSON.stringify(tasks), "application/json");
    else if (path == "") reply(JSON.stringify(info), "application/json");
    else p.send("Fetch.continueRequest", { requestId }).catch(() => {});
  });
  // A card's buttons, read where the board is: which show, whether they fit, the main one, the spinner.
  const readRows = () => p.eval<{ id: number; keys: string[]; inside: boolean; overlap: boolean; cut: string[]; off: number; mainRight: boolean; main: string; spin: { w: number; h: number; anim: string } | null }[]>(`[...document.querySelectorAll("#board .card")].map((c) => {
    const bs = [...c.querySelectorAll(".actions > *")], box = c.getBoundingClientRect(), r = bs.map((e) => e.getBoundingClientRect());
    const pad = parseFloat(getComputedStyle(c).paddingRight), last = bs.at(-1), lr = r.at(-1), spin = c.querySelector(".spin");
    const sr = spin?.getBoundingClientRect();
    return { id: Number(c.dataset.open), keys: bs.map((e) => e.dataset.btn), inside: r.every((x) => x.left >= box.left && x.right <= box.right),
      overlap: r.some((a, i) => r.some((b, j) => i < j && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5)),
      cut: bs.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.dataset.btn), off: c.querySelectorAll("button:disabled").length,
      mainRight: !last || Math.abs(box.right - pad - 1 - lr.right) < 3 || Math.abs(box.right - pad - lr.right) < 3,
      main: last && (last.classList.contains("primary") || last.classList.contains("busy")) ? last.dataset.btn + (last.classList.contains("busy") ? ":busy" : "") : "",
      spin: sr ? { w: sr.width, h: sr.height, anim: getComputedStyle(spin).animationName } : null };
  })`);
  const fits = async (where: string) => {
    for (const r of await readRows()) {
      expect(r.inside && !r.overlap && !r.cut.length, `the buttons fit inside the card, apart, their labels whole (${where})`, r);
      expect(!r.off, `no off buttons on a card (${where})`, r);
      if (r.main) expect(r.mainRight, `the main step is on the right (${where})`, r);
      if (r.spin) expect(Math.abs(r.spin.w - r.spin.h) < 0.5 && r.spin.w >= 11 && r.spin.anim != "none", `the spinner is a round circle that spins (${where})`, r);
    }
  };
  for (const dark of [false, true]) {
    // The board alone, at a narrow width first (four narrow columns), then at the normal one.
    await p.open(`${host.root}/admin/factory`, { width: 1540, height: 900, scale: 2, dark });
    for (const end = Date.now() + 15_000; !(await p.eval(`document.querySelectorAll("#board .card").length`)) && Date.now() < end;) await Bun.sleep(50);
    await Bun.sleep(300);
    expect(await p.eval(`getComputedStyle(document.getElementById("board")).gridTemplateColumns.split(" ").length == 4`), "four columns at 1540px");
    await fits(`four columns, ${dark ? "dark" : "light"}`);
    await boardShot(p, `factory-card-states-narrow${dark ? "-dark" : ""}.png`);
    await p.open(`${host.root}/admin/factory`, { width: 1400, height: 900, scale: 2, dark });
    const deadline = Date.now() + 15_000;
    while (!(await p.eval(`document.querySelectorAll("#board .card").length`)) && Date.now() < deadline) await Bun.sleep(50);
    await p.eval(`document.getElementById("tasks").scrollIntoView()`);
    await Bun.sleep(300);
    await fits(`two columns, ${dark ? "dark" : "light"}`);
    await p.screenshot(join(SHOTS, dark ? "factory-cards-dark.png" : "factory-cards.png"));
    await boardShot(p, `factory-card-states${dark ? "-dark" : ""}.png`);
    // The detail view keeps all five: an off Merge reads as off, as the other off buttons do, in light and dark.
    await p.eval(`window.ergaBoard.open(3)`);
    const [merge, preview] = await p.eval<string[]>(`["merge", "preview"].map((k) => getComputedStyle(document.querySelector("#dlg [data-btn='" + k + "']")).color)`);
    expect(merge == preview, `an off Merge has the off text (${dark ? "dark" : "light"})`, { merge, preview });
    await p.eval(`document.getElementById("dlg").close()`);
  }
  ok("the cards' buttons fit inside the card, apart, with whole labels, at four and two columns, light and dark; no off buttons");
  ok("the spinner keeps its size: a round circle that spins");
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
  // Every card: only the steps that work for its state, the main one (Merge or Preview, or a spinner) last.
  const rows = await readRows();
  const shown = (id: number) => { const r = rows.find((x) => x.id == id)!; return r.keys.join() + (r.main ? " | " + r.main : ""); };
  expect(shown(3) == "restart,discard" && shown(4) == "restart,discard", "working: Restart and Discard", rows);
  expect(shown(5) == "restart,discard", "failed: Restart and Discard", shown(5));
  expect(shown(6) == "preview,discard,merge | merge", "ready to merge: Preview, Discard, and Merge as the main step", shown(6));
  expect(shown(7) == "discard,preview | preview", "ready, Merge waits for #3: no Merge, Preview as the main step", shown(7));
  expect(shown(8) == "discard,start | start:busy", "queued: Discard and the start's spinner (it starts by itself)", shown(8));
  expect(shown(9) == "discard", "queued, waiting for another task: Discard (the chip says what it waits for)", shown(9));
  expect(shown(10) == "restart,discard", "needs agent: Restart and Discard", shown(10));
  expect(shown(11) == "preview,merge | merge:busy", "merging: Preview and the merge's spinner", shown(11));
  ok("each state shows only the steps that work: Merge or Preview as the main step, on the right; a spinner while a merge or start runs");
  // The detail view keeps all five, in order; an off one says why.
  for (const id of [3, 6, 7, 8, 9, 10, 11]) {
    await p.eval(`window.ergaBoard.open(${id})`);
    const d = await p.eval<{ keys: string; offUntitled: number; spin: number[] | null }>(`(() => { const bs = [...document.querySelectorAll("#dlg .actions > :is(button, a)")], s = document.querySelector("#dlg .spin")?.getBoundingClientRect();
      return { keys: bs.map((b) => b.dataset.btn).join(), offUntitled: bs.filter((b) => b.disabled && !b.title).length, spin: s ? [s.width, s.height] : null }; })()`);
    expect(d.keys == "preview,restart,discard,merge" && !d.offUntitled, "the detail view: all four, an off one with its reason", { id, d });
    if (d.spin) expect(d.spin[0] == d.spin[1], "the detail view's spinner is round", d);
  }
  await p.eval(`window.ergaBoard.open(7)`);
  expect(await p.eval(`document.querySelector("#dlg .actions-why")?.textContent == "Can't merge until #3 merges"`), "the detail view says why Merge is off");
  const offLook = await p.eval<{ border: string; cursor: string }>(`(() => { const s = getComputedStyle(document.querySelector("#dlg [data-btn='merge']")); return { border: s.borderStyle, cursor: s.cursor }; })()`);
  expect(offLook.border == "dashed" && offLook.cursor == "not-allowed", "an off button looks off", offLook);
  await p.eval(`document.getElementById("dlg").close()`);
  ok("the detail view: Preview, Restart, Discard, Merge, no Start; an off one looks off and says why");
  // Discard's text is black (the page's ink), not red; in light mode at least.
  await p.open(`${host.root}/admin/factory`, { width: 1400, height: 900 });
  for (const end = Date.now() + 15_000; !(await p.eval(`document.querySelectorAll("#board .card").length`)) && Date.now() < end;) await Bun.sleep(50);
  const discard = await p.eval<string>(`getComputedStyle(document.querySelector("[data-open='5'] [data-act='arm']")).color`);
  expect(discard == "rgb(13, 13, 15)", "Discard's text is black", discard);
  ok("Discard's text is black");
  // Discard asks first: one click turns it into "Discard branch?", which still fits the card; a second click discards.
  await p.eval(`document.querySelector("[data-open='8'] [data-act='arm']").click()`);
  const armedCard = await p.eval<{ text: string; inside: boolean; cut: boolean }>(`(() => { const c = document.querySelector("[data-open='8']"), b = c.querySelector("[data-act='discard']"), box = c.getBoundingClientRect(), r = b?.getBoundingClientRect();
    return { text: b?.textContent ?? "", inside: !!r && r.left >= box.left && r.right <= box.right, cut: !!b && b.scrollWidth > b.clientWidth + 1 }; })()`);
  expect(armedCard.text == "Discard branch?" && armedCard.inside && !armedCard.cut, "Discard's confirm shows on the card, and fits", armedCard);
  ok("Discard asks first: \"Discard branch?\" on the card, inside it");
  expect(card(6).thumbs == 3, "the thumbnails stay (the last three)", card(6));
  ok("the thumbnails stay");
  // Each column in id order (oldest first), not by last update: #7 updated after #6, yet stays below it. (Queued puts the
  // ones waiting for another task below the rest.)
  const order = await p.eval<number[][]>(`[...document.querySelectorAll("#board .col")].map((c) => [...c.querySelectorAll(".card:not(.blocked)")].map((e) => Number(e.dataset.open)))`);
  for (const ids of order) expect(ids.every((id, i) => !i || ids[i - 1] < id), "each column is in id order", order);
  ok("each column is in id order, oldest first");
  // Stalled: #4 is working and its last log line is 12 minutes old; #3 (2 minutes), #10 (needs agent, 3 minutes)
  // and #5 (failed, 45 minutes) are not.
  const badges = () => p.eval<Record<number, { badge: string; tip: string; cls: boolean }>>(`Object.fromEntries([...document.querySelectorAll("#board .card")].map((c) => {
    const b = c.querySelector(".stalled-badge");
    return [c.dataset.open, { badge: b?.textContent ?? "", tip: b?.title ?? "", cls: c.classList.contains("stalled") }];
  }))`);
  let st = await badges();
  expect(st[4].badge == "stalled 12 min" && st[4].cls && st[4].tip.startsWith("No new log line for 12 min, since "), "a working task quiet for 12 minutes is stalled", st[4]);
  expect(Object.entries(st).every(([id, s]) => id == "4" || (!s.badge && !s.cls)), "no other task is stalled", st);
  expect(!(await p.eval(`document.querySelector("[data-open='4']").textContent.includes("blocked")`)), "a stalled card doesn't say blocked");
  ok("a working task with no new log line in 12 minutes: a stalled badge on its card");
  await p.eval(`window.ergaBoard.open(4)`);
  await Bun.sleep(200);
  const det = await p.eval<{ badge: string; note: string }>(`({ badge: document.querySelector("#dlg h3 .stalled-badge")?.textContent ?? "", note: document.getElementById("stalled-note")?.textContent ?? "" })`);
  expect(det.badge == "stalled 12 min" && det.note.startsWith("Stalled: No new log line for 12 min"), "the detail view says it is stalled, and for how long", det);
  await p.screenshot(join(SHOTS, "factory-stalled.png"));
  ok("the detail view: a stalled badge and a note that says how long the log has been quiet");
  // A new log line arrives: the badge clears, on the card and in the detail view.
  tasks[3].log.push({ at: new Date().toISOString(), message: "Claude runs Bash: bun test" });
  tasks[3].updatedAt = new Date().toISOString();
  pending.push(JSON.stringify({ type: "task", task: tasks[3] }));
  for (const end = Date.now() + 5000; pending.length && Date.now() < end;) await Bun.sleep(20);
  await Bun.sleep(200);
  st = await badges();
  expect(!st[4].badge && !st[4].cls && !(await p.eval(`document.querySelector("#dlg .stalled-badge, #stalled-note")`)), "a new log line clears it", st[4]);
  await p.eval(`document.querySelector("#dlg [data-act=close]").click()`);
  await Bun.sleep(300);
  ok("a new log line clears the stalled badge");
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

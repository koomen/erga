// What a card shows: the id and the title (up to two lines), only what its column doesn't say, no branch and no
// time; its four icon buttons in one order, the ones that don't apply off, with why; each column in id order;
// and Discard that asks first.
import { expect, servers, test } from "../fixtures";
import { buttonRows, cardBoard, cardTasks, CARDS } from "./cards";

await servers.main();

const readCards = (page: import("../fixtures").Page) => page.evaluate(`[...document.querySelectorAll("#board .card")].map((c) => {
  const title = c.querySelector(".title"), lineH = parseFloat(getComputedStyle(title).lineHeight);
  return { id: Number(c.dataset.open), text: c.innerText.trim(), titleLines: Math.round(title.getBoundingClientRect().height / lineH), titleTip: title.title,
    titleCut: title.scrollHeight > title.clientHeight + 1, meta: [...c.querySelectorAll(".meta .m")].map((m) => [m.textContent.trim(), m.title]),
    lines: [...c.querySelectorAll(".step, .err")].map((e) => e.textContent), images: c.querySelectorAll("img").length };
})`) as Promise<{ id: number; text: string; titleLines: number; titleTip: string; titleCut: boolean; meta: [string, string][]; lines: string[]; images: number }[]>;

test("merged tasks leave the board; a long title wraps to two lines, then an ellipsis, its full title the tooltip; no branch names, no times, no thumbnails; a card says only what its column doesn't", async ({ tab }) => {
  tab.strict = true;
  await cardBoard(tab.page, { width: 1540 });
  const cards = await readCards(tab.page), card = (id: number) => cards.find((c) => c.id == id)!;
  expect(cards.length).toBe(CARDS);
  expect([card(3).titleLines, card(3).titleCut, card(3).titleTip]).toEqual([2, true, cardTasks()[2].title]);
  for (const c of cards) {
    expect(c.text).not.toContain("task/");
    expect(c.text, `#${c.id}: no time`).not.toMatch(/\b\d+[mhd]\b|just now|\bnow\b/);
    expect(c.images, `#${c.id}: no thumbnails`).toBe(0);
  }
  // Working: the latest step. Ready to merge, queued and merging: the column says it all, so only the title.
  expect(card(3).meta).toEqual([]);
  expect(card(3).lines).toEqual(["Reading the code"]);
  for (const id of [6, 11]) expect([card(id).meta, card(id).lines], `#${id}`).toEqual([[], []]);
  expect(card(6).text).toBe("#6" + cardTasks()[5].title);
  // Failed: the reason, in red, which says it failed. Needs agent: the word, and the reason.
  expect(card(5).meta).toEqual([]);
  expect(card(5).lines[0]).toMatch(/^The build failed/);
  expect(card(10).meta.map((m) => m[0])).toEqual(["needs agent"]);
  expect(card(10).lines).toEqual(["conflicts merging origin/staging: README.md"]);
  // A dependency: a link and the task's id, its words in the tooltip. A starting VM: a spinner, with its tooltip.
  expect(card(7).meta).toEqual([["#3", "Can't merge until #3 merges"]]);
  expect(card(9).meta).toEqual([["#6", "Waiting for #6 to merge"]]);
  expect(card(8).meta).toEqual([["", "Starting: the VM is starting"]]);
});

test("each card has the four buttons as icons in one order, Discard first, Merge last; the ones that don't apply are off; each column is in id order", async ({ tab }) => {
  tab.strict = true;
  await cardBoard(tab.page);
  const rows = await buttonRows(tab.page);
  const on = (id: number) => rows.find((x) => x.id == id)!.on.join();
  for (const r of rows) expect(r.keys, `#${r.id}`).toEqual(["discard", "restart", "preview", "merge"]);
  expect(on(3), "working").toBe("discard,restart");
  expect(on(5), "failed").toBe("discard,restart");
  expect(on(6), "ready to merge").toBe("discard,restart,preview,merge");
  expect(on(7), "ready, Merge waits for #3").toBe("discard,restart,preview");
  expect(on(8), "queued: it starts by itself").toBe("discard");
  expect(on(9), "queued, waiting for another task").toBe("discard");
  expect(on(10), "needs agent").toBe("discard,restart");
  expect(on(11), "merging: a spinner in Merge's place").toBe("restart,preview");
  expect(rows.find((x) => x.id == 11)!.spin).not.toBeNull();
  // An off button's tooltip says why; one that works says what it does.
  const tips = (id: number) => rows.find((x) => x.id == id)!.tips;
  expect(tips(7)[3]).toBe("Merge (off): Can't merge until #3 merges");
  expect(tips(6)[3]).toBe("Merge: Merge the branch into staging");
  expect(tips(8)[1]).toBe("Restart (off): The task hasn't run yet");
  expect(tips(3)[0]).toBe("Discard: Delete the branch and stop the VM");
  // Not by last update: #7 updated after #6, yet stays below it. (Queued puts the ones waiting for another task below the rest.)
  const order = await tab.page.evaluate(`[...document.querySelectorAll("#board .col")].map((c) => [...c.querySelectorAll(".card:not(.blocked)")].map((e) => Number(e.dataset.open)))`) as number[][];
  for (const ids of order) expect(ids).toEqual([...ids].sort((a, b) => a - b));
});

test("Discard asks first: one click turns its icon red, and its tooltip asks; a click on an off button does nothing", async ({ tab }) => {
  tab.strict = true;
  await cardBoard(tab.page);
  await tab.page.evaluate(`document.querySelector("[data-open='8'] [data-act='arm']").click()`);
  const armed = await tab.page.evaluate(`(() => { const b = document.querySelector("[data-open='8'] [data-act='discard']"); return { label: b?.getAttribute("aria-label"), tip: b?.title, bg: b && getComputedStyle(b).backgroundColor }; })()`) as { label: string; tip: string; bg: string };
  expect([armed.label, armed.tip]).toEqual(["Discard branch?", "Click again to discard: delete the branch and stop the VM"]);
  expect(armed.bg).toBe("rgb(179, 38, 30)");
  // #7's Merge is off (it merges after #3): once the card is open, a click on it does nothing.
  await tab.page.locator("[data-open='7']").hover();
  await expect.poll(() => tab.page.evaluate<string>(`getComputedStyle(document.querySelector("[data-open='7'] .actions")).opacity`)).toBe("1");
  await tab.page.locator("[data-open='7'] [data-btn='merge']").click({ force: true });
  await tab.page.waitForTimeout(200);
  expect(await tab.page.evaluate<boolean>(`document.getElementById("dlg").open`)).toBe(false);
});

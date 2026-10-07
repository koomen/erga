// What a card shows (tests/factory-cards.ts): one line of title, no branch, a short time, only the steps that work,
// thumbnails, each column in id order, and Discard that asks first.
import { expect, servers, test } from "../fixtures";
import { buttonRows, cardBoard, cardTasks, CARDS } from "./cards";

test.beforeAll(async () => { await servers.main(); });

const readCards = (page: import("../fixtures").Page) => page.evaluate(`[...document.querySelectorAll("#board .card")].map((c) => {
  const title = c.querySelector(".title"), time = c.querySelector(".when");
  const lineH = parseFloat(getComputedStyle(title).lineHeight) || title.getBoundingClientRect().height;
  return { id: Number(c.dataset.open), text: c.innerText, titleLines: Math.round(title.getBoundingClientRect().height / lineH), titleTip: title.title, titleCut: title.scrollWidth > title.clientWidth,
    time: time?.textContent ?? "", timeTip: time?.title ?? "", height: c.getBoundingClientRect().height, thumbs: c.querySelectorAll(".thumbs img").length };
})`) as Promise<{ id: number; text: string; titleLines: number; titleTip: string; titleCut: boolean; time: string; timeTip: string; height: number; thumbs: number }[]>;

test("merged tasks leave the board; a long title is one line with an ellipsis and its full title as the tooltip; no branch names; the last update a short time with its date as the tooltip; a plain card is short; the thumbnails stay (the last three)", async ({ tab }) => {
  tab.strict = true;
  await cardBoard(tab.page);
  const cards = await readCards(tab.page), card = (id: number) => cards.find((c) => c.id == id)!;
  expect(cards.length).toBe(CARDS);
  expect([card(3).titleLines, card(3).titleCut, card(3).titleTip]).toEqual([1, true, cardTasks()[2].title]);
  for (const c of cards) expect(c.text).not.toContain("task/");
  expect([card(3).time, card(4).time, card(5).time]).toEqual(["2m", "12m", "45m"]);
  expect(card(5).timeTip).toMatch(/\d/);
  // The title's line, the last update's line, and the buttons: about 70px at 12-14px type.
  expect(card(4).height).toBeLessThanOrEqual(80);
  expect(card(6).thumbs).toBe(3);
});

test("each state shows only the steps that work, the main one (Merge, or else Preview, or a spinner while a merge or a start runs) last; each column is in id order", async ({ tab }) => {
  tab.strict = true;
  await cardBoard(tab.page);
  const rows = await buttonRows(tab.page);
  const shown = (id: number) => { const r = rows.find((x) => x.id == id)!; return r.keys.join() + (r.main ? " | " + r.main : ""); };
  expect(shown(3), "working").toBe("restart,discard");
  expect(shown(4), "working").toBe("restart,discard");
  expect(shown(5), "failed").toBe("restart,discard");
  expect(shown(6), "ready to merge").toBe("preview,discard,merge | merge");
  expect(shown(7), "ready, Merge waits for #3").toBe("discard,preview | preview");
  expect(shown(8), "queued: it starts by itself").toBe("discard,start | start:busy");
  expect(shown(9), "queued, waiting for another task").toBe("discard");
  expect(shown(10), "needs agent").toBe("restart,discard");
  expect(shown(11), "merging").toBe("preview,merge | merge:busy");
  // Not by last update: #7 updated after #6, yet stays below it. (Queued puts the ones waiting for another task below the rest.)
  const order = await tab.page.evaluate(`[...document.querySelectorAll("#board .col")].map((c) => [...c.querySelectorAll(".card:not(.blocked)")].map((e) => Number(e.dataset.open)))`) as number[][];
  for (const ids of order) expect(ids).toEqual([...ids].sort((a, b) => a - b));
});

test("Discard's text is the page's ink, not red; one click turns it into \"Discard branch?\", which fits the card", async ({ tab }) => {
  tab.strict = true;
  await cardBoard(tab.page);
  expect(await tab.page.evaluate<string>(`getComputedStyle(document.querySelector("[data-open='5'] [data-act='arm']")).color`)).toBe("rgb(13, 13, 15)");
  await tab.page.evaluate(`document.querySelector("[data-open='8'] [data-act='arm']").click()`);
  const armed = await tab.page.evaluate(`(() => { const c = document.querySelector("[data-open='8']"), b = c.querySelector("[data-act='discard']"), box = c.getBoundingClientRect(), r = b?.getBoundingClientRect();
    return { text: b?.textContent ?? "", inside: !!r && r.left >= box.left && r.right <= box.right, cut: !!b && b.scrollWidth > b.clientWidth + 1 }; })()`);
  expect(armed).toEqual({ text: "Discard branch?", inside: true, cut: false });
});

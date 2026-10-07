// The detail view's screenshots: first, three in a row, a click to enlarge, the arrow keys.
import { expect, servers, test, type Page } from "../fixtures";
import { cardBoard } from "./cards";

await servers.main();

const detail = (page: Page) => page.evaluate(`(() => {
  const d = document.getElementById("dlg"), r = d.getBoundingClientRect();
  return { first: d.querySelector(".dlg section h4")?.textContent, dlgW: r.width, dlgH: r.height,
    boxes: [...d.querySelectorAll(".shots figure")].map((f) => { const b = f.querySelector("img").getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, big: f.classList.contains("big") }; }) };
})()`) as Promise<{ first: string; boxes: { x: number; y: number; w: number; h: number; big: boolean }[]; dlgW: number; dlgH: number }>;
const state = (page: Page) => page.evaluate(`({ focus: document.activeElement.dataset?.file ?? null,
  big: document.querySelector("#dlg .shots figure.big")?.dataset.file ?? null, open: document.getElementById("dlg").open })`) as Promise<{ focus: string | null; big: string | null; open: boolean }>;
/** Opens #6 (four screenshots) and waits for them to be drawn. */
async function openShots(page: Page) {
  await page.evaluate(`document.querySelector("#board .card[data-open='6']").click()`);
  await expect.poll(() => page.evaluate(`(() => { const ims = [...document.querySelectorAll("#dlg .shots figure img")]; return ims.length == 4 && ims.every((i) => i.complete && i.naturalWidth > 0); })()`)).toBe(true);
}

test("the screenshots are the first section, three in a row; a click enlarges one to the modal's width, a redraw keeps it, a second click puts it back", async ({ tab }) => {
  tab.strict = true;
  await cardBoard(tab.page, { shots: true });
  await openShots(tab.page);
  let d = await detail(tab.page);
  expect(d.first).toBe("Screenshots");
  expect(d.boxes.length).toBe(4);
  expect(d.boxes[0].y == d.boxes[1].y && d.boxes[1].y == d.boxes[2].y && d.boxes[3].y > d.boxes[0].y && Math.abs(d.boxes[3].x - d.boxes[0].x) < 1, JSON.stringify(d.boxes)).toBe(true);
  await tab.page.evaluate(`document.querySelectorAll("#dlg .shots figure img")[1].click()`);
  await expect.poll(async () => (await detail(tab.page)).boxes.map((b) => b.big)).toEqual([false, true, false, false]);
  // The enlarged one fills the modal's width (its transition over).
  await expect.poll(async () => { const d = await detail(tab.page), big = d.boxes[1]; return big.w > d.dlgW - 60 && big.h > d.dlgH / 2; }).toBe(true);
  await tab.page.evaluate(`window.ergaBoard.open(6)`);
  expect((await detail(tab.page)).boxes[1].big).toBe(true);
  await tab.page.evaluate(`document.querySelector("#dlg .shots figure.big img").click()`);
  await expect.poll(async () => { d = await detail(tab.page); return d.boxes.every((b) => !b.big) && d.boxes[0].y == d.boxes[2].y; }).toBe(true);
});

test("the arrow keys go along the screenshots, around at the ends; Enter enlarges; in the enlarged view they change it; Escape shrinks it and leaves the view open; in the instructions they move the cursor", async ({ tab }) => {
  tab.strict = true;
  const page = tab.page;
  await cardBoard(page, { shots: true });
  await openShots(page);
  const keys = async (...ks: string[]) => { for (const k of ks) await page.keyboard.press(k); return state(page); };
  expect(await keys("ArrowRight")).toMatchObject({ focus: "a.png", big: null });
  expect(await keys("ArrowRight", "ArrowRight", "ArrowRight")).toMatchObject({ focus: "d.png", big: null });
  expect((await keys("ArrowRight")).focus, "around from the last to the first").toBe("a.png");
  expect((await keys("ArrowLeft")).focus, "around from the first to the last").toBe("d.png");
  expect(await keys("Enter")).toMatchObject({ big: "d.png", focus: "d.png" });
  expect(await keys("ArrowRight")).toMatchObject({ big: "a.png", focus: "a.png" });
  expect((await keys("ArrowRight")).big).toBe("b.png");
  expect((await keys("ArrowLeft", "ArrowLeft")).big).toBe("d.png");
  expect(await keys("Escape")).toEqual({ open: true, big: null, focus: "d.png" });
  await page.evaluate(`(() => { const t = document.getElementById("instructions"); t.value = "abc"; t.focus(); t.setSelectionRange(3, 3); })()`);
  await keys("ArrowLeft", "ArrowLeft");
  expect(await page.evaluate<Record<string, unknown>>(`({ focus: document.activeElement.id, at: document.getElementById("instructions").selectionStart, big: !!document.querySelector("#dlg .shots figure.big") })`)).toEqual({ focus: "instructions", at: 1, big: false });
});

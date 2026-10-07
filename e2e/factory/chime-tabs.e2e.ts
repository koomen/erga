// The chime with two admin tabs (tests/factory-chime.ts): one plays; the bell mutes both.
import { expect, servers, test } from "../fixtures";
import { chimeBoard, decided, type ChimeTab } from "./chime";

await servers.main();

const total = async (ts: ChimeTab[]) => (await Promise.all(ts.map((t) => t.notes()))).reduce((x, y) => x + y, 0);

test("with two admin tabs open, a task ready to merge plays one chime, not two", async ({ tab }) => {
  tab.strict = true;
  const board = await chimeBoard(tab.page.context());
  const a = await board.open(tab.page), b = await board.open(await tab.page.context().newPage());
  await a.click();
  await b.click();
  const from = [(await a.reads()).length, (await b.reads()).length];
  board.set(6, { status: "complete", summary: "Done." });
  await decided(a, from[0], "mine", "mute");
  await decided(b, from[1], "mine", "mute");
  // Each tab tried for the lock; one got it, and played.
  await expect.poll(async () => [(await a.claims()).tried, (await b.claims()).tried]).toEqual([1, 1]);
  expect((await a.claims()).granted + (await b.claims()).granted).toBe(1);
  expect(await total([a, b])).toBe(2);
});

test("the bell in the Tasks heading mutes it in both tabs: nothing plays; turned on again, it plays the chime once", async ({ tab }) => {
  tab.strict = true;
  const board = await chimeBoard(tab.page.context());
  const a = await board.open(tab.page), b = await board.open(await tab.page.context().newPage());
  await a.click();
  await b.click();
  const bell = (t: ChimeTab) => t.page.evaluate(`document.getElementById("chime-toggle").getAttribute("aria-pressed")`);
  await a.page.evaluate(`document.getElementById("chime-toggle").click()`);
  expect(await bell(a)).toBe("false");
  await expect.poll(() => bell(b)).toBe("false");
  const from = [(await a.reads()).length, (await b.reads()).length];
  board.set(7, { status: "complete", summary: "Done." });
  await decided(a, from[0], "mine", "mute");
  await decided(b, from[1], "mine", "mute");
  expect(await total([a, b])).toBe(0);
  expect((await a.claims()).tried + (await b.claims()).tried).toBe(0);
  await a.page.evaluate(`document.getElementById("chime-toggle").click()`);
  await expect.poll(() => total([a, b])).toBe(2);
  expect(await a.notes()).toBe(2);
});

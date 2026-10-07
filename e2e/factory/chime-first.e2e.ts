// The chime (tests/factory-chime.ts): never on the board's first read, never before a click, once for a task ready to merge.
import { expect, servers, test } from "../fixtures";
import { chimeBoard, decided } from "./chime";

await servers.main();

test("nothing plays on the board's first read, nor for a change before a click on the page; after a click, a task that becomes ready to merge plays one chime", async ({ tab }) => {
  tab.strict = true;
  const board = await chimeBoard(tab.page.context());
  const a = await board.open(tab.page);
  // The first read: a task ready to merge (#4) is no news.
  expect(await a.reads()).not.toContain("mine");
  let from = (await a.reads()).length;
  board.set(1, { status: "complete", summary: "Done." });
  await decided(a, from, "mine", "mute");
  expect(await a.notes()).toBe(0);
  expect((await a.claims()).tried).toBe(0);

  await a.click();
  from = (await a.reads()).length;
  board.set(2, { status: "complete", summary: "Done." });
  await decided(a, from, "mine", "mute");
  await expect.poll(() => a.claims()).toEqual({ tried: 1, granted: 1 });
  expect(await a.notes()).toBe(2);
});

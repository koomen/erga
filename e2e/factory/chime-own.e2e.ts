// The chime (tests/factory-chime.ts): the admin's own step plays none.
import { expect, servers, test } from "../fixtures";
import { chimeBoard, decided, look } from "./chime";

await servers.main();

test("the admin's own Merge on a card, failed at once (back to ready to merge), plays none", async ({ tab }) => {
  tab.strict = true;
  // Merge: merging, and then, at once, back to ready to merge with an error (the merge failed).
  let board: Awaited<ReturnType<typeof chimeBoard>>;
  board = await chimeBoard(tab.page.context(), { step: (id) => {
    board.set(id, { status: "merging" });
    setTimeout(() => board.set(id, { status: "complete", error: "The merge failed: a step timed out." }), 400);
    return board.byId(id);
  } });
  const a = await board.open(tab.page);
  await a.click();
  // Hidden, the tab counts in its title each task it would chime for, at the moment it decides (chime.ts, attention):
  // so the title shows a chime that the admin's own step must not make.
  await look(a.page, "hidden");
  const title = await a.page.title();
  const from = (await a.reads()).length;
  await a.page.evaluate(`document.querySelector('#board [data-act="merge"][data-id="4"]').click()`);
  // The Merge marks the task the admin's own; then the failed merge comes back, and the chime decides it is theirs.
  await expect.poll(() => board.byId(4).error).toBeTruthy();
  await decided(a, from, "mine", "mine");
  expect(await a.page.title()).toBe(title);
  expect(await a.notes()).toBe(0);
  expect((await a.claims()).tried).toBe(0);
});

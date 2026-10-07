// The chime: a burst of tasks is one chime.
import { expect, servers, test } from "../fixtures";
import { chimeBoard, decided } from "./chime";

await servers.main();

test("two tasks that fail at the same moment play one chime", async ({ tab }) => {
  tab.strict = true;
  const board = await chimeBoard(tab.page.context());
  const a = await board.open(tab.page);
  await a.click();
  const from = (await a.reads()).length;
  board.set(3, { status: "failed", error: "The build failed." });
  board.set(5, { status: "failed", error: "The build failed." });
  // Both came to need the admin before the burst's one try to play.
  const reads = await decided(a, from, "mine", "mine", "mute");
  expect(reads.filter((r) => r == "mute").length).toBe(1);
  await expect.poll(() => a.claims()).toEqual({ tried: 1, granted: 1 });
  expect(await a.notes()).toBe(2);
});

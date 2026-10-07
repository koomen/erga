// The chime's count in a hidden tab's title.
import { expect, servers, test } from "../fixtures";
import { chimeBoard, look } from "./chime";

await servers.main();

test("while the tab is hidden, its title counts the tasks that need the admin (\"(2) ...\"); the count goes when the admin looks", async ({ tab }) => {
  tab.strict = true;
  const board = await chimeBoard(tab.page.context());
  const a = await board.open(tab.page);
  await a.click();
  const title = await a.page.title();
  await look(a.page, "hidden");
  board.set(8, { status: "complete", summary: "Done." });
  board.set(9, { status: "failed", error: "Tests failed." });
  await expect.poll(() => a.page.title()).toBe("(2) " + title);
  await look(a.page, "visible");
  expect(await a.page.title()).toBe(title);
});

// The board's cards: their four icon buttons fit one row, at four narrow columns and at two, light and dark.
import { expect, servers, test } from "../fixtures";
import { cardBoard, fits } from "./cards";

await servers.main();

for (const dark of [false, true]) {
  const look = dark ? "dark" : "light";
  test(`four columns at 1540px (${look}): the four icon buttons fit one row inside the card, apart, in one order, each with its tooltip; Merge on the right; a round spinner that spins`, async ({ tab }) => {
    tab.strict = true;
    await cardBoard(tab.page, { width: 1540, dark });
    expect(await tab.page.evaluate<number>(`getComputedStyle(document.getElementById("board")).gridTemplateColumns.split(" ").length`)).toBe(4);
    await fits(tab.page);
  });

  test(`two columns at 1400px (${look}): the buttons fit the same way; the detail view's off Merge has the off text, as an off Preview does`, async ({ tab }) => {
    tab.strict = true;
    await cardBoard(tab.page, { width: 1400, dark });
    await tab.page.evaluate(`document.getElementById("tasks").scrollIntoView()`);
    await fits(tab.page);
    await tab.page.evaluate(`window.ergaBoard.open(3)`);
    const [merge, preview] = await tab.page.evaluate(`["merge", "preview"].map((k) => getComputedStyle(document.querySelector("#dlg [data-btn='" + k + "']")).color)`) as string[];
    expect(merge).toBe(preview);
  });
}

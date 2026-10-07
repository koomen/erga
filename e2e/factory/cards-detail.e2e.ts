// The detail view's steps (tests/factory-cards.ts): all four, always; an off one looks off and says why.
import { expect, servers, test } from "../fixtures";
import { cardBoard } from "./cards";

test.beforeAll(async () => { await servers.main(); });

test("the detail view keeps Preview, Restart, Discard and Merge in every state, an off one with its reason as a tooltip, its spinner round; an off Merge says why under them, with a dashed border and a not-allowed cursor", async ({ tab }) => {
  tab.strict = true;
  await cardBoard(tab.page);
  for (const id of [3, 6, 7, 8, 9, 10, 11]) {
    await tab.page.evaluate(`window.ergaBoard.open(${id})`);
    const d = await tab.page.evaluate(`(() => { const bs = [...document.querySelectorAll("#dlg .actions > :is(button, a)")], s = document.querySelector("#dlg .spin")?.getBoundingClientRect();
      return { keys: bs.map((b) => b.dataset.btn).join(), offUntitled: bs.filter((b) => b.disabled && !b.title).length, spin: s ? [s.width, s.height] : null }; })()`) as { keys: string; offUntitled: number; spin: number[] | null };
    expect([d.keys, d.offUntitled], `#${id}`).toEqual(["preview,restart,discard,merge", 0]);
    if (d.spin) expect(d.spin[0], `#${id}'s spinner`).toBe(d.spin[1]);
  }
  await tab.page.evaluate(`window.ergaBoard.open(7)`);
  expect(await tab.page.evaluate<string>(`document.querySelector("#dlg .actions-why")?.textContent`)).toBe("Can't merge until #3 merges");
  expect(await tab.page.evaluate<Record<string, unknown>>(`(() => { const s = getComputedStyle(document.querySelector("#dlg [data-btn='merge']")); return { border: s.borderStyle, cursor: s.cursor }; })()`)).toEqual({ border: "dashed", cursor: "not-allowed" });
});

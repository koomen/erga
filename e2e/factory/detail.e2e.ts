// A task's detail on the board.
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

await servers.factory();

test("a finished task's detail: its branch, summary, instructions box and preview, with the screenshot; Preview, Restart, Discard and Merge, and no Start", { timeout: TASK_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const id = await f.make("Show the detail");
  await f.until(id, "complete");
  const b = await board(tab.page, s.root);
  await until(() => b.eval(`!!document.querySelector('[data-open="${id}"]')`), 10_000, "the card");
  await b.click(`[data-open="${id}"]`);
  await until(() => b.eval(`document.getElementById("dlg").open && document.querySelector("#dlg .shots img")?.complete`), 5000, "the detail, with the screenshot");
  const detail = (await b.eval<string>(`document.getElementById("dlg").innerText`)).toLowerCase();
  for (const part of [`task/${id}-show-the-detail`, "summary", "more instructions", "open preview"]) expect(detail).toContain(part);
  const buttons = await b.eval<{ keys: string[]; on: string[]; offWhy: string[] }>(`(() => { const bs = [...document.querySelectorAll("#dlg .actions > *")];
    return { keys: bs.map((b) => b.dataset.btn), on: bs.filter((b) => !b.disabled && b.dataset.act).map((b) => b.dataset.btn), offWhy: bs.filter((b) => b.disabled).map((b) => b.title) }; })()`);
  expect(buttons).toEqual({ keys: ["preview", "restart", "discard", "merge"], on: ["restart", "discard", "merge"], offWhy: [] });
  // The board says which task is open, for the agent's context ("this task").
  expect(await b.eval<number>(`window.ergaBoard.openTask()`)).toBe(id);
});

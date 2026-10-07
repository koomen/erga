// A task's detail closed and opened again at once: the board still knows which task is open.
import { expect, test, until } from "../fixtures";
import { board, factory, servers } from "./factory";

test.beforeAll(async () => { await servers.factory(); });

test("Close, then the same card again in the same moment: the detail is open and openTask() is the task", async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const id = await f.make("Open me twice");
  const b = await board(tab.page, s.root);
  await until(() => b.eval(`!!document.querySelector('[data-open="${id}"]')`), 10_000, "the card");
  await b.click(`[data-open="${id}"]`);
  await until(() => b.eval(`document.getElementById("dlg").open`), 5000, "the detail");
  // The dialog's close event comes a task later, after the card's click has opened it again.
  // The test waits for that close event (a condition), then reads the board.
  await b.eval(`new Promise((done) => { const d = document.getElementById("dlg"); d.addEventListener("close", () => setTimeout(done), { once: true });
    d.querySelector('[data-act="close"]').click(); document.querySelector('[data-open="${id}"]').click(); })`);
  expect(await b.eval<boolean>(`document.getElementById("dlg").open`)).toBe(true);
  expect(await b.eval<number | null>(`window.ergaBoard.openTask()`)).toBe(id);
});

// Merges held back by a dependency (tests/factory.ts, 8).
import { expect, test } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

test.beforeAll(async () => { await servers.factory(); });

test("a blocked merge is refused (409), and on the board Merge is off with the reason", { timeout: TASK_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const a = await f.make("Blocker");
  const id = await f.make("Blocked", "A note.", { mergeAfter: [a] });
  await f.until([a, id], "complete");
  const r = await f.api(`/tasks/${id}/merge`, { method: "POST" });
  expect(r.status).toBe(409);
  expect(r.body.error).toContain(`can't merge until #${a} merges`);
  const b = await board(tab.page, s.root);
  await expect.poll(() => b.eval<boolean>(`(() => { const c = document.querySelector('[data-col="ready-to-merge"] [data-open="${id}"]'); return !!c && !c.querySelector("[data-btn=merge]") && c.innerText.includes("merges after #${a}"); })()`)).toBe(true);
});

// Unblocking: a dependency removed on the board; when one merges, the task waiting for it starts by itself (tests/factory.ts, 8).
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

await servers.factory();

// A task done, its merge, then the task waiting for it done.
test("a dependency removed with its × on the board; the task merges, the one waiting for it starts by itself, says why, and the board hears it", { timeout: 3 * TASK_MS }, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const other = await f.make("Never merged here");
  const a = await f.make("Merge me, then", "A note.", { mergeAfter: [other] });
  const waiter = await f.make("Follow the hello", "A note.", { startAfter: [a] });
  await f.until(a, "complete");
  const b = await board(tab.page, s.root);
  await b.eval(`(() => { window.__toasts = []; const t = document.getElementById("toast"); new MutationObserver(() => window.__toasts.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true }); return true; })()`);
  await until(() => b.eval(`!!document.querySelector('[data-open="${a}"]')`), 10_000, "the card");
  await b.click(`[data-open="${a}"]`);
  await until(() => b.eval(`!!document.querySelector('#dlg [data-act="undep"][data-dep="${other}"]')`), 5000, "its dependency has a ×");
  await b.click(`#dlg [data-act="undep"][data-dep="${other}"]`);
  await until(async () => { const t = await f.task(a); return !t.mergeAfter.length && !t.blockedBy; }, 5000, "the dependency is removed");
  await b.click('[data-act="close"]');
  expect((await f.api(`/tasks/${a}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(a, "merged");
  await f.until(waiter, ["working", "complete"], 15_000, (t) => !!t.vm);
  const w = await f.task(waiter);
  expect(w.log.some((l) => l.message == `#${a} merged: unblocked: it can start now`)).toBe(true);
  expect(w.blockedBy).toBeFalsy();
  await expect.poll(() => b.eval<boolean>(`window.__toasts.some((t) => t.includes("#${waiter} unblocked: Follow the hello"))`)).toBe(true);
  await f.until(waiter, "complete");
});

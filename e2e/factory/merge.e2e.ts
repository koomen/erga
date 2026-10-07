// Merge and discard, from the board (3 and 4; the change log).
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

await servers.factory();

// A task done, then its merge: two runs of the simulated VM's jobs.
const TWO_STEPS = { timeout: 2 * TASK_MS };

test("merge, on the board: into staging as a --no-ff merge commit named after the task; the branch deleted, the VM and preview gone; the card leaves a board of four columns; the change log has who added and merged it", TWO_STEPS, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const b = await board(tab.page, s.root);
  const id = await f.nextId();
  await b.click("#new");
  await b.fill("#t-title", "Merge me please");
  await b.fill("#t-desc", "A note.");
  await b.click("#create");
  await expect.poll(() => f.status(id).catch(() => null)).toBeTruthy();
  await f.until(id, "complete");
  const t = await f.task(id);
  await until(() => b.eval(`!!document.querySelector('[data-col="ready-to-merge"] [data-open="${id}"] [data-act="merge"]')`), 10_000, "its Merge button");
  await b.click(`[data-col="ready-to-merge"] [data-open="${id}"] [data-act="merge"]`);
  await f.until(id, "merged");
  const merged = await f.task(id);
  const br = f.branches();
  expect(br[t.branch]).toBeUndefined();
  expect(br.staging).toBe(merged.mergeCommit);
  const subject = f.git("log", "-1", "--format=%s %P", "staging").trim();
  expect(subject.startsWith(`Merge task/${id}-merge-me-please: Merge me please`)).toBe(true);
  expect(subject.split(" ").length).toBeGreaterThan(3);
  expect(merged.vm).toBeFalsy();
  expect(merged.url).toBeFalsy();
  await expect.poll(() => b.eval<string>(`document.getElementById("board")?.innerText ?? ""`), { timeout: 15_000 }).not.toContain("Merge me please");
  expect(await b.eval<boolean>(`!!document.querySelector('[data-col="merged"]')`)).toBe(false);
  expect(await b.eval<number>(`document.querySelectorAll("#board .col").length`)).toBe(4);
  // The change log: added on the board, by its admin; merged, by who merged it.
  await tab.page.goto(`${s.root}/admin/changes`);
  await until(() => b.eval(`!!document.querySelector("li.change")`), 10_000, "the change log");
  const log = await b.eval<{ by: string; what: string }[]>(`[...document.querySelectorAll("li.change")].map((li) => ({ by: li.querySelector(".by").textContent, what: li.querySelector(".what").textContent.replace(/\\s+/g, " ").trim() }))`);
  expect(log.find((l) => l.what.startsWith(`task #${id} added: Merge me please`))?.by).toBe("tester");
  expect(log.find((l) => l.what.startsWith(`task #${id} merged into staging as ${merged.mergeCommit.slice(0, 7)}: Merge me please`))?.by).toBe("tester");
});

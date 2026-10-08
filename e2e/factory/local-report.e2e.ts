// A local task reports (2 and 3): a log line, a screenshot, done; and the board shows it
// as local, on its machine, with Hand to a VM.
import { expect, test, until } from "../fixtures";
import { board, factory, servers } from "./factory";
import { join } from "node:path";
import { localAgent, MACHINE } from "./local";

await servers.factory();

test("task log, task shot and task done: ready to merge, pushed, with its summary, the line and the screenshot; the card has a laptop and the machine; the detail says who runs it where, with Hand to a VM and Send to the local agent", async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const agent = await localAgent(s);
  const dir = await agent.checkout("report");
  const a = await agent.register(dir, "Local report", "Add a note file, from a local agent.");
  await agent.commit(dir, "local-a.txt", "A note from a local agent.\n", "Add a local note");
  expect((await agent.task(dir, "log", "Wrote the note")).code).toBe(0);
  const b = await board(tab.page, s.root);
  const png = join(s.scratch, `board-${a}.png`);
  await tab.page.screenshot({ path: png });
  const shot = await agent.task(dir, "shot", png, "The board, from the local agent");
  expect(shot.code, shot.out).toBe(0);
  const done = await agent.task(dir, "done", "This task adds a note file.");
  expect(done.code, done.out).toBe(0);
  const t = await f.task(a);
  const head = (await agent.git(dir, "rev-parse", "HEAD")).stdout.trim();
  expect([t.status, t.commit, f.branches()[t.branch], t.summary]).toEqual(["complete", head, head, "This task adds a note file."]);
  expect(t.screenshots.length).toBe(1);
  expect(await f.logged(a, "Wrote the note")).toBe(true);

  await until(() => b.eval(`!!document.querySelector('[data-open="${a}"] .m.where')`), 5000, "the card has a laptop and the machine");
  const where = await b.eval<{ text: string; tip: string }>(`(() => { const m = document.querySelector('[data-open="${a}"] .m.where'); return { text: m.textContent, tip: m.title }; })()`);
  expect(where.text).toBe(MACHINE);
  expect(where.tip).toContain("A local task");
  await b.click(`[data-open="${a}"]`);
  await until(() => b.eval(`document.getElementById("dlg").open`), 5000, "the detail opens");
  const detail = await b.eval<string>(`document.getElementById("dlg").innerText`);
  for (const part of [`Runs locally: ${agent.by} on ${MACHINE}`, "Hand to a VM", "Send to the local agent"]) expect(detail).toContain(part);
});

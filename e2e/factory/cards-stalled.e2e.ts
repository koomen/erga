// A stalled task (tests/factory-cards.ts): working or needs agent, with no new log line in 5 minutes.
import { expect, servers, test } from "../fixtures";
import { cardBoard } from "./cards";

test.beforeAll(async () => { await servers.main(); });

test("a working task quiet for 12 minutes has a stalled badge (with since when) on its card and in its detail view, and no other does; a new log line clears both", async ({ tab }) => {
  tab.strict = true;
  const pending: string[] = [];
  const f = await cardBoard(tab.page, { fake: { events: () => "retry: 150\n\n" + (pending.length ? "data: " + pending.shift() + "\n\n" : "") } });
  const badges = () => tab.page.evaluate(`Object.fromEntries([...document.querySelectorAll("#board .card")].map((c) => {
    const b = c.querySelector(".stalled-badge");
    return [c.dataset.open, { badge: b?.textContent ?? "", tip: b?.title ?? "", cls: c.classList.contains("stalled") }];
  }))`) as Promise<Record<string, { badge: string; tip: string; cls: boolean }>>;
  // #3 (2 minutes), #10 (needs agent, 3 minutes) and #5 (failed, 45 minutes) are not stalled.
  const st = await badges();
  expect([st[4].badge, st[4].cls]).toEqual(["stalled 12 min", true]);
  expect(st[4].tip.startsWith("No new log line for 12 min, since "), st[4].tip).toBe(true);
  for (const [id, s] of Object.entries(st)) if (id != "4") expect([s.badge, s.cls], `#${id}`).toEqual(["", false]);
  expect(await tab.page.evaluate(`document.querySelector("[data-open='4']").textContent.includes("blocked")`)).toBe(false);
  await tab.page.evaluate(`window.ergaBoard.open(4)`);
  await expect.poll(() => tab.page.evaluate(`document.querySelector("#dlg h3 .stalled-badge")?.textContent ?? ""`)).toBe("stalled 12 min");
  expect(await tab.page.evaluate(`document.getElementById("stalled-note")?.textContent ?? ""`)).toMatch(/^Stalled: No new log line for 12 min/);

  const t = f.tasks[3];
  t.log.push({ at: new Date().toISOString(), message: "Claude runs Bash: bun test" });
  t.updatedAt = new Date().toISOString();
  pending.push(JSON.stringify({ type: "task", task: t }));
  await expect.poll(async () => (await badges())[4]).toEqual({ badge: "", tip: "", cls: false });
  await expect.poll(() => tab.page.evaluate(`!!document.querySelector("#dlg .stalled-badge, #stalled-note")`)).toBe(false);
});

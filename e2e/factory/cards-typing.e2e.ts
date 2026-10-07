// Live updates of the open task while the admin types in its detail view.
import { expect, servers, test, until } from "../fixtures";
import { cardBoard } from "./cards";

await servers.main();

test("typing in the instructions through live updates of the task: the view shows them; the focus, the text, the cursor and a selection stay; the next key replaces the selection; a dependency's kind keeps its choice", async ({ tab }) => {
  tab.strict = true;
  const page = tab.page;
  // Task #6's updates, one each time the page reconnects (every 150 ms), once sending.
  let updates = 0, sending = false;
  const f = await cardBoard(page, { fake: { events: () => {
    if (!sending) return "retry: 150\n\n";
    const task = f.tasks[5];
    task.log.push({ at: new Date().toISOString(), message: "update " + ++updates });
    task.updatedAt = new Date().toISOString();
    return "retry: 150\n\ndata: " + JSON.stringify({ type: "task", task }) + "\n\n";
  } } });
  await page.evaluate(`document.querySelector("#board .card[data-open='6']").click()`);
  await until(() => page.evaluate(`!!document.getElementById("instructions")`), 5000, "the instructions");
  /** Waits until `n` more updates are in the view's log. */
  const through = async (n: number) => { const want = updates + n; await expect.poll(() => page.evaluate(`document.getElementById("task-log").textContent.includes("update ${want}")`), { timeout: 10_000 }).toBe(true); };
  const field = () => page.evaluate(`(() => { const t = document.getElementById("instructions"); return { focus: document.activeElement.id, value: t.value, sel: [t.selectionStart, t.selectionEnd] }; })()`) as Promise<{ focus: string; value: string; sel: number[] }>;
  await page.locator("#instructions").click();
  await page.keyboard.type("Make the button ");
  sending = true;
  await through(1);
  await page.keyboard.type("blue", { delay: 120 });
  await through(2);
  expect(await field()).toEqual({ focus: "instructions", value: "Make the button blue", sel: [20, 20] });
  await page.evaluate(`document.getElementById("instructions").setSelectionRange(5, 8)`);
  await through(2);
  expect(await field()).toMatchObject({ focus: "instructions", sel: [5, 8] });
  await page.keyboard.type("a");
  expect((await field()).value).toBe("Make a button blue");
  await page.evaluate(`(() => { const k = document.getElementById("dep-kind"); k.value = "mergeAfter"; document.getElementById("instructions").focus(); })()`);
  await through(2);
  expect(await page.evaluate<string>(`document.getElementById("dep-kind").value`)).toBe("mergeAfter");
  sending = false;
});

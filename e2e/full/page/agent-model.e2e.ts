// The model menu: Opus 5.5 fast by default, Sonnet 5.5 to pick; the person's other tabs and a reload follow ("Agent model").
import { expect, servers, test, type Page } from "../../fixtures";
import { openEditor } from "../../editor";

await servers.agent();

const select = (p: Page) => p.evaluate(`(() => { const s = document.getElementById("agent-model-select"); return s && { value: s.value, text: s.selectedOptions[0]?.text, options: [...s.options].map((o) => o.text) }; })()`) as Promise<{ value: string; text: string; options: string[] } | null>;

test("the agent starts on Opus 5.5 fast; picking Sonnet 5.5 switches it, the person's other tab follows, and a reload keeps it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.agent(), "noedit");
  await expect.poll(async () => (await select(tab.page))?.value).toBe("opus-fast");
  expect((await select(tab.page))!.options).toEqual(["Sonnet 5.5", "Opus 5.5 fast"]);
  const other = await tab.page.context().newPage();
  await other.goto(`${ed.address}?edit`);
  await expect.poll(async () => (await select(other))?.value).toBe("opus-fast");
  await ed.eval(`(() => { const s = document.getElementById("agent-model-select"); s.value = "sonnet"; s.dispatchEvent(new Event("change")); })()`);
  await expect.poll(async () => (await (await fetch(`${ed.address}/api/agent`)).json() as { choice: string }).choice).toBe("sonnet");
  await expect.poll(async () => (await select(other))?.value).toBe("sonnet");
  await other.close();
  await tab.page.reload();
  await expect.poll(async () => (await select(tab.page))?.value).toBe("sonnet");
});

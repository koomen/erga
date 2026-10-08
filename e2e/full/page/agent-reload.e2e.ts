// The agent panel across a reload ("Agent, empty message").
import { expect, servers, test } from "../../fixtures";
import { openEditor } from "../../editor";

await servers.agent();

test("an unsent message in the agent box survives a reload, and a cleared box stays cleared", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.agent(), "page");
  await ed.openAgent();
  await ed.eval(`document.getElementById("agent-input").focus()`);
  await ed.type("half a thought");
  await tab.page.reload();
  await ed.loaded();
  expect(await ed.eval<string>(`document.getElementById("agent-input").value`)).toMatch(/half a thought$/);
  await ed.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  await tab.page.reload();
  await ed.loaded();
  expect(await ed.eval<string>(`document.getElementById("agent-input").value`)).toBe("");
});

test("an open pane is open after a reload from the first frame; a collapsed one stays collapsed", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.agent(), "page");
  await ed.openAgent();
  const paneOpen = () => ed.eval<boolean>(`document.body.classList.contains("agent-open") && !document.getElementById("agent").inert`);
  await expect.poll(paneOpen).toBe(true);
  // Checked as soon as the new page's script has run.
  await ed.eval(`window.__beforeReload = true; location.reload()`);
  await expect.poll(() => ed.eval<boolean>(`!window.__beforeReload && !!window.ergaPage`).catch(() => false)).toBe(true);
  expect(await paneOpen()).toBe(true);
  await ed.loaded();
  await ed.press("ControlOrMeta+j");
  await expect.poll(paneOpen).toBe(false);
  await tab.page.reload();
  await ed.loaded();
  expect(await paneOpen()).toBe(false);
  expect(await ed.eval<string>(`document.getElementById("agent-fab").getAttribute("aria-expanded")`)).toBe("false");
});

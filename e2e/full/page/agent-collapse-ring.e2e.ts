// Collapsing the agent with the mouse ("hints of a blue ring around the agent"): the circle shows no focus ring and no
// selection; with the keyboard, the ring is there.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.agent();

const ring = `(() => {
  const fab = document.getElementById("agent-fab"), s = getComputedStyle(fab), sel = getSelection();
  return {
    focused: document.activeElement == fab,
    outline: s.outlineStyle != "none" && parseFloat(s.outlineWidth) > 0,
    boxShadow: s.boxShadow != "none",
    selected: !!sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.containsNode(fab, true),
  };
})()`;

test("collapsing the agent with the mouse leaves no ring or selection on its circle; Tab still shows a ring", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.agent(), "page");
  await ed.openAgent();
  await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("agent-open")`)).toBe(true);
  // A real mouse click, once the panel stands still.
  await tab.page.locator("#agent-close").click();
  await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("agent-open")`)).toBe(false);
  // The circle again, the "e" in it.
  await expect.poll(() => ed.eval<string>(`getComputedStyle(document.getElementById("agent-fab")).opacity`)).toBe("1");
  expect(await ed.eval<Record<string, boolean>>(ring)).toEqual({ focused: true, outline: false, boxShadow: false, selected: false });
  // From the keyboard, the ring shows.
  await ed.press("Shift+Tab");
  await ed.press("Tab");
  expect(await ed.eval<Record<string, boolean>>(ring)).toMatchObject({ focused: true, outline: true });
});

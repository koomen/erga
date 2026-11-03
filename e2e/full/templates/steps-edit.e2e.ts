// A presentation's steps in the editor (editing): the controls and the keys outside the text go to
// a step, the arrows in text being edited move the caret, and an edit draws the list's pictures afresh.
import { expect, servers, settle, test } from "../../helpers/fixtures";
import { atStep, bar, clickOn, clickTextEnd, editorReady, frameAt, inPage, openTab, rawKey } from "./templates";

await servers.main();

test("editing: forward and → outside the text go to a step; ← in the heading's text stays; an edit relabels and redraws the list", async ({ tab }) => {
  const s = await servers.main();
  const { address } = await s.fixture("steps");
  const page = tab.page;
  await openTab(tab, `${address}?edit`);
  await editorReady(page);
  await expect.poll(async () => (await bar(page)).shown && (await inPage<number>(page, "ergaSteps.current()")) == 0).toBe(true);
  // The list open first: a click on its toggle later would take the caret out of the page.
  await clickOn(page, ".toggle");
  await expect.poll(async () => (await bar(page)).open).toBe(true);
  await clickOn(page, ".next");
  await atStep(page, 1, 4);
  // A click in the page puts the caret in the nearest text: out of it, the page has the keys.
  const f = await frameAt(page);
  await page.mouse.click(f.x + 30, f.y + 30);
  await settle(page);
  await inPage(page, "document.activeElement.blur(), getSelection().removeAllRanges(), true");
  await rawKey(page, "ArrowRight");
  await atStep(page, 2, 4);
  // Into the heading's text: the arrows move the caret there.
  await clickTextEnd(page, "h1", 4);
  const caret = () => inPage<number>(page, "getSelection().anchorOffset");
  const before = await caret();
  await rawKey(page, "ArrowLeft");
  await expect.poll(caret).toBe(before - 1);
  expect(await inPage<number>(page, "ergaSteps.current()")).toBe(2);
  expect((await bar(page)).at).toBe("3 / 4");

  await expect.poll(async () => (await bar(page)).items.length == 4 && (await bar(page)).items.every((i) => i.img.startsWith("blob:"))).toBe(true);
  const pictures = (await bar(page)).items.map((i) => i.img);
  await page.keyboard.insertText("s");
  await expect.poll(async () => { const b = await bar(page); return b.items[2].label.length == 14 && b.items[2].label != "What they eat" && b.items.every((i, k) => i.img.startsWith("blob:") && i.img != pictures[k]); }).toBe(true);
});

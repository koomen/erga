// Pausing the page: one that defines window.ergaPause stops answering clicks, so its text can be edited; the editor's
// pause button is on the page (libs/text/ui/controls.ts), and a page that can't pause has none ("Pausing the page").
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

const btn = async (ed: Editor) =>
  (await ed.controls<{ shown: boolean; pressed: string | null }>(
    `(() => { const b = C.getElementById("pause-btn"); return { shown: !C.getElementById("pause").hidden, pressed: b.getAttribute("aria-pressed") }; })()`
  )) ?? { shown: false, pressed: null };
const click = (ed: Editor) => ed.controls(`C.getElementById("pause-btn").click()`);
const slide = (ed: Editor) => ed.frame<number>(`${F}.defaultView.slide`);

test("a page with ergaPause can be paused: live, a click drives it; paused, a click places the caret, the page stays put, and the text edits", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "pause");
  await expect.poll(async () => (await btn(ed)).shown).toBe(true);
  await ed.clickEnd("h1");
  await expect.poll(() => slide(ed)).toBe(2);
  await click(ed);
  expect((await btn(ed)).pressed).toBe("true");
  await ed.clickEnd("h1");
  await ed.type("!");
  await expect.poll(() => ed.source()).toContain("advance on click!</h1>");
  expect(await slide(ed)).toBe(2);
});

test("a page rendered afresh stays paused; resuming hands clicks back to it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "pause");
  await expect.poll(async () => (await btn(ed)).shown).toBe(true);
  await click(ed);
  expect((await btn(ed)).pressed).toBe("true");
  // A render from scratch starts the page's script over, at slide 1.
  await ed.frame(`ergaFrame.page.render()`);
  await expect.poll(() => slide(ed)).toBe(1);
  await ed.settle();
  await ed.clickEnd("h1");
  await ed.settle();
  expect((await btn(ed)).pressed).toBe("true");
  expect(await slide(ed)).toBe(1);
  await click(ed);
  await ed.clickEnd("h1");
  expect((await btn(ed)).pressed).toBe("false");
  await expect.poll(() => slide(ed)).toBe(2);
});

test("a page without ergaPause has no pause button", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "noedit");
  await expect.poll(() => ed.controls<boolean>(`!!C.getElementById("fmt")`)).toBe(true);
  expect((await btn(ed)).shown).toBe(false);
});

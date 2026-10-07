// Pausing the page: one that defines window.ergaPause stops answering clicks, so its text can be edited; one that doesn't says so (tests/page.ts, "Pausing the page").
import { expect, servers, test } from "../fixtures";
import { F, openEditor, type Editor } from "../editor";

test.beforeAll(async () => { await servers.main(); });

const btn = (ed: Editor) => ed.eval<{ disabled: string | null; pressed: string | null }>(`(() => { const b = document.getElementById("btn-pause"); return { disabled: b.getAttribute("aria-disabled"), pressed: b.getAttribute("aria-pressed") }; })()`);
const slide = (ed: Editor) => ed.frame<number>(`${F}.defaultView.slide`);

test("a page with ergaPause can be paused: live, a click drives it; paused, a click places the caret, the page stays put, and the text edits", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "pause");
  expect((await btn(ed)).disabled).toBe("false");
  await ed.clickEnd("h1");
  await expect.poll(() => slide(ed)).toBe(2);
  await ed.eval(`document.getElementById("btn-pause").click()`);
  expect((await btn(ed)).pressed).toBe("true");
  await ed.clickEnd("h1");
  await ed.type("!");
  await expect.poll(() => ed.source()).toContain("advance on click!</h1>");
  expect(await slide(ed)).toBe(2);
});

test("a page rendered afresh stays paused; resuming hands clicks back to it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "pause");
  await ed.eval(`document.getElementById("btn-pause").click()`);
  expect((await btn(ed)).pressed).toBe("true");
  // A render from scratch starts the page's script over, at slide 1.
  await ed.eval(`window.ergaPage.page.render()`);
  await expect.poll(() => slide(ed)).toBe(1);
  await ed.clickEnd("h1");
  await ed.settle();
  expect((await btn(ed)).pressed).toBe("true");
  expect(await slide(ed)).toBe(1);
  await ed.eval(`document.getElementById("btn-pause").click()`);
  await ed.clickEnd("h1");
  expect((await btn(ed)).pressed).toBe("false");
  await expect.poll(() => slide(ed)).toBe(2);
});

test("a page without ergaPause can't be paused: hovering the button explains, with a fix button off while the agent is; clicking pauses nothing; Escape closes the card", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "noedit");
  const card = () => ed.eval<{ shown: boolean; text: string; fixDisabled: string | null; fixTitle: string }>(`(() => { const c = document.getElementById("pause-card"), f = document.getElementById("pause-fix"); return { shown: !c.hidden, text: c.textContent, fixDisabled: f.getAttribute("aria-disabled"), fixTitle: f.title }; })()`);
  expect((await btn(ed)).disabled).toBe("true");
  await ed.eval(`document.getElementById("btn-pause").dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }))`);
  const c = await card();
  expect(c.shown).toBe(true);
  expect(c.text).toMatch(/can't be paused/);
  expect(c.fixDisabled).toBe("true");
  expect(c.fixTitle).toMatch(/agent is off/i);
  await ed.eval(`document.getElementById("btn-pause").click()`);
  expect((await btn(ed)).pressed).toBe("false");
  await ed.press("Escape");
  await expect.poll(async () => (await card()).shown).toBe(false);
});

// Enter makes an empty paragraph; typing into it leaves no placeholder <br> behind, on the page or in the file ("Enter and the placeholder <br>").
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

const html = (ed: Editor, sel: string) => ed.frame<string>(`${F}.querySelector(${JSON.stringify(sel)}).innerHTML`);

test("Enter at the end, then typing: the text fills the new paragraph, with no <br> on the page or on disk; undo gives back the <br>, redo the text", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("blockquote p");
  await ed.press("Enter");
  await ed.type("hello");
  await expect.poll(() => ed.source()).toMatch(/<p>Typing never waits\.<\/p>\s*<p>hello<\/p>/);
  expect(await html(ed, "blockquote p:nth-of-type(2)")).toBe("hello");
  await expect.poll(() => ed.disk()).toMatch(/<p>hello<\/p>/);
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toMatch(/<p>Typing never waits\.<\/p>\s*<p><br><\/p>/);
  await ed.press("ControlOrMeta+Shift+z");
  await expect.poll(() => ed.source()).toMatch(/<p>hello<\/p>/);
});

test("Enter twice keeps a blank paragraph, a line high, held open by a <br>; the paragraph typed into has none; Backspace into the blank one leaves none", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("blockquote p");
  await ed.press("Enter");
  await ed.type("hello");
  await expect.poll(() => ed.source()).toMatch(/<p>hello<\/p>/);
  await ed.press("Enter");
  await ed.press("Enter");
  await ed.type("world");
  await expect.poll(() => ed.source()).toMatch(/<p>hello<\/p>\s*<p><br><\/p>\s*<p>world<\/p>/);
  expect(await html(ed, "blockquote p:nth-of-type(4)")).toBe("world");
  expect(await ed.frame<number>(`${F}.querySelector("blockquote p:nth-of-type(3)").getBoundingClientRect().height`)).toBeGreaterThan(10);
  for (let i = 0; i < 5; i++) await ed.press("ArrowLeft");
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).toMatch(/<p>hello<\/p>\s*<p>world<\/p>\s*<\/blockquote>/);
});

test("Enter at the start of a block leaves a blank block before it, held open by a <br>", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("figcaption");
  await ed.press("Home");
  await ed.press("Enter");
  await expect.poll(() => ed.source()).toMatch(/<figcaption><br><\/figcaption>\s*<figcaption>Where the leads go\.<\/figcaption>/);
});

test("Enter in the middle splits the block, and typing starts the second half", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const f = await ed.frameAt();
  const mid = await ed.frame<{ x: number; y: number }>(`(() => { const t = ${F}.querySelector("h2").firstChild; const r = ${F}.createRange(); r.setStart(t, 5); r.setEnd(t, 5); const b = r.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 }; })()`);
  await ed.click(f.x + mid.x, f.y + mid.y);
  await ed.press("Enter");
  await ed.type("X");
  await expect.poll(() => ed.source()).toMatch(/<h2>What <\/h2>\s*<h2>Xchanged<\/h2>/);
});

test("pasting into a new paragraph leaves no <br>", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("p.lede");
  await ed.press("Enter");
  await ed.frame(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", "pasted"); ${F}.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await expect.poll(() => ed.source()).toMatch(/<\/p>\s*<p class="lede">pasted<\/p>/);
});

test("composing (IME) into a new paragraph leaves no <br>, and the page shows the text once", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("p.lede");
  await ed.press("Enter");
  await ed.compose(["か", "かな"], "仮名");
  await expect.poll(() => ed.source()).toMatch(/<\/p>\s*<p class="lede">仮名<\/p>/);
  expect(await ed.frame<string>(`${F}.activeElement.innerHTML`)).toBe("仮名");
});

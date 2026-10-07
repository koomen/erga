// Joins that empty a quote or a list, joins that do nothing, and Delete (tests/page.ts, "Backspace joins a block to the one before").
import { expect, servers, test } from "../fixtures";
import { F, openEditor, type Editor } from "../editor";

await servers.main();

async function backspaceAt(ed: Editor, sel: string, changes = true) {
  const before = await ed.source();
  await ed.clickEnd(sel);
  await ed.press("Home");
  await expect.poll(() => ed.frame<boolean>(`(() => { const e = ${F}.querySelector(${JSON.stringify(sel)}), r = ${F}.getSelection().getRangeAt(0); if (!r.collapsed || !e.contains(r.startContainer)) return false; const x = r.cloneRange(); x.setStart(e, 0); return x.toString() == ""; })()`)).toBe(true);
  await ed.press("Backspace");
  if (changes) await expect.poll(() => ed.source()).not.toBe(before);
  else await ed.idle();
}

test("a quote with nothing left goes", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "join");
  await backspaceAt(ed, "#quoted");
  expect(await ed.source()).not.toMatch(/<blockquote>/);
});

test("a list with nothing left goes, typing goes in at the join and reaches the disk, and undo brings the list back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "join");
  const original = await ed.source();
  await backspaceAt(ed, "#two");
  await ed.idle();
  await ed.press("Home");
  await ed.press("Backspace");
  await ed.idle();
  await ed.type("+");
  await expect.poll(() => ed.source()).toContain(`<p id="gamma">keeps its own type.+Item oneItem two</p>\n    <p id="after">`);
  await expect.poll(() => ed.disk()).toContain("type.+Item oneItem two</p>");
  for (let i = 0; i < 3; i++) await ed.press("ControlOrMeta+z");
  await expect.poll(async () => (await ed.source()) == original && (await ed.count("li")) == 2).toBe(true);
});

test("in the first block Backspace does nothing, and with a picture between, nothing either", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "join");
  const original = await ed.source();
  await backspaceAt(ed, "h1", false);
  expect(await ed.source()).toBe(original);
  expect((await ed.selection()).head).toBe(original.indexOf("Joining blocks</h1>"));
  await backspaceAt(ed, "#cap", false);
  expect(await ed.source()).toBe(original);
});

test("Delete at the end of a block joins the next one to it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "join");
  await ed.clickEnd("#head");
  await ed.press("Delete");
  await expect.poll(() => ed.source()).toContain(`<h2 id="head">A headingkeeps its own type.</h2>`);
});

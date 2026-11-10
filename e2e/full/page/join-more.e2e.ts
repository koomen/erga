// Joins that empty a quote or a list, joins that do nothing, and Delete ("Backspace joins a block to the one before").
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

async function backspaceAt(ed: Editor, sel: string, changes = true) {
  const before = await ed.source();
  await ed.clickEnd(sel);
  await ed.press("Home");
  await expect.poll(() => ed.frame<boolean>(`(() => { const e = ${F}.querySelector(${JSON.stringify(sel)}), r = ${F}.getSelection().getRangeAt(0); if (!r.collapsed || !e.contains(r.startContainer)) return false; const x = r.cloneRange(); x.setStart(e, 0); return x.toString() == ""; })()`)).toBe(true);
  await ed.press("Backspace");
  if (changes) await expect.poll(() => ed.source()).not.toBe(before);
  else await ed.settle();
}

test("a list with nothing left goes, typing goes in at the join and reaches the disk, and undo brings the list back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "join");
  const original = await ed.source();
  await backspaceAt(ed, "#two");
  await ed.press("Home");
  // The first takes the bullet off, the next joins (blocks.ts).
  await ed.press("Backspace");
  await ed.press("Backspace");
  await ed.type("+");
  await expect.poll(() => ed.source()).toContain(`<p id="gamma">keeps its own type.+Item oneItem two</p>\n    <p id="after">`);
  await expect.poll(() => ed.disk()).toContain("type.+Item oneItem two</p>");
  for (let i = 0; i < 4; i++) await ed.press("ControlOrMeta+z");
  await expect.poll(async () => (await ed.source()) == original && (await ed.count("li")) == 2).toBe(true);
});

test("in the first block Backspace makes a heading a paragraph, then does nothing; with a picture between, it puts the caret at the end of the block before", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "join");
  const original = await ed.source();
  await backspaceAt(ed, "#cap", false);
  expect(await ed.source()).toBe(original);
  expect((await ed.selection()).head).toBe(original.indexOf("A quote</p>") + "A quote".length);
  await backspaceAt(ed, "h1", false);
  const para = original.replace("<h1>Joining blocks</h1>", "<p>Joining blocks</p>");
  await expect.poll(() => ed.source()).toBe(para);
  await ed.press("Backspace");
  expect(await ed.source()).toBe(para);
  expect((await ed.selection()).head).toBe(para.indexOf("Joining blocks</p>"));
});

test("Backspace at the start of a paragraph after a code block joins its text to the code's last line, inside the <code>", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "empty");
  await ed.clickEnd("p");
  await ed.type("```\nlet a = 1;");
  await ed.press("ArrowDown");
  await ed.type("After");
  await expect.poll(() => ed.source()).toContain("<pre><code>let a = 1;</code></pre>\n<p>After</p>");
  await ed.press("Home");
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).toContain("<pre><code>let a = 1;After</code></pre>");
  await ed.type("!");
  await expect.poll(() => ed.source()).toContain("<pre><code>let a = 1;!After</code></pre>");
});

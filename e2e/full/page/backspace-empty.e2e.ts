// Backspace in an empty block takes the block away and puts the caret at the end of the block before; Delete there joins the next block to it ("Backspace joins a block to the one before").
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor } from "../../helpers/editor";

await servers.main();

// [the block where Enter makes an empty block after it, its text]
const CASES: [string, string][] = [
  ["h1", "Custom Edit Examples"],
  ["p.intro", "deleting parts of the page with buttons."],
  [".note", "A note in a div."],
  [".item", "A list item."],
  [".url", "/owner/slug/page"],
];

for (const [sel, text] of CASES) {
  test(`after ${sel}: Enter makes an empty block, Backspace takes it away and the caret goes to the end of ${sel}`, async ({ tab }) => {
    const ed = await openEditor(tab, await servers.main(), "backspace-empty");
    const original = await ed.source();
    await ed.clickEnd(sel);
    await ed.press("Enter");
    await expect.poll(() => ed.source()).not.toBe(original);
    await ed.press("Backspace");
    await expect.poll(() => ed.source()).toBe(original);
    expect((await ed.selection()).head).toBe(original.indexOf(text, original.indexOf("<body>")) + text.length);
    expect(await ed.caretIn(sel)).toBe(true);
    // Typing goes in at the end of the block before.
    await ed.type("!");
    await expect.poll(() => ed.source()).toContain(text + "!<");
  });
}

test("Backspace in an empty block after an empty block takes one away, and Delete in an empty block joins the next block to it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "backspace-empty");
  const two = `<p class="intro"><br></p>\n    <p class="intro"><br></p>\n  </header>`;
  expect(await ed.source()).toContain(two);
  await ed.clickEnd("p.intro:last-of-type");
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).toContain(`buttons.</p>\n    <p class="intro"><br></p>\n  </header>`);
  await ed.clickEnd("p.intro:last-of-type");
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).toContain(`buttons.</p>\n  </header>`);
  // Delete: the empty block takes the next block's text.
  await ed.clickEnd(".note");
  await ed.press("Enter");
  await expect.poll(() => ed.count(".note")).toBe(2);
  await ed.press("Delete");
  await expect.poll(() => ed.source()).toContain(`<div class="note">A note in a div.</div>\n    <div class="note">A list item.</div>\n    <div class="view">`);
});

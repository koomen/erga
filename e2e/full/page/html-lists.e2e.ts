// Enter, Backspace and undo in an HTML list ("HTML page").
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

test("Enter at the end of an item makes an empty sibling, and typing fills it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("li:first-child");
  await ed.press("Enter");
  await expect.poll(() => ed.count("li")).toBe(3);
  expect(await ed.textOf("li:nth-child(2)")).toBe("");
  await ed.type("Nicer docs");
  await expect.poll(() => ed.textOf("li:nth-child(2)")).toBe("Nicer docs");
  expect(await ed.source()).toMatch(/<li>Faster builds<\/li>\n\s*<li>Nicer docs<\/li>/);
});

test("Backspace at the start of an item joins it to the one before; undo brings back the split, then the list", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("li:first-child");
  await ed.press("Enter");
  await ed.type("Nicer docs");
  await expect.poll(() => ed.textOf("li:nth-child(2)")).toBe("Nicer docs");
  await ed.press("Home");
  await ed.press("Backspace");
  await expect.poll(() => ed.count("li")).toBe(2);
  expect(await ed.textOf("li:first-child")).toBe("Faster buildsNicer docs");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.count("li")).toBe(3);
  await ed.press("ControlOrMeta+z");
  await ed.press("ControlOrMeta+z");
  await expect.poll(async () => [await ed.count("li"), await ed.textOf("li:first-child")]).toEqual([2, "Faster builds"]);
});

const list = async (ed: Editor) => ((await ed.source()).match(/<ul>[\s\S]*<\/ul>/)?.[0] ?? "").replace(/\s*\n\s*/g, "");

test("Enter in an empty item between two leaves the list there: a paragraph between two lists", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("li:first-child");
  await ed.press("Enter");
  await ed.press("Enter");
  await ed.type("Between");
  await expect
    .poll(() => ed.source())
    .toMatch(/<ul>\s*<li>Faster builds<\/li>\s*<\/ul>\s*<p>Between<\/p>\s*<ul>\s*<li>A <strong>new<\/strong> editor<\/li>\s*<\/ul>/);
});

test("Enter in an empty nested item moves it one level out", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("li:last-child");
  await ed.press("Tab");
  await expect.poll(() => list(ed)).toBe("<ul><li><p>Faster builds</p><ul><li>A <strong>new</strong> editor</li></ul></li></ul>");
  await ed.idle();
  await ed.clickEnd("li li");
  await ed.press("Enter");
  await ed.press("Enter");
  await ed.type("Out");
  await expect
    .poll(() => list(ed))
    .toBe("<ul><li><p>Faster builds</p><ul><li>A <strong>new</strong> editor</li></ul></li><li>Out</li></ul>");
});

// Joins in Markdown: the marks between the blocks go (tests/page.ts, "Backspace joins a block to the one before").
import { expect, servers, test } from "../fixtures";
import { openEditor } from "../editor";

test.beforeAll(async () => { await servers.main(); });

test("a heading joins the paragraph before, the caret at the join; one undo brings back both", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  const original = await ed.source();
  await ed.clickEnd("h2");
  await ed.press("Home");
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).toContain("has an ampersand.Things to do\n\n- Water");
  expect(await ed.count("h2")).toBe(0);
  expect((await ed.selection()).head).toBe((await ed.source()).indexOf("Things to do"));
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
});

test("in a list item the first Backspace takes the marker off, the second joins it to the heading, which stays a heading", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await ed.clickEnd("li:first-child");
  await ed.press("Home");
  await ed.press("Backspace");
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).toContain("## Things to doWater the plants\n- Call");
  expect(await ed.textOf("h2")).toBe("Things to doWater the plants");
});

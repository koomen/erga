// Enter, Backspace and undo in an HTML list ("HTML page").
import { expect, servers, test } from "../fixtures";
import { openEditor } from "../editor";

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

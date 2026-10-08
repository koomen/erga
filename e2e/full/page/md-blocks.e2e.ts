// Enter and Backspace in Markdown quotes, lists and tables ("Markdown page").
import { expect, servers, test } from "../../fixtures";
import { openEditor } from "../../editor";

await servers.main();

test("Enter in a quote continues it: two paragraphs", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await ed.clickEnd("blockquote p");
  await ed.press("Enter");
  await ed.type("Mapping is deterministic.");
  await expect.poll(() => ed.source()).toMatch(/> Typing never waits\.\n> ?\n> Mapping is deterministic\./);
  expect(await ed.count("blockquote p")).toBe(2);
});

test("Enter continues a list; Backspace at the start of the new item takes its marker off", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await ed.clickEnd("li:last-child p");
  await ed.press("Enter");
  await ed.type("Write it down");
  await expect.poll(() => ed.source()).toContain("- Call *Sam* back\n- Write it down\n");
  expect(await ed.count("li")).toBe(3);
  await ed.press("Home");
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).toMatch(/- Call \*Sam\* back\n\s*Write it down/);
});

test("a table cell edits: a click in its text, End, typing", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  const td = await ed.rectOf("td", 0.1);
  await ed.click(td.x, td.y);
  await ed.press("End");
  await ed.type(" Lovelace");
  await expect.poll(() => ed.source()).toMatch(/\| Ada\s+Lovelace\s*\| Math\s*\|/);
});

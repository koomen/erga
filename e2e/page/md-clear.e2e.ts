// Clear formatting, and headings typed as Markdown, in a Markdown file ("Markdown page").
import { expect, servers, test } from "../fixtures";
import { openEditor } from "../editor";

await servers.main();

test("⌘\\ in Markdown drops the marks and the link syntax, and a heading's #s", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await ed.selectAllOf("p:nth-of-type(1)");
  await ed.press("ControlOrMeta+\\");
  await expect.poll(() => ed.source()).toContain("A first paragraph with emphasis, bold, code and a link.\nIt continues");
  await ed.selectAllOf("h2");
  await ed.press("ControlOrMeta+\\");
  await expect.poll(() => ed.source()).toContain("\nThings to do\n");
});

test("'### ' in a Markdown file makes a real heading", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await ed.clickEnd("h1");
  await ed.press("Enter");
  await ed.type("### Sub");
  await expect.poll(() => ed.source()).toMatch(/^### Sub$/m);
});

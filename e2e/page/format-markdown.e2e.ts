// Markdown as you type, on an HTML page ("Styling and views").
import { expect, servers, test } from "../fixtures";
import { openEditor } from "../editor";

await servers.main();

test("typed Markdown becomes styling and the marks go; an underscore inside a word isn't a shortcut", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("h1");
  await ed.type(" **big** and *small* and `x` done");
  await expect.poll(() => ed.source()).toContain("<h1>Launch notes <strong>big</strong> and <em>small</em> and <code>x</code> done</h1>");
  await ed.type(" snake_case_name");
  await expect.poll(() => ed.source()).toContain("snake_case_name</h1>");
});

test("Markdown at the start of a line: ## a heading, - a list, > a quote; Enter leaves them well-formed; ⌘Z brings back the literal marks", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("p.lede");
  await ed.press("Enter");
  await ed.type("## Sub");
  await expect.poll(() => ed.source()).toContain("<h2>Sub</h2>");
  await ed.press("Enter");
  await expect.poll(() => ed.source()).toMatch(/<h2>Sub<\/h2>\s*<p><br><\/p>/);
  await ed.type("- item");
  await expect.poll(() => ed.source()).toMatch(/<ul>\s*<li>item<\/li>\s*<\/ul>/);
  await ed.press("Enter");
  await ed.press("Enter");
  await expect.poll(() => ed.source()).toMatch(/<\/ul>\s*<p><br><\/p>/);
  await ed.type("> quoted");
  await expect.poll(() => ed.source()).toMatch(/<blockquote>\s*<p>quoted<\/p>\s*<\/blockquote>/);
  await ed.press("ControlOrMeta+z");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toContain("<p>&gt; </p>");
});

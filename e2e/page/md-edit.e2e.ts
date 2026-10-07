// The editor on a Markdown page: edits land in the source line (tests/page.ts, "Markdown page").
import { expect, servers, test } from "../fixtures";
import { openEditor } from "../editor";

test.beforeAll(async () => { await servers.main(); });

test("front matter is not rendered; the page renders as units", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  expect(await ed.textOf("#erga-article")).not.toContain("title:");
  expect(await ed.count("[data-erga-id]")).toBeGreaterThanOrEqual(8);
});

test("a heading edit lands in its source line, and on disk", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await ed.clickEnd("h1");
  await ed.type(" 2026");
  await expect.poll(() => ed.source()).toContain("\n# Field notes 2026\n");
  await expect.poll(() => ed.disk()).toContain("# Field notes 2026");
});

test("a typed asterisk is escaped in the source and shown literally", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await ed.clickEnd("p:nth-of-type(1) strong");
  await ed.type("*");
  await expect.poll(() => ed.source()).toContain("**bold\\***");
  expect(await ed.textOf("p:nth-of-type(1) strong")).toBe("bold*");
});

test("⌘B adds ** in Markdown", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await ed.selectChars("h2", 6);
  await ed.press("ControlOrMeta+b");
  await expect.poll(() => ed.source()).toContain("## **Things** to do");
});

test("edits in a code block are not escaped", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await ed.clickEnd("pre");
  await ed.type(" // *not emphasis*");
  await expect.poll(() => ed.source()).toContain("const answer = 42; // *not emphasis*\n```");
});

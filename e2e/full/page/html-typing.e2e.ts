// Typing on an HTML page: the page, the source and the file follow ("HTML page").
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor } from "../../helpers/editor";

await servers.main();

test("typing updates the page, the source and the file; the arrows cross into the next unit and back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("h1");
  await ed.type(" v2");
  await expect.poll(() => ed.textOf("h1")).toBe("Launch notes v2");
  await ed.press("ArrowRight");
  await expect.poll(() => ed.caretIn("p.lede")).toBe(true);
  await ed.press("ArrowUp");
  await expect.poll(() => ed.caretIn("h1")).toBe(true);
  expect(await ed.source()).toContain("<h1>Launch notes v2</h1>");
  await expect.poll(() => ed.disk()).toContain("<h1>Launch notes v2</h1>");
});

test("an ampersand typed is escaped in the source and shown as itself on the page", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("p.lede em");
  await ed.type(" & fun");
  await expect.poll(() => ed.textOf("p.lede em")).toBe("cool & fun");
  expect(await ed.source()).toContain("<em>cool &amp; fun</em>");
});

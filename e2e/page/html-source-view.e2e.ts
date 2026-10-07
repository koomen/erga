// The source view, ⌘⇧P (tests/page.ts, "HTML page").
import { expect, servers, test } from "../fixtures";
import { F, openEditor } from "../editor";

test.beforeAll(async () => { await servers.main(); });

test("⌘⇧P shows the file, and again goes back to a page that edits", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  ed.write(ed.disk().replace("Where the leads go.", "Where leads go now."));
  await expect.poll(() => ed.textOf("figcaption")).toBe("Where leads go now.");
  await ed.press("ControlOrMeta+Shift+p");
  await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("source")`)).toBe(true);
  expect(await ed.source()).toContain("Where leads go now.");
  await ed.press("ControlOrMeta+Shift+p");
  await expect.poll(async () => !(await ed.eval<boolean>(`document.body.classList.contains("source")`)) && await ed.frame<boolean>(`!!${F}.querySelector("h1[data-erga-id]")`)).toBe(true);
  // A click right away puts the caret where it lands: the editor doesn't move it back afterwards.
  await ed.clickEnd("h1");
  await ed.type("!");
  await expect.poll(() => ed.textOf("h1")).toBe("Launch notes!");
});

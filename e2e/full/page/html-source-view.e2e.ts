// The source view, ⌘⇧P ("HTML page").
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor } from "../../helpers/editor";

await servers.main();

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

test("the source view is the file, editable, as code (smaller monospace, lines not wrapped); Esc goes back to the page", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.press("ControlOrMeta+Shift+p");
  await expect.poll(() => ed.eval<string | null>(`document.querySelector("#source .cm-content")?.getAttribute("contenteditable") ?? null`)).toBe("true");
  await ed.settle();
  expect(await ed.eval<boolean>(`(() => { const c = document.querySelector("#source .cm-content"); return getComputedStyle(c).fontSize == "13px" && !c.classList.contains("cm-lineWrapping"); })()`)).toBe(true);
  await ed.press("Escape");
  await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("source")`)).toBe(false);
});

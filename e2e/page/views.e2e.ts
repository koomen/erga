// The view switcher: the page, its Markdown and its HTML (tests/page.ts, "Styling and views").
import { expect, servers, test } from "../fixtures";
import { F, openEditor } from "../editor";

test.beforeAll(async () => { await servers.main(); });

test("the view button shows three views; an HTML file's Markdown view is read-only, as wide as the text, and says so", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.eval(`document.querySelector("#mode [data-mode=text]").click()`);
  await expect.poll(() => ed.eval<boolean>(`document.getElementById("mode").classList.contains("open")`)).toBe(true);
  await ed.eval(`document.querySelector("#mode [data-mode=md]").click()`);
  await expect.poll(() => ed.eval<boolean>(`!!document.querySelector("#source .cm-content")`)).toBe(true);
  await ed.settle();
  const h1Width = await ed.frame<number>(`${F}.querySelector("h1").getBoundingClientRect().width`);
  await expect.poll(async () => Math.abs(await ed.eval<number>(`document.querySelector("#source .cm-content").getBoundingClientRect().width`) - h1Width)).toBeLessThan(4);
  expect(await ed.eval<string>(`document.querySelector("#source .cm-content").getAttribute("contenteditable")`)).toBe("false");
  expect(await ed.eval<boolean>(`document.getElementById("mode-note").hidden`)).toBe(false);
  expect(await ed.eval<string>(`document.querySelector("#source .cm-content").textContent`)).toContain("# Launch notes");
});

test("the HTML view is the file, editable, as code (smaller monospace, lines not wrapped); Esc goes back to the page", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.eval(`document.querySelector("#mode [data-mode=text]").click()`);
  await expect.poll(() => ed.eval<boolean>(`document.getElementById("mode").classList.contains("open")`)).toBe(true);
  await ed.eval(`document.querySelector("#mode [data-mode=html]").click()`);
  await expect.poll(() => ed.eval<string | null>(`document.querySelector("#source .cm-content")?.getAttribute("contenteditable") ?? null`)).toBe("true");
  await ed.settle();
  expect(await ed.eval<boolean>(`(() => { const c = document.querySelector("#source .cm-content"); return getComputedStyle(c).fontSize == "13px" && !c.classList.contains("cm-lineWrapping"); })()`)).toBe(true);
  expect(await ed.eval<boolean>(`document.getElementById("mode-note").hidden`)).toBe(true);
  await ed.press("Escape");
  await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("source")`)).toBe(false);
});

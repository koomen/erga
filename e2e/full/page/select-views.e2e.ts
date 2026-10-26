// Selecting across lines in the HTML view ("Selecting across paragraphs").
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

test("the HTML view selects across lines with a drag, and Backspace deletes them", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.eval(`ergaPage.toggleSource(true)`);
  await expect.poll(() => ed.eval<number>(`document.querySelectorAll("#source .cm-line").length`)).toBeGreaterThan(5);
  await ed.settle();
  const line = (n: number) => ed.eval<{ x: number; y: number }>(`(() => { const l = document.querySelectorAll("#source .cm-line")[${n}]; l.scrollIntoView({ block: "center" }); const r = l.getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; })()`);
  const lines = await ed.eval<string[]>(`[...document.querySelectorAll("#source .cm-line")].map((l) => l.textContent)`);
  const i = lines.findIndex((l) => l.includes("<h1>"));
  const a1 = await line(i), a2 = await line(i + 2);
  await ed.drag(a1.x, a1.y, a2.x, a2.y);
  expect(((await ed.eval<string>(`getSelection().toString()`)).match(/\n/g) ?? []).length).toBeGreaterThanOrEqual(2);
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).not.toContain("<h1>Launch notes</h1>");
});

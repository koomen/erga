// To-do items: "[ ] " makes one, a click ticks it in the file, Enter makes the next, Backspace takes the checkbox off ("To-do lists").
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

const list = async (ed: Editor) => ((await ed.source()).match(/<ul>[\s\S]*<\/ul>/)?.[0] ?? "").replace(/\s*\n\s*/g, "");
const checked = (ed: Editor, n: number) => ed.frame<boolean>(`${F}.querySelectorAll("input[type=checkbox]")[${n}].checked`);
const ITEM = `<li style="list-style: none"><input type="checkbox">`;

test("[ ] in a paragraph makes a to-do list; Enter makes the next item; a click ticks it, in the file and on the page; undo unticks it", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "todo-list");
  await ed.clickEnd("p");
  await ed.press("Enter");
  await ed.type("[ ] Buy milk");
  await expect.poll(() => list(ed)).toBe(`<ul>${ITEM} Buy milk</li></ul>`);
  await ed.press("Enter");
  await ed.type("Walk the dog");
  await expect.poll(() => list(ed)).toBe(`<ul>${ITEM} Buy milk</li>${ITEM} Walk the dog</li></ul>`);
  await ed.idle();
  const box = await ed.rectOf("li:last-child input");
  await ed.click(box.x, box.y);
  await expect
    .poll(() => list(ed))
    .toBe(`<ul>${ITEM} Buy milk</li><li style="list-style: none"><input type="checkbox" checked> Walk the dog</li></ul>`);
  await expect.poll(() => checked(ed, 1)).toBe(true);
  expect(await checked(ed, 0)).toBe(false);
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => list(ed)).toBe(`<ul>${ITEM} Buy milk</li>${ITEM} Walk the dog</li></ul>`);
  await expect.poll(() => checked(ed, 1)).toBe(false);
  // Enter in an empty to-do item at the end leaves the list.
  await ed.clickEnd("li:last-child");
  await ed.press("Enter");
  await ed.press("Enter");
  await ed.type("After");
  await expect.poll(() => ed.source()).toMatch(/Walk the dog<\/li>\s*<\/ul>\s*<p>After<\/p>/);
});

test("- [x] makes a ticked item; Backspace at its text's start takes the checkbox off", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "todo-list");
  await ed.clickEnd("p");
  await ed.press("Enter");
  await ed.type("- [x] Done");
  await expect.poll(() => list(ed)).toBe(`<ul><li style="list-style: none"><input type="checkbox" checked> Done</li></ul>`);
  for (let i = 0; i < 4; i++) await ed.press("ArrowLeft");
  await ed.press("Backspace");
  await expect.poll(() => list(ed)).toBe(`<ul><li>Done</li></ul>`);
});

// The "/" menu (libs/text/ui/slash.ts): "/" at the start of an empty paragraph opens a small menu of blocks. The
// arrow keys and Enter choose one, letters filter it, Esc closes it and leaves the "/" as text. It never opens in the
// middle of a sentence. In a table, Tab in the last cell adds a row.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

/** The menu's items as it shows them, the chosen one in brackets; null while it is closed. */
const menu = (ed: Editor) =>
  ed.frame<string[] | null>(
    `(() => { const m = document.querySelector("erga-slash")?.shadowRoot?.getElementById("menu"); return m && !m.hidden ? [...m.querySelectorAll("li")].map((li) => (li.classList.contains("on") ? "[" + li.firstChild.textContent + "]" : li.firstChild.textContent)) : null; })()`
  );
const start = async (tab: Parameters<typeof openEditor>[0]) => {
  const ed = await openEditor(tab, await servers.main(), "empty");
  await ed.clickEnd("p");
  await ed.idle();
  return ed;
};

test("/ opens the menu; the arrows and Enter choose; letters filter; Esc leaves the / as text; no menu in a sentence", async ({ tab }) => {
  const ed = await start(tab);
  await ed.type("/");
  await expect.poll(() => menu(ed)).toEqual(["[Heading]", "List", "To-do", "Quote", "Code", "Table", "Image", "Divider"]);
  await ed.page.screenshot({ path: ".e2e/shots/slash-menu.png" });
  await ed.press("ArrowDown");
  await expect.poll(() => menu(ed)).toEqual(["Heading", "[List]", "To-do", "Quote", "Code", "Table", "Image", "Divider"]);
  await ed.press("Enter");
  await expect.poll(() => menu(ed)).toBeNull();
  await ed.type("Milk");
  await expect.poll(() => ed.source()).toMatch(/<ul>\s*<li>Milk<\/li>\s*<\/ul>/);

  // A new paragraph after the list (Enter two times), then a heading by its letters.
  await ed.press("Enter");
  await ed.press("Enter");
  await ed.type("/he");
  await expect.poll(() => menu(ed)).toEqual(["[Heading]"]);
  await ed.press("Enter");
  await ed.type("Plan");
  await expect.poll(() => ed.source()).toContain("<h2>Plan</h2>");

  // Esc: the menu closes, the "/" stays, and more letters do not open it again.
  await ed.press("Enter");
  await ed.type("/");
  await expect.poll(async () => (await menu(ed))?.length).toBe(8);
  await ed.press("Escape");
  await expect.poll(() => menu(ed)).toBeNull();
  await ed.clickEnd("p");
  await ed.type("x");
  expect(await menu(ed)).toBeNull();
  await expect.poll(() => ed.source()).toContain("<p>/x</p>");
  // In a sentence: never.
  await ed.type(" and /");
  expect(await menu(ed)).toBeNull();
  await expect.poll(() => ed.source()).toContain("<p>/x and /</p>");
});

test("/ makes a table of 3 by 3, a divider and a code block; Tab in a table's last cell adds a row", async ({ tab }) => {
  const ed = await start(tab);
  await ed.type("/ta");
  await expect.poll(() => menu(ed)).toEqual(["[Table]"]);
  await ed.press("Enter");
  const cells = () => ed.frame<number[]>(`[...document.querySelectorAll("table tr")].map((r) => r.children.length)`);
  await expect.poll(cells).toEqual([3, 3, 3]);
  // The caret is in the first cell.
  await ed.type("Day");
  await expect.poll(() => ed.frame<string>(`document.querySelector("table th").textContent`)).toBe("Day");
  await ed.clickEnd("table tr:last-child td:last-child");
  await ed.type("End");
  await ed.press("Tab");
  await expect.poll(cells).toEqual([3, 3, 3, 3]);
  await ed.type("New");
  await expect.poll(() => ed.frame<string>(`document.querySelector("table tr:last-child td").textContent`)).toBe("New");
  await ed.page.screenshot({ path: ".e2e/shots/slash-table.png" });

  // Below the table: a divider, then a code block.
  await ed.clickEnd("body > p:last-child");
  await ed.type("/di");
  await ed.press("Enter");
  await expect.poll(() => ed.source()).toMatch(/<hr>/);
  await ed.type("/co");
  await expect.poll(() => menu(ed)).toEqual(["[Code]"]);
  await ed.press("Enter");
  await ed.type("let x = 1;");
  await expect.poll(() => ed.source()).toMatch(/<pre><code>let x = 1;<\/code><\/pre>/);
});

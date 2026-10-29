// Tab in a list item, with the caret anywhere in it or a selection: the item moves, or stays, and the focus never
// leaves the editor (before, Tab in the middle of an item's text moved it to the breadcrumbs).
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

/** The page's frame has the focus in the tab, in a text block (or on the page, for a selection across blocks). */
const focused = async (ed: Editor) =>
  (await ed.eval<boolean>(`document.activeElement?.id == "frame"`)) &&
  (await ed.frame<boolean>(
    `document.hasFocus() && (!!${F}.activeElement?.closest("[data-erga-id]") || (${F}.activeElement == ${F}.body && ${F}.documentElement.classList.contains("erga-span")))`
  ));
/** Puts the caret `at` characters into an element's text. */
const caret = async (ed: Editor, selector: string, at: number) => {
  await ed.rectOf(selector);
  const p = await ed.charAt(selector, at);
  await ed.click(p.x, p.y);
  await ed.idle();
};
/** Selects from character `a` of one element's text to character `b` of another's. */
const select = (ed: Editor, from: string, a: number, to: string, b: number) =>
  ed.frame(
    `(() => { const t = (s) => ${F}.createTreeWalker(${F}.querySelector(s), 4).nextNode(); ${F}.getSelection().setBaseAndExtent(t(${JSON.stringify(from)}), ${a}, t(${JSON.stringify(to)}), ${b}); return true; })()`
  );
const nested = (ed: Editor) => ed.count("li li");

test("Tab in the middle of an item's text indents it; the focus stays in the editor, and the caret where it was", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "list-tab");
  await caret(ed, "ul > li:nth-child(3)", 9);
  await ed.press("Tab");
  await expect.poll(() => nested(ed)).toBe(1);
  expect(await focused(ed)).toBe(true);
  await ed.type("X");
  await expect.poll(() => ed.source()).toContain("<li>Item 3: cXheck");
  // At the end of the line (item 4, now the third at the top), and again in the nested item: one level more.
  await caret(ed, "main > ul > li:nth-child(3)", 60);
  await ed.press("End");
  await ed.press("Tab");
  await expect.poll(() => nested(ed)).toBe(2);
  await ed.press("Tab");
  await expect.poll(() => ed.count("li li li")).toBe(1);
  expect(await focused(ed)).toBe(true);
  await ed.press("Shift+Tab");
  await expect.poll(() => ed.count("li li li")).toBe(0);
  expect(await focused(ed)).toBe(true);
});

test("Tab in the first item, Shift+Tab at the top level and Tab in an item with no </li> change nothing, and keep the focus", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "list-tab");
  const before = await ed.source();
  await caret(ed, "ul > li:first-child", 5);
  await ed.press("Tab");
  await ed.press("Shift+Tab");
  await ed.idle();
  expect(await ed.source()).toBe(before);
  expect(await focused(ed)).toBe(true);
  // Items written with no </li>: they stay as they are, and so does the focus.
  await caret(ed, "ul.open > li:nth-child(2)", 3);
  await ed.press("Tab");
  await ed.idle();
  expect(await ed.source()).toBe(before);
  expect(await focused(ed)).toBe(true);
});

test("Tab with a selection in one item, or across items, moves them and keeps the focus", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "list-tab");
  await caret(ed, "ul > li:nth-child(2)", 2);
  await select(ed, "ul > li:nth-child(2)", 2, "ul > li:nth-child(2)", 8);
  await ed.press("Tab");
  await expect.poll(() => nested(ed)).toBe(1);
  expect(await focused(ed)).toBe(true);
  await expect.poll(async () => (await ed.selection()).text).toBe("em 2: ");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => nested(ed)).toBe(0);
  await ed.idle();
  await select(ed, "ul > li:nth-child(5)", 3, "ul > li:nth-child(7)", 3);
  // The selection's text, but for the indents in its source.
  const text = async () => (await ed.selection()).text.replace(/\s+/g, " ");
  await expect.poll(text).toContain("m 5: check");
  const selected = await text();
  await ed.press("Tab");
  await expect.poll(() => nested(ed)).toBe(3);
  expect(await focused(ed)).toBe(true);
  await expect.poll(text).toBe(selected);
  await ed.press("Shift+Tab");
  await expect.poll(() => nested(ed)).toBe(0);
  expect(await focused(ed)).toBe(true);
});

test("Tab in a numbered item, in a to-do item and right after typing indents it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "list-tab");
  await caret(ed, "ol > li:nth-child(2)", 4);
  await ed.press("Tab");
  await expect.poll(() => ed.count("ol li li")).toBe(1);
  expect(await focused(ed)).toBe(true);
  await caret(ed, "ul.todo > li:nth-child(2)", 4);
  await ed.press("Tab");
  await expect.poll(() => ed.count("ul.todo li li")).toBe(1);
  expect(await focused(ed)).toBe(true);
  await caret(ed, "ul > li:nth-child(9)", 4);
  await ed.type("abc");
  await ed.press("Tab");
  await expect.poll(() => nested(ed)).toBe(3);
  expect(await focused(ed)).toBe(true);
  await expect.poll(() => ed.source()).toContain("Itemabc 9");
});

test("Tab and undo in a long page change only the list: no block outside it is touched, and the page doesn't load again", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "list-tab-long");
  expect(await ed.count("[data-erga-id]")).toBeGreaterThan(250);
  await caret(ed, "ul > li:nth-child(6)", 10);
  // Every change the page sees to an element outside the lists, from here on (the time it takes grows with them).
  await ed.frame(
    `(() => { window.__same = true; window.__outside = 0; new MutationObserver((rs) => { for (const r of rs) { const el = r.target.nodeType == 1 ? r.target : r.target.parentElement; if (el && !el.closest("ul, ol") && el.closest("main")) window.__outside++; } }).observe(${F}.body, { subtree: true, attributes: true, childList: true, characterData: true }); return true; })()`
  );
  await ed.press("Tab");
  await expect.poll(() => nested(ed)).toBe(1);
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => nested(ed)).toBe(0);
  await ed.idle();
  expect(await ed.frame<string>(`JSON.stringify({ same: window.__same, outside: window.__outside })`)).toBe(`{"same":true,"outside":0}`);
  expect(await focused(ed)).toBe(true);
});

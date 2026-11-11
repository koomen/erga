// Lists from real keys: "- " and "1. " make a list, Enter, Shift+Enter, Tab, Shift+Tab and Backspace change it, and
// the focus never leaves the editor. Two journeys, each on one page: lists made on an empty page, with keys only and
// checked by what the page shows; Tab in a page that has lists already (e2e/fixtures/list-tab). Then one test with a
// page of its own: Tab in a long page.
import { expect, journey, servers, test } from "../helpers/fixtures";
import { openEditor, openEmpty, type Editor } from "../helpers/editor";
import { caret, checked, extension, focused, lastList, lines, nested, textNow } from "./lists-helpers";

const s = await servers.main();

journey("lists made with keys on an empty page", () => {
  let ed: Editor;
  /** What the page shows after the first step, with `lines` under it: the list that a later step works in. */
  const below = (...lines: string[]) => ["Groceries", "", "• Milk", "• Eggs", "  free range", "", "Done", "", ...lines].join("\n");
  /** The bulleted list that the steps leave, and the numbered list under it. */
  const above = ["• One", "• TwoXY", "• Three", ""];
  const NUMBERS = ["1. One", "2. Two", "    1. Sub", "3. Three"];

  test("- makes a bulleted list; Enter adds an item, Shift+Enter a line in it, Enter in an empty item leaves the list", async ({ tab }) => {
    ed = await openEmpty(tab);
    await ed.type("Groceries");
    await ed.press("Enter");
    await ed.type("- Milk");
    await ed.shows(`
      Groceries

      • Milk|
    `);
    await ed.press("Enter");
    await ed.type("Eggs");
    await ed.press("Shift+Enter");
    await ed.type("free range");
    await ed.shows(`
      Groceries

      • Milk
      • Eggs
        free range|
    `);
    await ed.press("Enter");
    await ed.shows(`
      Groceries

      • Milk
      • Eggs
        free range
      • |
    `);
    await ed.press("Enter");
    await ed.type("Done");
    await ed.shows(`
      Groceries

      • Milk
      • Eggs
        free range

      Done|
    `);
  });

  test("Enter in an item's text splits it; Backspace at an item's start joins it to the item above", async () => {
    await ed.press("Enter");
    await ed.type("- One");
    await ed.press("Enter");
    await ed.type("Two");
    await ed.press("ArrowLeft");
    await ed.press("ArrowLeft");
    await ed.press("Enter");
    await ed.shows(below("• One", "• T", "• |wo"));
    await ed.press("Backspace");
    await ed.shows(below("• One", "• T|wo"));
    await ed.press("Home");
    await ed.press("Backspace");
    await ed.shows(below("• One|Two"));
  });

  // The first Shift+ArrowUp selected only to the start of the line: a second press was needed to reach the line above.
  test("Shift+ArrowUp at the end of the last item selects up to the end of the item above, in one press", async () => {
    // Three items, One, Two and Three, the caret at the end of Three.
    await ed.press("Enter");
    await ed.press("End");
    await ed.press("Enter");
    await ed.type("Three");
    await ed.press("Shift+ArrowUp");
    await ed.shows(below("• One", "• Two[", "• Three]"));
  });

  // The same going down: the first Shift+ArrowDown selected only to the end of the line.
  test("Shift+ArrowDown at the start of an item selects down to the start of the next item, in one press", async () => {
    await ed.press("ArrowRight");
    await ed.press("ArrowUp");
    await ed.press("ArrowUp");
    await ed.press("Home");
    await ed.press("Shift+ArrowDown");
    await ed.shows(below("• [One", "• ]Two", "• Three"));
  });

  // A browser extension (Grammarly, a password manager) adds its own element to the page's body. That made the
  // editor's patch of the page fail, and Tab then Shift+Tab left the item's old place as a blank bullet until a reload.
  test("Tab then Shift+Tab leaves no blank bullet when an extension has put a custom element in the page", async () => {
    await ed.press("ArrowRight");
    await ed.press("End");
    await extension(ed, "grammarly-desktop-integration");
    await ed.press("Tab");
    await ed.press("Shift+Tab");
    await ed.type("X");
    await ed.shows(below("• One", "• TwoX|", "• Three"));
  });

  // The same with an element that is not a custom one: the page loads again after each key, so the step waits for it,
  // as a person's next key would.
  test("Tab then Shift+Tab leaves no blank bullet when an extension has put a plain element in the page", async () => {
    await extension(ed, "div");
    await ed.press("Tab");
    await ed.idle();
    await ed.press("Shift+Tab");
    await ed.idle();
    await ed.type("Y");
    await ed.shows(below("• One", "• TwoXY|", "• Three"));
  });

  // The line of a nested item was not spaced as the other lines.
  test("Tab nests an item under the one above and Shift+Tab brings the next out again; the numbers follow, and the lines stay evenly spaced", async () => {
    await ed.press("ArrowDown");
    await ed.press("End");
    await ed.press("Enter");
    await ed.press("Enter");
    await ed.type("1. One");
    await ed.press("Enter");
    await ed.type("Two");
    await ed.press("Enter");
    await ed.press("Tab");
    await ed.type("Sub");
    await ed.shows(below(...above, "1. One", "2. Two", "    1. Sub|"));
    await ed.press("Enter");
    await ed.press("Shift+Tab");
    await ed.type("Three");
    await ed.shows(`${below(...above, ...NUMBERS)}|`);
  });

  test("two bulleted items, copied into a new item of a numbered list, become its next two numbers", async () => {
    await ed.press("Enter");
    await ed.press("Enter");
    await ed.type("- Ham");
    await ed.press("Enter");
    await ed.type("Jam");
    await ed.press("Shift+Home");
    await ed.press("Shift+ArrowUp");
    await ed.press("ControlOrMeta+c");
    // (ArrowUp with a selection goes up a line from its start, as on a Mac.)
    await ed.press("ArrowUp");
    await ed.press("End");
    await ed.press("Enter");
    await ed.press("ControlOrMeta+v");
    await ed.shows(below(...above, ...NUMBERS, "4. Ham", "5. Jam|", "", "• Ham", "• Jam"));
  });

  test("redo of a Tab nests the item again, the caret stays in it, and typing goes on there", async () => {
    await ed.press("Tab");
    const nested = below(...above, ...NUMBERS, "4. Ham", "    1. Jam|", "", "• Ham", "• Jam");
    await ed.shows(nested);
    await ed.press("ControlOrMeta+z");
    await ed.shows(below(...above, ...NUMBERS, "4. Ham", "5. Jam|", "", "• Ham", "• Jam"));
    await ed.press("ControlOrMeta+Shift+z");
    await ed.shows(nested);
    await ed.type("X");
    await ed.shows(nested.replace("Jam|", "JamX|"));
  });

  test("[ ] in a paragraph makes a to-do list; Enter makes the next item; a click ticks it, in the file and on the page; undo unticks it", async () => {
    const ITEM = `<li style="list-style: none"><input type="checkbox">`;
    // To the end of the page, out of its last list, and a paragraph after it (with no paragraph between, the new item joins the list above).
    await ed.press("ArrowDown");
    await ed.press("ArrowDown");
    await ed.press("End");
    await ed.press("Enter");
    await ed.press("Enter");
    await ed.type("Things to do.");
    await ed.press("Enter");
    await ed.type("[ ] Buy milk");
    await expect.poll(() => lastList(ed)).toBe(`<ul>${ITEM} Buy milk</li></ul>`);
    await ed.press("Enter");
    await ed.type("Walk the dog");
    await expect.poll(() => lastList(ed)).toBe(`<ul>${ITEM} Buy milk</li>${ITEM} Walk the dog</li></ul>`);
    await ed.idle();
    const box = await ed.rectOf("li:last-child input");
    await ed.click(box.x, box.y);
    await expect
      .poll(() => lastList(ed))
      .toBe(`<ul>${ITEM} Buy milk</li><li style="list-style: none"><input type="checkbox" checked> Walk the dog</li></ul>`);
    await expect.poll(() => checked(ed, 1)).toBe(true);
    expect(await checked(ed, 0)).toBe(false);
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => lastList(ed)).toBe(`<ul>${ITEM} Buy milk</li>${ITEM} Walk the dog</li></ul>`);
    await expect.poll(() => checked(ed, 1)).toBe(false);
    // Enter in an empty to-do item at the end leaves the list.
    await ed.clickEnd("body > ul:last-of-type > li:last-child");
    await ed.press("Enter");
    await ed.press("Enter");
    await ed.type("After");
    await expect.poll(() => ed.source()).toMatch(/Walk the dog<\/li>\s*<\/ul>\s*<p>After<\/p>/);
  });

  // "- " and "1. " made a list only at a paragraph's start: on a line after Shift+Enter they stayed as text.
  test("- and 1. at the start of a paragraph's later line, after Shift+Enter, make a list from that line", async () => {
    const end = async () => (await ed.visible()).split("\n").slice(-7).join("\n");
    await ed.press("Shift+Enter");
    await ed.type("- Milk");
    await ed.press("Enter");
    await ed.press("Enter");
    await ed.type("Steps");
    await ed.press("Shift+Enter");
    await ed.type("1. One");
    await expect.poll(end).toBe(["After", "", "• Milk", "", "Steps", "", "1. One|"].join("\n"));
    expect(await ed.source()).toMatch(/<p>After<\/p>\s*<ul>\s*<li>Milk<\/li>\s*<\/ul>\s*<p>Steps<\/p>\s*<ol>\s*<li>One<\/li>\s*<\/ol>/);
  });
});

journey("Tab in a page that has lists", () => {
  let ed: Editor;

  // Tab moved the focus out of the editor.
  test("Tab in the first item, Shift+Tab at the top level and Tab in an item with no </li> change nothing, and keep the focus", async ({
    tab,
  }) => {
    ed = await openEditor(tab, s, "list-tab");
    const before = await textNow(ed);
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

  // Tab in the middle of an item's text moved the focus to the breadcrumbs.
  test("Tab in the middle of an item's text indents it; the focus stays in the editor, and the caret where it was", async () => {
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

  test("Shift+Enter in a to-do item breaks the line in the item, mid-text and at the end; undo and Backspace take it out", async () => {
    const selector = "ul.todo > li:nth-child(1)",
      text = "Buy seeds";
    const items = await ed.count("li");
    const start = await textNow(ed);
    // Mid-text: after the item's fourth character.
    const at = (await ed.textOf(selector)).indexOf(text) + 4;
    await caret(ed, selector, at);
    await ed.press("Shift+Enter");
    await ed.type("Z");
    await expect.poll(() => ed.source()).toContain(`${text.slice(0, 4)}<br>Z${text.slice(4)}`);
    expect(await ed.count("li")).toBe(items);
    await expect.poll(() => lines(ed, selector)).toBe(2);
    // Backspace twice: the Z, then the break; the lines join.
    await ed.press("Backspace");
    await ed.press("Backspace");
    await expect.poll(() => ed.source()).toBe(start);
    await ed.type("Y");
    await expect.poll(() => ed.source()).toContain(`${text.slice(0, 4)}Y${text.slice(4)}`);
    await ed.press("Backspace");
    await expect.poll(() => ed.source()).toBe(start);
    // At the end of the text: a new, empty line in the item, with the caret on it.
    await ed.press("End");
    await ed.press("Shift+Enter");
    await expect.poll(() => lines(ed, selector)).toBe(2);
    expect(await ed.count("li")).toBe(items);
    await ed.type("W");
    await expect.poll(async () => (await ed.source()).replace(/\s+/g, " ")).toMatch(/<br>W<\/li>/);
    await expect.poll(() => lines(ed, selector)).toBe(2);
    // Undo: the W, then the break, each in one step.
    await ed.press("ControlOrMeta+z");
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toBe(start);
    await expect.poll(() => lines(ed, selector)).toBe(1);
    // Backspace on the new, empty line: the break goes, and the caret is at the end of the text again.
    await ed.press("End");
    await ed.press("Shift+Enter");
    await expect.poll(() => lines(ed, selector)).toBe(2);
    await ed.press("Backspace");
    await expect.poll(() => ed.source()).toBe(start);
    await ed.type("V");
    await expect.poll(async () => (await ed.source()).replace(/\s+/g, " ")).toMatch(/V<\/li>/);
    await ed.press("Backspace");
    // One undo takes a break out, mid-text and at the end.
    await caret(ed, selector, at);
    await ed.press("Shift+Enter");
    await expect.poll(() => lines(ed, selector)).toBe(2);
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toBe(start);
    await ed.press("End");
    await ed.press("Shift+Enter");
    await expect.poll(() => lines(ed, selector)).toBe(2);
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toBe(start);
  });
});

// A page of its own: it needs more than 250 blocks.
test("Tab and undo in a long page change only the list: no block outside it is touched, and the page doesn't load again", async ({
  tab,
}) => {
  const ed = await openEditor(tab, s, "list-tab-long");
  expect(await ed.count("[data-erga-text]")).toBeGreaterThan(250);
  await caret(ed, "ul > li:nth-child(6)", 10);
  // Every change the page sees to an element outside the lists, from here on (the time it takes grows with them).
  await ed.frame(
    `(() => { window.__same = true; window.__outside = 0; new MutationObserver((rs) => { for (const r of rs) { const el = r.target.nodeType == 1 ? r.target : r.target.parentElement; if (el && !el.closest("ul, ol") && el.closest("main")) window.__outside++; } }).observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true }); return true; })()`
  );
  await ed.press("Tab");
  await expect.poll(() => nested(ed)).toBe(1);
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => nested(ed)).toBe(0);
  await ed.idle();
  expect(await ed.frame<string>(`JSON.stringify({ same: window.__same, outside: window.__outside })`)).toBe(`{"same":true,"outside":0}`);
  expect(await focused(ed)).toBe(true);
});

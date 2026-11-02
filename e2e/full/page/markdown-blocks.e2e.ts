// Markdown at the start of a line, typed with real keys from an empty page, as a person does in a writing app: what the
// page shows, and how a person takes it back. Google Docs, Notion, Typora and Bear agree on each behavior here.
import { expect, servers, test, type Tab } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

/** An empty page in the editor, the caret in its one paragraph. */
const empty = async (tab: Tab) => {
  const ed = await openEditor(tab, await servers.main(), "empty");
  await ed.clickEnd("p");
  await ed.idle();
  return ed;
};
/** Types text with real key presses, a key for each character ("\n" is Enter). */
const keys = async (ed: Editor, text: string) => {
  for (const ch of text) await ed.press(ch == " " ? "Space" : ch == "\n" ? "Enter" : ch);
};

test("#, - and 1. with a space make a heading and lists; undo gives back the typed marks", async ({ tab }) => {
  const ed = await empty(tab);
  await keys(ed, "## Plan\n- Milk\nEggs\n\n1. One\nTwo");
  await ed.shows(`
    ## Plan

    • Milk
    • Eggs

    1. One
    2. Two|
  `);
  await keys(ed, "\n\n* ");
  await ed.shows(`
    ## Plan

    • Milk
    • Eggs

    1. One
    2. Two

    • |
  `);
  await ed.press("ControlOrMeta+z");
  await ed.shows(`
    ## Plan

    • Milk
    • Eggs

    1. One
    2. Two

    * |
  `);
});

// Tab in a paragraph indents it one step, as Google Docs does, and Shift+Tab takes the step back. The caret stays in
// the paragraph, and the next key types there (Tab moved the focus out of the page once, and the keys went nowhere).
test("Tab in a paragraph indents it, Shift+Tab takes it back, and the next key types there", async ({ tab }: { tab: Tab }) => {
  const ed = await empty(tab);
  await keys(ed, "Plan");
  const left = () => ed.frame<number>(`${F}.querySelector("body > p").getBoundingClientRect().left`);
  const start = await left();
  await ed.press("Tab");
  await ed.press("Tab");
  await keys(ed, "x");
  await ed.shows(`
    Planx|
  `);
  await expect.poll(() => ed.source()).toContain(`<p style="margin-left: 80px">Planx</p>`);
  expect(await left()).toBe(start + 80);
  await ed.press("Shift+Tab");
  await ed.press("Shift+Tab");
  await expect.poll(() => ed.source()).toContain("<p>Planx</p>");
  expect(await left()).toBe(start);
  // Each Tab is its own undo step.
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toContain(`<p style="margin-left: 40px">Planx</p>`);
});

// Backspace at the start of a heading makes it a paragraph, as Notion, Typora and Bear do (editing-blocks.e2e.ts: in the
// middle of a page).
test("Backspace at the start of a heading makes it a paragraph", async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "# Title");
    await ed.press("Home");
    await ed.press("Backspace");
    await ed.shows(`
      |Title
    `);
});

// Backspace at the start of a list's first item takes the bullet off, as Google Docs, Notion, Typora and Bear do. (A
// later item joins the item above: list-keys.e2e.ts.)
test("Backspace at the start of a list item takes the bullet off", async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "- Milk");
    await ed.press("Home");
    await ed.press("Backspace");
    await ed.shows(`
      |Milk
    `);
});

// Enter in an empty line of a quote leaves the quote, as Notion, Typora and Bear do, and as Enter in an empty list item
// leaves the list.
test("Enter twice in a quote leaves the quote", async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "> Quoted\n\nAfter");
    await ed.shows(`
      Quoted

      After|
    `);
    await expect.poll(() => ed.count("blockquote p")).toBe(1);
});

// Backspace at the start of a quote makes it a paragraph again, as Notion, Typora and Bear do.
test("Backspace at the start of a quote makes it a paragraph", async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "> Quoted");
    await ed.press("Home");
    await ed.press("Backspace");
    await expect.poll(() => ed.count("blockquote")).toBe(0);
    await ed.shows(`
      |Quoted
    `);
});

test("- [ ] makes a to-do item that shows a checkbox and no bullet", async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "- [ ] Walk");
    await ed.shows(`
      ☐ Walk|
    `);
  }
);

test("``` and Enter make a code block, with the language as a class; undo gives back the typed marks", async ({ tab }) => {
  const ed = await empty(tab);
  await keys(ed, "```js\nlet a = 1");
  await ed.shows(`
    let a = 1|
  `);
  await expect.poll(() => ed.frame(`${F}.querySelector("pre > code")?.className`)).toBe("language-js");
  await ed.press("ControlOrMeta+z");
  await ed.press("ControlOrMeta+z");
  await ed.shows(`
    \`\`\`js|
  `);
  await expect.poll(() => ed.count("pre")).toBe(0);
});

// Enter at the end of a code line adds a line that shows (a <pre> hides its last line break: a <br> holds the new line
// open until text comes). The snapshot shows a code block's lines with a space between them.
test("Enter in a code block adds a line in it", async ({ tab }: { tab: Tab }) => {
  const ed = await empty(tab);
  await keys(ed, "```js\nlet a = 1\nlet b");
  await ed.shows(`
    let a = 1 let b|
  `);
  await expect.poll(() => ed.source()).toContain(">let a = 1\nlet b</code></pre>");
  await expect.poll(() => ed.count("pre")).toBe(1);
});

// ArrowDown on the last line of a code block that ends the page makes a paragraph after it, as Notion does: else there
// is no way out of the code block with keys.
test("ArrowDown at the end of a code block goes to a paragraph after it", async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "```\ncode");
    await ed.press("ArrowDown");
    await keys(ed, "After");
    await expect.poll(() => ed.textOf("pre")).toBe("code");
    await expect.poll(() => ed.textOf("body > p")).toBe("After");
});

test("---, *** or ___ on its own line, then Enter, makes a horizontal rule; undo gives back the typed marks", async ({ tab }) => {
  const ed = await empty(tab);
  await keys(ed, "Above\n---\nBelow\n***\n");
  await expect.poll(() => ed.count("hr")).toBe(2);
  await expect.poll(() => ed.textOf("body")).not.toContain("---");
  // One undo takes back the last rule only, and gives back its marks with the caret after them.
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.count("hr")).toBe(1);
  await expect.poll(async () => (await ed.visible()).endsWith("Below\n\n***|")).toBe(true);
});

test('after bold text, Enter then "- ", "# " or "[ ] " makes the block and the text typed stays bold, as valid HTML', async ({ tab }) => {
  for (const [marker, want] of [
    ["- ", /<ul>\n {2}<li><strong>item<\/strong><\/li>\n<\/ul>/],
    ["# ", /<h1><strong>item<\/strong><\/h1>/],
    ["[ ] ", /<li style="list-style: none"><input type="checkbox"> <strong>item<\/strong><\/li>/],
  ] as const) {
    const ed = await openEditor(tab, await servers.main(), "empty");
    await ed.clickEnd("p");
    await ed.type("Hello more");
    for (let i = 0; i < 4; i++) await ed.press("Shift+ArrowLeft");
    await ed.press("ControlOrMeta+b");
    await ed.press("End");
    await ed.type(`\n${marker}item`);
    await expect.poll(() => ed.source()).toMatch(want);
  }
});

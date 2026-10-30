// Everyday editing in a page of every kind of block (e2e/fixtures/editing): clicks, Enter, Tab, Backspace, the style
// keys, undo and typing over a selection, as a writer does them, fast. Checked by what the page shows (ed.shows), each
// expected snapshot checked by eye first on `bun run look` screenshots. Where Google Docs, Notion, Typora and Bear
// agree, the editor should do the same.
import { expect, knownBug, servers, test, type Tab } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

const FIRST =
  "First paragraph with some words in it that wrap across more than one line when the page is narrow enough to do so, which it should be at this length of text.";
/** The fixture as the page shows it, the caret nowhere. */
const PAGE = `# Title here

${FIRST}

## Section

• Apple
• Banana

A quote line.

code line one code line two

Last paragraph.`;

/** The editing fixture in the editor, the caret at the end of `selector`'s text. */
const open = async (tab: Tab, selector: string) => {
  const ed = await openEditor(tab, await servers.main(), "editing");
  await ed.clickEnd(selector);
  await ed.idle();
  return ed;
};
/** Whether the caret is in a quote. */
const inQuote = (ed: Editor) => ed.frame<boolean>(`!!${F}.getSelection().anchorNode?.parentElement?.closest("blockquote")`);

// A click in the empty part of the page under the last block puts no caret anywhere, and the keys typed after it are lost.
test(
  "a click under the last block puts the caret at the end of the last block",
  knownBug(async ({ tab }) => {
    const ed = await open(tab, "h1");
    const last = await ed.rectOf("#last", 0.3);
    await ed.click(last.x, last.y + 200);
    await ed.press("X");
    await ed.shows(PAGE.replace("Last paragraph.", "Last paragraph.X|"));
  })
);

// Tab in a paragraph, heading or quote keeps the caret where it is (the browser moved the focus to the next block, and
// the text typed next went there or was lost). Google Docs indents the paragraph; that needs new markup here.
test("Tab in a paragraph keeps the caret in it", async ({ tab }) => {
    const ed = await open(tab, "#q");
    await ed.press("Tab");
    await ed.type("x");
    // Google Docs puts a tab there, Notion indents the block: either way, the x follows the paragraph's text.
    await expect.poll(async () => /A quote line\.[^\n]*x\|/.test(await ed.visible()), { timeout: 3000 }).toBe(true);
});

// Tab in a code block types an indent: two spaces, or a tab where the block's lines start with tabs.
test("Tab in a code block types two spaces", async ({ tab }) => {
  const ed = await open(tab, "pre");
  await ed.press("Home");
  await ed.press("Tab");
  await ed.type("x");
  await expect.poll(() => ed.source()).toContain("code line one\n  xcode line two</pre>");
});

// Enter at the end of a code block adds a line break after the caret: the text typed next joins the last line.
test(
  "Enter at the end of a code block starts a new line in it, and typing goes there",
  knownBug(async ({ tab }) => {
    const ed = await open(tab, "pre");
    await ed.press("End");
    await ed.press("Enter");
    await ed.type("three");
    await ed.shows(PAGE.replace("code line two", "code line two three|"));
    expect(await ed.source()).toContain("code line two\nthree</pre>");
  })
);

// Enter on an empty line of a quote makes another empty line in the quote: there is no way out of it with Enter.
test(
  "Enter on an empty line at the end of a quote leaves the quote",
  knownBug(async ({ tab }) => {
    const ed = await open(tab, "#q");
    await ed.press("Enter");
    await ed.press("Enter");
    await ed.type("y");
    await ed.shows(PAGE.replace("A quote line.", "A quote line.\n\ny|"));
    expect(await inQuote(ed)).toBe(false);
  })
);

// Backspace at the start of a quote joins its text to the list item above; it should take the quote off first.
test(
  "Backspace at the start of a quote turns it into a paragraph",
  knownBug(async ({ tab }) => {
    const ed = await open(tab, "#q");
    await ed.press("Home");
    await ed.press("Backspace");
    await ed.shows(PAGE.replace("A quote line.", "|A quote line."));
    expect(await inQuote(ed)).toBe(false);
  })
);

// Cmd+B, Cmd+I and Cmd+U with no selection only say "Select some text to style first."; the text typed next is plain.
test(
  "Cmd+B with no selection makes the text typed next bold, and Cmd+B again ends it",
  knownBug(async ({ tab }) => {
    const ed = await open(tab, "#last");
    await ed.type(" ");
    await ed.press("ControlOrMeta+b");
    await ed.type("bold");
    await ed.press("ControlOrMeta+b");
    await ed.type(" plain");
    await ed.shows(PAGE.replace("Last paragraph.", "Last paragraph. bold plain|"));
    const weight = (word: string) =>
      ed.frame<number>(
        `(() => { const t = ${F}.createTreeWalker(${F}.querySelector("#last"), 4); for (let n; (n = t.nextNode()); ) if (n.nodeValue.includes(${JSON.stringify(word)})) return +getComputedStyle(n.parentElement).fontWeight; return 0; })()`
      );
    expect(await weight("bold")).toBeGreaterThanOrEqual(600);
    expect(await weight("plain")).toBeLessThan(600);
  })
);

// Enter over a selection takes two undos: the first gives back the split, but the selected text stays gone.
test(
  "one undo after Enter over a selection gives back the selected text",
  knownBug(async ({ tab }) => {
    const ed = await open(tab, "#last");
    for (let i = 0; i < 3; i++) await ed.press("Shift+ArrowLeft");
    await ed.press("Enter");
    await ed.press("ControlOrMeta+z");
    await expect.poll(async () => (await ed.visible()).replace(/[[\]|]/g, ""), { timeout: 3000 }).toBe(PAGE);
  })
);

// Text that comes as input with no key (an IME, the emoji picker, dictation) over a selection across blocks is dropped.
test(
  "composed text over a selection across blocks replaces it",
  knownBug(async ({ tab }) => {
    const ed = await open(tab, "h2");
    const a = await ed.charAt("h2", 3),
      b = await ed.charAt("#q", 3);
    await ed.drag(a.x, a.y, b.x, b.y);
    await ed.compose(["n", "に"], "日");
    await ed.shows(`
    # Title here

    ${FIRST}

    ## Sec日|uote line.

    code line one code line two

    Last paragraph.
  `);
  })
);

// With one more element in the page's body (as browser extensions add), fast typing after ⌘A ⌘A Backspace keeps every
// letter: the page is patched around the element (it was loaded again, and the keys typed meanwhile were lost).
test("with an extension's element in the page, typing after Cmd+A twice and Backspace keeps every letter", async ({ tab }) => {
    const ed = await openEditor(tab, await servers.main(), "editing");
    await ed.frame(`(${F}.body.appendChild(${F}.createElement("div")), true)`);
    await ed.clickEnd("#last");
    await ed.idle();
    await ed.press("ControlOrMeta+a");
    await ed.press("ControlOrMeta+a");
    await ed.press("Backspace");
    for (const k of "fresh") await ed.press(k);
    await ed.shows(`# fresh|`);
});

// Works: undo all the way back after mixed edits gives back the page exactly, and redo all the way gives the edits again.
test("undo all the way back gives the start exactly; redo all the way gives the edits", async ({ tab }) => {
  const ed = await open(tab, "#last");
  const start = await ed.source();
  await ed.type(" More words");
  await ed.press("Enter");
  await ed.type("new para");
  for (let i = 0; i < 4; i++) await ed.press("Shift+ArrowLeft");
  await ed.press("ControlOrMeta+b");
  await ed.press("ArrowRight");
  await ed.press("Backspace");
  await ed.press("ArrowUp");
  await ed.type("X");
  const edited = await ed.visible();
  for (let i = 0; i < 30; i++) await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(start);
  await ed.shows(PAGE.replace("Last paragraph.", "Last paragraph.|"));
  for (let i = 0; i < 30; i++) await ed.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await ed.visible()).replace(/[[\]|]/g, "")).toBe(edited.replace(/[[\]|]/g, ""));
});

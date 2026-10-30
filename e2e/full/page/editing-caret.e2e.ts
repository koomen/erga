// Moving the caret and selecting with keys, as a writer does, in a page of every kind of block (e2e/fixtures/editing):
// checked by what the page shows (ed.shows), each expected snapshot checked by eye first on `bun run look` screenshots.
// Where Google Docs, Notion, Typora and Bear agree, the editor should do the same. Keys a Mac turns into its own editing
// commands (Cmd+arrows, Option+arrows) go through page.keyboard, as a real keyboard sends them.
import { expect, servers, test, type Tab } from "../../helpers/fixtures";
import { F, openEditor } from "../../helpers/editor";

await servers.main();

const FIRST =
  "First paragraph with some words in it that wrap across more than one line when the page is narrow enough to do so, which it should be at this length of text.";

/** The editing fixture in the editor, the caret at the end of `selector`'s text. */
const open = async (tab: Tab, selector: string) => {
  const ed = await openEditor(tab, await servers.main(), "editing");
  await ed.clickEnd(selector);
  await ed.idle();
  return ed;
};

// Was a bug: ArrowDown out of the big title skips the first line of the wrapped paragraph under it, and lands on its second line.
test("ArrowDown from the title's start goes to the first line of the paragraph under it", async ({ tab }) => {
    const ed = await open(tab, "h1");
    await ed.press("Home");
    await ed.press("ArrowDown");
    await ed.type("Y");
    await ed.shows(`
    # Title here

    Y|${FIRST}

    ## Section

    • Apple
    • Banana

    A quote line.

    code line one code line two

    Last paragraph.
  `);
});

// Was a bug: The column is lost once the caret passes a short block: back on the long line, it is at the short block's column.
test("ArrowDown then ArrowUp across short blocks comes back to the same column", async ({ tab }) => {
    const ed = await open(tab, "#first");
    // The click lands in "this" at the end of the second line.
    await ed.press("ArrowLeft");
    await ed.shows(`
    # Title here

    ${FIRST.replace("at this", "at th|is")}

    ## Section

    • Apple
    • Banana

    A quote line.

    code line one code line two

    Last paragraph.
  `);
    for (const k of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp"]) await ed.press(k);
    await ed.type("Z");
    await ed.shows(`
    # Title here

    ${FIRST.replace("at this", "at thZ|is")}

    ## Section

    • Apple
    • Banana

    A quote line.

    code line one code line two

    Last paragraph.
  `);
});

// Was a bug: Shift+ArrowDown on a one-line block selects to the block's end and stops there; a second press goes on.
test("Shift+ArrowDown from the start of a heading selects down to the start of the next line", async ({ tab }) => {
    const ed = await open(tab, "h2");
    await ed.press("Home");
    await ed.press("Shift+ArrowDown");
    await ed.shows(`
    # Title here

    ${FIRST}

    ## [Section

    • ]Apple
    • Banana

    A quote line.

    code line one code line two

    Last paragraph.
  `);
});

// Was a bug: Cmd+ArrowDown goes only to the end of the block the caret is in, not to the end of the page (Cmd+Shift+ArrowDown does).
test("Cmd+ArrowDown goes to the end of the page", async ({ tab }) => {
    const ed = await open(tab, "h2");
    await ed.page.keyboard.press("Meta+ArrowDown");
    await ed.shows(`
    # Title here

    ${FIRST}

    ## Section

    • Apple
    • Banana

    A quote line.

    code line one code line two

    Last paragraph.|
  `);
});

// Was a bug: Option+ArrowRight at the end of a block stays there: it never goes on to the next block's first word.
test("Option+ArrowRight at the end of a heading goes to the end of the next block's first word", async ({ tab }) => {
    const ed = await open(tab, "h2");
    await ed.page.keyboard.press("Alt+ArrowRight");
    await ed.shows(`
    # Title here

    ${FIRST}

    ## Section

    • Apple|
    • Banana

    A quote line.

    code line one code line two

    Last paragraph.
  `);
});

// Was a bug: Cmd+ArrowRight (and End) on a wrapped line draws the caret at the start of the next line, not at the end of this one.
test("Cmd+ArrowRight on a wrapped line draws the caret at the end of that line", async ({ tab }) => {
    const ed = await open(tab, "h2");
    await ed.press("ArrowUp");
    await ed.press("ArrowUp");
    await ed.page.keyboard.press("Meta+ArrowRight");
    // The caret's top, and the top of "this", the last word of the second line.
    const at = () =>
      ed.frame<{ caret: number; line: number }>(`(() => {
    const p = ${F}.querySelector("#first"), t = p.firstChild, i = t.nodeValue.indexOf("this length");
    const r = ${F}.createRange(); r.setStart(t, i); r.setEnd(t, i + 1);
    return { caret: Math.round(${F}.querySelector("erga-caret").getBoundingClientRect().top), line: Math.round(r.getBoundingClientRect().top) };
  })()`);
    await expect
      .poll(
        async () => {
          const a = await at();
          return Math.abs(a.caret - a.line) < 4;
        },
        { timeout: 3000 }
      )
      .toBe(true);
});

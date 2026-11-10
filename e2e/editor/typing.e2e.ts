// Typing on a page: text, Enter, Backspace, Tab and undo, as a writer does them. The page, the source and the file on
// disk agree, no key is lost, and undo gives the text back. Five journeys, each on one page: a page of every kind of
// content (e2e/fixtures/page), a page of plain blocks (editing), two pages of blocks to join (join, join-cases), and
// a deck, whose own keys work after Escape.
import { expect, journey, servers, test } from "../helpers/fixtures";
import { F, openEditor, type Editor } from "../helpers/editor";
import { backspaceAt, burst, editable, html, joins, list, moves, textNow, weight } from "./typing-helpers";

const s = await servers.main();

test("the homepage and the documents list answer", async () => {
  for (const path of ["/", "/docs"]) expect((await fetch(`${s.root}${path}`)).status, path).toBe(200);
});

journey("typing on a page", () => {
  let ed: Editor;

  test("a page opens with the caret in its first text: typing at once edits it, and undo takes it back", async ({ tab }) => {
    ed = await openEditor(tab, s, "page");
    const original = await ed.source();
    await ed.type("x");
    await expect.poll(() => ed.source()).toContain("<h1>xLaunch notes</h1>");
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toBe(original);
    expect(await ed.textOf("h1")).toBe("Launch notes");
  });

  test("typed text shows on the page, in the source and in the file; the arrows cross into the next block and back", async () => {
    await ed.clickEnd("h1");
    await ed.type(" v2");
    await expect.poll(() => ed.textOf("h1")).toBe("Launch notes v2");
    await ed.press("ArrowRight");
    await expect.poll(() => ed.caretIn("p.lede")).toBe(true);
    await ed.press("ArrowUp");
    await expect.poll(() => ed.caretIn("h1")).toBe(true);
    expect(await ed.source()).toContain("<h1>Launch notes v2</h1>");
    await expect.poll(() => ed.disk()).toContain("<h1>Launch notes v2</h1>");
  });

  // Backspace in the empty block did nothing: the editor looked for text before the caret, and found none.
  test("Enter after the heading makes an empty block; Backspace takes it away, and the caret goes to the heading's end", async () => {
    const before = await textNow(ed);
    await ed.press("End");
    await ed.press("Enter");
    await expect.poll(() => ed.source()).not.toBe(before);
    await ed.press("Backspace");
    await expect.poll(() => ed.source()).toBe(before);
    expect((await ed.selection()).head).toBe(before.indexOf("Launch notes v2", before.indexOf("<body>")) + "Launch notes v2".length);
    expect(await ed.caretIn("h1")).toBe(true);
    await ed.type("!");
    await expect.poll(() => ed.source()).toContain("<h1>Launch notes v2!</h1>");
  });

  // Keys typed right after Enter were lost while the page drew the new paragraph.
  test("Enter, then typing at once fills the new paragraph, with no <br> on the page or on disk; undo gives back the <br>, redo the text", async () => {
    await ed.clickEnd("blockquote p");
    await burst(ed, "Enter", "hello");
    await expect.poll(() => ed.source()).toMatch(/<p>Typing never waits\.<\/p>\s*<p>hello<\/p>/);
    expect(await html(ed, "blockquote p:nth-of-type(2)")).toBe("hello");
    await expect.poll(() => ed.disk()).toMatch(/<p>hello<\/p>/);
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toMatch(/<p>Typing never waits\.<\/p>\s*<p><br><\/p>/);
    await ed.press("ControlOrMeta+Shift+z");
    await expect.poll(() => ed.source()).toMatch(/<p>hello<\/p>/);
  });

  test("composing (IME) into a new paragraph leaves no <br>, and the page shows the text once", async () => {
    await ed.idle();
    await ed.clickEnd("p.lede");
    await ed.press("Enter");
    await ed.compose(["か", "かな"], "仮名");
    await expect.poll(() => ed.source()).toMatch(/<\/p>\s*<p class="lede">仮名<\/p>/);
    expect(await ed.frame<string>(`${F}.getSelection().focusNode.parentElement.closest("[data-erga-text]").innerHTML`)).toBe("仮名");
  });

  // The X typed right after Tab was lost, or went in the wrong place, while the page drew the nested list.
  test("Tab nests a list item, and typing at once goes at the start of its text", async () => {
    // Three items in a row first, from the page's two.
    await ed.clickEnd("li:last-child");
    await ed.press("Enter");
    await ed.type("Fewer bugs");
    await expect.poll(() => list(ed)).toBe("<ul><li>Faster builds</li><li>A <strong>new</strong> editor</li><li>Fewer bugs</li></ul>");
    await ed.idle();
    await ed.clickEnd("li:nth-child(2)");
    await ed.press("Home");
    await burst(ed, "Tab", "X");
    await expect.poll(() => ed.source()).toMatch(/<ul>\s*<li>Faster builds\s*<ul>\s*<li>XA <strong>new<\/strong> editor<\/li>/);
  });

  test("the next item joins the nested list; Tab again makes three levels, on the page too; undo and redo", async () => {
    const two = "<ul><li>Faster builds<ul><li>XA <strong>new</strong> editor</li><li>Fewer bugs</li></ul></li></ul>";
    // An indent renders the page afresh: a click waits for the new page (ed.idle), keys don't need to.
    await ed.idle();
    await ed.clickEnd("li:nth-child(2)");
    await ed.press("Home");
    await ed.press("Tab");
    await expect.poll(() => list(ed)).toBe(two);
    await ed.idle();
    await ed.clickEnd("li li:last-child");
    await ed.press("Home");
    await ed.press("Tab");
    await expect
      .poll(() => list(ed))
      .toBe("<ul><li>Faster builds<ul><li>XA <strong>new</strong> editor<ul><li>Fewer bugs</li></ul></li></ul></li></ul>");
    await expect.poll(async () => (await ed.count("li li li")) == 1 && (await editable(ed))).toBe(true);
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => list(ed)).toBe(two);
    await ed.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => (await ed.count("li li li")) == 1 && (await editable(ed))).toBe(true);
  });

  // The last step: the button's script changes text of the page that is in the source, so the page no longer shows
  // its HTML, and the editor's check says so at the next edit.
  test("a widget's button works inside the editor", async () => {
    await ed.idle();
    const r = await ed.rectOf("#bump");
    await ed.click(r.x, r.y);
    await expect.poll(() => ed.textOf("#count")).toBe("1");
  });
});

const FIRST =
  "First paragraph with some words in it that wrap across more than one line when the page is narrow enough to do so, which it should be at this length of text.";
/** The editing fixture as the page shows it, the caret nowhere. */
const PAGE = `# Title here

${FIRST}

## Section

• Apple
• Banana

A quote line.

code line one code line two

Last paragraph.`;

journey("everyday editing in a page of plain blocks", () => {
  let ed: Editor;
  /** What the page shows now, with no caret: each step changes it, and puts the caret in. */
  let now = PAGE;

  // The click put no caret anywhere, and the keys typed after it were lost.
  test("a click under the last block puts the caret at the end of the last block", async ({ tab }) => {
    ed = await openEditor(tab, s, "editing");
    await ed.clickEnd("h1");
    await ed.idle();
    const last = await ed.rectOf("#last", 0.3);
    await ed.click(last.x, last.y + 200);
    await ed.press("X");
    await ed.shows(now.replace("Last paragraph.", "Last paragraph.X|"));
    now = now.replace("Last paragraph.", "Last paragraph.X");
  });

  // The click put no caret, or put it in another block.
  test("a click in the margin puts the caret at the start or end of the line beside it", async () => {
    const left = await ed.rectOf("h2", 0);
    await ed.click(left.x - 10, left.y);
    await ed.press("X");
    const right = await ed.rectOf("#last", 1);
    await ed.click(right.x + 100, right.y);
    await ed.press("Y");
    now = now.replace("## Section", "## XSection");
    await ed.shows(now.replace("Last paragraph.X", "Last paragraph.XY|"));
    now = now.replace("Last paragraph.X", "Last paragraph.XY");
  });

  // Cmd+B with no selection only said "Select some text to style first."
  test("Cmd+B with no selection makes the text typed next bold, and Cmd+B again ends it", async () => {
    await ed.type(" ");
    await ed.press("ControlOrMeta+b");
    await ed.type("bold");
    await ed.press("ControlOrMeta+b");
    await ed.type(" plain");
    await ed.shows(now.replace("Last paragraph.XY", "Last paragraph.XY bold plain|"));
    now = now.replace("Last paragraph.XY", "Last paragraph.XY bold plain");
    expect(await weight(ed, "#last", "bold")).toBeGreaterThanOrEqual(600);
    expect(await weight(ed, "#last", "plain")).toBeLessThan(600);
    expect(await ed.source()).toContain(`<p id="last">Last paragraph.XY <strong>bold</strong> plain</p>`);
  });

  // Pete's decision: the first Backspace makes the heading a paragraph, as Notion and Typora do (it joined at once).
  test("Backspace at the start of a heading makes it a paragraph; the next joins it to the block above", async () => {
    await ed.clickEnd("h2");
    await ed.press("Home");
    await ed.press("Backspace");
    await ed.shows(now.replace("## XSection", "|XSection"));
    expect(await ed.source()).toContain("<p>XSection</p>");
    await ed.press("Backspace");
    await ed.shows(now.replace(`${FIRST}\n\n## XSection`, `${FIRST}|XSection`));
    now = now.replace(`${FIRST}\n\n## XSection`, `${FIRST}XSection`);
  });

  // Tab moved the focus to the next block, and the text typed next went there or was lost.
  test("Tab indents the paragraph of a quote, and a selection's blocks; the caret stays", async () => {
    await ed.idle();
    await ed.clickEnd("#q");
    await ed.press("Tab");
    await ed.type("x");
    await ed.shows(now.replace("A quote line.", "A quote line.x|"));
    now = now.replace("A quote line.", "A quote line.x");
    await expect.poll(() => ed.source()).toContain(`<p id="q" style="margin-left: 40px">A quote line.x</p>`);
    await ed.press("ControlOrMeta+a");
    await ed.press("ControlOrMeta+a");
    await ed.press("Tab");
    await expect.poll(() => ed.source()).toContain(`<h1 style="margin-left: 40px">Title here</h1>`);
    expect(await ed.source()).toContain(`<p id="q" style="margin-left: 80px">`);
    expect(await ed.source()).toContain("<li>Apple</li>");
  });

  // Text that comes as input with no key (an IME, the emoji picker, dictation) over a selection was dropped.
  test("composed text over a selection across blocks replaces it", async () => {
    // (The Tab of the step before has drawn the page: a drag on a page that is being drawn is lost.)
    await ed.idle();
    const a = await ed.charAt("#first", 3),
      b = await ed.charAt("#q", 3);
    await ed.drag(a.x, a.y, b.x, b.y);
    await ed.compose(["n", "に"], "日");
    await ed.shows(`
      # Title here

      Fir日|uote line.x

      code line one code line two

      Last paragraph.XY bold plain
    `);
  });

  // With one more element in the page's body (as browser extensions add), the page loaded again, and the keys typed
  // meanwhile were lost.
  test("with an extension's element in the page, typing after Cmd+A twice and Backspace keeps every letter", async () => {
    await ed.frame(`(${F}.body.appendChild(${F}.createElement("div")), true)`);
    await ed.clickEnd("#last");
    await ed.idle();
    await ed.press("ControlOrMeta+a");
    await ed.press("ControlOrMeta+a");
    await ed.press("Backspace");
    for (const k of "fresh") await ed.press(k);
    await ed.shows(`# fresh|`);
  });

  // Pete's keys. The Backspace took the last line away with the letter: the caret showed on the empty line above,
  // and the next letter went there.
  test("Backspace of the one letter on a last line after a line break leaves that line, and the caret on it", async () => {
    await ed.press("Enter");
    await ed.type("The way we work.");
    await ed.press("Shift+Enter");
    await ed.press("Shift+Enter");
    await ed.type("s");
    await ed.press("Backspace");
    await ed.shows(`
      # fresh

      The way we work.

      |
    `);
    await ed.type("X");
    await ed.shows(`
      # fresh

      The way we work.

      X|
    `);
  });
});

journey("Backspace joins a block to the one before", () => {
  let ed: Editor;

  test("a paragraph into a paragraph: it joins, the page shows it, the caret is at the join, and one undo brings back both", async ({
    tab,
  }) => {
    ed = await openEditor(tab, s, "join");
    const original = await ed.source();
    const joined = `<p id="alpha">Press Backspace at the <em>start</em>|of a paragraph to join it.</p>\n    <h2`;
    const plain = joined.replace("|", "");
    await backspaceAt(ed, "#beta");
    const src = await ed.source();
    expect(src).toContain(plain);
    expect(src).not.toContain(`id="beta"`);
    await expect
      .poll(
        async () =>
          (await ed.count("#beta")) == 0 && (await ed.textOf("#alpha")) == "Press Backspace at the startof a paragraph to join it."
      )
      .toBe(true);
    expect((await ed.selection()).head).toBe(src.indexOf(plain) + joined.indexOf("|"));
    expect(await ed.caretIn("#alpha")).toBe(true);
    await ed.press("ControlOrMeta+z");
    await expect.poll(async () => (await ed.source()) == original && (await ed.count("#beta")) == 1).toBe(true);
  });

  // The keys sent right after the join were lost while the page drew it.
  test("a join that empties a list, then Backspace and typing at once: no key is lost", async () => {
    await ed.idle();
    await ed.clickEnd("#two");
    await ed.press("Home");
    await ed.press("Backspace");
    await ed.press("Home");
    // (The first Backspace takes the bullet off.)
    await ed.press("Backspace");
    await burst(ed, "Backspace", "+");
    await expect.poll(() => ed.source()).toContain(`<p id="gamma">keeps its own type.+Item oneItem two</p>`);
  });
});

journey("joins of blocks of every kind", () => {
  let ed: Editor;

  test("Backspace: a block that starts in nested inline elements joins, the caret at the join, and one undo splits it again", async ({
    tab,
  }) => {
    ed = await openEditor(tab, s, "join-cases");
    await joins(ed, "Before a span", "Deep at the start", "Backspace");
  });

  test("with a widget between: Backspace puts the caret at the end of the block before, and Delete at the start of the next", async () => {
    await moves(ed, "Before a widget", "After the widget");
  });

  test("Delete: a paragraph after a div joins, the caret at the join, and one undo splits it again", async () => {
    await joins(ed, "A div", "then a paragraph", "Delete");
  });
});

journey("Escape on a deck", () => {
  let ed: Editor;

  test("Escape with the Share card open closes the card, and the caret stays in the text", async ({ tab }) => {
    ed = await openEditor(tab, s, "deck");
    await ed.clickEnd("h1");
    await ed.eval(`document.getElementById("btn-share").click()`);
    expect(await ed.eval<boolean>(`!document.getElementById("sharing").hidden`)).toBe(true);
    await ed.press("Escape");
    await expect.poll(() => ed.eval<boolean>(`document.getElementById("sharing").hidden`)).toBe(true);
    // The card's box had the focus: it goes back to the text, by message, a moment later.
    await expect.poll(() => ed.caretIn("[data-erga-text]")).toBe(true);
    await ed.press("ArrowLeft");
    await ed.type("!");
    await ed.shows(`
      # First slid!|e

      The arrows move between slides.
    `);
  });

  test("Escape leaves the text: the deck's arrows move between slides, the text stays as it was; a click on text edits again", async () => {
    const before = await textNow(ed);
    await ed.press("Escape");
    await expect.poll(() => ed.frame<boolean>(`!${F}.activeElement?.closest("[contenteditable]")`)).toBe(true);
    await ed.press("ArrowRight");
    await ed.press("ArrowRight");
    await ed.shows(`
      # Third slide

      The last one.
    `);
    // The focus stays in the page, not in the shell's controls.
    expect(await ed.eval<boolean>(`document.activeElement?.tagName == "IFRAME"`)).toBe(true);
    await ed.type("x");
    expect(await ed.source()).toBe(before);
    await ed.clickEnd(".current h1");
    await ed.type("!");
    await ed.shows(`
      # Third slide!|

      The last one.
    `);
    expect(await ed.source()).toContain("<h1>Third slide!</h1>");
  });
});

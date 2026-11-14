// The caret, the arrows and selections, by keys and by mouse: the caret that the editor draws is where the text is, an
// arrow goes where a writer expects, and a selection takes the range that the keys or the mouse gave it. Five pages,
// each a journey: a narrow page of every kind of block, a page whose paragraph ends before a heading, a board that
// pans, a page with spaces at the ends of its blocks, and a page with a widget between its blocks. The checks need
// the real layout: they read where the page draws the text.
import { expect, journey, servers, settle, test, until } from "../helpers/fixtures";
import { F, openEditor, type Editor } from "../helpers/editor";
import { pointerOnPage } from "../helpers/press";
import {
  board,
  CARET,
  type Caret,
  clickAt,
  domText,
  drawn,
  hosts,
  onPage,
  openNew,
  selected,
  startOf,
  stop,
  symmetric,
  wordAndEnd,
  zoom,
} from "./caret-helpers";

const s = await servers.main();

const FIRST =
  "First paragraph with some words in it that wrap across more than one line when the page is narrow enough to do so, which it should be at this length of text.";
/** The narrow page (e2e/fixtures/editing) as it shows, with other text in some of its blocks. The first step adds the "!". */
const narrow = ({
  title = "Title here!",
  first = FIRST,
  section = "Section",
  apple = "• Apple",
  banana = "\n• Banana",
  last = "Last paragraph.",
} = {}) => `# ${title}\n\n${first}\n\n## ${section}\n\n${apple}${banana}\n\nA quote line.\n\ncode line one code line two\n\n${last}`;

journey("the caret and the arrows on a narrow page", () => {
  let ed: Editor;
  /** The caret at the end of a block's text. */
  const endOf = async (selector: string) => {
    await ed.clickEnd(selector);
    await ed.idle();
  };

  test("the drawn caret shows in place of the native one, wider than 1 px, and wider in a heading than in body text", async ({ tab }) => {
    ed = await openEditor(tab, s, "editing");
    await ed.clickEnd("h1");
    await ed.type("!");
    const heading = await drawn(ed);
    expect(heading.width).toBeGreaterThan(2);
    expect(heading.height).toBeGreaterThan(20);
    // The native caret is transparent, so there aren't two.
    expect(await ed.frame<string>(`getComputedStyle(${F}.querySelector("h1")).caretColor`)).toBe("rgba(0, 0, 0, 0)");
    // It has the text's colour.
    const colors = await ed.frame<[string, string]>(
      `[getComputedStyle(${F}.querySelector("erga-caret")).backgroundColor, getComputedStyle(${F}.querySelector("h1")).color]`
    );
    expect(colors[0]).toBe(colors[1]);
    await ed.clickEnd("#first");
    const body = await drawn(ed);
    expect(body.width).toBeGreaterThan(1);
    expect(body.width).toBeLessThan(heading.width);
    // A selection of text has no caret.
    await ed.selectChars("#first", 2);
    await expect.poll(async () => (await ed.frame<Caret | null>(CARET))?.shown).toBe(false);
  });

  // Was a bug: ArrowDown out of the big title skips the first line of the wrapped paragraph under it, and lands on its second line.
  test("ArrowDown from the title's start goes to the first line of the paragraph under it", async () => {
    await endOf("h1");
    await ed.press("Home");
    await ed.press("ArrowDown");
    await ed.type("Y");
    await ed.shows(narrow({ first: `Y|${FIRST}` }));
    await ed.press("Backspace");
    await ed.shows(narrow({ first: `|${FIRST}` }));
  });

  // Was a bug: The column is lost once the caret passes a short block: back on the long line, it is at the short block's column.
  test("ArrowDown then ArrowUp across short blocks comes back to the same column", async () => {
    // The click lands in "this" at the end of the second line.
    await endOf("#first");
    await ed.press("ArrowLeft");
    await ed.shows(narrow({ first: FIRST.replace("at this", "at th|is") }));
    for (const k of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp"]) await ed.press(k);
    await ed.type("Z");
    await ed.shows(narrow({ first: FIRST.replace("at this", "at thZ|is") }));
    await ed.press("Backspace");
    await ed.shows(narrow({ first: FIRST.replace("at this", "at th|is") }));
  });

  // Was a bug: Cmd+ArrowRight (and End) on a wrapped line draws the caret at the start of the next line, not at the end of this one.
  test("Cmd+ArrowRight on a wrapped line draws the caret at the end of that line", async () => {
    await endOf("h2");
    await ed.press("ArrowUp");
    await ed.press("ArrowUp");
    await ed.page.keyboard.press("Meta+ArrowRight");
    // The caret's top, and the top of "this", the last word of the second line.
    const at = () =>
      ed.frame<{ caret: number; line: number }>(`(() => {
        const t = ${F}.querySelector("#first").firstChild, i = t.nodeValue.indexOf("this length");
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

  // Was a bug: Shift+ArrowDown on a one-line block selects to the block's end and stops there; a second press goes on.
  test("Shift+ArrowDown from the start of a heading selects down to the start of the next line", async () => {
    await endOf("h2");
    await ed.press("Home");
    await ed.press("Shift+ArrowDown");
    await ed.shows(narrow({ section: "[Section", apple: "• ]Apple" }));
  });

  // Was a bug: Option+ArrowRight at the end of a block stays there: it never goes on to the next block's first word.
  test("Option+ArrowRight at the end of a heading goes to the end of the next block's first word", async () => {
    await endOf("h2");
    await ed.page.keyboard.press("Alt+ArrowRight");
    await ed.shows(narrow({ apple: "• Apple|" }));
  });

  // Was a bug: Cmd+ArrowDown goes only to the end of the block the caret is in, not to the end of the page (Cmd+Shift+ArrowDown does).
  test("Cmd+ArrowDown goes to the end of the page", async () => {
    await endOf("h2");
    await ed.page.keyboard.press("Meta+ArrowDown");
    await ed.shows(narrow({ last: "Last paragraph.|" }));
  });

  // Was a bug: typing over a paragraph that a triple-click selected changed the next block too (the browser selects to its start).
  test("a triple-clicked paragraph, typed over, keeps its block and the heading after it; typing goes on there", async () => {
    await clickAt(ed, "#first", 2, 3);
    await ed.press("Shift+N");
    await ed.press("e");
    await ed.press("w");
    await ed.shows(narrow({ first: "New|" }));
    expect(await ed.source()).toContain(`<p id="first">New</p>\n  <h2>Section</h2>`);
  });

  // Was a bug: Ctrl+K deleted into the next block.
  test("Ctrl+K deletes to the end of the item, heading or paragraph only; at an item's end it joins the next; Ctrl+Y puts the text back", async () => {
    // The Mac's text keys (Control+K, Control+Y): other systems have none.
    if (process.platform != "darwin") return;
    await clickAt(ed, "li", 2);
    await ed.press("Control+k");
    await ed.shows(narrow({ first: "New", apple: "• Ap|" }));
    await ed.press("Control+y");
    await ed.shows(narrow({ first: "New", apple: "• Apple|" }));
    await ed.press("Control+k");
    await ed.shows(narrow({ first: "New", apple: "• Apple|Banana", banana: "" }));
    await clickAt(ed, "h1", 5);
    await ed.press("Control+k");
    await clickAt(ed, "#first", 1);
    await ed.press("Control+k");
    await ed.shows(narrow({ title: "Title", first: "N|", apple: "• AppleBanana", banana: "" }));
    expect(await ed.source()).toContain(`<h1>Title</h1>\n  <p id="first">N</p>\n  <h2>Section</h2>`);
  });

  test("on a Mac, Control-N and Control-P go to the next and the previous block at a block's last and first line", async () => {
    // (Control-N and Control-P move the caret only on a Mac.)
    if (process.platform != "darwin") return;
    await endOf("li");
    await ed.press("Control+n");
    await ed.type("N");
    await expect.poll(() => ed.textOf("#q")).toContain("N");
    expect(await ed.textOf("li")).toBe("AppleBanana");
    await ed.press("Control+p");
    await ed.type("P");
    await expect.poll(() => ed.textOf("li")).toContain("P");
    expect(await ed.textOf("#q")).not.toContain("P");
  });
});

journey("a selection by mouse across blocks", () => {
  let ed: Editor;

  test("a drag from the heading into the paragraph selects across both; Backspace deletes it and joins them as valid HTML; undo brings both back", async ({
    tab,
  }) => {
    ed = await openEditor(tab, s, "under-hood");
    const original = await ed.source();
    // From "Un|der" in the heading to "D|1", in the paragraph's bold text.
    const h = await ed.charAt("h2", 2),
      b = await ed.charAt("p strong", 1);
    await ed.drag(h.x, h.y, b.x, b.y);
    await expect.poll(async () => (await ed.selection()).text).toBe("der the hood (draft text for the diagram)</h2>\n  <p><strong>D");
    expect((await domText(ed)).replace(/\s+/g, " ")).toBe("der the hood (draft text for the diagram) D");
    await ed.press("Backspace");
    await expect.poll(() => ed.textOf("h2")).toBe("Un1 (database): Documents, people and versions.");
    expect(await ed.source()).toContain(
      "<h2>Un<strong>1</strong> (database): Documents, people and versions.</h2>\n  <p><strong>R2</strong>"
    );
    expect(await hosts(ed)).toBe(true);
    expect(await ed.caretIn("h2")).toBe(true);
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toBe(original);
    expect(await ed.count("h2 strong")).toBe(0);
  });

  // Was a bug: "Images and files kept whole." selected and deleted pulled the "Lines" heading up into the paragraph.
  test(`a double-click on "Images", a shift-click on the last ".", then Backspace: the words go and "Lines" stays a heading`, async () => {
    const w = await wordAndEnd(ed, "p:nth-of-type(2)", "Images");
    await ed.click(w.x, w.y, { clickCount: 2 });
    await ed.click(w.end, w.y, { modifiers: ["Shift"] });
    await expect.poll(async () => (await ed.selection()).text).toContain("kept whole.");
    await ed.press("Backspace");
    await expect.poll(() => ed.source()).toContain("<p><strong>R2</strong> (storage): </p>\n  <h3>Lines</h3>\n  <p>The window");
    await ed.shows(`
      ## Under the hood (draft text for the diagram)

      D1 (database): Documents, people and versions.

      R2 (storage): |

      ### Lines

      The window to the Worker: HTTPS
    `);
  });
});

journey("the caret and a selection on a board that pans", () => {
  let ed: Editor;

  // Was a bug: with the caret in text, a press on the empty board started a selection, and the board did not pan.
  test("with the caret in text, a drag on the empty board (a grab cursor) pans it and selects nothing; the caret stays on its text", async ({
    tab,
  }) => {
    await tab.page.setViewportSize({ width: 1200, height: 760 });
    ed = await openEditor(tab, s, "pan");
    const sel = () =>
      ed.frame<{ text: string; node: string; offset: number; collapsed: boolean; active: string }>(`(() => {
        const s = ${F}.getSelection();
        return { text: s.toString(), node: s.focusNode?.textContent ?? "", offset: s.focusOffset, collapsed: s.isCollapsed, active: (s.focusNode?.nodeType == 1 ? s.focusNode : s.focusNode?.parentElement)?.closest("[data-erga-text]")?.className ?? "" };
      })()`);
    await clickAt(ed, ".card p.note", 5);
    const placed = await sel();
    expect(placed.collapsed).toBe(true);
    expect(placed.active).toBe("note");
    expect(await ed.frame<string>(`getComputedStyle(${F}.elementFromPoint(40, 380)).cursor`)).toBe("grab");
    // Pete's steps: away from the text, over the board, then press and drag.
    const p = await onPage(ed, 40, 380);
    await ed.page.mouse.move(p.x, p.y, { steps: 4 });
    await ed.drag(p.x, p.y, p.x + 120, p.y - 70, 10);
    await expect.poll(() => board(ed)).toBe("translate(120px, -70px)");
    expect(await sel()).toEqual(placed);
    await drawn(ed);
    // Typing goes on at the caret.
    await ed.type("X");
    await expect.poll(() => ed.textOf(".card p.note")).toBe("Drag Xthe board to move this card around.");
  });

  /** The format bar: whether it shows, and where. */
  const bar = async () =>
    (await ed.controls<{ shown: boolean; left: number; top: number }>(
      `(() => { const b = C.getElementById("fmt"); return { shown: !b.hidden, left: parseFloat(b.style.left), top: parseFloat(b.style.top) }; })()`
    )) ?? { shown: false, left: 0, top: 0 };

  test("the format bar follows selected text as the board pans", async () => {
    await ed.selectChars(".card p.note", 8);
    await expect.poll(async () => (await bar()).shown).toBe(true);
    const before = await bar();
    const p = await onPage(ed, 40, 380);
    await pointerOnPage(ed.page, p.x, p.y);
    await ed.page.mouse.wheel(-40, -70);
    await expect
      .poll(async () => {
        const b = await bar();
        return b.shown && Math.round(b.left - before.left) == 40 && Math.round(b.top - before.top) == 70;
      })
      .toBe(true);
    await expect.poll(() => board(ed)).toBe("translate(160px, 0px)");
  });

  test("a drag on the text selects it and doesn't pan the board; a drag on the empty board pans it", async () => {
    // (The format bar of the step before floats over the heading: a click in the text takes it away.)
    await clickAt(ed, ".card p.note", 20);
    await expect.poll(async () => (await bar()).shown).toBe(false);
    // Across two blocks: the heading into the paragraph.
    const a = await ed.charAt(".card h2", 0),
      b = await ed.charAt(".card p.note", 3);
    await ed.drag(a.x, a.y, b.x, b.y);
    await expect.poll(async () => (await domText(ed)).replace(/\s+/g, " ")).toBe("Board title Dra");
    expect(await board(ed)).toBe("translate(160px, 0px)");
    // In one block. (The format bar now floats over the heading.)
    await ed.selectChars(".card p.note", 8);
    await expect.poll(() => domText(ed)).toBe("Drag Xth");
    expect(await board(ed)).toBe("translate(160px, 0px)");
    // Typing replaces what the drag selected.
    await ed.selectChars(".card p.note", 4);
    await ed.type("Pull");
    await expect.poll(() => ed.textOf(".card p.note")).toBe("Pull Xthe board to move this card around.");
    // The page still has the rest: a drag on its empty part pans.
    const p = await onPage(ed, 40, 380);
    await ed.drag(p.x, p.y, p.x + 50, p.y + 30);
    await expect.poll(() => board(ed)).toBe("translate(210px, 30px)");
  });

  test("the caret stays on its text while the board pans, at 100% and at 125%, and while a column scrolls by itself", async () => {
    /** Clicks just past the end of an element's text, on the page as it is drawn (zoomed or not). */
    const clickEnd = async (selector: string) => {
      const r = await ed.frame<{ x: number; y: number }>(
        `(() => { const r = ${F}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.right - 4, y: r.top + r.height / 2 }; })()`
      );
      const p = await onPage(ed, r.x, r.y);
      await ed.click(p.x, p.y);
    };
    /** Pans the board by a drag on its empty part, then by the wheel; the caret is on its text after each. */
    const pans = async () => {
      const start = await drawn(ed);
      // (An empty part that is in sight zoomed in too: the page is then wider than the window.)
      const a = await onPage(ed, 200, 500);
      await ed.drag(a.x, a.y, a.x + 90, a.y + 60, 6);
      const dragged = await drawn(ed, (c) => Math.abs(c.x - start.x) > 40);
      await ed.page.mouse.wheel(30, 50);
      await drawn(ed, (c) => c.y < dragged.y - 30);
    };
    // The board back where the page first had it (the steps before moved it): the card is clear of the side column.
    const p = await onPage(ed, 40, 380);
    await pointerOnPage(ed.page, p.x, p.y);
    await ed.page.mouse.wheel(210, 30);
    await expect.poll(() => board(ed)).toBe("translate(0px, 0px)");
    await clickEnd(".card p.note");
    await pans();

    await ed.press("ControlOrMeta+Equal");
    await ed.press("ControlOrMeta+Equal");
    await expect.poll(() => zoom(ed)).toBeCloseTo(1.25, 2);
    await clickEnd(".card h2");
    await pans();

    // The side column scrolls (an element's scroll, not the window's). At 100%: zoomed in, the column at the window's
    // right is out of sight until the page moves sideways.
    await ed.press("ControlOrMeta+Digit0");
    await expect.poll(() => zoom(ed)).toBe(1);
    await clickEnd(".side p.aside");
    const before = await drawn(ed);
    const side = await onPage(ed, 960, 300);
    await pointerOnPage(ed.page, side.x, side.y);
    await ed.page.mouse.wheel(0, 120);
    await drawn(ed, (c) => c.y < before.y - 40);
  });
});

journey("the arrows at the spaces at the ends of blocks", () => {
  let ed: Editor;

  // Was a bug: ArrowLeft from the next block put the caret after the line break that the source has after the text.
  test("from the next block, ArrowLeft puts the caret at the end of indented text, not after the source's line break", async ({ tab }) => {
    ed = await openEditor(tab, s, "trailing-space");
    const src = await ed.source();
    await startOf(ed, "#after-pretty");
    await ed.press("ArrowLeft");
    await ed.type("!");
    await expect.poll(() => ed.source()).toContain("indents!\n    </p>");
    await ed.press("Backspace");
    await expect.poll(() => ed.source()).toBe(src);
  });

  // [the block, the next block, the text before the caret's last stop in the block (as the source has it), and how
  // many characters the page shows in the block (a <br> is one)]
  const WALKS: [string, string, string, number][] = [
    ["#spaces", "#after-spaces", "Three spaces at the end   ", 26],
    ["#lead", "#pretty", "Two spaces at the start", 25],
    ["#br", "#after-br", "and a second line", 42],
    ["#nbsp", "#after-nbsp", "Two no-break spaces at the end&nbsp;&nbsp;", 32],
    ["#pretty", "#after-pretty", "Text that the source indents", 28],
  ];
  /** The step for one block's walk. */
  const walk = ([sel, next, end, shown]: [string, string, string, number]) =>
    // Was a bug: ArrowRight skipped spaces that ArrowLeft stopped at, and stopped in the source's own line breaks.
    test(`${sel}: ArrowRight stops where ArrowLeft stops, at each space the page shows, and the caret ends after "${end.slice(-12)}"`, async () => {
      const src = await ed.source();
      const heads = (await symmetric(ed, sel, next)).map((s) => s.head);
      expect(heads[heads.length - 1]).toBe(src.indexOf(end) + end.length);
      // One stop before each character that the page shows, and one after the last: no space is skipped.
      expect(heads.length).toBe(shown + 1);
      // Spaces before a <br> show, and the caret stops at each of them.
      const line = src.indexOf("a break") + "a break".length;
      if (sel == "#br") for (let k = 0; k <= 3; k++) expect(heads).toContain(line + k);
    });
  walk(WALKS[0]);

  // Was a bug: spaces typed at a block's end did not show, and ArrowRight did not stop at them.
  test("spaces typed at the end of a block: ArrowRight goes through them, as ArrowLeft does, and typing goes in after them", async () => {
    await ed.clickEnd("#after-spaces");
    await ed.type("   ");
    await expect.poll(() => ed.source()).toContain("The next block   </p>");
    const stops = await symmetric(ed, "#after-spaces", "#nbsp");
    expect(stops.slice(-4).map((s) => s.x)).toEqual([...new Set(stops.slice(-4).map((s) => s.x))]);
    await startOf(ed, "#nbsp");
    await ed.press("ArrowLeft");
    await ed.type("!");
    await expect.poll(() => ed.source()).toContain("The next block   !</p>");
  });

  test("ArrowUp and ArrowDown keep the caret's column across a block that ends in spaces", async () => {
    await startOf(ed, "#after-spaces");
    for (let i = 0; i < 5; i++) await ed.press("ArrowRight");
    const before = await stop(ed);
    expect(before.id).toBe("after-spaces");
    await ed.press("ArrowUp");
    await expect
      .poll(async () => {
        const up = await stop(ed);
        return up.id == "spaces" && Math.abs(up.x - before.x) < 10;
      })
      .toBe(true);
    await ed.press("ArrowDown");
    await expect
      .poll(async () => {
        const down = await stop(ed);
        return down.id == "after-spaces" && Math.abs(down.x - before.x) < 10;
      })
      .toBe(true);
  });

  for (const w of WALKS.slice(1)) walk(w);

  test("Shift+ArrowRight selects the spaces at the end one at a time, then goes on into the next block; Shift+ArrowLeft takes them back", async () => {
    const src = await ed.source();
    await startOf(ed, "#after-spaces");
    for (let i = 0; i < 4; i++) await ed.press("ArrowLeft");
    await expect.poll(async () => (await stop(ed)).head).toBe(src.indexOf("at the end   ") + "at the end".length);
    for (let k = 1; k <= 3; k++) {
      await ed.press("Shift+ArrowRight");
      await expect.poll(() => selected(ed)).toBe(" ".repeat(k));
    }
    await ed.press("Shift+ArrowRight");
    await expect.poll(async () => (await selected(ed)).startsWith("   </p>")).toBe(true);
    await ed.press("Shift+ArrowLeft");
    await ed.press("Shift+ArrowLeft");
    await expect.poll(() => selected(ed)).toBe("  ");
    // The editor's model, which hears of the keys in its own time, has the same selection.
    await expect.poll(async () => (await ed.selection()).text).toBe("  ");
  });

  test("End goes after the spaces at the end of a block, Home before the spaces at its start", async () => {
    const src = await ed.source();
    await startOf(ed, "#spaces");
    await ed.press("End");
    await expect.poll(async () => (await stop(ed)).head).toBe(src.indexOf("at the end   ") + "at the end   ".length);
    await ed.clickEnd("#lead");
    await ed.press("Home");
    await expect.poll(async () => (await stop(ed)).head).toBe(src.indexOf("  Two spaces"));
  });
});

journey("a selection by keys across blocks, and its copy and cut", () => {
  let ed: Editor;
  /** The caret in the heading, at "La|unch notes", then the keys. */
  const fromHeading = async (keys: string[]) => {
    await clickAt(ed, "h1", 2);
    for (const k of keys) await ed.press(k);
    await ed.settle();
  };
  /** What a copy or a cut of the page's selection writes to the clipboard. */
  const clip = (how: "copy" | "cut") =>
    ed.frame<{ text: string; html: string }>(
      `(() => { const d = new DataTransfer(); ${F}.activeElement.dispatchEvent(new ClipboardEvent("${how}", { clipboardData: d, bubbles: true, cancelable: true })); return { text: d.getData("text/plain"), html: d.getData("text/html") }; })()`
    );

  test("Shift+ArrowDown selects past the end of the heading, and the editor's selection follows; a copy inside one paragraph is its text alone", async ({
    tab,
  }) => {
    ed = await openEditor(tab, s, "page");
    await fromHeading(["Shift+ArrowDown", "Shift+ArrowDown", "Shift+ArrowRight"]);
    // (The page's selection and the editor's model each hear of the keys in their own time.)
    await expect
      .poll(async () => {
        const t = await domText(ed);
        return t.startsWith("unch notes") && /Build/.test(t);
      })
      .toBe(true);
    await expect.poll(async () => (await ed.selection()).text.startsWith("unch notes</h1>")).toBe(true);
    await ed.frame(`(() => { const t = ${F}.querySelector("p.lede").firstChild; ${F}.getSelection().setBaseAndExtent(t, 0, t, 5); })()`);
    expect(await clip("copy")).toEqual({ text: "Build", html: "Build" });
  });

  test("⌘A twice selects every block, on the page too", async () => {
    await fromHeading(["ControlOrMeta+a", "ControlOrMeta+a"]);
    await expect.poll(async () => (await domText(ed)).trim()).toMatch(/^Launch notes[\s\S]*Typing never waits\.$/);
  });

  test("Shift-click extends a caret into another block; a copy is the blocks' text and bare HTML, without the widget; a cut copies the same and deletes it; undo brings it back", async () => {
    await clickAt(ed, "h1", 2);
    const li = await ed.charAt("li:first-child", 6);
    await ed.click(li.x, li.y, { modifiers: ["Shift"] });
    await expect.poll(async () => (await ed.selection()).text).toContain("Faster");
    expect((await domText(ed)).trim()).toMatch(/^unch notes[\s\S]*What changed[\s\S]*Faster$/);
    const m = await ed.selection();
    expect(m.text.startsWith("unch notes") && m.text.endsWith("Faster")).toBe(true);
    const copied = await clip("copy");
    // The plain text is Markdown (libs/text/api/clipboard.ts).
    expect(copied.text).toBe(
      "# unch notes\n\nBuild *cool* things & ship them. This paragraph has [a link](https://example.com/) and `code`.\n\n**0**clicks\n\n## What changed\n\n- Faster"
    );
    expect(copied.text + copied.html).not.toContain("Bump");
    expect(copied.html).toBe(
      `<h1>unch notes</h1><p>Build <em>cool</em> things &amp; ship them. This paragraph has <a href="https://example.com/">a link</a> and <code>code</code>.</p><p><strong>0</strong>clicks</p><h2>What changed</h2><ul><li>Faster</li></ul>`
    );
    expect((await clip("cut")).text).toBe(copied.text);
    await expect
      .poll(async () => {
        const src = await ed.source();
        return /<h1>La<\/h1>[\s\S]*<li> builds<\/li>/.test(src) && !src.includes("What changed");
      })
      .toBe(true);
    await ed.press("ControlOrMeta+z");
    await expect
      .poll(async () => {
        const src = await ed.source();
        return src.includes("<h1>Launch notes</h1>") && src.includes("<li>Faster builds</li>");
      })
      .toBe(true);
  });

  test("Shift+ArrowUp comes back; typing replaces a selection across blocks, the caret after it in a block that edits, and typing goes on there", async () => {
    // (One Shift+ArrowDown on the heading's one line goes on to the next line, as in Google Docs.)
    await fromHeading(["Shift+ArrowDown", "Shift+ArrowRight", "Shift+ArrowLeft"]);
    await expect.poll(async () => (await ed.selection()).text).toContain("</h1>");
    await ed.press("Shift+ArrowUp");
    await expect.poll(async () => (await ed.selection()).text.includes("</h1>")).toBe(false);
    await ed.press("Shift+ArrowDown");
    await expect.poll(async () => (await ed.selection()).text).toContain("</h1>");
    await ed.press("Shift+X");
    await expect.poll(() => ed.textOf("h1")).toMatch(/^LaXd cool/);
    expect(await hosts(ed)).toBe(true);
    expect(await ed.caretIn("h1")).toBe(true);
    await ed.type("y");
    await expect.poll(() => ed.textOf("h1")).toMatch(/^LaXy/);
  });
});

// The caret keeps its shape at every zoom: on a page that scales its text itself (the Canvas template's camera, a
// transform) and with the page zoomed in the editor. It is a thin bar 1.5 to 3 px wide on the screen (by the text's
// size there), and as tall as the line on the screen. (The editor's zoom keys go to the canvas's camera,
// window.ergaZoom: the test takes that away to reach the editor's zoom.)
test("the caret is a thin bar as tall as its line at every zoom: the canvas's camera and the editor's zoom", async ({ tab }) => {
  const ed = await openNew(tab, s, "canvas", { width: 1100, height: 720 });
  /** The drawn caret on the screen (in the tab's pixels): its box, the line's height there, and the text's scale. */
  type Caret = { width: number; height: number; line: number; off: number; scale: number } | null;
  const CARET = `(() => {
    const c = ${F}.querySelector("erga-caret");
    if (!c || getComputedStyle(c).display == "none") return null;
    const k = window.ergaFrame?.zoom ?? 1, r = c.getBoundingClientRect(), s = ${F}.getSelection().getRangeAt(0).getBoundingClientRect();
    const h = ${F}.querySelector(".frame.current p");
    return { width: r.width * k, height: r.height * k, line: s.height * k,
      off: Math.abs(r.left + r.width / 2 - s.left) * k + Math.abs(r.top - s.top) * k, scale: h.getBoundingClientRect().height / h.offsetHeight * k };
  })()`;
  /** The canvas's camera at zoom `by`, its current frame in the middle (the template's own `place`). */
  const camera = (by: number) =>
    ed.frame(`(() => {
      const c = ${F}.querySelector(".canvas"), f = ${F}.querySelector(".frame.current");
      const x = f.offsetLeft + f.offsetWidth / 2, y = f.offsetTop + f.offsetHeight / 2;
      c.style.transform = "translate(" + (innerWidth / 2 - x * ${by}) + "px, " + (innerHeight / 2 - y * ${by}) + "px) scale(${by})";
      dispatchEvent(new Event("scroll"));
      return true;
    })()`);
  /** The editor's zoom, by its keys: a step at a time to `level`. */
  const zoomTo = async (level: number) => {
    for (let at = await zoom(ed); Math.abs(at - level) > 0.01; ) {
      await ed.press(at < level ? "ControlOrMeta+Equal" : "ControlOrMeta+Minus");
      const before = at;
      at = await until(
        async () => {
          const now = await zoom(ed);
          return Math.abs(now - before) > 0.001 ? now : 0;
        },
        3000,
        `a zoom step from ${before}`
      );
    }
  };

  // A page without a zoom of its own, so the keys zoom the page in the editor (the shell hears of it with the page's next news).
  await ed.frame(`(() => { delete window.ergaZoom; return true; })()`);
  await expect
    .poll(async () => {
      await ed.frame(`${F}.dispatchEvent(new Event("scroll"))`);
      return ed.eval("window.ergaPage.page.zoomsItself");
    })
    .toBe(false);
  // The caret in the current frame's paragraph, after its third word.
  const at = await ed.frame<{ x: number; y: number }>(`(() => {
    const t = ${F}.querySelector(".frame.current p").firstChild, rg = ${F}.createRange();
    rg.setStart(t, 18); rg.setEnd(t, 19);
    const r = rg.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2 };
  })()`);
  const point = await onPage(ed, at.x, at.y);
  await ed.click(point.x + 1, point.y);
  await expect.poll(async () => (await ed.frame<Caret>(CARET))?.off ?? 99).toBeLessThan(2);

  // The editor's zoom times the camera's: the text at 10% to 400% of its size. (In the order that takes the fewest zoom keys.)
  const cases = [
    { zoom: 1, camera: 1 },
    { zoom: 1, camera: 0.25 },
    { zoom: 1, camera: 2 },
    { zoom: 1, camera: 0.1 },
    { zoom: 1, camera: 4 },
    { zoom: 2, camera: 1 },
    { zoom: 0.5, camera: 1 },
    { zoom: 0.5, camera: 0.5 },
  ];
  const seen: { name: string; text: number; width: number; ratio: number; gap: number }[] = [];
  for (const c of cases) {
    await zoomTo(c.zoom);
    // Again while it waits: the page's own fit to its window, on the zoom's resize, may come after the first.
    let k: Caret = null;
    await expect
      .poll(
        async () => {
          await camera(c.camera);
          await settle(ed.page);
          k = await ed.frame<Caret>(CARET);
          return !!k && k.off < 3 && Math.abs(k.scale - c.zoom * c.camera) < 0.01;
        },
        { message: `the caret at ${c.zoom * 100}% × ${c.camera * 100}%` }
      )
      .toBe(true);
    const caret = k as unknown as NonNullable<Caret>;
    seen.push({
      name: `zoom ${c.zoom * 100}% camera ${c.camera * 100}%`,
      text: c.zoom * c.camera,
      width: caret.width,
      ratio: caret.height / caret.line,
      gap: Math.abs(caret.height - caret.line),
    });
  }
  // All at once, so a failure shows every zoom's caret. The paragraph's text is 32 px: 2.7 px of caret at 100%,
  // 1.5 px at least (2 on a 1x screen) when it shows smaller, 3 px at most when larger.
  for (const k of seen) {
    const all = JSON.stringify(seen);
    expect(k.width, `${k.name}: the width on the screen (${all})`).toBeGreaterThanOrEqual(k.text < 1 ? 1 : 2);
    expect(k.width, `${k.name}: the width on the screen (${all})`).toBeLessThanOrEqual(k.text < 1 ? 2.01 : 3.01);
    // (On whole pixels: at 10%, a line 4.6 px tall gets a caret of 5.)
    if (k.gap > 1) expect(k.ratio, `${k.name}: the height against the line's (${all})`).toBeCloseTo(1, 1);
  }
});

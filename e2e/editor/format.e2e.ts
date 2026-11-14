// The format bar, the link bar, Markdown shortcuts and the slash menu: each changes the text it is for, and no other.
// One page, typed from empty: a bold word, Markdown in a line, a link (its bar, its ends, its text), a link made with
// the bar, the clear key, Markdown blocks, the slash menu, the shortcut card. Then the same page as a reader has it:
// where its links open.
import { expect, journey, servers, test } from "../helpers/fixtures";
import { F, openEmpty, type Editor } from "../helpers/editor";
import { pointerOnPage } from "../helpers/press";

const s = await servers.main();

/** Types text with real key presses, a key for each character ("\n" is Enter). */
const keys = async (ed: Editor, text: string) => {
  for (const ch of text) await ed.press(ch == " " ? "Space" : ch == "\n" ? "Enter" : ch);
};
/** In the editor's own controls on the page (C: their shadow root). */
const bar = <T>(ed: Editor, expr: string) => ed.controls<T>(expr) as Promise<T>;
const linkBar = (ed: Editor) =>
  bar<boolean>(ed, `!C.getElementById("fmt").hidden && !C.getElementById("link").hidden && !C.querySelector(".fmt.morphing")`);
const styleBar = (ed: Editor) =>
  bar<boolean>(ed, `!C.getElementById("fmt").hidden && !C.getElementById("style").hidden && !C.querySelector(".fmt.morphing")`);
const field = (ed: Editor, id: string) => bar<string>(ed, `C.getElementById(${JSON.stringify(id)}).value`);
const press = (ed: Editor, sel: string) => bar(ed, `C.querySelector(${JSON.stringify(sel)}).click()`);
type Box = { left: number; top: number; right: number; bottom: number };
const BOX = `(r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })`;
/** Where the bar is, on the page. */
const barBox = (ed: Editor) => bar<Box>(ed, `(${BOX})(C.getElementById("fmt").getBoundingClientRect())`);
/** Where an element is, on the page. */
const boxOf = (ed: Editor, sel: string) => ed.frame<Box>(`(${BOX})(${F}.querySelector(${JSON.stringify(sel)}).getBoundingClientRect())`);
/** A point in the tab just inside the right edge of an element's text: a click there puts the caret at its end. */
const endOf = async (ed: Editor, sel: string) => {
  const [b, f] = [await boxOf(ed, sel), await ed.frameAt()];
  return { x: f.x + b.right - 1, y: f.y + (b.top + b.bottom) / 2 };
};
/** The slash menu's items as it shows them, the chosen one in brackets; null while it is closed. */
const menu = (ed: Editor) =>
  ed.frame<string[] | null>(
    `(() => { const m = ${F}.querySelector("erga-slash")?.shadowRoot?.getElementById("menu"); return m && !m.hidden ? [...m.querySelectorAll("li")].map((li) => (li.classList.contains("on") ? "[" + li.firstChild.textContent + "]" : li.firstChild.textContent)) : null; })()`
  );
const ALL = ["Heading", "List", "To-do", "Quote", "Code", "Table", "Image", "Divider"];
/** The third line, "see the site ok", and its link. */
const SEE = "p:nth-of-type(3)";
const A = `${SEE} a`;
const LINK = `<a href="https://example.com">`;
/** Another Erga address, for a link that opens in this tab. */
const away = () => new URL("/docs?went=1", s.root).href;

journey("the format bar, the link bar, Markdown and the slash menu", () => {
  let ed: Editor;

  // The bar opened above the first line, under the bars that float over the page: the click on Bold went to them.
  test("a word dragged across on the page's first line is bold after a mouse click on the bar's Bold", async ({ tab }) => {
    ed = await openEmpty(tab); // the journey's one page load in the editor
    await ed.type("Hello brave world");
    const a = await ed.charAt("p", 6),
      b = await ed.charAt("p", 10);
    await ed.drag(a.x, a.y, b.x + 6, b.y);
    await expect.poll(() => styleBar(ed)).toBe(true);
    await ed.clickIn("erga-controls", "#fmt [data-style=strong]");
    await expect.poll(() => ed.source()).toContain("<p>Hello <strong>brave</strong> world</p>");
    await ed.shows("Hello [brave] world");
  });

  test("⌘B across the end of a bold word bolds the rest as valid HTML; the bar shows bold, and its italic works", async () => {
    // From inside <strong>brave</strong> into the plain text after it.
    const f = await ed.frameAt();
    const r = await ed.frame<{ a: number; b: number; y: number }>(
      `(() => { const st = ${F}.querySelector("p strong").firstChild, t = st.parentNode.nextSibling; const rg = ${F}.createRange(); rg.setStart(st, 1); rg.setEnd(t, 4); const rs = rg.getClientRects(); return { a: rs[0].left + 1, b: rs[rs.length - 1].right - 1, y: rs[0].top + rs[0].height / 2 }; })()`
    );
    await ed.drag(f.x + r.a, f.y + r.y, f.x + r.b, f.y + r.y);
    await expect.poll(() => styleBar(ed)).toBe(true);
    await ed.press("ControlOrMeta+b");
    await expect.poll(() => ed.source()).toContain("<p>Hello <strong>brave</strong> <strong>wor</strong>ld</p>");
    await expect.poll(() => bar<string>(ed, `C.querySelector("#fmt [data-style=strong]").getAttribute("aria-pressed")`)).toBe("true");
    await press(ed, "#fmt [data-style=em]");
    await expect.poll(async () => (await ed.source()).match(/<p>Hello[\s\S]*?<\/p>/)?.[0] ?? "").toMatch(/<em>/);
  });

  test("**bold**, *italic* and `code` lose their marks; a word with underscores stays text", async () => {
    await ed.press("End");
    await keys(ed, "\na **b** *i* `c` snake_case_name");
    await ed.shows(`
      Hello brave world

      a b i c snake_case_name|
    `);
    await expect
      .poll(() =>
        ed.frame(`[...${F}.querySelectorAll("p + p :is(strong, em, code)")].map((e) => e.tagName + ":" + e.textContent).join(" ")`)
      )
      .toBe("STRONG:b EM:i CODE:c");
  });

  // The link bar is taller than the style bar. Near the page's top it opened above its link, over the top bar and the
  // document's title. Here the link is on the third line: the style bar has room above this line, the link bar has not.
  test("a link near the top of the page: its bar opens below it, clear of the top bar", async () => {
    await keys(ed, "\nsee [the site](https://example.com) ok");
    await expect.poll(() => ed.source()).toContain(`<p>see ${LINK}the site</a> ok</p>`);
    const line = await boxOf(ed, SEE);
    await ed.selectChars(SEE, 3);
    await expect.poll(() => styleBar(ed)).toBe(true);
    expect((await barBox(ed)).bottom, "the style bar is above this line").toBeLessThanOrEqual(line.top);
    const at = await ed.charAt(A, 2);
    await ed.click(at.x, at.y);
    await expect.poll(() => linkBar(ed)).toBe(true);
    const box = await barBox(ed);
    expect(box.top, "the link bar is below its link").toBeGreaterThanOrEqual((await boxOf(ed, A)).bottom);
    // The bar is the page's (in its frame), the top bar the tab's: both in the tab's coordinates.
    const covered = await ed.eval<string[]>(
      `(() => { const p = document.getElementById("frame").getBoundingClientRect(), b = ${JSON.stringify(box)}; const f = { left: p.left + b.left, top: p.top + b.top, right: p.left + b.right, bottom: p.top + b.bottom }; return [".chrome-nav", ".chrome-top"].filter((s) => { const t = document.querySelector(s).getBoundingClientRect(); return f.top < t.bottom && f.bottom > t.top && f.left < t.right && f.right > t.left; }); })()`
    );
    expect(covered).toEqual([]);
  });

  // The bar showed with the caret at a link's start or end, where typing may not go into the link.
  test("the link bar shows for a caret inside a link, not at its start or its end, by click or by arrows", async () => {
    // "see <a>the site</a> ok": the link's first character, and a point inside it.
    const [first, inside, end] = [await ed.charAt(A, 0), await ed.charAt(A, 2), await endOf(ed, A)];
    await ed.click(inside.x, inside.y);
    await expect.poll(() => linkBar(ed)).toBe(true);
    // A click at its start: the caret after "see ", where the link starts.
    await ed.click(first.x - 1, first.y);
    await expect.poll(() => linkBar(ed)).toBe(false);
    await ed.press("ArrowRight");
    await expect.poll(() => linkBar(ed)).toBe(true);
    await ed.press("ArrowLeft");
    await expect.poll(() => linkBar(ed)).toBe(false);
    // A click at its end, after "e".
    await ed.click(inside.x, inside.y);
    await expect.poll(() => linkBar(ed)).toBe(true);
    await ed.click(end.x, end.y);
    await expect.poll(() => linkBar(ed)).toBe(false);
    await ed.press("ArrowLeft");
    await expect.poll(() => linkBar(ed)).toBe(true);
    await ed.press("ArrowRight");
    await expect.poll(() => linkBar(ed)).toBe(false);
    // Typing at the end still joins the link, and the caret stays at its end: no bar.
    await ed.type("s");
    await expect.poll(() => ed.source()).toContain(`>the sites</a> ok`);
    expect(await linkBar(ed)).toBe(false);
  });

  test("a click in a link puts the caret there and shows the link bar, without following the link; letters at its ends join it, a space ends it", async () => {
    const url = ed.page.url();
    const at = await ed.charAt(A, 2);
    await ed.click(at.x, at.y);
    await expect.poll(() => linkBar(ed)).toBe(true);
    expect(await field(ed, "link-url")).toBe("https://example.com");
    expect(await field(ed, "link-text")).toBe("the sites");
    expect(ed.page.url()).toBe(url);
    // The focus stayed in the page: typing goes into the link, and the bar follows it.
    await ed.type("X");
    await expect.poll(() => ed.source()).toContain(`${LINK}thXe sites</a>`);
    await expect.poll(() => field(ed, "link-text")).toBe("thXe sites");
    // At its end.
    for (let i = 0; i < 7; i++) await ed.press("ArrowRight");
    await ed.type("s");
    await expect.poll(() => ed.source()).toContain(`>thXe sitess</a> ok`);
    await ed.type(" ok");
    await expect.poll(() => ed.source()).toContain(`>thXe sitess</a> ok ok`);
    // At its start.
    const start = await ed.charAt(A, 0);
    await ed.click(start.x - 1, start.y);
    await ed.type("Z");
    await expect.poll(() => ed.source()).toContain(`see ${LINK}ZthXe sitess</a>`);
  });

  test("the link bar changes a link's text; Esc closes it until a click in the link; it removes the link, and undo brings it back", async () => {
    const at = await ed.charAt(A, 2);
    await ed.click(at.x, at.y);
    await expect.poll(() => linkBar(ed)).toBe(true);
    await bar(ed, `C.getElementById("link-text").focus()`);
    await ed.press("ControlOrMeta+a");
    await ed.type("the example");
    await ed.press("Enter");
    await expect.poll(() => ed.source()).toContain(`see ${LINK}the example</a> ok ok`);
    // Esc closes the link bar while the caret stays in the link; a click there opens it again.
    const again = await ed.charAt(A, 3);
    await ed.click(again.x, again.y);
    await expect.poll(() => linkBar(ed)).toBe(true);
    await ed.press("Escape");
    await expect.poll(() => bar<boolean>(ed, `C.getElementById("fmt").hidden`)).toBe(true);
    await ed.click(again.x, again.y);
    await expect.poll(() => linkBar(ed)).toBe(true);
    await press(ed, "#fmt [data-link=remove]");
    await expect.poll(() => ed.source()).toContain("<p>see the example ok ok</p>");
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toContain(`<p>see ${LINK}the example</a> ok ok</p>`);
  });

  test("a click in the page while the link bar is open applies it to its own selection, not where the click goes; Esc applies nothing", async () => {
    // "see", on the link's own line: the link bar opens below the line, and leaves the other link free for the click.
    await ed.selectChars(SEE, 3);
    await expect.poll(() => styleBar(ed)).toBe(true);
    await press(ed, "#fmt [data-act=link]");
    await expect.poll(() => linkBar(ed)).toBe(true);
    await ed.type("example.com/a");
    await ed.press("Escape");
    await expect.poll(() => styleBar(ed)).toBe(true);
    await press(ed, "#fmt [data-act=link]");
    await expect.poll(() => linkBar(ed)).toBe(true);
    await ed.type("example.com/b");
    // A click in the other link: the new link is on "see", and the other link stays as it was.
    const at = await ed.charAt(`${SEE} a[href$=".com"]`, 2);
    await ed.click(at.x, at.y);
    await expect.poll(() => ed.source()).toContain(`<p><a href="https://example.com/b">see</a> ${LINK}the example</a> ok ok</p>`);
    expect(await ed.source()).not.toContain("example.com/a");
  });

  test("⌘\\ takes every style off the selection (bold, italic, code, links), as one undo step", async () => {
    const original = await ed.source();
    // The first three lines.
    const [from, to] = [await ed.charAt("p", 0), await endOf(ed, `${SEE} a + a`)];
    await ed.drag(from.x - 1, from.y, to.x + 30, to.y);
    await ed.press("ControlOrMeta+\\");
    await expect
      .poll(() => ed.source())
      .toContain("<p>Hello brave world</p>\n<p>a b i c snake_case_name</p>\n<p>see the example ok ok</p>");
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toBe(original);
  });

  test("#, - and 1. with a space make a heading and lists; undo gives back the typed marks", async () => {
    await ed.clickEnd(SEE);
    await keys(ed, "\n## Plan\n- Milk\nEggs\n\n1. One\nTwo");
    const top = `
      Hello brave world

      a b i c snake_case_name

      see the example ok ok

      ## Plan

      • Milk
      • Eggs

      1. One
      2. Two`;
    await ed.shows(`${top}|`);
    await keys(ed, "\n\n* ");
    await ed.shows(`${top}\n\n      • |`);
    await ed.press("ControlOrMeta+z");
    await ed.shows(`${top}\n\n      * |`);
  });

  test("/ opens the menu; the arrows and Enter choose; letters filter; Esc leaves the / as text; no menu in a sentence", async () => {
    // The line has "* " from the step before: the menu is for an empty line.
    await ed.press("Backspace");
    await ed.press("Backspace");
    await ed.type("/");
    await expect.poll(() => menu(ed)).toEqual(["[Heading]", ...ALL.slice(1)]);
    await ed.press("ArrowDown");
    await expect.poll(() => menu(ed)).toEqual(["Heading", "[List]", ...ALL.slice(2)]);
    await ed.press("Enter");
    await expect.poll(() => menu(ed)).toBeNull();
    await ed.type("Tea");
    await expect.poll(() => ed.source()).toMatch(/<ul>\s*<li>Tea<\/li>\s*<\/ul>/);

    // A new paragraph after the list (Enter two times), then a heading by its letters.
    await ed.press("Enter");
    await ed.press("Enter");
    await ed.type("/he");
    await expect.poll(() => menu(ed)).toEqual(["[Heading]"]);
    await ed.press("Enter");
    await ed.type("Next");
    await expect.poll(() => ed.source()).toContain("<h2>Next</h2>");

    // Esc: the menu closes, the "/" stays, and more letters do not open it again.
    await ed.press("Enter");
    await ed.type("/");
    await expect.poll(async () => (await menu(ed))?.length).toBe(8);
    await ed.press("Escape");
    await expect.poll(() => menu(ed)).toBeNull();
    await ed.clickEnd("body > p:last-child");
    await ed.type("x");
    expect(await menu(ed)).toBeNull();
    await expect.poll(() => ed.source()).toContain("<p>/x</p>");
    // In a sentence: never.
    await ed.type(" and /");
    expect(await menu(ed)).toBeNull();
    await expect.poll(() => ed.source()).toContain("<p>/x and /</p>");
  });

  test("the link button turns the style bar into the link bar; Enter links the selection, opening in this tab; × goes back; a click on the new link doesn't follow it", async () => {
    const url = ed.page.url();
    await ed.selectChars("h2", 4);
    await expect.poll(() => styleBar(ed)).toBe(true);
    await press(ed, "#fmt [data-act=link]");
    await expect.poll(() => linkBar(ed)).toBe(true);
    expect(await bar<string>(ed, "C.activeElement?.id")).toBe("link-url");
    expect(await field(ed, "link-text")).toBe("Plan");
    await ed.type(away());
    await press(ed, "#fmt [data-link=tab]");
    await ed.press("Enter");
    const made = `<h2><a href="${away()}" target="_self">Plan</a></h2>`;
    await expect.poll(() => ed.source()).toContain(made);
    await expect.poll(() => styleBar(ed)).toBe(true);
    // The link bar again, for the link that's there now; × goes back to the style bar and changes nothing.
    await press(ed, "#fmt [data-act=link]");
    await expect.poll(() => linkBar(ed)).toBe(true);
    expect(await field(ed, "link-url")).toBe(away());
    expect(await bar<string>(ed, `C.querySelector("#fmt [data-link=tab]").getAttribute("aria-checked")`)).toBe("false");
    await press(ed, "#fmt [data-link=close]");
    await expect.poll(() => styleBar(ed)).toBe(true);
    expect(await ed.source()).toContain(made);
    // A click on the new link: the caret and the link bar, and the editor stays (the steps after this one need it).
    const at = await ed.charAt("h2 a", 2);
    await ed.click(at.x, at.y);
    await expect.poll(() => linkBar(ed)).toBe(true);
    expect(await ed.caretIn("h2 a")).toBe(true);
    expect(ed.page.url()).toBe(url);
    expect(await bar<string>(ed, `C.querySelector("#fmt [data-link=tab] .label").textContent`)).toBe("Opens in this tab");
  });

  test("the ? button opens the shortcut card; it lists the Markdown, the comment and the editor's key; ⌘/ opens it too", async () => {
    const page = ed.page;
    const open = () => ed.eval<boolean>(`!document.getElementById("help").hidden`);
    expect(await open()).toBe(false);
    await page.click("#btn-help");
    await expect.poll(open).toBe(true);
    const rows = await ed.eval<string[]>(
      `[...document.querySelectorAll("#help dt")].map((d) => d.textContent + ": " + d.nextElementSibling.textContent.replace(/\\s+/g, " ").trim())`
    );
    expect(rows).toEqual([
      "Bold: ⌘B",
      "Italic: ⌘I",
      "Code: ⌘E",
      "Link: ⌘⇧K",
      "Clear formatting: ⌘\\",
      "Comment: ⌘⌥M",
      "Insert a block: /",
      "Heading: # to ######",
      "List: - or 1.",
      "To-do: [ ]",
      "Quote: >",
      "Code block: ``` Enter",
      "Divider: --- Enter",
      "Indent a list item: Tab / ⇧Tab",
      "New paragraph: Enter",
      "Line break: ⇧Enter",
      "Undo / redo: ⌘Z / ⌘⇧Z",
      "Leave text: Esc",
      "Open or close the editor: ⌘⇧E",
      "Page / source: ⌘⇧P",
      "Agent: ⌘J",
      "Go to a document or page: ⌘K",
      "Zoom: ⌘+ ⌘− ⌘0",
      "Print: ⌘P",
      "This list: ⌘/",
    ]);
    // The button closes it too; ⌘/ still opens it, and Esc closes it.
    await page.click("#btn-help");
    await expect.poll(open).toBe(false);
    await page.keyboard.press("ControlOrMeta+/");
    await expect.poll(open).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(open).toBe(false);
  });

  test("for readers, a link that leaves the document opens a new tab; the one set to open in this tab takes the tab", async () => {
    const page = ed.page;
    /** In the document's page, as a reader has it (the tab's own frames). */
    const inPage = async <T>(expr: string) =>
      (
        await Promise.all(
          page
            .frames()
            .filter((f) => f.parentFrame() == page.mainFrame())
            .map((f) => f.evaluate(expr).catch(() => null))
        )
      ).find((v) => v != null) as T | undefined;
    // (The links go to example.com: the test answers for it, so that no request leaves this machine.)
    await page
      .context()
      .route("https://example.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Example</title>" }));
    await page.goto(ed.address); // the page as a reader has it: the journey's second page load
    await expect.poll(() => inPage<number>(`document.querySelectorAll("a").length || null`)).toBe(3);
    const popup = page.context().waitForEvent("page");
    await inPage(`(document.querySelector("p a").click(), 1)`);
    const other = await popup;
    await expect.poll(() => other.url()).toContain("example.com");
    await other.close();
    // In this tab: a reader's click (a real one) on the heading's link, to another Erga address, takes the whole tab, not
    // the page's frame.
    const box = await page.evaluate(() => {
      const r = document.getElementById("frame")!.getBoundingClientRect();
      return { x: r.left, y: r.top };
    });
    const r = (await inPage<{ x: number; y: number }>(
      `(() => { const b = document.querySelector("h2 a").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`
    ))!;
    await pointerOnPage(page, box.x + r.x, box.y + r.y);
    await page.mouse.click(box.x + r.x, box.y + r.y);
    await expect.poll(() => page.url()).toContain("went=1");
  });
});

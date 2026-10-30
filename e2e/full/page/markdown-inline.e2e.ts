// Markdown inside a line, typed with real keys, and Markdown pasted as plain text: what the page shows. Google Docs,
// Notion, Typora and Bear agree on each behavior here. The visible snapshot shows no links, rules or struck text, so
// these tests read the page's elements for them.
import { expect, knownBug, servers, test, type Tab } from "../../helpers/fixtures";
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
/** Pastes plain text at the caret, as the browser hands a paste to the page. */
const paste = (ed: Editor, text: string) =>
  ed.frame(
    `(() => { const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(text)}); ${F}.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`
  );
/** The page's text in elements that draw a line through it. */
const struck = (ed: Editor) =>
  ed.frame<string>(
    `[...${F}.querySelectorAll("body *")].filter((e) => getComputedStyle(e).textDecorationLine.includes("line-through")).map((e) => e.textContent).join("|")`
  );

test("**bold**, *italic* and `code` lose their marks; a word with underscores stays text", async ({ tab }) => {
  const ed = await empty(tab);
  await keys(ed, "a **b** *i* `c` snake_case_name");
  await ed.shows(`
    a b i c snake_case_name|
  `);
  await expect
    .poll(() => ed.frame(`[...${F}.querySelectorAll("strong, em, code")].map((e) => e.tagName + ":" + e.textContent).join(" ")`))
    .toBe("STRONG:b EM:i CODE:c");
});

// Bug: ~~text~~ stays as typed. Google Docs, Notion, Typora and Bear strike the text through and take the marks off.
test(
  "~~text~~ strikes the text through",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "a ~~old~~ b");
    await ed.shows(`
      a old b|
    `);
    await expect.poll(() => struck(ed)).toBe("old");
  })
);

// Bug: ***text*** stays as typed, with all six asterisks. Notion, Typora and Bear make it bold and italic.
test(
  "***text*** makes the text bold and italic",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "a ***both*** b");
    await ed.shows(`
      a both b|
    `);
  })
);

// Bug: the italic inside converts, then the closing ** of the bold does nothing: "**bold it x**" stays with its marks.
test(
  "**bold with *italic* inside** makes all of it bold",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "**bold *it* x**");
    await ed.shows(`
      bold it x|
    `);
  })
);

// Bug: [text](url) stays as typed. Google Docs, Notion, Typora and Bear make a link with the text.
test(
  "[text](url) makes a link",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "see [the site](https://example.com) ok");
    await ed.shows(`
      see the site ok|
    `);
    await expect.poll(() => ed.frame(`${F}.querySelector("a")?.getAttribute("href")`)).toBe("https://example.com");
  })
);

// Bug: an address typed and then a space, or pasted, stays plain text. Google Docs, Notion, Typora and Bear make it a link.
test(
  "an address typed with a space after it, or pasted, becomes a link",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "see https://example.com ok ");
    await paste(ed, "https://erga.dev");
    await expect
      .poll(() => ed.frame(`[...${F}.querySelectorAll("a")].map((a) => a.getAttribute("href")).join(" ")`))
      .toBe("https://example.com https://erga.dev");
  })
);

test("a Markdown document pasted as plain text becomes headings, lists, a quote and code", async ({ tab }) => {
  const ed = await empty(tab);
  await paste(ed, "# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n> quote\n\n```\nlet a = 1;\n```\n");
  await ed.shows(`
    # Title

    Some bold and code.

    • one
    • two

    1. first
    2. second

    quote

    let a = 1;|
  `);
  await expect.poll(() => ed.count("blockquote")).toBe(1);
  await expect.poll(() => ed.count("pre")).toBe(1);
});

// Bug: a pasted Markdown table stays as its lines of text, with the pipes, in one paragraph. Notion, Typora and Bear
// make a table; Google Docs makes one from a paste too.
test(
  "a Markdown table pasted as plain text becomes a table",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await paste(ed, "| Name | Age |\n| --- | --- |\n| Ann | 30 |\n");
    await expect.poll(() => ed.count("table td")).toBe(2);
    await expect.poll(() => ed.textOf("body")).not.toContain("|");
  })
);

// Bug: in a pasted Markdown document, --- stays as text and ~~text~~ keeps its marks, though the rest converts.
test(
  "--- and ~~text~~ in pasted Markdown become a rule and struck text",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await paste(ed, "Above\n\n---\n\nBelow ~~old~~\n");
    await expect.poll(() => ed.count("hr")).toBe(1);
    await expect.poll(() => struck(ed)).toBe("old");
  })
);

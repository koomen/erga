// Markdown inside a line, typed with real keys, and Markdown pasted as plain text: what the page shows. Google Docs,
// Notion, Typora and Bear agree on each behavior here. The visible snapshot shows no links, rules or struck text, so
// these tests read the page's elements for them.
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

test("~~text~~ strikes the text through", async ({ tab }) => {
  const ed = await empty(tab);
  await keys(ed, "a ~~old~~ b");
  await ed.shows(`
    a old b|
  `);
  await expect.poll(() => struck(ed)).toBe("old");
});

test("***text*** makes the text bold and italic", async ({ tab }) => {
  const ed = await empty(tab);
  await keys(ed, "a ***both***");
  await ed.shows(`
    a both|
  `);
  await expect.poll(() => ed.frame(`${F}.querySelector("strong > em")?.textContent`)).toBe("both");
  // One undo gives back the typed marks.
  await ed.press("ControlOrMeta+z");
  await ed.shows(`
    a ***both***|
  `);
});

test("**bold with *italic* inside** makes all of it bold", async ({ tab }) => {
  const ed = await empty(tab);
  await keys(ed, "**bold *it* x**");
  await ed.shows(`
    bold it x|
  `);
});

test("[text](url) makes a link", async ({ tab }) => {
  const ed = await empty(tab);
  await keys(ed, "see [the site](https://example.com) ok");
  await ed.shows(`
    see the site ok|
  `);
  await expect.poll(() => ed.frame(`${F}.querySelector("a")?.getAttribute("href")`)).toBe("https://example.com");
});

test("an address typed with a space after it, or pasted, becomes a link", async ({ tab }) => {
  const ed = await empty(tab);
  await keys(ed, "see https://example.com ok ");
  await paste(ed, "https://erga.dev");
  await expect
    .poll(() => ed.frame(`[...${F}.querySelectorAll("a")].map((a) => a.getAttribute("href")).join(" ")`))
    .toBe("https://example.com https://erga.dev");
});

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

test("a Markdown table pasted as plain text becomes a table", async ({ tab }) => {
  const ed = await empty(tab);
  await paste(ed, "| Name | Age |\n| --- | --- |\n| Ann | 30 |\n");
  await expect.poll(() => ed.count("table td")).toBe(2);
  await expect.poll(() => ed.textOf("body")).not.toContain("|");
});

test("--- and ~~text~~ in pasted Markdown become a rule and struck text", async ({ tab }) => {
  const ed = await empty(tab);
  await paste(ed, "Above\n\n---\n\nBelow ~~old~~\n");
  await expect.poll(() => ed.count("hr")).toBe(1);
  await expect.poll(() => struck(ed)).toBe("old");
});

// What the clipboard carries in and out of the page editor (libs/text/api/clipboard.ts), with no browser: plain text
// read as Markdown, and the text a copy writes. The reading of the clipboard's HTML and of a page's selection needs a
// page (ui/clipboard-read.ts): the browser tests have those. "|" is the caret (helpers/page-keys.ts).
import { expect, test } from "bun:test";
import * as C from "../libs/text/api/clipboard";
import { keys } from "./helpers/page-keys";

/** A copied paragraph of plain text, as the copy reads it from the page (clipboard-read.ts, inline: its runs, rendered). */
const line = (text: string): C.Line => ({ tag: "p", list: [], quote: false, ...C.render([{ text, marks: C.NONE }], false, false) });

test("one paragraph without formatting copies as its text alone; Markdown's characters in a copy are escaped only where they would read as Markdown", () => {
  const first = "2 * 3 = 6, snake_case, a [note] and 1. not a list",
    second = "Under *stars* and #1";
  expect(C.clipboardOf([line(first)])).toEqual({ html: first, text: first });
  expect(C.clipboardOf([line(first), line(second)])).toEqual({
    html: `<p>${first}</p><p>${second}</p>`,
    text: "2 * 3 = 6, snake_case, a \\[note\\] and 1. not a list\n\nUnder \\*stars\\* and #1",
  });
});

test("a Markdown document pasted as plain text becomes headings, lists, a quote and code", () => {
  const text = "# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n> quote\n\n```\nlet a = 1;\n```\n";
  const page =
    "<h1>Title</h1>\n<p>Some <strong>bold</strong> and <code>code</code>.</p>\n<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>\n<ol>\n  <li>first</li>\n  <li>second</li>\n</ol>\n<blockquote>\n  <p>quote</p>\n</blockquote>\n<pre>let a = 1;</pre>";
  expect(C.toSource(C.fromText(text), "")).toBe(page);
  // Pasted into an empty page: the blocks take the empty paragraph's place, and the caret is at their end.
  expect(keys("<p>|<br></p>").pasteText(text).text).toBe(page.replace("</pre>", "|</pre>"));
});

test("a Markdown table pasted as plain text becomes a table", () => {
  expect(keys("<p>|<br></p>").pasteText("| Name | Age |\n| --- | --- |\n| Ann | 30 |\n").text).toBe(
    "<table>\n  <thead>\n    <tr><th>Name</th><th>Age</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Ann</td><td>30|</td></tr>\n  </tbody>\n</table>"
  );
});

test("--- and ~~text~~ in pasted Markdown become a rule and struck text", () => {
  expect(keys("<p>|<br></p>").pasteText("Above\n\n---\n\nBelow ~~old~~\n").text).toBe("<p>Above</p>\n<hr>\n<p>Below <s>old</s>|</p>");
});

test("pasting plain text containing URLs auto-links each bare URL outside code and preserves trailing punctuation", () => {
  expect(keys("<p>|<br></p>").pasteText("See https://example.com/a_b_c and www.erga.dev.").text).toBe(
    '<p>See <a href="https://example.com/a_b_c">https://example.com/a_b_c</a> and <a href="https://www.erga.dev">www.erga.dev</a>.|</p>'
  );
  expect(keys("<p>|<br></p>").pasteText("- https://a.example\n- `https://b.example`\n").text).toBe(
    '<ul>\n  <li><a href="https://a.example">https://a.example</a></li>\n  <li><code>https://b.example|</code></li>\n</ul>'
  );
  // Pasting a URL over selected text works with www. as well as https://.
  expect(keys("<p>[Erga] docs</p>").pasteText("www.erga.dev").text).toBe('<p><a href="https://www.erga.dev">[Erga]</a> docs</p>');
  // Pasting a URL inside inline <code> keeps it plain text.
  expect(keys("<p><code>run |</code></p>").pasteText("https://example.com").text).toBe("<p><code>run https://example.com|</code></p>");
  // Pasting a URL, removing the link, and typing after it does not re-link.
  const ed = keys("<p>|<br></p>").pasteText("https://erga.dev");
  expect(ed.text).toBe('<p><a href="https://erga.dev">https://erga.dev</a>|</p>');
  ed.select('<p><a href="https://erga.dev">https://er|ga.dev</a></p>');
  expect(ed.editor.setLink({ url: "" })).toBeNull();
  ed.select("<p>https://erga.dev|</p>").key(" ok ");
  expect(ed.text).toBe("<p>https://erga.dev ok&nbsp;|</p>");
});

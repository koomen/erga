// The page editor's block rules (client/page-editor/blocks.ts), with no browser: Enter, Backspace at a block's start
// and Tab in each kind of block that isn't a list item. "|" is the caret, "[" and "]" a selection (helpers/page-keys.ts).
import { expect, test } from "bun:test";
import { keys } from "./helpers/page-keys";

/** Each key in a place: the source, the keys, the source after them. */
const CASES: [string, string, string[], string][] = [
  ["Backspace at the start of a heading first in the page", '<h1 id="t">|Title</h1>', ["Backspace"], '<p id="t">|Title</p>'],
  ["Backspace twice at the start of a heading after a paragraph", "<p>A</p>\n<h2>|B</h2>", ["Backspace", "Backspace"], "<p>A|B</p>"],
  [
    "Backspace at the start of a list's first item after a paragraph",
    "<p>A</p>\n<ul>\n  <li>|One</li>\n</ul>",
    ["Backspace"],
    "<p>A</p>\n<p>|One</p>",
  ],
  [
    "Backspace at the start of a list's second item joins",
    "<ul>\n  <li>One</li>\n  <li>|Two</li>\n</ul>",
    ["Backspace"],
    "<ul>\n  <li>One|Two</li>\n</ul>",
  ],
  [
    "Backspace at the start of a list's first item, first in the page",
    "<ul>\n  <li>|One</li>\n  <li>Two</li>\n</ul>",
    ["Backspace"],
    "<p>|One</p>\n<ul>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Backspace at the start of a quote's first paragraph",
    "<p>A</p>\n<blockquote>\n  <p>|B</p>\n  <p>C</p>\n</blockquote>",
    ["Backspace"],
    "<p>A</p>\n<p>|B</p>\n<blockquote>\n  <p>C</p>\n</blockquote>",
  ],
  [
    "Enter in an empty last line of a quote",
    "<blockquote>\n  <p>A</p>\n  <p>|<br></p>\n</blockquote>",
    ["Enter"],
    "<blockquote>\n  <p>A</p>\n</blockquote>\n  <p>|<br></p>",
  ],
  [
    "Enter in an empty middle line of a quote",
    "<blockquote>\n  <p>A</p>\n  <p>|<br></p>\n  <p>B</p>\n</blockquote>",
    ["Enter"],
    "<blockquote>\n  <p>A</p>\n</blockquote>\n  <p>|<br></p>\n<blockquote>\n  <p>B</p>\n</blockquote>",
  ],
  [
    "Enter at the end of a code block, typing, and Backspace back",
    "<pre><code>a|</code></pre>",
    ["Enter", "b", "Backspace", "Backspace"],
    "<pre><code>a|</code></pre>",
  ],
  [
    "Enter at the end of a code block holds the new line open",
    "<pre><code>a|</code></pre>",
    ["Enter", "Enter"],
    "<pre><code>a\n\n|<br></code></pre>",
  ],
  [
    "Enter at the end of a closed details' summary",
    "<details><summary>S|</summary><p>X</p></details>",
    ["Enter"],
    "<details><summary>S</summary><p>X</p></details>\n<p>|<br></p>",
  ],
  [
    "Enter in the middle of a summary",
    "<details><summary>S|T</summary></details>",
    ["Enter"],
    "<details><summary>S<br>|T</summary></details>",
  ],
  [
    "Tab and Shift+Tab in a paragraph with a style",
    '<p style="color: red">A|</p>',
    ["Tab", "Tab", "Shift+Tab"],
    '<p style="color: red; margin-left: 40px">A|</p>',
  ],
  [
    "Shift+Tab takes the last step and the style with it",
    '<h2 style="margin-left: 40px">A|</h2>',
    ["Shift+Tab", "Shift+Tab"],
    "<h2>A|</h2>",
  ],
  [
    "Tab over a selection indents each block in it",
    "<p>[A</p>\n<p>B]</p>",
    ["Tab"],
    '<p style="margin-left: 40px">[A</p>\n<p style="margin-left: 40px">B]</p>',
  ],
  // (Not a block rule, but the edit under each: a range replaced keeps the inline tags it opens or closes.)
  ["Typing over a selection that ends in bold", "<p>Bu[ild <em>co]ol</em></p>", ["x"], "<p>Bux|<em>ol</em></p>"],
  [
    "Typing over a selection from a paragraph into a widget's text",
    '<p>A[bc</p>\n<section>\n  <div><b id="n">0</b><span>cl]icks</span></div>\n</section>',
    ["x"],
    '<p>Ax|</p>\n<section>\n  <div><b id="n"></b><span>icks</span></div>\n</section>',
  ],
  // Cmd+B with no selection: the text typed next is bold, or not (a stored mark).
  ["Cmd+B, typing, Cmd+B, typing", "<p>A |</p>", ["Mod+b", "b", "c", "Mod+b", " d"], "<p>A <strong>bc</strong> d|</p>"],
  [
    "Cmd+B in the middle of bold text, then typing",
    "<p><strong>ab|cd</strong></p>",
    ["Mod+b", "x"],
    "<p><strong>ab</strong>x|<strong>cd</strong></p>",
  ],
  ["Cmd+B at the start of bold text, then typing", "<p>A <strong>|bc</strong></p>", ["Mod+b", "x"], "<p>A x|<strong>bc</strong></p>"],
  ["Cmd+B twice is no change", "<p>A|</p>", ["Mod+b", "Mod+b", "x"], "<p>Ax|</p>"],
];

for (const [name, src, ks, after] of CASES)
  test(name, () => {
    const ed = keys(src);
    for (const k of ks) ed.key(k);
    expect(ed.text).toBe(after);
  });

test("one undo takes back each Tab", () => {
  const ed = keys("<p>A|</p>").key("Tab").key("Tab").key("Undo");
  expect(ed.text).toBe('<p style="margin-left: 40px">A|</p>');
});

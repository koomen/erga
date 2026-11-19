// A block's type and its change (libs/text/api/block-type.ts), with no browser: an agent's set_block on a page's HTML,
// which is what the style bar's type menu does to the blocks of a selection.
import { expect, test } from "bun:test";
import * as M from "../shared/manuscript";
import { blocksIn, setBlockType, typeOf } from "../libs/text/api/block-type";
import { textApi } from "../libs/text/api/edits";
import type { Page } from "../libs/text/api/rules";

/** The page after set_block on the elements `selector` names, or its refusal. */
function set(html: string, selector: string, to: string): string {
  const r = textApi.apply(html, "index.html", "set_block", { selector, to });
  if ("refused" in r) return `refused: ${r.refused}`;
  let out = html;
  for (const c of [...r.changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

const LIST = "<ul>\n  <li>One</li>\n  <li>Two</li>\n  <li>Three</li>\n</ul>";
const NESTED = "<ul>\n  <li>One\n    <ul>\n      <li>Deep</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>";

/** Each change: what it is, the page, the element, the type, the page after. */
const CASES: [string, string, string, string, string][] = [
  [
    "a paragraph keeps its attributes as a heading",
    '<p id="a" class="x">A <b>b</b></p>',
    "p",
    "h2",
    '<h2 id="a" class="x">A <b>b</b></h2>',
  ],
  ["a heading as text", "<h3>A</h3>", "h3", "p", "<p>A</p>"],
  [
    "paragraphs next to each other: one list",
    "<div>\n  <p>A</p>\n  <p>B</p>\n</div>",
    "div",
    "ul",
    "<div>\n  <ul>\n    <li>A</li>\n    <li>B</li>\n  </ul>\n</div>",
  ],
  ["a heading as a numbered item", "<h1>A</h1>", "h1", "ol", "<ol>\n  <li>A</li>\n</ol>"],
  ["a paragraph as a to-do item", "<p>A</p>", "p", "todo", '<ul>\n  <li style="list-style: none"><input type="checkbox"> A</li>\n</ul>'],
  ["a paragraph right after a list joins it", "<ul>\n  <li>A</li>\n</ul>\n<p>B</p>", "p", "ul", "<ul>\n  <li>A</li>\n  <li>B</li>\n</ul>"],
  [
    "a paragraph between two lists joins both",
    "<ul>\n  <li>A</li>\n</ul>\n<p>B</p>\n<ul>\n  <li>C</li>\n</ul>",
    "p",
    "ul",
    "<ul>\n  <li>A</li>\n  <li>B</li>\n  <li>C</li>\n</ul>",
  ],
  [
    "a list's middle item as text: the list ends and starts again",
    LIST,
    "li:nth-of-type(2)",
    "p",
    "<ul>\n  <li>One</li>\n</ul>\n<p>Two</p>\n<ul>\n  <li>Three</li>\n</ul>",
  ],
  ["a list's first item as a heading", LIST, "li:nth-of-type(1)", "h2", "<h2>One</h2>\n<ul>\n  <li>Two</li>\n  <li>Three</li>\n</ul>"],
  ["a whole list as text", LIST, "ul", "p", "<p>One</p>\n<p>Two</p>\n<p>Three</p>"],
  ["a whole list as a numbered list keeps its place", LIST, "ul", "ol", LIST.replaceAll("ul>", "ol>")],
  [
    "one item as a to-do item, in its list",
    LIST,
    "li:nth-of-type(2)",
    "todo",
    LIST.replace("<li>Two", '<li style="list-style: none"><input type="checkbox"> Two'),
  ],
  [
    "a to-do item as a bullet again",
    LIST.replace("<li>Two", '<li style="list-style: none"><input type="checkbox" checked> Two'),
    "li:nth-of-type(2)",
    "ul",
    LIST,
  ],
  [
    "one item as a numbered item: a list of its own",
    LIST,
    "li:nth-of-type(3)",
    "ol",
    "<ul>\n  <li>One</li>\n  <li>Two</li>\n</ul>\n<ol>\n  <li>Three</li>\n</ol>",
  ],
  [
    "an item with a nested list as a numbered item keeps the nested list",
    NESTED,
    "body > ul > li:nth-of-type(1)",
    "ol",
    "<ol>\n  <li>One\n    <ol>\n      <li>Deep</li>\n    </ol>\n  </li>\n</ol>\n<ul>\n  <li>Two</li>\n</ul>",
  ],
  [
    "a nested item as a numbered item, in its place",
    NESTED.replace("<li>Deep</li>", "<li>Deep</li>\n      <li>Deeper</li>"),
    "ul ul li:nth-of-type(2)",
    "ol",
    "<ul>\n  <li>One\n    <ul>\n      <li>Deep</li>\n    </ul>\n    <ol>\n      <li>Deeper</li>\n    </ol>\n  </li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "an item as a numbered item joins the numbered list before it",
    "<ol>\n  <li>A</li>\n</ol>\n<ul>\n  <li>B</li>\n  <li>C</li>\n</ul>",
    "ul li:nth-of-type(1)",
    "ol",
    "<ol>\n  <li>A</li>\n  <li>B</li>\n</ol>\n<ul>\n  <li>C</li>\n</ul>",
  ],
  [
    "a list with attributes joins none",
    '<ul class="x">\n  <li>A</li>\n</ul>\n<p>B</p>',
    "p",
    "ul",
    '<ul class="x">\n  <li>A</li>\n</ul>\n<ul>\n  <li>B</li>\n</ul>',
  ],
  ["a nested list as a numbered list keeps its nesting", NESTED, "body > ul", "ol", NESTED.replaceAll("ul>", "ol>")],
  ["a nested list as text: its items in order", NESTED, "body > ul", "p", "<p>One</p>\n    <p>Deep</p>\n<p>Two</p>"],
  [
    "an item and its nested list as text",
    NESTED,
    "body > ul > li:nth-of-type(1)",
    "p",
    "<p>One</p>\n    <p>Deep</p>\n<ul>\n  <li>Two</li>\n</ul>",
  ],
  [
    "a quote's paragraph as text leaves the quote",
    "<blockquote>\n  <p>A</p>\n  <p>B</p>\n</blockquote>",
    "p:nth-of-type(2)",
    "p",
    "<blockquote>\n  <p>A</p>\n</blockquote>\n<p>B</p>",
  ],
  ["paragraphs as a quote", "<p>A</p>\n<p>B</p>", "body", "quote", "<blockquote>\n  <p>A</p>\n  <p>B</p>\n</blockquote>"],
  [
    "a quote as a list",
    "<blockquote>\n  <p>A</p>\n  <p>B</p>\n</blockquote>",
    "blockquote",
    "ul",
    "<ul>\n  <li>A</li>\n  <li>B</li>\n</ul>",
  ],
  [
    "paragraphs as a code block: a line each, no styles",
    "<p>let <b>a</b> = 1;</p>\n<p>a &lt; 2<br>b</p>",
    "body",
    "code",
    "<pre><code>let a = 1;\na &lt; 2\nb</code></pre>",
  ],
  ["a code block as text", '<pre><code class="language-js">a\n  b\n</code></pre>', "pre", "p", "<p>a<br>  b</p>"],
  ["an empty paragraph as a code block", "<p><br></p>", "p", "code", "<pre><code><br></code></pre>"],
  ["the type it has: no change", "<h2>A</h2>", "h2", "h2", "<h2>A</h2>"],
  [
    "a table's cell has no type",
    "<table><tr><td>A</td></tr></table>",
    "td",
    "h2",
    "refused: Only paragraphs, headings, list items, quotes and code blocks change their type.",
  ],
  [
    "an item nested in an item that stays",
    NESTED,
    "ul ul li",
    "p",
    "refused: An item nested in another stays a list item: change its whole list, or take it out first (Shift+Tab).",
  ],
];

for (const [name, html, selector, to, after] of CASES)
  test(`set_block: ${name}`, () => {
    expect(set(`<body>\n${html}\n</body>`, selector, to)).toBe(after.startsWith("refused") ? after : `<body>\n${after}\n</body>`);
  });

/** The page with "[" and "]" around a selection, as the rules know it, and the selection's blocks. */
function selected(marked: string, locked = "") {
  const from = marked.indexOf("["),
    to = marked.indexOf("]") - 1;
  const src = marked.replace(/[[\]]/g, "");
  const units = M.analyzeHtml(src).units;
  const page: Page = { src, units, decode: M.basicDecoder, editable: (u) => !locked || u.tag != locked, open: () => false };
  return { page, blocks: blocksIn(units, from, to) };
}
const after = (src: string, changes: { from: number; to?: number; insert?: string }[]) =>
  [...changes].sort((a, b) => b.from - a.from).reduce((s, c) => s.slice(0, c.from) + (c.insert ?? "") + s.slice(c.to ?? c.from), src);

test("a selection's blocks: the ones it has text of; their type, or mixed; a locked block stays", () => {
  // (A selection that ends at the start of the next block's text, as a triple-click's, has none of that block.)
  const a = selected("<p>[One</p>\n<h2>]Two</h2>");
  expect(a.blocks.map((u) => u.tag)).toEqual(["p"]);
  expect(typeOf(a.page, a.blocks)).toBe("p");
  const b = selected(
    '<h2>O[ne</h2>\n<ul>\n  <li style="list-style: none"><input type="checkbox"> T]wo</li>\n</ul>\n<table><tr><td>x</td></tr></table>'
  );
  expect(typeOf(b.page, b.blocks)).toBe("mixed");
  expect(typeOf(b.page, b.blocks.slice(1))).toBe("todo");
  expect(typeOf(b.page, b.page.units.slice(2))).toBe(null);
  const c = selected("<h2>[One</h2>\n<p>Two]</p>", "h2");
  expect(typeOf(c.page, c.blocks)).toBe("p");
  const r = setBlockType(c.page, c.blocks, "h3");
  expect("changes" in r && after(c.page.src, r.changes)).toBe("<h2>One</h2>\n<h3>Two</h3>");
});

test("an item's own text as text: its nested list stays a list, after it", () => {
  const s = selected(NESTED.replace("One", "[One]"));
  const r = setBlockType(s.page, s.blocks, "p");
  expect("changes" in r && after(s.page.src, r.changes)).toBe(
    "<p>One</p>\n    <ul>\n      <li>Deep</li>\n    </ul>\n<ul>\n  <li>Two</li>\n</ul>"
  );
});

// The page editor's lists (libs/text/api/lists.ts, docs/design/lists.md), with no browser: every list key in
// every place, the round trips that must give back the source exactly, and a sweep of every key at the start, in the
// middle and at the end of every item of a set of lists, which checks what must always hold. "|" is the caret, "["
// and "]" the anchor and head of a selection (helpers/page-keys.ts).
import { describe, expect, test } from "bun:test";
import * as M from "../shared/manuscript";
import { keys, parse, walk } from "./helpers/page-keys";

/** The item after an item with a list in it, the caret at the end of that list's last item. */
const NEXT_ITEM =
  '<ul>\n  <li><p id="nested-a">A parent item</p>\n    <ul>\n      <li id="nested-b">a child item|</li>\n    </ul>\n  </li>\n  <li id="nested-c">The next item</li>\n</ul>';
/** A list of five items (e2e/fixtures/tab-round). */
const FIVE = "<ul>\n  <li>One</li>\n  <li>Two</li>\n  <li>Three</li>\n  <li>Four</li>\n  <li>Five</li>\n</ul>";

/** Each key in a place: the source, the keys, the source after them. */
const CASES: [string, string, string[], string][] = [
  [
    "Enter in the middle of an item",
    "<ul>\n  <li>One</li>\n  <li>T|wo</li>\n  <li>Three</li>\n</ul>",
    ["Enter"],
    "<ul>\n  <li>One</li>\n  <li>T</li>\n  <li>|wo</li>\n  <li>Three</li>\n</ul>",
  ],
  [
    "Enter at the end of the last item",
    "<ul>\n  <li>One</li>\n  <li>Two|</li>\n</ul>",
    ["Enter"],
    "<ul>\n  <li>One</li>\n  <li>Two</li>\n  <li>|<br></li>\n</ul>",
  ],
  [
    "Enter at the start of an item with attributes",
    '<ul>\n  <li class="a" id="i1">|One</li>\n</ul>',
    ["Enter"],
    '<ul>\n  <li class="a"><br></li>\n  <li class="a" id="i1">|One</li>\n</ul>',
  ],
  [
    "Enter in the empty last item",
    "<p>A</p>\n<ul>\n  <li>One</li>\n  <li>|<br></li>\n</ul>\n<p>B</p>",
    ["Enter"],
    "<p>A</p>\n<ul>\n  <li>One</li>\n</ul>\n<p>|<br></p>\n<p>B</p>",
  ],
  [
    "Enter in the empty first item",
    "<ul>\n  <li>|<br></li>\n  <li>Two</li>\n</ul>",
    ["Enter"],
    "<p>|<br></p>\n<ul>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Enter in an empty middle item of a numbered list",
    '<ol start="3">\n  <li>One</li>\n  <li>|<br></li>\n  <li>Three</li>\n</ol>',
    ["Enter"],
    '<ol start="3">\n  <li>One</li>\n</ol>\n<p>|<br></p>\n<ol start="4">\n  <li>Three</li>\n</ol>',
  ],
  ["Enter in the empty only item", "<p>A</p>\n<ul>\n  <li>|<br></li>\n</ul>\n<p>B</p>", ["Enter"], "<p>A</p>\n<p>|<br></p>\n<p>B</p>"],
  // (This case and the next four were browser tests that read only the source: e2e/full/page.)
  [
    "Enter twice at the end of an item between two: a paragraph between two lists",
    "<ul>\n  <li>Faster builds|</li>\n  <li>A <strong>new</strong> editor</li>\n</ul>",
    ["Enter", "Enter", "Between"],
    "<ul>\n  <li>Faster builds</li>\n</ul>\n<p>Between|</p>\n<ul>\n  <li>A <strong>new</strong> editor</li>\n</ul>",
  ],
  [
    "Enter in the empty last item: the page's own empty list stays as it was",
    "<ul></ul>\n<ul>\n  <li>Item 8</li>\n  <li>|<br></li>\n</ul>\n<section>\n  <p>x</p>\n</section>",
    ["Enter", "Z"],
    "<ul></ul>\n<ul>\n  <li>Item 8</li>\n</ul>\n<p>Z|</p>\n<section>\n  <p>x</p>\n</section>",
  ],
  [
    "Enter twice at the end of the only item, in a section: the paragraph stays in the section",
    "<section>\n  <ol>\n    <li>First|</li>\n  </ol>\n</section>",
    ["Enter", "Enter"],
    "<section>\n  <ol>\n    <li>First</li>\n  </ol>\n  <p>|<br></p>\n</section>",
  ],
  [
    "Enter twice in a nested item moves the new item one level out",
    "<ul>\n  <li>Faster builds\n    <ul>\n      <li>A <strong>new</strong> editor|</li>\n    </ul>\n  </li>\n</ul>",
    ["Enter", "Enter", "Out"],
    "<ul>\n  <li>Faster builds\n    <ul>\n      <li>A <strong>new</strong> editor</li>\n    </ul>\n  </li>\n  <li>Out|</li>\n</ul>",
  ],
  [
    "Tab, a key, Shift+Tab, a key: the caret stays where it was in the item's text",
    "<ul>\n  <li>Faster builds</li>\n  <li>A <strong>new</strong> editor|</li>\n</ul>",
    ["Tab", "!", "Shift+Tab", "?"],
    "<ul>\n  <li>Faster builds</li>\n  <li>A <strong>new</strong> editor!?|</li>\n</ul>",
  ],
  [
    "Enter at the end of an item with a list in it, then typing: the new item takes the list",
    "<ul>\n  <li>Beta</li>\n  <li><p>Two|</p>\n    <ul>\n      <li>Beta one</li>\n    </ul>\n  </li>\n</ul>",
    ["Enter", "X"],
    "<ul>\n  <li>Beta</li>\n  <li>Two</li>\n  <li><p>X|</p>\n    <ul>\n      <li>Beta one</li>\n    </ul>\n  </li>\n</ul>",
  ],
  [
    "Shift+Tab at the end of the first nested item keeps the caret at the end of its text",
    "<ul>\n  <li>Beta</li>\n  <li><p>Two</p>\n    <ul>\n      <li>Beta one|</li>\n      <li>Beta two</li>\n    </ul>\n  </li>\n</ul>",
    ["Shift+Tab", "X"],
    "<ul>\n  <li>Beta</li>\n  <li>Two</li>\n  <li>Beta oneX|\n    <ul>\n      <li>Beta two</li>\n    </ul>\n  </li>\n</ul>",
  ],
  [
    "Backspace at a ticked to-do's text start takes the checkbox off",
    '<ul>\n  <li style="list-style: none"><input type="checkbox" checked> |Done</li>\n</ul>',
    ["Backspace"],
    "<ul>\n  <li>|Done</li>\n</ul>",
  ],
  [
    "Enter in an empty nested item",
    "<ul>\n  <li><p>One</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n      <li>|<br></li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
    ["Enter"],
    "<ul>\n  <li><p>One</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>|<br></li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Enter at the end of an item with a list in it",
    "<ul>\n  <li><p>One|</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
    ["Enter"],
    "<ul>\n  <li>One</li>\n  <li><p>|<br></p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Enter in the text of an item with a list in it",
    "<ul>\n  <li><p>O|ne</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
    ["Enter"],
    "<ul>\n  <li>O</li>\n  <li><p>|ne</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Enter at the start of an item with a list in it",
    "<ul>\n  <li><p>|One</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
    ["Enter"],
    "<ul>\n  <li><br></li>\n  <li><p>|One</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Enter at the start of a done to-do",
    '<ul>\n  <li style="list-style: none"><input type="checkbox" checked> |One</li>\n</ul>',
    ["Enter"],
    '<ul>\n  <li style="list-style: none"><input type="checkbox"> </li>\n  <li style="list-style: none"><input type="checkbox" checked> |One</li>\n</ul>',
  ],
  [
    "Enter at the end of a to-do",
    '<ul>\n  <li style="list-style: none"><input type="checkbox" checked> One|</li>\n</ul>',
    ["Enter"],
    '<ul>\n  <li style="list-style: none"><input type="checkbox" checked> One</li>\n  <li style="list-style: none"><input type="checkbox"> |</li>\n</ul>',
  ],
  [
    "Shift+Enter at the end of an item",
    "<ul>\n  <li>One|</li>\n  <li>Two</li>\n</ul>",
    ["Shift+Enter"],
    "<ul>\n  <li>One<br>|<br></li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Shift+Enter in an item",
    "<ul>\n  <li>On|e</li>\n  <li>Two</li>\n</ul>",
    ["Shift+Enter"],
    "<ul>\n  <li>On<br>|e</li>\n  <li>Two</li>\n</ul>",
  ],
  ["Backspace at the start of an item", "<ul>\n  <li>One</li>\n  <li>|Two</li>\n</ul>", ["Backspace"], "<ul>\n  <li>One|Two</li>\n</ul>"],
  [
    "Backspace twice at the start of the first item: the bullet goes, then the join",
    "<p>A</p>\n<ul>\n  <li>|One</li>\n  <li>Two</li>\n</ul>",
    ["Backspace", "Backspace"],
    "<p>A|One</p>\n<ul>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Backspace at the start of the only nested item",
    "<ul>\n  <li><p>One</p>\n    <ul>\n      <li>|A</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
    ["Backspace"],
    "<ul>\n  <li>One|A</li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Backspace at the start of an item after one with a list",
    "<ul>\n  <li><p>One</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>|Two</li>\n</ul>",
    ["Backspace"],
    "<ul>\n  <li><p>One</p>\n    <ul>\n      <li>A</li>\n      <li>B|Two</li>\n    </ul>\n  </li>\n</ul>",
  ],
  [
    "Backspace at the start of an item with a list in it",
    "<ul>\n  <li>Zero</li>\n  <li><p>|One</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
    ["Backspace"],
    "<ul>\n  <li><p>Zero|One</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Backspace at a to-do's checkbox",
    '<ul>\n  <li style="list-style: none"><input type="checkbox"> |One</li>\n</ul>',
    ["Backspace"],
    "<ul>\n  <li>|One</li>\n</ul>",
  ],
  [
    "Backspace at the start of a paragraph after a list",
    "<ul>\n  <li>One</li>\n</ul>\n<p>|After</p>",
    ["Backspace"],
    "<ul>\n  <li>One|After</li>\n</ul>",
  ],
  ["Delete at the end of an item", "<ul>\n  <li>One|</li>\n  <li>Two</li>\n</ul>", ["Delete"], "<ul>\n  <li>One|Two</li>\n</ul>"],
  ["Delete at the end of the last item", "<ul>\n  <li>One|</li>\n</ul>\n<p>After</p>", ["Delete"], "<ul>\n  <li>One|After</li>\n</ul>"],
  [
    "Delete at the end of a paragraph before a list",
    "<p>Before|</p>\n<ul>\n  <li>One</li>\n  <li>Two</li>\n</ul>",
    ["Delete"],
    "<p>Before|One</p>\n<ul>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Delete at the end of an item's text, before its list",
    "<ul>\n  <li><p>One|</p>\n    <ul>\n      <li>A</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
    ["Delete"],
    "<ul>\n  <li>One|A</li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Delete at the end of a list, before a to-do list",
    '<ol>\n  <li>Second|</li>\n</ol>\n<ul>\n  <li style="list-style: none"><input type="checkbox" checked> Done</li>\n  <li>x</li>\n</ul>',
    ["Delete"],
    "<ol>\n  <li>Second|Done</li>\n</ol>\n<ul>\n  <li>x</li>\n</ul>",
  ],
  [
    "Tab in the second item",
    "<ul>\n  <li>One</li>\n  <li>Tw|o</li>\n  <li>Three</li>\n</ul>",
    ["Tab"],
    "<ul>\n  <li>One\n    <ul>\n      <li>Tw|o</li>\n    </ul>\n  </li>\n  <li>Three</li>\n</ul>",
  ],
  ["Tab in the first item", "<ul>\n  <li>On|e</li>\n  <li>Two</li>\n</ul>", ["Tab"], "<ul>\n  <li>On|e</li>\n  <li>Two</li>\n</ul>"],
  [
    "Tab in an item after one with a list",
    "<ul>\n  <li><p>One</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>T|wo</li>\n</ul>",
    ["Tab"],
    "<ul>\n  <li><p>One</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n      <li>T|wo</li>\n    </ul>\n  </li>\n</ul>",
  ],
  [
    "Tab in a numbered list",
    "<ol>\n  <li>One</li>\n  <li>Tw|o</li>\n</ol>",
    ["Tab"],
    "<ol>\n  <li>One\n    <ol>\n      <li>Tw|o</li>\n    </ol>\n  </li>\n</ol>",
  ],
  [
    "Tab with a selection over two items",
    "<ul>\n  <li>One</li>\n  <li>T[wo</li>\n  <li>Thr]ee</li>\n</ul>",
    ["Tab"],
    "<ul>\n  <li>One\n    <ul>\n      <li>T[wo</li>\n      <li>Thr]ee</li>\n    </ul>\n  </li>\n</ul>",
  ],
  [
    "Shift+Tab in a nested item",
    "<ul>\n  <li><p>One</p>\n    <ul>\n      <li>A|</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
    ["Shift+Tab"],
    "<ul>\n  <li>One</li>\n  <li>A|\n    <ul>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Shift+Tab in the last nested item",
    "<ul>\n  <li><p>One</p>\n    <ul>\n      <li>A</li>\n      <li>|B</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
    ["Shift+Tab"],
    "<ul>\n  <li><p>One</p>\n    <ul>\n      <li>A</li>\n    </ul>\n  </li>\n  <li>|B</li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Shift+Tab at the top level",
    "<ul>\n  <li>One</li>\n  <li>Tw|o</li>\n</ul>",
    ["Shift+Tab"],
    "<ul>\n  <li>One</li>\n  <li>Tw|o</li>\n</ul>",
  ],
  [
    "Delete a selection over two items",
    "<ul>\n  <li>O[ne</li>\n  <li>Tw]o</li>\n  <li>Three</li>\n</ul>",
    ["Backspace"],
    "<ul>\n  <li>O|o</li>\n  <li>Three</li>\n</ul>",
  ],
  [
    "Delete a selection over a whole list",
    "<p>A</p>\n<ul>\n  <li>[One</li>\n  <li>Two]</li>\n</ul>\n<p>B</p>",
    ["Backspace"],
    "<p>A</p>\n<ul>\n  <li>|</li>\n</ul>\n<p>B</p>",
  ],
  [
    "Delete a selection from a paragraph into a list",
    "<p>Be[fore</p>\n<ul>\n  <li>One</li>\n  <li>Tw]o</li>\n  <li>Three</li>\n</ul>",
    ["Backspace"],
    "<p>Be|o</p>\n<ul>\n  <li>Three</li>\n</ul>",
  ],
  [
    "Delete a selection from a list into a paragraph",
    "<ul>\n  <li>One</li>\n  <li>Tw[o</li>\n</ul>\n<p>Aft]er</p>",
    ["Backspace"],
    "<ul>\n  <li>One</li>\n  <li>Tw|er</li>\n</ul>",
  ],
  [
    "Delete a selection from a list into another list",
    "<ul>\n  <li>One</li>\n  <li>Tw[o</li>\n</ul>\n<ol>\n  <li>Th]ree</li>\n  <li>Four</li>\n</ol>",
    ["Backspace"],
    "<ul>\n  <li>One</li>\n  <li>Tw|ree</li>\n</ul>\n<ol>\n  <li>Four</li>\n</ol>",
  ],
  [
    "Delete a selection from an item's text to the end of its list",
    "<ul>\n  <li><p>On[e</p>\n    <ul>\n      <li>A</li>\n      <li>B]</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
    ["Backspace"],
    "<ul>\n  <li>On|</li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Delete a selection from an item's text into the next item",
    "<ul>\n  <li><p>On[e</p>\n    <ul>\n      <li>A</li>\n      <li>B</li>\n    </ul>\n  </li>\n  <li>T]wo</li>\n</ul>",
    ["Backspace"],
    "<ul>\n  <li>On|wo</li>\n</ul>",
  ],
  ["Markdown - starts a list", "<p>|</p>", ["-", " ", "x"], "<ul>\n  <li>x|</li>\n</ul>"],
  ["Markdown 1. starts a numbered list", "<p>|</p>", ["1", ".", " ", "x"], "<ol>\n  <li>x|</li>\n</ol>"],
  [
    "Markdown [ ] starts a to-do list",
    "<p>|</p>",
    ["[", "]", " ", "x"],
    '<ul>\n  <li style="list-style: none"><input type="checkbox"> x|</li>\n</ul>',
  ],
  [
    "Markdown [ ] in an item makes it a to-do",
    "<ul>\n  <li>|</li>\n</ul>",
    ["[", "]", " "],
    '<ul>\n  <li style="list-style: none"><input type="checkbox"> |</li>\n</ul>',
  ],
  // (The cases below were browser tests of one rule each: e2e/full/page. The same keys; a selection made with Shift
  // and the arrows there is the source's "[" and "]" here.)
  [
    "Delete at the end of the last nested item joins the next item to it",
    NEXT_ITEM,
    ["Delete"],
    '<ul>\n  <li><p id="nested-a">A parent item</p>\n    <ul>\n      <li id="nested-b">a child item|The next item</li>\n    </ul>\n  </li>\n</ul>',
  ],
  [
    "Delete a selection from a paragraph over a whole list into the next list: no list is left empty",
    "<p>Bef[ore.</p>\n<ul>\n  <li>Only</li>\n</ul>\n<section>\n  <ol>\n    <li>Fi]rst</li>\n  </ol>\n</section>\n<p>After.</p>",
    ["Backspace"],
    "<p>Bef|rst</p>\n<p>After.</p>",
  ],
  [
    "A key typed over a selection of whole items replaces them with one item",
    "<ul>\n  <li>]One</li>\n  <li>Two[</li>\n  <li>Three</li>\n</ul>",
    ["x"],
    "<ul>\n  <li>x|</li>\n  <li>Three</li>\n</ul>",
  ],
  [
    "Tab in a to-do item nests it, with its checkbox",
    '<ul class="todo">\n  <li style="list-style: none"><input type="checkbox"> Buy seeds</li>\n  <li style="list-style: none"><input type="checkbox"> Wate|r the plots</li>\n</ul>',
    ["Tab"],
    '<ul class="todo">\n  <li style="list-style: none"><input type="checkbox"> Buy seeds\n    <ul class="todo">\n      <li style="list-style: none"><input type="checkbox"> Wate|r the plots</li>\n    </ul>\n  </li>\n</ul>',
  ],
  [
    "Tab right after typing in an item nests it, with the text typed",
    "<ul>\n  <li>Item 8</li>\n  <li>Item| 9</li>\n  <li>Item 10</li>\n</ul>",
    ["abc", "Tab"],
    "<ul>\n  <li>Item 8\n    <ul>\n      <li>Itemabc| 9</li>\n    </ul>\n  </li>\n  <li>Item 10</li>\n</ul>",
  ],
  ["Undo right after - makes a list gives back the - typed, as text", "<p>|<br></p>", ["- ", "Undo"], "<p>- |</p>"],
  [
    "Redo after - and undo makes the list again, the caret in its item, and typing goes on there",
    "<p>|<br></p>",
    ["- ", "Undo", "Redo", "One"],
    "<ul>\n  <li>One|</li>\n</ul>",
  ],
  [
    "Undo after Tab and Shift+Tab takes back the Shift+Tab only: the item is nested again",
    "<p>|<br></p>",
    ["- One", "Enter", "Two", "Tab", "Shift+Tab", "Undo"],
    "<ul>\n  <li>One\n    <ul>\n      <li>Two|</li>\n    </ul>\n  </li>\n</ul>",
  ],
];

const P = (t: string) => ({ tag: "p" as const, html: t, text: t, md: t });
const NESTED = "<ul>\n  <li><p>One</p>\n    <ul>\n      <li>A</li>\n    </ul>\n  </li>\n</ul>";
/** An item's text beside its nested list, with no <p>: as Tab writes it (the text is a unit of its own: manuscript.ts, headOf). */
const BARE = "<ul>\n  <li>One\n    <ul>\n      <li>A</li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>";
/** A paste of blocks: the source, the blocks, the source after. */
const PASTES: [string, string, Parameters<ReturnType<typeof keys>["pasteIn"]>[0], string][] = [
  [
    "two paragraphs into an item",
    "<ul>\n  <li>On|e</li>\n  <li>Two</li>\n</ul>",
    [P("X"), P("Y")],
    "<ul>\n  <li>OnX</li>\n  <li>Y|e</li>\n  <li>Two</li>\n</ul>",
  ],
  [
    "three paragraphs into an item",
    "<ul>\n  <li>On|e</li>\n</ul>",
    [P("X"), P("Y"), P("Z")],
    "<ul>\n  <li>OnX</li>\n  <li>Y</li>\n  <li>Z|e</li>\n</ul>",
  ],
  [
    "two paragraphs into an item with a list in it",
    NESTED.replace("One", "On|e"),
    [P("X"), P("Y")],
    "<ul>\n  <li>OnX</li>\n  <li><p>Y|e</p>\n    <ul>\n      <li>A</li>\n    </ul>\n  </li>\n</ul>",
  ],
  [
    "two paragraphs at the start of an item with a list in it",
    NESTED.replace("One", "|One"),
    [P("X"), P("Y")],
    "<ul>\n  <li>X</li>\n  <li><p>Y|One</p>\n    <ul>\n      <li>A</li>\n    </ul>\n  </li>\n</ul>",
  ],
  [
    "a list at the end of an item",
    "<ul>\n  <li>One|</li>\n</ul>",
    [{ tag: "ul", items: ["X", "Y"].map((t) => ({ html: t, text: t, md: t, lists: [] })) }],
    "<ul>\n  <li>OneX</li>\n  <li>Y|</li>\n</ul>",
  ],
  // (Browser tests before, e2e/full/page: the blocks are what the page read from the clipboard's HTML there.)
  [
    "two paragraphs, the first with bold, in the middle of a paragraph split it",
    '<h1>Clipboard</h1>\n<p id="target">Before |after.</p>\n<p id="empty"><br></p>',
    [{ tag: "p", html: "one <strong>bold</strong>", text: "one bold", md: "one **bold**" }, P("two")],
    '<h1>Clipboard</h1>\n<p id="target">Before one <strong>bold</strong></p>\n<p>two|after.</p>\n<p id="empty"><br></p>',
  ],
  [
    "a paragraph and a list into a table cell, which can't split, are lines in it",
    '<table><tr><td id="cell">Cell|</td></tr></table>',
    [P("a"), { tag: "ul", items: [{ html: "<em>b</em>", text: "b", md: "*b*", lists: [] }] }],
    '<table><tr><td id="cell">Cella<br><em>b</em>|</td></tr></table>',
  ],
  [
    "items in the empty paragraph right above a list join that list",
    "<p>Intro</p>\n<p>|<br></p>\n<ul>\n  <li>One</li>\n  <li>Two</li>\n</ul>",
    [{ tag: "ul", items: ["One", "Two"].map((t) => ({ html: t, text: t, md: t, lists: [] })) }],
    "<p>Intro</p>\n<ul>\n  <li>One</li>\n  <li>Two|</li>\n  <li>One</li>\n  <li>Two</li>\n</ul>",
  ],
];

/**
 * Keys that must give back the source exactly, caret and all. (Not Enter at a to-do's start, then Backspace: Backspace
 * at a to-do's start takes its checkbox off first.)
 */
const ROUNDS: [string, string[]][] = [
  ["<ul>\n  <li>One</li>\n  <li>T|wo</li>\n</ul>", ["Enter", "Backspace"]],
  ["<ul>\n  <li>One|</li>\n  <li>Two</li>\n</ul>", ["Enter", "Backspace"]],
  ['<ul class="x">\n  <li class="a" id="i1">|One</li>\n</ul>', ["Enter", "Backspace"]],
  [NESTED.replace("One", "O|ne"), ["Enter", "Backspace"]],
  [NESTED.replace("One", "One|"), ["Enter", "Backspace"]],
  [NESTED.replace("One", "|One"), ["Enter", "Backspace"]],
  // An item's text beside its nested list, with no <p> (as Tab writes it now).
  [BARE.replace("One", "O|ne"), ["Enter", "Backspace"]],
  [BARE.replace("One", "One|"), ["Enter", "Backspace"]],
  [BARE.replace("One", "|One"), ["Enter", "Backspace"]],
  [BARE.replace("Two", "Tw|o"), ["Tab", "Shift+Tab"]],
  [BARE.replace(">A<", ">A|<"), ["Shift+Tab", "Tab"]],
  ['<ul>\n  <li style="list-style: none"><input type="checkbox" checked> One|</li>\n</ul>', ["Enter", "Backspace", "Backspace"]],
  ["<ul>\n  <li>One|</li>\n  <li>Two</li>\n</ul>", ["Shift+Enter", "Backspace"]],
  ["<ul>\n  <li>One</li>\n  <li>Tw|o</li>\n  <li>Three</li>\n</ul>", ["Tab", "Shift+Tab"]],
  ["<ul>\n  <li>One</li>\n  <li>Two</li>\n  <li>Thr|ee</li>\n</ul>", ["Tab", "Shift+Tab"]],
  ["<ul>\n  <li>One</li>\n  <li>Two|</li>\n</ul>", ["Tab", "Tab", "Shift+Tab"]],
  ["<ul>\n  <li>One</li>\n  <li>T[wo</li>\n  <li>Thr]ee</li>\n</ul>", ["Tab", "Shift+Tab"]],
  ["<ul><li>One</li><li>Tw|o</li><li>Three</li></ul>", ["Tab", "Shift+Tab"]],
  ["<ul>\n  <li><p>One</p>\n    <ul>\n      <li>A</li>\n      <li>|B</li>\n    </ul>\n  </li>\n</ul>", ["Shift+Tab", "Tab"]],
  ["<ul>\n  <li>One</li>\n  <li><p>Tw|o</p>\n    <ul>\n      <li>A</li>\n    </ul>\n  </li>\n</ul>", ["Tab", "Shift+Tab"]],
  ["<ol>\n  <li>One</li>\n  <li>|<br></li>\n  <li>Three</li>\n</ol>", ["Enter", "Undo"]],
  ['<ul id="flat">\n  <li>One|</li>\n  <li>Two</li>\n</ul>', ["Enter", "Enter", "Backspace"]],
  // (Browser tests before: e2e/full/page/list-tab-round.e2e.ts, join-cases.e2e.ts.)
  [FIVE.replace("Three", "Th|ree"), ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]],
  [FIVE.replace("Five", "Fi|ve"), ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]],
  ["<main><h1>One line</h1><ul><li>One</li><li>Two</li><li>Th|ree</li></ul><p>After.</p></main>", ["Tab", "Shift+Tab"]],
  [NEXT_ITEM, ["Delete", "Undo"]],
];

/** The lists the sweep goes over: flat, on one line, nested, numbered, to-do, with attributes, with empty items. */
const LISTS: Record<string, string> = {
  flat: "<p>Before</p>\n<ul>\n  <li>One</li>\n  <li>Two</li>\n  <li>Three</li>\n</ul>\n<p>After</p>",
  "one line": "<p>Before</p>\n<ul><li>One</li><li>Two</li><li>Three</li></ul>\n<p>After</p>",
  nested:
    "<ul>\n  <li><p>One</p>\n    <ul>\n      <li>A</li>\n      <li><p>B</p>\n        <ul>\n          <li>C</li>\n        </ul>\n      </li>\n    </ul>\n  </li>\n  <li>Two</li>\n</ul>",
  numbered: '<ol start="3">\n  <li>One</li>\n  <li>Two</li>\n</ol>\n<ol>\n  <li>Three</li>\n</ol>',
  "to-do":
    '<ul>\n  <li style="list-style: none"><input type="checkbox" checked> One</li>\n  <li style="list-style: none"><input type="checkbox"> Two</li>\n</ul>',
  attributes: '<ul class="x">\n  <li class="a" id="i1">One</li>\n  <li class="b" style="color: red">Two <b>bold</b></li>\n</ul>',
  empty: "<ul>\n  <li>One</li>\n  <li><br></li>\n  <li>Three</li>\n  <li><br></li>\n</ul>\n<ul>\n  <li><br></li>\n</ul>",
};
const SWEEP_KEYS = ["Enter", "Shift+Enter", "Backspace", "Delete", "Tab", "Shift+Tab"];

/** What must hold after any key: what's wrong, or nothing. */
function wrong(before: string, after: string): string[] {
  const out: string[] = [];
  const src = parse(after).src,
    was = parse(before).src;
  const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
  const more = (re: RegExp) => count(src, re) > count(was, re);
  if (more(/<(ul|ol)\b[^>]*>\s*<\/\1>/g)) out.push("an empty list");
  if (more(/<li\b[^>]*>\s*<p>(?:(?!<\/?(?:ul|ol|p)\b)[\s\S])*<\/p>\s*<\/li>/g)) out.push("a <p> alone in an item");
  if (more(/<\/li>\s*<(ul|ol)\b/g) || more(/<(ul|ol)\b[^>]*>\s*<(ul|ol)\b/g)) out.push("a list in a list, not in an item");
  if (more(/<li\b[^>]*>(?:\s*<p>)?\s*<li\b/g)) out.push("an item in an item");
  if (more(/<\/(ul|ol)>\s*<\1\b(?![^>]*\bstart=)/g)) out.push("a list split in two");
  if (!M.unitAt(M.analyzeHtml(src).units, parse(after).anchor)) out.push("the caret outside the text");
  return out;
}

describe("lists", () => {
  test.each(CASES)("%s", (_, src, ks, after) => {
    const ed = keys(src);
    for (const k of ks) ed.key(k);
    expect(ed.text).toBe(after);
  });

  test.each(PASTES)("paste: %s", (_, src, blocks, after) => {
    expect(keys(src).pasteIn(blocks).text).toBe(after);
    expect(parse(keys(src).pasteIn(blocks).key("Undo").text).src).toBe(parse(src).src);
  });

  test.each(ROUNDS)("%s, then %p, gives the source back", (src, ks) => {
    const ed = keys(src);
    for (const k of ks) ed.key(k);
    expect(ed.text).toBe(src);
  });

  // ---- Cases of more than one step (helpers/page-keys.ts, walk: keys and the source after them; a source alone is a
  // click or the arrows). Browser tests before: e2e/full/page.

  test("paste: plain text at the end of an item: its paragraphs and its list's items join the list; one undo takes it back", () => {
    const start = '<ul id="list">\n  <li>Alpha|</li>\n  <li>Omega</li>\n</ul>';
    const ed = keys(start).pasteText("Beta\n\nGamma\n- Delta\n  - Epsilon");
    expect(ed.text).toBe(
      '<ul id="list">\n  <li>AlphaBeta</li>\n  <li>Gamma</li>\n  <li>Delta\n    <ul>\n      <li>Epsilon|</li>\n    </ul>\n  </li>\n  <li>Omega</li>\n</ul>'
    );
    expect(ed.key("Undo").text).toBe(start);
  });

  test("Undo after Tab and typing takes back the typing first, then the indent", () => {
    const nested = (item: string) => `<ul>\n  <li>One\n    <ul>\n      <li>${item}</li>\n    </ul>\n  </li>\n</ul>`;
    walk(
      "<p>|<br></p>",
      [["- One", "Enter", "Tab"], nested("|<br>")],
      [["Sub"], nested("Sub|")],
      [["Undo"], nested("|<br>")],
      [["Undo"], "<ul>\n  <li>One</li>\n  <li>|<br></li>\n</ul>"]
    );
  });

  test("Redo of a Backspace that joins two items puts the caret at the join, and typing goes on there", () => {
    walk(
      "<p>|<br></p>",
      [["- One", "Enter", "Two"], "<ul>\n  <li>One</li>\n  <li>Two|</li>\n</ul>"],
      "<ul>\n  <li>One</li>\n  <li>|Two</li>\n</ul>",
      [["Backspace"], "<ul>\n  <li>One|Two</li>\n</ul>"],
      [["Undo"], "<ul>\n  <li>One</li>\n  <li>|Two</li>\n</ul>"],
      [["Redo", "X"], "<ul>\n  <li>OneX|Two</li>\n</ul>"]
    );
  });

  test("Deleting the paragraph between two bulleted lists makes them one list", () => {
    const lists = (gap: string) => `<ul>\n  <li>One</li>\n</ul>\n<p>${gap}</p>\n<ul>\n  <li>Two</li>\n</ul>`;
    walk(
      "<p>|<br></p>",
      [["- One", "Enter", "Enter", "Gap", "Enter", "- Two"], lists("Gap").replace("Two", "Two|")],
      lists("[Gap]"),
      [["Backspace"], lists("|")],
      [["Backspace"], "<ul>\n  <li>One|</li>\n  <li>Two</li>\n</ul>"]
    );
  });

  test.each([
    [
      "bulleted",
      "<ul>\n  <li>Item 1: check the north plots</li>\n  <li>Item 2: check the north plots</li>\n  <li>Item 3: check the north plots</li>\n</ul>",
      "Item 2: check the north plots",
    ],
    ["numbered", "<ol>\n  <li>First step</li>\n  <li>Second step with <strong>bold</strong> text</li>\n</ol>", "First step"],
  ])("Shift+Enter in a %s item breaks the line in the item, mid-text and at the end; undo and Backspace take it out", (_, list, text) => {
    /** The list with `t` as the item's text ("|" in it: the caret). */
    const item = (t: string) => list.replace(text, t);
    const [a, b] = [text.slice(0, 4), text.slice(4)];
    const mid = item(`${a}|${b}`),
      end = item(`${text}|`);
    walk(
      mid,
      // Mid-text: the break, then a letter on the new line. The list keeps its items.
      [["Shift+Enter", "Z"], item(`${a}<br>Z|${b}`)],
      // Backspace twice: the Z, then the break; the lines join.
      [["Backspace", "Backspace"], mid],
      [["Y"], item(`${a}Y|${b}`)],
      [["Backspace"], mid],
      // At the end of the text: a new, empty line in the item, with the caret on it.
      end,
      [["Shift+Enter"], item(`${text}<br>|<br>`)],
      [["W"], item(`${text}<br>W|`)],
      // Undo: the W, then the break, each in one step.
      [["Undo"], item(`${text}<br>|<br>`)],
      [["Undo"], end],
      // Backspace on the new, empty line: the break goes, and the caret is at the end of the text again.
      [["Shift+Enter", "Backspace"], end],
      [["V"], item(`${text}V|`)],
      [["Backspace"], end],
      // One undo takes a break out, mid-text and at the end.
      mid,
      [["Shift+Enter"], item(`${a}<br>|${b}`)],
      [["Undo"], mid],
      end,
      [["Shift+Enter", "Undo"], end],
      // Enter, as before: a new item.
      [["Enter"], item(`${text}</li>\n  <li>|<br>`)]
    );
  });

  test("every key at the start, in the middle and at the end of every item: the list stays whole, undo and redo are exact", () => {
    const failed: string[] = [];
    let n = 0;
    for (const [name, src] of Object.entries(LISTS)) {
      const spots = M.analyzeHtml(src).units.flatMap((u) => {
        const a = M.textStart(u),
          b = M.textEnd(u);
        return [...new Set([a, a + ((b - a) >> 1), b])];
      });
      for (const pos of spots)
        for (const key of SWEEP_KEYS) {
          n++;
          const before = src.slice(0, pos) + "|" + src.slice(pos);
          const ed = keys(before).key(key);
          const after = ed.text;
          const problems = wrong(before, after);
          if (after != before) {
            ed.key("Undo");
            if (parse(ed.text).src != src) problems.push("undo isn't exact");
            ed.key("Redo");
            if (parse(ed.text).src != parse(after).src) problems.push("redo isn't exact");
          }
          if (problems.length) failed.push(`${name}, ${key} in:\n${before}\n${problems.join(", ")}:\n${after}`);
        }
    }
    expect(n).toBeGreaterThan(400);
    expect(failed).toEqual([]);
  });
});

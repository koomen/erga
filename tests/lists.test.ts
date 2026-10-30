// The page editor's lists (client/page-editor/lists.ts, docs/design/lists.md), with no browser: every list key in
// every place, the round trips that must give back the source exactly, and a sweep of every key at the start, in the
// middle and at the end of every item of a set of lists, which checks what must always hold. "|" is the caret, "["
// and "]" the anchor and head of a selection (helpers/page-keys.ts).
import { describe, expect, test } from "bun:test";
import * as M from "../shared/manuscript";
import { keys, parse } from "./helpers/page-keys";

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
    "Backspace at the start of the first item",
    "<p>A</p>\n<ul>\n  <li>|One</li>\n  <li>Two</li>\n</ul>",
    ["Backspace"],
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

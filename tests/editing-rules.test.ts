// The page editor's editing rules (libs/text/api/rules.ts), with no browser and no editor: each key is the pure
// function from the HTML, the selection and the intent to the change, the selection after it and its undo step. "|" is
// the caret, "[" and "]" the anchor and head of a selection (helpers/page-keys.ts, show and parse).
import { describe, expect, test } from "bun:test";
import { ChangeSet, Text } from "@codemirror/state";
import * as M from "../shared/manuscript";
import { blockRange, caretNear, joinBlocks, rules, type Intent, type Page, type Step } from "../libs/text/api/rules";
import type { Change } from "../libs/text/api/lists";
import { keys } from "./helpers/page-keys";

function parse(marked: string): { src: string; anchor: number; head: number } {
  const caret = marked.indexOf("|");
  if (caret >= 0) return { src: marked.slice(0, caret) + marked.slice(caret + 1), anchor: caret, head: caret };
  const a = marked.indexOf("["),
    h = marked.indexOf("]");
  const src = marked.replace("[", "").replace("]", "");
  return { src, anchor: a < h ? a : a - 1, head: h < a ? h : h - 1 };
}

/** A page with every block editable; as on a page, a block of another parse is none of its blocks. */
const pageOf = (src: string): Page => {
  const units = M.analyzeHtml(src).units;
  return { src, units, decode: M.basicDecoder, editable: (u) => units.includes(u), open: () => false };
};

const apply = (src: string, changes: Change[]) =>
  ChangeSet.of(changes, src.length)
    .apply(Text.of(src.split("\n")))
    .toString();

/** The key on a marked source (`intent` can read the caret): the marked source after it, and its undo step. */
function key(marked: string, intent: Intent | ((caret: number) => Intent)): { text: string; undo: Step["undo"] } | "stay" | null {
  const { src, anchor, head } = parse(marked);
  const step = rules(pageOf(src), { anchor, head }, typeof intent == "function" ? intent(head) : intent);
  if (!step || step == "stay") return step;
  return { text: show(apply(src, step.changes), step.selection.anchor, step.selection.head ?? step.selection.anchor), undo: step.undo };
}

function show(src: string, anchor: number, head: number): string {
  if (anchor == head) return src.slice(0, anchor) + "|" + src.slice(anchor);
  const [a, b] = [
    [anchor, "["],
    [head, "]"],
  ].sort((x, y) => (x[0] as number) - (y[0] as number)) as [number, string][];
  return src.slice(0, a[0]) + a[1] + src.slice(a[0], b[0]) + b[1] + src.slice(b[0]);
}

const type =
  (text: string) =>
  (at: number): Intent => ({ kind: "type", from: at, to: at, text, userEvent: "input.type" });

describe("the keys", () => {
  test("a typed letter is a splice in its run, and joins the typing before it in undo", () => {
    expect(key("<p>Hel|o</p>", type("l"))).toEqual({ text: "<p>Hell|o</p>", undo: "type" });
  });

  test("Backspace at a paragraph's start joins it to the one before: only the tags between their texts go", () => {
    expect(key("<p>One</p>\n<p>|Two</p>", { kind: "delete", forward: false })).toEqual({ text: "<p>One|Two</p>", undo: "own" });
  });

  test("Delete at a paragraph's end joins the next", () => {
    expect(key("<p>One|</p>\n<p>Two</p>", { kind: "delete", forward: true })).toEqual({ text: "<p>One|Two</p>", undo: "own" });
  });

  test("Enter splits a paragraph, a step of its own", () => {
    expect(key("<p>On|e</p>", { kind: "enter", shift: false })).toEqual({ text: "<p>On</p>\n<p>|e</p>", undo: "own" });
  });

  test("Enter over a selection across two paragraphs: the delete and the split are one step", () => {
    expect(key("<p>O[ne</p>\n<p>Tw]o</p>", { kind: "enter", shift: false })).toEqual({ text: "<p>O</p>\n<p>|o</p>", undo: "own" });
  });

  test("Enter over a selection to the end of a block: an empty block after it", () => {
    expect(key("<p>O]ne</p>\n<p>Two[</p>", { kind: "enter", shift: false })).toEqual({ text: "<p>O</p>\n<p>|<br></p>", undo: "own" });
  });

  test("Shift+Enter is a line break", () => {
    expect(key("<p>On|e</p>", { kind: "enter", shift: true })).toEqual({ text: "<p>On<br>|e</p>", undo: "own" });
  });

  test("Tab in a list item nests it, with tags only", () => {
    expect(key("<ul>\n  <li>One</li>\n  <li>T|wo</li>\n</ul>", { kind: "indent", out: false })).toEqual({
      text: "<ul>\n  <li>One\n    <ul>\n      <li>T|wo</li>\n    </ul>\n  </li>\n</ul>",
      undo: "own",
    });
  });

  test("Shift+Tab in a code block is taken, and changes nothing", () => {
    expect(key("<pre>a|b</pre>", { kind: "indent", out: true })).toBe("stay");
  });

  test("a paste of two paragraphs splits the block at the caret", () => {
    const blocks = [
      { tag: "p", html: "A", text: "A", md: "A" },
      { tag: "p", html: "B", text: "B", md: "B" },
    ];
    expect(key("<p>x|y</p>", { kind: "paste", blocks } as Intent)).toEqual({ text: "<p>xA</p>\n<p>B|y</p>", undo: "own" });
  });

  test("a locked block takes no key", () => {
    const { src, anchor } = parse("<p>On|e</p>");
    expect(rules({ ...pageOf(src), editable: () => false }, { anchor, head: anchor }, { kind: "delete", forward: false })).toBeNull();
  });

  test("text typed into an empty block takes the place of its <br>", () => {
    expect(key("<p>|<br></p>", type("a"))).toEqual({ text: "<p>a|</p>", undo: "type" });
  });

  // Where no join can be, the key moves the caret to the other block, and the source stays as it was. "{B}" is the
  // caret before Backspace, "{D}" the caret before Delete: each key puts the caret where the other starts. (Browser
  // tests before: the old join-cases browser test and its page.)
  test.each([
    ["after a table", '<table>\n  <tr><td id="table-a">A cell{D}</td></tr>\n</table>\n<p id="table-b">{B}After the table</p>'],
    [
      "with a locked block between",
      '<p id="noedit-a">Before a locked block{D}</p>\n<div data-erga-noedit><p>Locked text</p></div>\n<p id="noedit-b">{B}After the locked block</p>',
    ],
    [
      "with a picture between",
      '<p id="pic-a">Before a picture{D}</p>\n<svg width="40" height="20"><rect width="40" height="20" fill="#7fb6e0"/></svg>\n<p id="pic-b">{B}After the picture</p>',
    ],
  ])("%s: Backspace puts the caret at the end of the block before, and Delete at the start of the next", (_, blocks) => {
    const [atB, atD] = ["{B}", "{D}"].map((mine) => blocks.replace(mine, "|").replace(/\{[BD]\}/, ""));
    expect(key(atB, { kind: "delete", forward: false })).toMatchObject({ text: atD });
    expect(key(atD, { kind: "delete", forward: true })).toMatchObject({ text: atB });
  });
});

// The same rules through the editor's own handlers (helpers/page-keys.ts): a paste, a cut, and typing over the selection
// a triple-click makes. (Browser tests before; they made the clipboard's events by hand, as this does.)
describe("through the editor's handlers", () => {
  test("text pasted over a selection replaces it; a URL pasted over selected text links it", () => {
    expect(keys('<p class="lede">[Bui]ld <em>cool</em> things</p>').pasteText("not a url").text).toBe(
      '<p class="lede">not a url|ld <em>cool</em> things</p>'
    );
    expect(keys("<h1>[Launch] notes</h1>").pasteText(" https://example.com/a?b=1&c=2 ").text).toBe(
      '<h1><a href="https://example.com/a?b=1&amp;c=2">[Launch]</a> notes</h1>'
    );
  });

  // Pete's report: typing over a block a triple-click selected changed the next block too. (A triple-click selects to
  // the start of the next block's text.)
  test("a triple-clicked heading and list item, typed over, keep the block after them", () => {
    expect(keys('<h1>[Title here</h1>\n<p id="first">]First paragraph.</p>').key("To").text).toBe(
      '<h1>To|</h1>\n<p id="first">First paragraph.</p>'
    );
    expect(keys("<ul>\n  <li>[Apple</li>\n  <li>]Banana</li>\n</ul>").key("Pe").text).toBe(
      "<ul>\n  <li>Pe|</li>\n  <li>Banana</li>\n</ul>"
    );
  });

  test("on a slide, a triple-clicked title, typed over, keeps the slide's text below it", () => {
    const slide = (title: string, text: string) => `<section class="slide current"><h1>${title}</h1><p>${text}</p></section>`;
    expect(keys(slide("[First slide", "]The arrows move between slides.")).key("Hi").text).toBe(
      slide("Hi|", "The arrows move between slides.")
    );
  });

  // An id is unique in the page: a paste adds none that the page has already.
  const IDS =
    '<p id="target" class="lead">A block with an id.</p>\n<p id="linked">See <a id="link" name="link" href="#target">the target block</a> above.</p>\n<p class="other">Another block.</p>';

  test("a paste of a copied block with an id: the original keeps its id, and the paste adds no id", () => {
    const pasted = IDS.replace("Another block.", 'Another block.See <a href="#target">the target block</a> above.|');
    // What a copy of the block puts on the clipboard has no id (the copy reads the page: ui/clipboard-read.ts). A block
    // that comes with the page's id and name all the same loses them here.
    for (const link of ['<a href="#target">', '<a id="link" name="link" href="#target">']) {
      const block = { tag: "p" as const, html: `See ${link}the target block</a> above.`, text: "See the target block above.", md: "" };
      expect(keys(IDS.replace("Another block.", "Another block.|")).pasteIn([block]).text).toBe(pasted);
    }
  });

  test("cut and paste of text in a block with an id: the block keeps its id, and the paste adds none", () => {
    const cut = IDS.replace("the target block", "");
    const ed = keys(IDS.replace("the target block", "[the target block]")).cutOut();
    expect(ed.text).toBe(cut.replace('href="#target">', 'href="#target">|'));
    ed.select(cut.replace("Another block.", "Another block.|")).pasteText("the target block");
    expect(ed.text).toBe(cut.replace("Another block.", "Another block.the target block|"));
  });
});

describe("the three shared answers", () => {
  test("a range stops at a block's edge: a triple-click's selection holds none of the next block", () => {
    const src = "<p>One</p>\n<p>Two</p>";
    const units = M.analyzeHtml(src).units;
    expect(blockRange(units, src.indexOf("One"), src.indexOf("Two"))).toEqual({ from: src.indexOf("One"), to: src.indexOf("One") + 3 });
    // A delete from a caret stays in its block.
    expect(blockRange(units, src.indexOf("ne"), src.indexOf("wo"), src.indexOf("ne"))).toEqual({
      from: src.indexOf("ne"),
      to: src.indexOf("One") + 3,
    });
  });

  test("two blocks join: an item and a paragraph after the list", () => {
    const src = "<ul>\n  <li>One</li>\n</ul>\n<p>Two</p>";
    const units = M.analyzeHtml(src).units;
    const join = joinBlocks(src, units[0], units[1], units[1].contentFrom)!;
    expect(apply(src, join)).toBe("<ul>\n  <li>OneTwo</li>\n</ul>");
    expect(join.at as number).toBe(src.indexOf("One") + 3);
  });

  test("a caret outside the text goes to the end of the block before it, else the start of the next", () => {
    const src = "<p>One</p>\n<ul><li>Two</li></ul>";
    const units = M.analyzeHtml(src).units;
    expect(caretNear(units, src.indexOf("\n"))).toBe(src.indexOf("One") + 3);
    expect(caretNear(units, 0)).toBe(src.indexOf("One"));
    expect(caretNear(units, src.indexOf("Two") + 1)).toBeNull();
  });
});

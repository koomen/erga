// The page editor's block rules (libs/text/api/blocks.ts), with no browser: Enter, Backspace at a block's start
// and Tab in each kind of block that isn't a list item. "|" is the caret, "[" and "]" a selection (helpers/page-keys.ts).
import { expect, test } from "bun:test";
import { ChangeSet, Text } from "@codemirror/state";
import * as M from "../shared/manuscript";
import { keys, parse, show, walk } from "./helpers/page-keys";
import { leaveCode } from "../libs/text/api/blocks";
import { textIn } from "../libs/text/api/source";
import { slashItems } from "../libs/text/ui/slash";

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
  // Pete: with the caret at the end of bold text, Cmd+B ends the bold, and the text typed next is not bold: it goes
  // after the </strong>, not in it. Cmd+B again turns bold back on.
  [
    "Cmd+B at the end of bold text makes the text typed next plain; Cmd+B again, bold",
    "<ul>\n  <li>A <strong>new|</strong> editor</li>\n</ul>",
    ["Mod+b", " plain", "Mod+b", "B"],
    "<ul>\n  <li>A <strong>new</strong> plain<strong>B|</strong> editor</li>\n</ul>",
  ],
  // The cases below were browser tests that read only the source (e2e/full/page). The same keys, with no browser.
  [
    "Tab in a code block types two spaces",
    "<pre>code line one\n|code line two</pre>",
    ["Tab", "x"],
    "<pre>code line one\n  x|code line two</pre>",
  ],
  [
    "Enter at the start of a block leaves a blank block before it, held open by a <br>",
    "<figure>\n  <figcaption>|Where the leads go.</figcaption>\n</figure>",
    ["Enter"],
    "<figure>\n  <figcaption><br></figcaption>\n  <figcaption>|Where the leads go.</figcaption>\n</figure>",
  ],
  ["Typing in a <pre> lands after its entity", "<pre>const x = 1 &lt; 2;|</pre>", [" // ok"], "<pre>const x = 1 &lt; 2; // ok|</pre>"],
  [
    "Delete at the end of a heading joins the next block to it, and it stays a heading",
    '<h2 id="head">A heading|</h2>\n<p id="gamma">keeps its own type.</p>',
    ["Delete"],
    '<h2 id="head">A heading|keeps its own type.</h2>',
  ],
  [
    "Backspace at the start of a quote's only paragraph: the quote goes",
    '<p>A</p>\n<blockquote>\n  <p id="quoted">|B</p>\n</blockquote>',
    ["Backspace"],
    '<p>A</p>\n<p id="quoted">|B</p>',
  ],
  [
    "Backspace joins to a block that ends in a line break: on the same line, before the break",
    "<p>This ends in a line break<br></p>\n<p>|and the break goes on</p>",
    ["Backspace"],
    "<p>This ends in a line break|and the break goes on<br></p>",
  ],
  [
    "Backspace twice at a heading's start, one undo: a paragraph again",
    "<p>A</p>\n<h2>|B</h2>",
    ["Backspace", "Backspace", "Undo"],
    "<p>A</p>\n<p>|B</p>",
  ],
  [
    "Backspace twice at a heading's start, two undos: the start",
    "<p>A</p>\n<h2>|B</h2>",
    ["Backspace", "Backspace", "Undo", "Undo"],
    "<p>A</p>\n<h2>|B</h2>",
  ],
  [
    "Backspace twice at a list's first item, one undo: a paragraph again",
    "<p>A</p>\n<ul>\n  <li>|One</li>\n  <li>Two</li>\n</ul>",
    ["Backspace", "Backspace", "Undo"],
    "<p>A</p>\n<p>|One</p>\n<ul>\n  <li>Two</li>\n</ul>",
  ],
  [
    "Backspace twice at the start of a list's only item: the bullet goes, the list goes, then the join",
    "<p>Before.</p>\n<ul>\n  <li>|Only</li>\n</ul>\n<section>\n  <p>x</p>\n</section>",
    ["Backspace", "Backspace"],
    "<p>Before.|Only</p>\n<section>\n  <p>x</p>\n</section>",
  ],
  // Markdown as you type.
  [
    "Typed Markdown becomes styling and the marks go; an underscore inside a word isn't a shortcut",
    "<h1>Launch notes|</h1>",
    [" **big** and *small* and `x` done", " snake_case_name"],
    "<h1>Launch notes <strong>big</strong> and <em>small</em> and <code>x</code> done snake_case_name|</h1>",
  ],
  [
    "## at the start of a line makes a heading; Enter leaves it well-formed",
    "<p>|<br></p>",
    ["## Sub", "Enter"],
    "<h2>Sub</h2>\n<p>|<br></p>",
  ],
  ["- makes a list; Enter twice leaves it", "<p>|<br></p>", ["- item", "Enter", "Enter"], "<ul>\n  <li>item</li>\n</ul>\n<p>|<br></p>"],
  ["> makes a quote", "<p>|<br></p>", ["> quoted"], "<blockquote>\n  <p>quoted|</p>\n</blockquote>"],
  ["> makes a quote; two undos bring back the literal mark", "<p>|<br></p>", ["> quoted", "Undo", "Undo"], "<p>&gt; |</p>"],
  [
    "- [x] makes a ticked to-do item",
    "<p>|<br></p>",
    ["- [x] Done"],
    '<ul>\n  <li style="list-style: none"><input type="checkbox" checked> Done|</li>\n</ul>',
  ],
  ["~~text~~ strikes the text through", "<p>|<br></p>", ["a ~~old~~ b"], "<p>a <s>old</s> b|</p>"],
  [
    "**bold with *italic* inside** makes all of it bold",
    "<p>|<br></p>",
    ["**bold *it* x**"],
    "<p><strong>bold <em>it</em> x</strong>|</p>",
  ],
  [
    "[text](url) makes a link",
    "<p>|<br></p>",
    ["see [the site](https://example.com) ok"],
    '<p>see <a href="https://example.com">the site</a> ok|</p>',
  ],
  ["___ and Enter make a horizontal rule", "<p>|<br></p>", ["___", "Enter"], "<hr>\n<p>|<br></p>"],
  // More browser tests of one rule each (e2e/full/page), with the same keys.
  [
    "Cmd+I and Cmd+U with no selection style the text typed next, and end it again",
    '<p id="last">Last paragraph.|</p>',
    [" ", "Mod+i", "em", "Mod+i", "!", " ", "Mod+u", "u", "Mod+u", "!"],
    '<p id="last">Last paragraph. <em>em</em>! <u>u</u>!|</p>',
  ],
  [
    "Backspace at the start of a paragraph after a code block joins its text to the code's last line, inside the <code>",
    "<pre><code>let a = 1;</code></pre>\n<p>|After</p>",
    ["Backspace", "!"],
    "<pre><code>let a = 1;!|After</code></pre>",
  ],
  // An id is unique in the page: the element an edit adds loses an id (or a link's name) that the page has already.
  [
    "Enter inside a link with an id and a name: the second half of the link keeps its href, not its id or name",
    '<p id="linked">See <a id="link" name="link" href="#target">the |target block</a> above.</p>',
    ["Enter"],
    '<p id="linked">See <a id="link" name="link" href="#target">the </a></p>\n<p><a href="#target">|target block</a> above.</p>',
  ],
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

// ---------------------------------------------------------------- joins
// Backspace at the start of any block joins it to the end of the block before, and Delete at the end of a block joins
// the next one to it: whatever the blocks are, however they nest, whatever lies between them in the source. The caret
// is at the join, and one undo for each key gives back the source and the caret. (e2e/full/page/join-cases.e2e.ts and
// its page, with no browser.) "{B}" is the caret for Backspace, "{D}" the caret for Delete.

/** [what, the two blocks, the source after the join, the key that joins (both when left out), how many presses of each join]. */
const JOINS: [string, string, string, ("Backspace" | "Delete")?, { Backspace: number; Delete: number }?][] = [
  [
    "a paragraph after a div",
    '<div id="divp-a">A div{D}</div>\n<p id="divp-b">{B}then a paragraph</p>',
    '<div id="divp-a">A div|then a paragraph</div>',
  ],
  [
    "a div after a paragraph",
    '<p id="pdiv-a">A paragraph{D}</p>\n<div id="pdiv-b">{B}then a div</div>',
    '<p id="pdiv-a">A paragraph|then a div</p>',
  ],
  [
    "the first block in a box",
    '<p id="intobox-a">Before the box{D}</p>\n<div class="box">\n  <p id="intobox-b">{B}First in the box</p>\n  <p>Second in the box</p>\n</div>',
    '<p id="intobox-a">Before the box|First in the box</p>\n<div class="box">\n  <p>Second in the box</p>\n</div>',
  ],
  [
    "a block after a box",
    '<div class="box">\n  <p>One in the box</p>\n  <p id="outofbox-a">Last in the box{D}</p>\n</div>\n<p id="outofbox-b">{B}After the box</p>',
    '<div class="box">\n  <p>One in the box</p>\n  <p id="outofbox-a">Last in the box|After the box</p>\n</div>',
  ],
  // (Backspace at a heading's start makes it a paragraph first: the second Backspace joins.)
  [
    "a section's heading",
    '<p id="section-a">Before the section{D}</p>\n<section>\n  <h3 id="section-b">{B}The section\'s heading</h3>\n  <p>The section\'s text</p>\n</section>',
    "<p id=\"section-a\">Before the section|The section's heading</p>\n<section>\n  <p>The section's text</p>\n</section>",
    undefined,
    { Backspace: 2, Delete: 1 },
  ],
  [
    "a quote's second paragraph",
    '<blockquote>\n  <p id="quote-a">A quote\'s first line{D}</p>\n  <p id="quote-b">{B}and its second</p>\n</blockquote>',
    '<blockquote>\n  <p id="quote-a">A quote\'s first line|and its second</p>\n</blockquote>',
  ],
  // An empty block before: it takes the text.
  [
    "a block after an empty block",
    '<p id="empty-a">{D}<br></p>\n<p id="empty-b">{B}After an empty block</p>',
    '<p id="empty-a">|After an empty block</p>',
  ],
  [
    "a block after one that ends in a link",
    '<p id="link-a">This ends in <a href="#here">a link{D}</a></p>\n<p id="link-b">{B}and the link goes on</p>',
    '<p id="link-a">This ends in <a href="#here">a link</a>|and the link goes on</p>',
  ],
  // (Backspace here is a case above: "Backspace joins to a block that ends in a line break".)
  [
    "a block after one that ends in a line break",
    '<p id="br-a">This ends in a line break{D}<br></p>\n<p id="br-b">{B}and the break goes on</p>',
    '<p id="br-a">This ends in a line break|and the break goes on<br></p>',
    "Delete",
  ],
  [
    "blocks with different styles",
    '<p id="style-a" style="color: #a33">A red paragraph{D}</p>\n<p id="style-b" class="big">{B}and a big one</p>',
    '<p id="style-a" style="color: #a33">A red paragraph|and a big one</p>',
  ],
  [
    "a block after a comment in the source",
    '<p id="comment-a">Before a comment{D}</p>\n<!-- a note in the source -->\n<p id="comment-b">{B}after the comment</p>',
    '<p id="comment-a">Before a comment|after the comment</p>\n<!-- a note in the source -->',
  ],
  [
    "a block that starts in bold",
    '<p id="bold-a">Before bold{D}</p>\n<p id="bold-b"><b>{B}Bold</b> at the start</p>',
    '<p id="bold-a">Before bold|<b>Bold</b> at the start</p>',
  ],
  [
    "a block that starts with a link",
    '<p id="anchor-a">Before a link{D}</p>\n<p id="anchor-b"><a href="#there">{B}A link</a> at the start</p>',
    '<p id="anchor-a">Before a link|<a href="#there">A link</a> at the start</p>',
  ],
  [
    "a block that starts in nested inline elements",
    '<p id="span-a">Before a span{D}</p>\n<p id="span-b"><span class="s"><em>{B}Deep</em></span> at the start</p>',
    '<p id="span-a">Before a span|<span class="s"><em>Deep</em></span> at the start</p>',
  ],
  [
    "the details after a summary",
    '<details open>\n  <summary id="summary-a">A summary{D}</summary>\n  <p id="summary-b">{B}and the details</p>\n</details>',
    '<details open>\n  <summary id="summary-a">A summary|and the details</summary>\n</details>',
  ],
  [
    "a paragraph after code",
    '<pre id="pre-a">some code{D}</pre>\n<p id="pre-b">{B}after the code</p>',
    '<pre id="pre-a">some code|after the code</pre>',
  ],
  // (Delete here is a case above: "Delete at the end of a heading joins the next block to it".)
  [
    "a paragraph into a heading, which stays a heading",
    '<h2 id="head">A heading{D}</h2>\n<p id="gamma">{B}keeps its own type.</p>',
    '<h2 id="head">A heading|keeps its own type.</h2>',
    "Backspace",
  ],
  // A rule between: the first key takes the rule away, the next joins.
  [
    "blocks with a rule between",
    '<p id="rule-a">Before a rule{D}</p>\n<hr>\n<p id="rule-b">{B}after the rule</p>',
    '<p id="rule-a">Before a rule|after the rule</p>',
    undefined,
    { Backspace: 2, Delete: 2 },
  ],
];

for (const [what, blocks, joined, only, presses = { Backspace: 1, Delete: 1 }] of JOINS)
  for (const [key, mine, other] of [
    ["Backspace", "{B}", "{D}"],
    ["Delete", "{D}", "{B}"],
  ] as const) {
    if (only && only != key) continue;
    test(`${key}: ${what} joins, the caret at the join, and one undo splits it again`, () => {
      const start = blocks.replace(other, "").replace(mine, "|");
      const ed = keys(start);
      for (let i = 0; i < presses[key]; i++) ed.key(key);
      expect(ed.text).toBe(joined);
      for (let i = 0; i < presses[key]; i++) ed.key("Undo");
      expect(ed.text).toBe(start);
    });
  }

test("a rule between: Backspace takes the rule away, and the caret stays at the block's start; one undo brings it back", () => {
  walk(
    '<p id="rule-a">Before a rule</p>\n<hr>\n<p id="rule-b">|after the rule</p>',
    [["Backspace"], '<p id="rule-a">Before a rule</p>\n<p id="rule-b">|after the rule</p>'],
    [["Undo"], '<p id="rule-a">Before a rule</p>\n<hr>\n<p id="rule-b">|after the rule</p>']
  );
});

// ---------------------------------------------------------------- empty blocks
// Backspace in an empty block takes the block away and puts the caret at the end of the block before; Delete there
// joins the next block to it. (e2e/full/page/backspace-empty.e2e.ts and its page.)
const EMPTIES = `<main>
  <header>
    <p class="kicker">Erga designs</p>
    <h1>Custom Edit Examples</h1>
    <p class="intro">Pages that offer edits beyond typing: adding, moving and deleting parts of the page with buttons.</p>
    <p class="intro"><br></p>
    <p class="intro"><br></p>
  </header>
  <section>
    <div class="note">A note in a div.</div>
    <ul>
      <li class="item">A list item.</li>
    </ul>
    <div class="view">
      <div class="view-head"><h3>Page</h3><p class="url">/owner/slug/page</p></div>
    </div>
  </section>
</main>`;

for (const [block, text] of [
  ["p.intro", "deleting parts of the page with buttons."],
  [".note", "A note in a div."],
  [".url", "/owner/slug/page"],
])
  test(`after ${block}: Enter makes an empty block, Backspace takes it away and the caret goes to the end of ${block}`, () => {
    const start = EMPTIES.replace(text, text + "|");
    const ed = keys(start).key("Enter");
    expect(ed.text).not.toBe(start);
    expect(ed.key("Backspace").text).toBe(start);
    // Typing goes in at the end of the block before.
    expect(ed.key("!").text).toBe(EMPTIES.replace(text, text + "!|"));
  });

test("Backspace in an empty block after an empty block takes one away, and Delete in an empty block joins the next block to it", () => {
  const EMPTY = '    <p class="intro"><br></p>\n';
  const one = EMPTIES.replace(EMPTY, ""),
    none = one.replace(EMPTY, "");
  const inEmpty = (src: string) => src.replace('<p class="intro"><br></p>\n  </header>', '<p class="intro">|<br></p>\n  </header>');
  const ed = keys(inEmpty(EMPTIES)).key("Backspace");
  expect(parse(ed.text).src).toBe(one);
  // A click in the one that stays, and Backspace again: the caret goes to the end of the text before.
  expect(ed.select(inEmpty(one)).key("Backspace").text).toBe(none.replace("buttons.", "buttons.|"));
  // Delete: the empty block takes the next block's text, and the list that held it goes.
  ed.select(none.replace("A note in a div.", "A note in a div.|")).key("Enter").key("Delete");
  expect(ed.text).toBe(
    none.replace('\n    <ul>\n      <li class="item">A list item.</li>\n    </ul>', '\n    <div class="note">|A list item.</div>')
  );
});

// ---------------------------------------------------------------- cases of more than one step
// (helpers/page-keys.ts, walk: keys and the source after them; a source alone is a click or the arrows.)

test("Enter twice keeps a blank paragraph, held open by a <br>; the paragraph typed into has none; Backspace into the blank one leaves none", () => {
  const page = (blocks: string) => `<h1>Launch notes</h1>\n${blocks}\n<p class="lede">Build <em>cool</em> things.</p>`;
  walk(
    '<h1>Launch notes|</h1>\n<p class="lede">Build <em>cool</em> things.</p>',
    [["Enter", "hello"], page("<p>hello|</p>")],
    [["Enter", "Enter", "world"], page("<p>hello</p>\n<p><br></p>\n<p>world|</p>")],
    page("<p>hello</p>\n<p><br></p>\n<p>|world</p>"),
    [["Backspace"], page("<p>hello</p>\n<p>|world</p>")]
  );
});

test("Enter at the start of a block with an id: the id stays with the text, and the blank block before has none", () => {
  walk(
    '<main>\n  <p id="target" class="lead">|A block with an id.</p>\n</main>',
    [["Enter"], '<main>\n  <p class="lead"><br></p>\n  <p id="target" class="lead">|A block with an id.</p>\n</main>'],
    [["X"], '<main>\n  <p class="lead"><br></p>\n  <p id="target" class="lead">X|A block with an id.</p>\n</main>']
  );
});

test("pasting into a new paragraph leaves no <br>", () => {
  const ed = keys('<p class="lede">Build things.|</p>').key("Enter");
  expect(ed.text).toBe('<p class="lede">Build things.</p>\n<p class="lede">|<br></p>');
  expect(ed.pasteText("pasted").text).toBe('<p class="lede">Build things.</p>\n<p class="lede">pasted|</p>');
});

test("an ampersand typed is escaped in the source, and reads as itself", () => {
  const ed = keys('<p class="lede">Build <em>cool|</em> things &amp; ship them.</p>').key(" & fun");
  expect(ed.text).toBe('<p class="lede">Build <em>cool &amp; fun|</em> things &amp; ship them.</p>');
  const src = parse(ed.text).src;
  expect(textIn(M.analyzeHtml(src).units, 0, src.length)).toBe("Build cool & fun things & ship them.");
});

// Pete's keys, with Delete: two line breaks, one letter on the new last line, then that letter deleted. Before, the
// deletion took the last line away with the letter.
test("Delete of the one letter on a last line after a line break leaves that line, and the caret on it", () => {
  walk(
    "<p>|<br></p>",
    [["The way we work.", "Shift+Enter", "Shift+Enter", "s"], "<p>The way we work.<br><br>s|</p>"],
    "<p>The way we work.<br><br>|s</p>",
    [["Delete"], "<p>The way we work.<br><br>|<br></p>"],
    [["X"], "<p>The way we work.<br><br>X|</p>"]
  );
});

test("one undo after Enter over a selection gives back the selected text", () => {
  walk(
    '<p id="last">Last paragra]ph.[</p>',
    [["Enter"], '<p id="last">Last paragra</p>\n<p>|<br></p>'],
    [["Undo"], '<p id="last">Last paragra]ph.[</p>']
  );
});

test("undo all the way back gives the start exactly; redo all the way gives the edits", () => {
  const start = '<p id="last">Last paragraph.|</p>';
  const first = '<p id="last">Last paragraph. More words</p>';
  const edited = '<p id="last">Last paragraph. More X|words</p>\n<p>new <strong>par</strong></p>';
  const ed = walk(
    start,
    [[" More words", "Enter", "new para"], `${first}\n<p>new para|</p>`],
    `${first}\n<p>new ]para[</p>`,
    [["Mod+b"], `${first}\n<p>new <strong>[para]</strong></p>`],
    `${first}\n<p>new <strong>para|</strong></p>`,
    [["Backspace"], `${first}\n<p>new <strong>par|</strong></p>`],
    '<p id="last">Last paragraph. More |words</p>\n<p>new <strong>par</strong></p>',
    [["X"], edited]
  );
  for (let i = 0; i < 30; i++) ed.key("Undo");
  expect(ed.text).toBe(start);
  for (let i = 0; i < 30; i++) ed.key("Redo");
  expect(ed.text).toBe(edited);
});

test("Cmd+B wraps the selection in <strong>, and again takes it off", () => {
  const list = (item: string) => `<ul>\n  <li>Faster builds</li>\n  <li>${item} <strong>new</strong> editor</li>\n</ul>`;
  walk(list("[A]"), [["Mod+b"], list("<strong>[A]</strong>")], [["Mod+b"], list("[A]")]);
});

test("Cmd+B on a bold and italic word takes the bold off and keeps the italic, as valid HTML, on part of a bold and italic stretch and on all of one", () => {
  walk(
    "<p>Hello ]brave world[</p>",
    [["Mod+b", "Mod+i"], "<p>Hello <strong><em>[brave world]</em></strong></p>"],
    "<p>Hello <strong><em>brave ]world[</em></strong></p>",
    [["Mod+b"], "<p>Hello <strong><em>brave </em></strong><em>[world]</em></p>"],
    "<p>Hello <strong><em>]brave[ </em></strong><em>world</em></p>",
    [["Mod+b"], "<p>Hello <em>[brave] </em><em>world</em></p>"]
  );
});

// ---------------------------------------------------------------- Markdown as you type, in more than one step

test("***text*** makes the text bold and italic; one undo gives back the typed marks", () => {
  walk("<p>|<br></p>", [["a ***both***"], "<p>a <strong><em>both</em></strong>|</p>"], [["Undo"], "<p>a ***both***|</p>"]);
});

test("an address typed with a space after it, or pasted, becomes a link", () => {
  const typed = '<p>see <a href="https://example.com">https://example.com</a> ok ';
  const ed = walk("<p>|<br></p>", [["see https://example.com ok "], `${typed}|</p>`]);
  expect(ed.pasteText("https://erga.dev").text).toBe(`${typed}<a href="https://erga.dev">https://erga.dev</a>|</p>`);
});

test("``` and Enter make a code block, with the language as a class; undo gives back the typed marks", () => {
  walk(
    "<p>|<br></p>",
    [["```js", "Enter", "let a = 1"], '<pre><code class="language-js">let a = 1|</code></pre>'],
    [["Undo", "Undo"], "<p>```js|</p>"]
  );
});

test("--- or *** on its own line, then Enter, makes a horizontal rule; undo gives back the typed marks", () => {
  walk(
    "<p>|<br></p>",
    [["Above", "Enter", "---", "Enter", "Below", "Enter", "***", "Enter"], "<p>Above</p>\n<hr>\n<p>Below</p>\n<hr>\n<p>|<br></p>"],
    // One undo takes back the last rule only, and gives back its marks with the caret after them.
    [["Undo"], "<p>Above</p>\n<hr>\n<p>Below</p>\n<p>***|</p>"]
  );
});

for (const [marker, block] of [
  ["- ", "<ul>\n  <li><strong>item|</strong></li>\n</ul>"],
  ["# ", "<h1><strong>item|</strong></h1>"],
  ["[ ] ", '<ul>\n  <li style="list-style: none"><input type="checkbox"> <strong>item|</strong></li>\n</ul>'],
])
  test(`after bold text, Enter then "${marker}" makes the block and the text typed stays bold, as valid HTML`, () => {
    walk("<p>Hello ]more[</p>", [["Mod+b"], "<p>Hello <strong>[more]</strong></p>"], "<p>Hello <strong>more|</strong></p>", [
      ["Enter", `${marker}item`],
      `<p>Hello <strong>more</strong></p>\n${block}`,
    ]);
  });

// ArrowDown on the last line of a code block that ends the page makes a paragraph after it: else there is no way out of
// the code block with keys. (The rule alone: that the caret is on the block's last line, the editor reads from the page.)
test("ArrowDown at the end of a code block that ends the page: a paragraph after it, and typing goes there", () => {
  const code = walk("<p>|<br></p>", [["```", "Enter", "code"], "<pre><code>code|</code></pre>"]);
  const src = parse(code.text).src;
  const units = M.analyzeHtml(src).units;
  const out = leaveCode(src, units, units[0])!;
  const at = out.selection.anchor;
  const after = show(
    ChangeSet.of(out.changes, src.length)
      .apply(Text.of(src.split("\n")))
      .toString(),
    { anchor: at, head: at }
  );
  expect(after).toBe("<pre><code>code</code></pre>\n<p>|<br></p>");
  expect(keys(after).key("After").text).toBe("<pre><code>code</code></pre>\n<p>After|</p>");
  // Only from a code block that ends the page: elsewhere the key is the browser's.
  const more = M.analyzeHtml(parse(after).src).units;
  expect(more.map((u) => leaveCode(parse(after).src, more, u))).toEqual([null, null]);
});

// The "/" menu (ui/slash.ts) shows the blocks whose names start with the letters typed; its choice makes the block.
test("/ makes a table of 3 by 3, a divider and a code block; Tab in a table's last cell adds a row", () => {
  const OPEN = '<table border="1" cellpadding="6" style="border-collapse: collapse; table-layout: fixed; width: 100%">';
  const cells = (tag: string, ...text: string[]) => `  <tr>${text.map((t) => `<${tag}>${t}</${tag}>`).join("")}</tr>\n`;
  const EMPTY = cells("td", "<br>", "<br>", "<br>");
  const ed = walk("<p>|<br></p>", [["/ta"], "<p>/ta|</p>"]);
  expect(ed.slashText()).toBe("ta");
  expect(slashItems("ta").map((i) => i.kind)).toEqual(["table"]);
  ed.slashBlock("table");
  // The caret is in the first cell.
  expect(ed.text).toBe(`${OPEN}\n${cells("th", "|<br>", "<br>", "<br>")}${EMPTY}${EMPTY}</table>\n<p><br></p>`);
  const head = `${OPEN}\n${cells("th", "Day", "<br>", "<br>")}${EMPTY}`;
  expect(ed.key("Day").text).toBe(`${OPEN}\n${cells("th", "Day|", "<br>", "<br>")}${EMPTY}${EMPTY}</table>\n<p><br></p>`);
  // Tab in the last cell: a new row, the caret in its first cell.
  ed.select(`${head}${cells("td", "<br>", "<br>", "|<br>")}</table>\n<p><br></p>`)
    .key("End")
    .key("Tab")
    .key("New");
  const table = `${head}${cells("td", "<br>", "<br>", "End")}${cells("td", "New|", "<br>", "<br>")}</table>`;
  expect(ed.text).toBe(`${table}\n<p><br></p>`);
  // Below the table: a divider, then a code block.
  ed.select(`${table.replace("|", "")}\n<p>|<br></p>`).key("/di");
  expect(slashItems(ed.slashText()!).map((i) => i.kind)).toEqual(["divider"]);
  ed.slashBlock("divider");
  expect(ed.text).toBe(`${table.replace("|", "")}\n<hr>\n<p>|<br></p>`);
  ed.key("/co");
  expect(slashItems(ed.slashText()!).map((i) => i.kind)).toEqual(["code"]);
  ed.slashBlock("code");
  expect(ed.key("let x = 1;").text).toBe(`${table.replace("|", "")}\n<hr>\n<pre><code>let x = 1;|</code></pre>`);
});

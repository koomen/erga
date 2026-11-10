// What an agent's edit broke in a page's HTML (agents/document/faults.ts): an element with no end tag, and text
// beside blocks. Only the faults the edit made, and only those that are sure.

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Y from "yjs";
import { broke } from "../agents/document/faults";
import { YjsWorkspace } from "../agents/document/workspace";
import { files } from "../document/content";

const DECK = `<!doctype html>
<html>
<body>
<section class="slide"><h1>One</h1><p>First.</p></section>
<section class="slide"><h1>Two</h1><p>Second.</p></section>
<section class="slide"><h1>Three</h1><p>Third.</p></section>
</body>
</html>
`;

test("an element the edit left open, and text it put beside blocks, each with its line", () => {
  const after = DECK.replace("<p>First.</p></section>", "<p><b>First.</p></section>\nLoose words");
  expect(broke("index.html", DECK, after)).toBe(
    [
      "2 problems in its HTML:",
      " line 4: <b> is not closed",
      ' line 5: loose text "Loose words" beside <section>: nobody can edit it by hand',
      "Fix them now, or restore the last version.",
    ].join("\n")
  );
});

test("well-formed HTML, in each form a browser takes as such, has no fault", () => {
  const fine = [
    "<p>One<p>Two<ul><li>a<li>b</ul>",
    "<table><tr><td>a<td>b<tr><td>c</table>",
    '<p>A<br>line <img src="a.png"> and <input value="x>y"></p><hr>',
    '<svg viewBox="0 0 1 1"><path d="M0 0"/><g><circle r="1"/></g></svg>',
    "<script>if (a < b) document.write('<b>')</script><style>a > b { color: red }</style>",
    "<!-- <b> --><p>1 < 2 and a<b>bold</b></p>",
    "<ul><li>Text first<ul><li>nested</li></ul></li></ul>",
    "<button>Go<div>now</div></button><div data-erga-noedit>Made by script<p>here</p></div>",
    "<template>loose<div>block</div></template>",
    "<div>\n  <p>only blocks</p>\n</div>",
    "<p>inline <b>only</b> text</p>",
  ];
  for (const html of fine) expect(broke("index.html", "", html), html).toBe("");
});

test("each sure fault is named", () => {
  const line = (html: string) => broke("index.html", "", html).split("\n")[1];
  expect(line("<div><p>a</p>")).toBe(" line 1: <div> is not closed");
  expect(line("<p><b><i>a</b></i></p>")).toBe(" line 1: <i> is not closed");
  expect(line("<div />\n<p>a</p>")).toBe(" line 1: <div> is not closed");
  expect(line("<div>\n<p>a</p>\n  A long line of text that goes on and on and on, past any limit\n</div>")).toBe(
    ' line 3: loose text "A long line of text that goes…" beside <p>: nobody can edit it by hand'
  );
  expect(line("<ul><li>Head<ul><li>x</li></ul>tail</li></ul>")).toBe(' line 1: loose text "tail" beside <ul>: nobody can edit it by hand');
});

test("a fault the file had before the edit is not the edit's, and only HTML files are checked", () => {
  const old = "<div>loose<p>a</p></div>\n<p><b>open</p>\n";
  expect(broke("index.html", old, old.replace("<p>a</p>", "<p>b</p>"))).toBe("");
  expect(broke("index.html", old, old + "<span><em>new</span>\n")).toBe(
    "1 problem in its HTML:\n line 3: <em> is not closed\nFix it now, or restore the last version."
  );
  expect(broke("notes.md", "", "<div><b>x</div>")).toBe("");
  expect(broke("page.HTML", "", "<div><b>x</div>")).not.toBe("");
});

test("many faults: the first five, and how many more", () => {
  const out = broke("index.html", "", "<div><b>x</div>\n".repeat(8)).split("\n");
  expect(out[0]).toBe("8 problems in its HTML:");
  expect(out.slice(1)).toEqual([
    ...[1, 2, 3, 4, 5].map((n) => ` line ${n}: <b> is not closed`),
    " and 3 more",
    "Fix them now, or restore the last version.",
  ]);
});

test("edit, write and a page's own edit each say what they broke", () => {
  const doc = new Y.Doc();
  const t = new Y.Text();
  t.insert(0, DECK);
  files(doc).set("index.html", t);
  const ws = new YjsWorkspace(doc, { user: "ada", name: "Ada’s agent", color: "#12a594", kind: "agent" }, () => true, {});
  const edit = Effect.runSync(ws.edit("index.html", [{ oldText: "<p>First.</p>", newText: "<p><b>First.</p>" }]));
  expect(edit.summary).toBe(
    "Edited index.html (1 change).\n1 problem in its HTML:\n line 4: <b> is not closed\nFix it now, or restore the last version."
  );
  // The next edit didn't make that fault: it says nothing of it.
  expect(Effect.runSync(ws.edit("index.html", [{ oldText: "Second.", newText: "2nd." }])).summary).toBe("Edited index.html (1 change).");
  const now = t.toString();
  const at = now.indexOf("<h1>Two");
  expect(Effect.runSync(ws.change("index.html", now, [{ from: at, to: at, insert: "<i>" }])).summary).toMatch(
    /^Edited index\.html \(1 change\)\.\n1 problem in its HTML:\n line 5: <i> is not closed\n/
  );
  expect(Effect.runSync(ws.write("new.html", "<div>Hi<p>there</p></div>")).summary).toBe(
    'Created new.html.\n1 problem in its HTML:\n line 1: loose text "Hi" beside <p>: nobody can edit it by hand\nFix it now, or restore the last version.'
  );
  expect(Effect.runSync(ws.write("new.html", "<div><p>Hi</p><p>there</p></div>")).summary).toBe("Wrote new.html.");
});

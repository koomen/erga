// Pure Layer 1 unit tests for libs/text/api/markdown.ts and the link-edge / stored-marks helpers in
// libs/text/api/format.ts. No DOM, no PageEditor: each rule takes a Page and position and returns a Step or null.

import { describe, expect, test } from "bun:test";
import { ChangeSet, Text } from "@codemirror/state";
import * as M from "../shared/manuscript";
import type { Page, Step } from "../libs/text/api/rules";
import { blockRule, enterRule, inputRule, linkRule, slashTable, slashText, tableRow } from "../libs/text/api/markdown";
import { toggleStoredStyle, typeAtLinkEdge, typeWithStored, type StoredStyles } from "../libs/text/api/format";
import { parse, show } from "./helpers/page-keys";

const pageOf = (src: string, editable?: (u: M.Unit) => boolean): Page => {
  const units = M.analyzeHtml(src).units;
  return { src, units, decode: M.basicDecoder, editable: editable ?? ((u) => units.includes(u)), open: () => false };
};

function applyStep(src: string, step: Step | null): { text: string; undo: Step["undo"]; userEvent: string } | null {
  if (!step) return null;
  const set = ChangeSet.of(step.changes, src.length);
  const after = set.apply(Text.of(src.split("\n"))).toString();
  const sel = { anchor: step.selection.anchor, head: step.selection.head ?? step.selection.anchor };
  return { text: show(after, sel), undo: step.undo, userEvent: step.userEvent };
}

describe("libs/text/api/markdown.ts", () => {
  test("blockRule converts heading, quote, list, numbered list, and to-do markers", () => {
    const run = (marked: string) => {
      const { src, head } = parse(marked);
      return applyStep(src, blockRule(pageOf(src), head));
    };
    expect(run("<p>## |Title</p>")).toEqual({ text: "<h2>|Title</h2>", undo: "own", userEvent: "input.format" });
    expect(run("<h2>### |Sub</h2>")).toEqual({ text: "<h3>|Sub</h3>", undo: "own", userEvent: "input.format" });
    expect(run("<p>&gt; |Quote</p>")).toEqual({
      text: "<blockquote>\n  <p>|Quote</p>\n</blockquote>",
      undo: "own",
      userEvent: "input.format",
    });
    expect(run("<p>- |Item</p>")).toEqual({ text: "<ul>\n  <li>|Item</li>\n</ul>", undo: "own", userEvent: "input.format" });
    expect(run("<p>3. |Third</p>")).toEqual({
      text: '<ol start="3">\n  <li>|Third</li>\n</ol>',
      undo: "own",
      userEvent: "input.format",
    });
    expect(run("<p>[x] |Done</p>")).toEqual({
      text: '<ul>\n  <li style="list-style: none"><input type="checkbox" checked> |Done</li>\n</ul>',
      undo: "own",
      userEvent: "input.format",
    });
    expect(run("<ul>\n  <li>[ ] |Task</li>\n</ul>")).toEqual({
      text: '<ul>\n  <li style="list-style: none"><input type="checkbox"> |Task</li>\n</ul>',
      undo: "own",
      userEvent: "input.format",
    });
  });

  test("blockRule joins adjacent compatible lists directly without a second tidy pass", () => {
    const run = (marked: string) => {
      const { src, head } = parse(marked);
      return applyStep(src, blockRule(pageOf(src), head))?.text;
    };
    expect(run("<ul>\n  <li>One</li>\n</ul>\n<p>- |Two</p>")).toBe("<ul>\n  <li>One</li>\n  <li>|Two</li>\n</ul>");
    expect(run('<p>- |One</p>\n<ul id="keep">\n  <li>Two</li>\n</ul>')).toBe('<ul id="keep">\n  <li>|One</li>\n  <li>Two</li>\n</ul>');
    expect(run("<ul>\n  <li>One</li>\n</ul>\n<p>- |Two</p>\n<ul>\n  <li>Three</li>\n</ul>")).toBe(
      "<ul>\n  <li>One</li>\n  <li>|Two</li>\n  <li>Three</li>\n</ul>"
    );
    // A marker after a <br> splits the paragraph and does not join the list before the head paragraph.
    expect(run("<ul>\n  <li>Before</li>\n</ul>\n<p>Keep<br>- |Item</p>")).toBe(
      "<ul>\n  <li>Before</li>\n</ul>\n<p>Keep</p>\n<ul>\n  <li>|Item</li>\n</ul>"
    );
  });

  test("blockRule reopens inline formatting and respects locked blocks", () => {
    const { src, head } = parse("<p><strong>- |bold</strong></p>");
    expect(applyStep(src, blockRule(pageOf(src), head))?.text).toBe("<ul>\n  <li><strong>|bold</strong></li>\n</ul>");
    expect(
      blockRule(
        pageOf(src, () => false),
        head
      )
    ).toBeNull();
  });

  test("enterRule creates fenced code blocks and horizontal rules", () => {
    const run = (marked: string) => {
      const { src, head } = parse(marked);
      return applyStep(src, enterRule(pageOf(src), head));
    };
    expect(run("<p>```ts|</p>")).toEqual({
      text: '<pre><code class="language-ts">|<br></code></pre>',
      undo: "own",
      userEvent: "input.format",
    });
    expect(run("<p>---|</p>")).toEqual({
      text: "<hr>\n<p>|<br></p>",
      undo: "own",
      userEvent: "input.format",
    });
    // Does not trigger inside a list item or before the end of text.
    expect(run("<ul><li>---|</li></ul>")).toBeNull();
    expect(run("<p>--|-" + "</p>")).toBeNull();
  });

  test("inputRule handles inline styles, links, balanced HTML check, and safety guards", () => {
    const run = (marked: string) => {
      const { src, head } = parse(marked);
      return applyStep(src, inputRule(pageOf(src), head))?.text ?? null;
    };
    expect(run("<p>a **bold**|</p>")).toBe("<p>a <strong>bold</strong>|</p>");
    expect(run("<p>a __bold__|</p>")).toBe("<p>a <strong>bold</strong>|</p>");
    expect(run("<p>a *it*|</p>")).toBe("<p>a <em>it</em>|</p>");
    expect(run("<p>a _it_|</p>")).toBe("<p>a <em>it</em>|</p>");
    expect(run("<p>snake_case_|</p>")).toBeNull();
    expect(run("<p>a ***both***|</p>")).toBe("<p>a <strong><em>both</em></strong>|</p>");
    expect(run("<p>a ~~old~~|</p>")).toBe("<p>a <s>old</s>|</p>");
    expect(run("<p>a `code`|</p>")).toBe("<p>a <code>code</code>|</p>");
    expect(run("<p>**bold <em>it</em> x**|</p>")).toBe("<p><strong>bold <em>it</em> x</strong>|</p>");
    expect(run("<p>[Erga](https://example.com)|</p>")).toBe('<p><a href="https://example.com">Erga</a>|</p>');
    // Rejects unbalanced inner HTML (via M.balanced), <br> inside, unsafe schemes, image syntax, and nested code/links.
    expect(run("<p>*a <em>b*| c</em></p>")).toBeNull();
    expect(run("<p>**a<br>b**|</p>")).toBeNull();
    expect(run("<p>[bad](javascript:alert(1))|</p>")).toBeNull();
    expect(run("<p>![alt](https://example.com/a.png)|</p>")).toBeNull();
    expect(run("<p><code>**no**|</code></p>")).toBeNull();
    expect(run('<p><a href="https://example.com">[nested](https://example.com)|</a></p>')).toBeNull();
  });

  test("linkRule auto-links a typed URL followed by a space", () => {
    const run = (marked: string) => {
      const { src, head } = parse(marked);
      return applyStep(src, linkRule(pageOf(src), head))?.text ?? null;
    };
    expect(run("<p>visit https://example.com/a |</p>")).toBe('<p>visit <a href="https://example.com/a">https://example.com/a</a> |</p>');
    expect(run("<p>(https://example.com/a |</p>")).toBe('<p>(<a href="https://example.com/a">https://example.com/a</a> |</p>');
    expect(run("<p>visit https://example.com/a. |</p>")).toBeNull();
    expect(run('<p><a href="https://example.com">https://example.com |</a></p>')).toBeNull();
    expect(run("<p><code>https://example.com |</code></p>")).toBeNull();
  });

  test("tableRow, slashText, and slashTable", () => {
    const { src, head } = parse("<table><tr><th>A</th><th>B|</th></tr></table>");
    expect(applyStep(src, tableRow(pageOf(src), head))?.text).toBe(
      "<table><tr><th>A</th><th>B</th></tr>\n<tr><td>|<br></td><td><br></td></tr></table>"
    );
    const mid = parse("<table><tr><th>A|</th><th>B</th></tr></table>");
    expect(tableRow(pageOf(mid.src), mid.head)).toBeNull();

    const s1 = parse("<p>/hea|</p>");
    expect(slashText(pageOf(s1.src), { empty: true, head: s1.head })).toBe("hea");
    const s2 = parse("<p>hi /hea|</p>");
    expect(slashText(pageOf(s2.src), { empty: true, head: s2.head })).toBeNull();
    const s3 = parse("<ul><li>/ta|</li></ul>");
    expect(slashText(pageOf(s3.src), { empty: true, head: s3.head })).toBeNull();

    const p = pageOf(s1.src);
    const tbl = applyStep(s1.src, slashTable(s1.src, p.units[0]))!;
    expect(tbl.text).toContain("<tr><th>|<br></th><th><br></th><th><br></th></tr>");
    expect(tbl.text).toContain("</table>\n<p><br></p>");
  });
});

describe("libs/text/api/format.ts stored marks and link-edge typing", () => {
  test("toggleStoredStyle and typeWithStored turn styles on, off, and split existing inline tags", () => {
    // Turn bold on in plain text, then type.
    const a = parse("<p>Hello |</p>");
    const r1 = toggleStoredStyle(pageOf(a.src), a.head, "strong", null);
    expect("styles" in r1).toBe(true);
    const styles = (r1 as { styles: StoredStyles }).styles;
    expect(applyStep(a.src, typeWithStored(pageOf(a.src), a.head, "world", styles))).toEqual({
      text: "<p>Hello <strong>world|</strong></p>",
      undo: "type",
      userEvent: "input.type",
    });

    // Toggling bold twice cancels out -> typeWithStored returns null.
    const r2 = toggleStoredStyle(pageOf(a.src), a.head, "strong", styles);
    expect(typeWithStored(pageOf(a.src), a.head, "x", (r2 as { styles: StoredStyles }).styles)).toBeNull();

    // Turning bold off at the end of <strong> exits after </strong>.
    const end = parse("<p><strong>bold|</strong></p>");
    const offEnd = toggleStoredStyle(pageOf(end.src), end.head, "strong", null) as { styles: StoredStyles };
    expect(applyStep(end.src, typeWithStored(pageOf(end.src), end.head, " plain", offEnd.styles))?.text).toBe(
      "<p><strong>bold</strong> plain|</p>"
    );

    // Turning bold off at the start of <strong> inserts before <strong>.
    const start = parse("<p>A <strong>|bold</strong></p>");
    const offStart = toggleStoredStyle(pageOf(start.src), start.head, "strong", null) as { styles: StoredStyles };
    expect(applyStep(start.src, typeWithStored(pageOf(start.src), start.head, "x", offStart.styles))?.text).toBe(
      "<p>A x|<strong>bold</strong></p>"
    );

    // Turning bold off in the middle of <strong><em> splits <strong> while keeping <em>.
    const mid = parse("<p><strong><em>ab|cd</em></strong></p>");
    const offMid = toggleStoredStyle(pageOf(mid.src), mid.head, "strong", null) as { styles: StoredStyles };
    expect(applyStep(mid.src, typeWithStored(pageOf(mid.src), mid.head, "x", offMid.styles))?.text).toBe(
      "<p><strong><em>ab</em></strong><em>x|</em><strong><em>cd</em></strong></p>"
    );

    // Drops placeholder <br> in an empty paragraph.
    const empty = parse("<p>|<br></p>");
    const onEmpty = toggleStoredStyle(pageOf(empty.src), empty.head, "em", null) as { styles: StoredStyles };
    expect(applyStep(empty.src, typeWithStored(pageOf(empty.src), empty.head, "hi", onEmpty.styles))?.text).toBe("<p><em>hi|</em></p>");

    // Refuses code blocks and locked blocks.
    const pre = parse("<pre><code>x|</code></pre>");
    expect(toggleStoredStyle(pageOf(pre.src), pre.head, "strong", null)).toEqual({ why: "Text in a code block can't be styled." });
    expect(
      toggleStoredStyle(
        pageOf(a.src, () => false),
        a.head,
        "strong",
        null
      )
    ).toEqual({ why: "Put the caret in the text first." });
  });

  test("typeAtLinkEdge extends links on non-space text and exits on spaces at both edges", () => {
    const run = (marked: string, text: string) => {
      const { src, head } = parse(marked);
      return applyStep(src, typeAtLinkEdge(pageOf(src), head, text))?.text ?? null;
    };
    // End of link (inside or outside </a>): word extends, space exits, mixed splits.
    expect(run('<p><a href="https://example.com">link|</a></p>', "s")).toBe('<p><a href="https://example.com">links|</a></p>');
    expect(run('<p><a href="https://example.com">link</a>|</p>', "s")).toBe('<p><a href="https://example.com">links|</a></p>');
    expect(run('<p><a href="https://example.com">link|</a></p>', " ")).toBe('<p><a href="https://example.com">link</a> |</p>');
    expect(run('<p><a href="https://example.com">link|</a></p>', "s more")).toBe('<p><a href="https://example.com">links</a> more|</p>');

    // Start of link (inside or outside <a>): word extends, space stays outside, mixed splits.
    expect(run('<p><a href="https://example.com">|link</a></p>', "my")).toBe('<p><a href="https://example.com">my|link</a></p>');
    expect(run('<p>|<a href="https://example.com">link</a></p>', " ")).toBe('<p> |<a href="https://example.com">link</a></p>');
    expect(run('<p><a href="https://example.com">|link</a></p>', "see my")).toBe('<p>see <a href="https://example.com">my|link</a></p>');

    // Middle of link, outside a link, or inside <pre>: returns null.
    expect(run('<p><a href="https://example.com">li|nk</a></p>', "x")).toBeNull();
    expect(run("<p>plain|</p>", "x")).toBeNull();
    expect(run('<pre><a href="https://example.com">link|</a></pre>', "x")).toBeNull();
  });
});

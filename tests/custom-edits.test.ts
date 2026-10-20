import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { planCustomEdits, applyChanges, type CustomEdit } from "../client/custom-edits";
import { parseHtml, type ElementNode } from "../shared/manuscript";

const page = `<body>
  <ul class="branch">
    <li>
      <div class="view"><h3>Front</h3></div>
    </li>
    <li>
      <div class="view"><h3>Docs</h3></div>
    </li>
  </ul>
  <p id="note">Note</p><img src="a.png">
</body>`;

/** The element whose open tag starts with `open` (the n-th such). */
function el(src: string, root: ElementNode, open: string, n = 0): ElementNode {
  const found: ElementNode[] = [];
  const walk = (e: ElementNode) => { for (const c of e.children) if (c.kind == "element") { if (src.startsWith(open, c.from)) found.push(c); walk(c); } };
  walk(root);
  return found[n];
}
/** Runs a page's custom edits; the new source, or the error. Checks CodeMirror applies the changes the same way. */
function run(src: string, ops: (find: (open: string, n?: number) => ElementNode) => CustomEdit<ElementNode | null>[]): string {
  const root = parseHtml(src);
  const plan = planCustomEdits(src, root, ops((open, n) => el(src, root, open, n)));
  if ("error" in plan) return `ERROR: ${plan.error}`;
  const out = applyChanges(src, plan.changes);
  const state = EditorState.create({ doc: src });
  expect(state.update({ changes: state.changes(plan.changes) }).state.doc.toString()).toBe(out);
  return out;
}
const NEW = `<li>\n<div class="view"><h3>New</h3></div>\n</li>`;

describe("custom edits", () => {
  test("inserts after, before, into and at the start of an element, indented like the code around it", () => {
    expect(run(page, (f) => [{ op: "insert", after: f("<li>", 1), html: NEW }])).toContain(
      `      <div class="view"><h3>Docs</h3></div>\n    </li>\n    <li>\n      <div class="view"><h3>New</h3></div>\n    </li>\n  </ul>`);
    expect(run(page, (f) => [{ op: "insert", before: f("<li>"), html: NEW }])).toContain(
      `<ul class="branch">\n    <li>\n      <div class="view"><h3>New</h3></div>\n    </li>\n    <li>\n      <div class="view"><h3>Front</h3></div>`);
    expect(run(page, (f) => [{ op: "insert", into: f("<ul"), html: NEW }])).toContain(`<h3>New</h3></div>\n    </li>\n  </ul>`);
    expect(run(page, (f) => [{ op: "insert", prepend: f("<ul"), html: NEW }])).toContain(`<ul class="branch">\n    <li>\n      <div class="view"><h3>New</h3>`);
  });

  test("an empty element gets the new HTML on lines of its own", () => {
    const src = `<div>\n  <ul class="x"></ul>\n</div>`;
    expect(run(src, (f) => [{ op: "insert", into: f("<ul"), html: "<li>A</li>" }])).toBe(`<div>\n  <ul class="x">\n    <li>A</li>\n  </ul>\n</div>`);
  });

  test("however the page's script wrote the HTML, it's indented by its nesting", () => {
    const html = `<ul class="branch">\n        <li>\n  <div class="view"><h3>Sub</h3></div>\n            </li>\n</ul>`;
    expect(run(page, (f) => [{ op: "insert", into: f("<li>"), html }])).toContain(
      `<h3>Front</h3></div>\n      <ul class="branch">\n        <li>\n          <div class="view"><h3>Sub</h3></div>\n        </li>\n      </ul>\n    </li>`);
  });

  test("removes, moves and replaces whole elements; sets and removes attributes", () => {
    expect(run(page, (f) => [{ op: "remove", el: f("<li>") }])).not.toContain("Front");
    const moved = run(page, (f) => [{ op: "move", el: f("<li>", 1), before: f("<li>") }]);
    expect(moved.indexOf("Docs")).toBeLessThan(moved.indexOf("Front"));
    expect(moved.replace("Docs", "X").replace("Front", "Docs").replace("X", "Front")).toBe(page);
    expect(run(page, (f) => [{ op: "replace", el: f("<p"), html: `<p id="note">New <em>note</em></p>` }])).toContain(`<p id="note">New <em>note</em></p><img`);
    expect(run(page, (f) => [{ op: "attr", el: f("<li>"), name: "class", value: `done "now"` }])).toContain(`<li class="done &quot;now&quot;">`);
    expect(run(page, (f) => [{ op: "attr", el: f("<ul"), name: "class", value: null }])).toContain(`<ul>`);
    expect(run(page, (f) => [{ op: "attr", el: f("<img"), name: "alt", value: "A" }])).toContain(`<img src="a.png" alt="A">`);
  });

  test("several edits are one change, all against the source as it was", () => {
    const out = run(page, (f) => [{ op: "remove", el: f("<li>") }, { op: "insert", after: f("<li>", 1), html: NEW }, { op: "attr", el: f("<p"), name: "class", value: "x" }]);
    expect(out).not.toContain("Front");
    expect(out.indexOf("Docs")).toBeLessThan(out.indexOf("New"));
    expect(out).toContain(`<p id="note" class="x">`);
  });

  test("refuses what would break the page, and says why", () => {
    const err = (ops: Parameters<typeof run>[1]) => run(page, ops);
    expect(err(() => [{ op: "remove", el: null }])).toMatch(/isn't an element of the page's source/);
    expect(err((f) => [{ op: "remove", el: f("<body") }])).toMatch(/page's <body>/);
    expect(err((f) => [{ op: "insert", after: f("<li>"), html: "<li>Open" }])).toMatch(/isn't closed/);
    expect(err((f) => [{ op: "insert", after: f("<li>"), html: "<li>A</li></ul>" }])).toMatch(/end tag that closes nothing/);
    expect(err((f) => [{ op: "insert", after: f("<li>"), html: "<li>A<script>x()</script></li>" }])).toMatch(/<script>/);
    expect(err((f) => [{ op: "insert", after: f("<li>"), html: `<li onclick="x()">A</li>` }])).toMatch(/onclick/);
    expect(err((f) => [{ op: "insert", after: f("<li>"), html: `<li data-erga-id="3">A</li>` }])).toMatch(/data-erga-id/);
    expect(err((f) => [{ op: "attr", el: f("<li>"), name: "onclick", value: "x()" }])).toMatch(/onclick/);
    expect(err((f) => [{ op: "move", el: f("<li>"), into: f("<div") }])).toMatch(/into itself/);
    expect(err((f) => [{ op: "remove", el: f("<li>") }, { op: "attr", el: f("<div"), name: "a", value: "b" }])).toMatch(/same element/);
    expect(err((f) => [{ op: "insert", into: f("<img"), html: "<b>x</b>" }])).toMatch(/into a <img>/);
    expect(err(() => [{ op: "explode" } as never])).toMatch(/unknown op/);
    expect(err(() => [])).toMatch(/list of edits/);
    const unclosed = `<div><p>One<div>x</div></div>`;
    const root = parseHtml(unclosed);
    expect(planCustomEdits(unclosed, root, [{ op: "remove", el: el(unclosed, root, "<p>") }])).toEqual({ error: expect.stringMatching(/isn't closed by its own end tag/) });
  });
});

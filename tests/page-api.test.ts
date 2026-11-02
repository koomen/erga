// A page's own API (document/page-api.ts): its module, run in the sandbox, answers operations on elements named by CSS
// selector; Erga makes them one change to the source, or refuses them, saying why.
import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { applyPageEdit, describePageApi } from "../document/page-api";
import { apiPathOf, applyChanges, planPageOps } from "../shared/page-ops";
import { testSandbox } from "./helpers/sandbox";

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
const LI1 = "ul > li:nth-child(1)",
  LI2 = "ul > li:nth-child(2)";

/** Plans operations on `src`; the new source, or the error. Checks CodeMirror applies the changes the same way. */
function run(ops: unknown, src = page): string {
  const plan = planPageOps(src, ops);
  if ("error" in plan) return `ERROR: ${plan.error}`;
  const out = applyChanges(src, plan.changes);
  const state = EditorState.create({ doc: src });
  expect(state.update({ changes: state.changes(plan.changes) }).state.doc.toString()).toBe(out);
  return out;
}
const NEW = `<li>\n<div class="view"><h3>New</h3></div>\n</li>`;

describe("a page's operations", () => {
  test("inserts after, before, into and at the start of an element, indented like the code around it", () => {
    expect(run([{ op: "insert", after: LI2, html: NEW }])).toContain(
      `      <div class="view"><h3>Docs</h3></div>\n    </li>\n    <li>\n      <div class="view"><h3>New</h3></div>\n    </li>\n  </ul>`
    );
    expect(run([{ op: "insert", before: LI1, html: NEW }])).toContain(
      `<ul class="branch">\n    <li>\n      <div class="view"><h3>New</h3></div>\n    </li>\n    <li>\n      <div class="view"><h3>Front</h3></div>`
    );
    expect(run([{ op: "insert", into: "ul", html: NEW }])).toContain(`<h3>New</h3></div>\n    </li>\n  </ul>`);
    expect(run([{ op: "insert", prepend: "ul", html: NEW }])).toContain(
      `<ul class="branch">\n    <li>\n      <div class="view"><h3>New</h3>`
    );
  });

  test("an empty element gets the new HTML on lines of its own; any HTML is indented by its nesting", () => {
    expect(run([{ op: "insert", into: "ul", html: "<li>A</li>" }], `<div>\n  <ul class="x"></ul>\n</div>`)).toBe(
      `<div>\n  <ul class="x">\n    <li>A</li>\n  </ul>\n</div>`
    );
    const html = `<ul class="branch">\n        <li>\n  <div class="view"><h3>Sub</h3></div>\n            </li>\n</ul>`;
    expect(run([{ op: "insert", into: LI1, html }])).toContain(
      `<h3>Front</h3></div>\n      <ul class="branch">\n        <li>\n          <div class="view"><h3>Sub</h3></div>\n        </li>\n      </ul>\n    </li>`
    );
  });

  test("removes, moves and replaces whole elements; sets and removes attributes; several are one change", () => {
    expect(run([{ op: "remove", el: LI1 }])).not.toContain("Front");
    const moved = run([{ op: "move", el: LI2, before: LI1 }]);
    expect(moved.replace("Docs", "X").replace("Front", "Docs").replace("X", "Front")).toBe(page);
    expect(run([{ op: "replace", el: "#note", html: `<p id="note">New <em>note</em></p>` }])).toContain(
      `<p id="note">New <em>note</em></p><img`
    );
    expect(run([{ op: "attr", el: LI1, name: "class", value: `done "now"` }])).toContain(`<li class="done &quot;now&quot;">`);
    expect(run([{ op: "attr", el: "ul", name: "class", value: null }])).toContain(`<ul>`);
    expect(run([{ op: "attr", el: "img", name: "alt", value: "A" }])).toContain(`<img src="a.png" alt="A">`);
    const out = run([
      { op: "remove", el: LI1 },
      { op: "insert", after: LI2, html: NEW },
      { op: "attr", el: "#note", name: "class", value: "x" },
    ]);
    expect(out.indexOf("Docs")).toBeLessThan(out.indexOf("New"));
    expect(out).toContain(`<p id="note" class="x">`);
  });

  test("refuses what would break the page, and says why", () => {
    expect(run([{ op: "remove", el: "#gone" }])).toMatch(/matches 0 elements/);
    expect(run([{ op: "remove", el: "li" }])).toMatch(/matches 2 elements/);
    expect(run([{ op: "remove", el: "li:hover" }])).toMatch(/isn't a selector/);
    expect(run([{ op: "remove", el: "body" }])).toMatch(/page's <body>/);
    expect(run([{ op: "insert", after: LI1, html: "<li>Open" }])).toMatch(/isn't closed/);
    expect(run([{ op: "insert", after: LI1, html: "<li>A</li></ul>" }])).toMatch(/end tag that closes nothing/);
    expect(run([{ op: "insert", after: LI1, html: "<li>A<script>x()</script></li>" }])).toMatch(/<script>/);
    expect(run([{ op: "insert", after: LI1, html: `<li onclick="x()">A</li>` }])).toMatch(/onclick/);
    expect(run([{ op: "insert", after: LI1, html: `<li data-erga-text>A</li>` }])).toMatch(/data-erga-text/);
    expect(run([{ op: "attr", el: LI1, name: "onclick", value: "x()" }])).toMatch(/onclick/);
    expect(run([{ op: "move", el: LI1, into: `${LI1} > div` }])).toMatch(/into itself/);
    expect(
      run([
        { op: "remove", el: LI1 },
        { op: "attr", el: `${LI1} > div`, name: "a", value: "b" },
      ])
    ).toMatch(/same element/);
    expect(run([{ op: "insert", into: "img", html: "<b>x</b>" }])).toMatch(/into a <img>/);
    expect(run([{ op: "explode" }])).toMatch(/unknown op/);
    expect(run([])).toMatch(/list of operations/);
    expect(run([{ op: "remove", el: "p" }], `<div><p>One<div>x</div></div>`)).toMatch(/isn't closed by its own end tag/);
  });
});

describe("a page's API module, in the sandbox", () => {
  const code = `export default {
    name: "notes",
    description: "The page's notes.",
    edits: [{ name: "set_note", description: "Sets the note", input: { type: "object", properties: { text: { type: "string" } } } }],
    apply(html, edit, input) {
      if (!html.includes('id="note"')) return { refused: "the page has no note" };
      return [{ op: "replace", el: "#note", html: '<p id="note">' + input.text + "</p>" }];
    },
  };`;

  test("the page names its module; the module describes its edits and answers one with operations", async () => {
    expect(apiPathOf("blog/post.html", `<meta name="erga-api" content="../api.js">`)).toBe("api.js");
    expect(apiPathOf("blog/post.html", `<meta content='api.js' name=erga-api>`)).toBe("blog/api.js");
    expect(apiPathOf("index.html", `<p>No API</p>`)).toBeNull();
    expect(await describePageApi(testSandbox, code)).toEqual({
      name: "notes",
      description: "The page's notes.",
      edits: [{ name: "set_note", description: "Sets the note", input: { type: "object", properties: { text: { type: "string" } } } }],
    });
    const r = await applyPageEdit(testSandbox, code, page, "set_note", { text: "Done" });
    expect("changes" in r && applyChanges(page, r.changes)).toContain(`<p id="note">Done</p><img`);
  });

  test("a refusal, a bad answer or a module that throws comes back as why", async () => {
    expect(await applyPageEdit(testSandbox, code, "<p>x</p>", "set_note", { text: "a" })).toEqual({ refused: "the page has no note" });
    expect(await applyPageEdit(testSandbox, code, page, "set_note", { text: "<b>a" })).toEqual({
      refused: expect.stringMatching(/set_note can't be made: .*isn't closed/),
    });
    await expect(applyPageEdit(testSandbox, `export default { apply() { throw new Error("boom") } }`, page, "x", {})).rejects.toThrow(
      /didn't answer: boom/
    );
    await expect(describePageApi(testSandbox, `export default { name: "x" }`)).rejects.toThrow(/needs edits/);
  });
});

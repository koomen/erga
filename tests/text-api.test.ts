// erga/text's API (libs/text/api/edits.ts): the named edits, on a page's HTML, with no browser, as the document's object
// runs them for an agent's call_edit.
import { expect, test } from "bun:test";
import { textApi, type EditResult } from "../libs/text/api/edits";
import { walk } from "./helpers/page-keys";

const PAGE = `<!doctype html>
<html><body>
  <h1>Draft notes</h1>
  <p id="intro">The quick <strong>brown</strong> fox jumps.</p>
  <ul>
    <li>One</li>
    <li>Two</li>
  </ul>
</body></html>
`;

/** The page after an edit, or its refusal. */
function run(edit: string, input: unknown, html = PAGE): string {
  const r: EditResult = textApi.apply(html, "index.html", edit, input);
  if ("refused" in r) return `refused: ${r.refused}`;
  let out = html;
  for (const c of [...r.changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

test("it lists its edits, each with a description and its input's schema", () => {
  expect(textApi.edits.map((e) => e.name)).toEqual([
    "insert_text",
    "replace_text",
    "split",
    "set_block",
    "style",
    "clear_styles",
    "link",
    "indent",
    "insert_blocks",
  ]);
  for (const e of textApi.edits) expect((e.input as { type: string }).type).toBe("object");
});

test("text: typed at a place, replaced, deleted, by the text a person reads", () => {
  expect(run("insert_text", { selector: "h1", text: "!", at: "end" })).toContain("<h1>Draft notes!</h1>");
  expect(run("insert_text", { selector: "#intro", text: "very ", before: "quick" })).toContain("The very quick <strong>brown</strong>");
  // (Over styled text, as typing over a selection: the new text is plain.)
  expect(run("replace_text", { selector: "#intro", find: "brown fox", text: "red fox" })).toContain(
    '<p id="intro">The quick red fox jumps.</p>'
  );
  expect(run("replace_text", { selector: "h1", find: "Draft ", text: "" })).toContain("<h1>notes</h1>");
  expect(run("replace_text", { selector: "#intro", find: "cat", text: "x" })).toMatch(/^refused: "cat" isn't in the text of #intro/);
  expect(run("replace_text", { selector: "li", find: "One", text: "x" })).toMatch(/^refused: "li" matches 2 elements/);
});

test("blocks: Enter splits, a heading becomes a paragraph, Tab nests an item, Markdown adds blocks", () => {
  expect(run("split", { selector: "#intro", after: "jumps." })).toMatch(/fox jumps\.<\/p>\s*<p[^>]*><br><\/p>/);
  expect(run("set_block", { selector: "h1", to: "h2" })).toContain("<h2>Draft notes</h2>");
  expect(run("indent", { selector: "li:nth-of-type(2)" })).toMatch(/<li>One\s*<ul>\s*<li>Two<\/li>\s*<\/ul>\s*<\/li>/);
  expect(run("insert_blocks", { selector: "h1", markdown: "A new paragraph.\n\n- a\n- b" })).toMatch(
    /<h1>Draft notes<\/h1>\n  <p>A new paragraph\.<\/p>/
  );
});

test("styles and links: on, off, cleared; a link put on and taken off", () => {
  expect(run("style", { selector: "#intro", find: "quick", style: "em" })).toContain("The <em>quick</em> <strong>brown</strong>");
  // (On already: no change.)
  expect(run("style", { selector: "#intro", find: "brown", style: "strong" })).toBe(PAGE);
  expect(run("style", { selector: "#intro", find: "brown", style: "strong", on: false })).toContain("The quick brown fox");
  expect(run("clear_styles", { selector: "#intro", find: "quick brown" })).toContain("The quick brown fox");
  const linked = run("link", { selector: "h1", find: "notes", url: "https://erga.dev" });
  expect(linked).toContain('<h1>Draft <a href="https://erga.dev">notes</a></h1>');
  expect(run("link", { selector: "h1", find: "notes", url: "" }, linked)).toContain("<h1>Draft notes</h1>");
  expect(run("bold", { selector: "h1" })).toMatch(/^refused: erga\/text has no edit "bold"/);
});

// Clear formatting (api/format.ts, clearStyles): the edit, and the same change with Cmd+\ in the editor (helpers/page-keys.ts,
// walk), where one undo takes it back. (Browser tests before: the old format-clear browser test.)
test("clear_styles splits an element it only partly covers, as one undo step", () => {
  const list = (item: string) => `<ul>\n  <li>Faster builds</li>\n  <li>A ${item} editor</li>\n</ul>`;
  expect(run("clear_styles", { selector: "li:nth-of-type(2)", find: "ew" }, list("<strong>new</strong>"))).toBe(
    list("<strong>n</strong>ew")
  );
  // (In the middle of an element: its two ends keep the style.)
  expect(run("clear_styles", { selector: "#intro", find: "ro" })).toContain("The quick <strong>b</strong>ro<strong>wn</strong> fox");
  walk(list("<strong>n[ew]</strong>"), [["Mod+\\"], list("<strong>n</strong>[ew]")], [["Undo"], list("<strong>n[ew]</strong>")]);
});

test("clearing a heading makes it a paragraph, as one undo step", () => {
  expect(run("clear_styles", { selector: "h1", find: "Draft notes" })).toBe(PAGE.replace("<h1>Draft notes</h1>", "<p>Draft notes</p>"));
  walk("<h2>[What changed]</h2>", [["Mod+\\"], "<p>[What changed]</p>"], [["Undo"], "<h2>[What changed]</h2>"]);
});

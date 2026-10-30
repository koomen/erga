// One part of a file's source by a selector (shared/source-select.ts): an element, as read's selector and an edit's
// selector name it, or a CSS rule, as css_rule and cssRule do. Found in the source as written.
import { expect, test } from "bun:test";
import { cssRulesInSource, findInSource, parseSelector, selectInSource } from "../shared/source-select";

const PAGE = `<!doctype html>
<html><head><style>
  /* The legible slide */
  .legible h2 { color: red; }
  .legible  >  p { content: "}"; }
  @media (max-width: 600px) {
    .legible h2 { color: blue; }
  }
</style></head>
<body>
<section class="slide legible" id="one"><h2>One</h2><p>First</p><p>Second</p></section>
<section class="slide"><h2 data-k='a b'>Two</h2>
<svg viewBox="0 0 10 10"><g id="logo"><rect width="10" height="10"/></g><g class="mark"></g></svg>
</section>
</body></html>`;

const text = (sel: string) => {
  const r = findInSource(PAGE, "index.html", { selector: sel });
  return typeof r == "string" ? r : PAGE.slice(r.from, r.to);
};

test("an element by tag, class, id, attribute, position and combinator: its whole source", () => {
  expect(text("section.legible")).toBe(`<section class="slide legible" id="one"><h2>One</h2><p>First</p><p>Second</p></section>`);
  expect(text("#one > p:nth-of-type(2)")).toBe("<p>Second</p>");
  expect(text("section + section h2")).toBe(`<h2 data-k='a b'>Two</h2>`);
  expect(text("[data-k~=b]")).toBe(`<h2 data-k='a b'>Two</h2>`);
  expect(text("svg g#logo")).toBe(`<g id="logo"><rect width="10" height="10"/></g>`);
  expect(text("g:last-child")).toBe(`<g class="mark"></g>`);
  expect(text("h2 ~ p:last-child")).toBe("<p>Second</p>");
  expect(selectInSource(PAGE, "p:nth-child(odd)")).toHaveLength(1);
  const r = findInSource(PAGE, "index.html", { selector: "#logo" });
  expect(typeof r != "string" && r.lines).toEqual([13, 13]);
});

test("0 or 2 matches, and a selector it can't find, say so", () => {
  expect(text("section p")).toMatch(/^"section p" matches 2 elements in index\.html \(at line 11, line 11\)/);
  expect(text("article")).toMatch(/^"article" matches 0 elements in index\.html, as written in the source/);
  expect(text("p:hover")).toMatch(/isn't a selector this can find in the source: it has :hover/);
  expect(text("h2, p")).toMatch(/it is a list/);
  expect(parseSelector("p::before")).toMatch(/isn't a selector/);
});

test("a CSS rule by its selector, spacing aside; inside an at-rule; twice is an error that says where", () => {
  const rule = (sel: string, src = PAGE, path = "index.html") => {
    const r = findInSource(src, path, { cssRule: sel });
    return typeof r == "string" ? r : src.slice(r.from, r.to);
  };
  expect(rule(".legible > p")).toBe(`.legible  >  p { content: "}"; }`);
  expect(rule("@media (max-width:600px)")).toBe("@media (max-width: 600px) {\n    .legible h2 { color: blue; }\n  }");
  expect(rule(".legible h2")).toMatch(/is in index\.html 2 times \(line 4, line 7 in @media \(max-width: 600px\)\)/);
  expect(rule(".missing")).toMatch(/not in index\.html's <style> elements/);
  expect(rule("b", "a { x: 1 }\nb { y: 2 }\n", "style.css")).toBe("b { y: 2 }");
  expect(cssRulesInSource(PAGE, "index.html", ".legible h2")).toHaveLength(2);
});

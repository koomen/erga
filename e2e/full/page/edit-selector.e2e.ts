// read and edit by selector, as an agent calls them: one element (selector) or one CSS rule (css_rule, cssRule) of a
// page, found in its source as written. read gives that part and its lines; edit replaces it whole, and the file and
// the page show the change. A selector that matches no element, or two, is an error that says how many.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { DISK_MS } from "../../helpers/editor";
import { deck } from "./view-page";

await servers.main();

test("read by selector gives the element; edit by selector and by cssRule replaces it, in the file and on the page", {
  timeout: 30_000,
}, async ({ tab }) => {
  const { ed, tool } = await deck(tab);
  const read = await tool("read", { path: "index.html", selector: "section:nth-of-type(2)" });
  expect(read.text).toBe(
    `[index.html, line 18: the element "section:nth-of-type(2)"]\n<section class="slide"><h1>Second slide</h1><p class="build">No parts here.</p></section>`
  );
  expect((await tool("read", { path: "index.html", css_rule: "#progress" })).text).toMatch(
    /^\[index\.html, line 1\d: the CSS rule "#progress"\]\n#progress \{ position: fixed;.*\}$/
  );
  const edited = await tool("edit", {
    path: "index.html",
    edits: [
      { selector: "section:nth-of-type(2) h1", newText: "<h1>The middle slide</h1>" },
      {
        cssRule: "#progress",
        newText: "#progress { position: fixed; left: 0; bottom: 0; height: 24px; width: 0; background: rgb(0, 0, 200); }",
      },
    ],
  });
  expect(edited.text).toMatch(/^Edited index\.html/);
  await until(() => ed.disk().includes("<h1>The middle slide</h1>"), DISK_MS, "the file has the new heading");
  expect(ed.disk()).toContain("background: rgb(0, 0, 200); }");
  expect(ed.disk()).not.toContain("Second slide");
  const page = await tool("eval_in_page", {
    expression: `[document.querySelectorAll("h1")[1].textContent, getComputedStyle(document.getElementById("progress")).backgroundColor]`,
  });
  expect(page.text.split("\n")[0]).toBe('["The middle slide","rgb(0, 0, 200)"]');
  // A preview by selector, too: the copy changes, the file doesn't.
  const preview = await tool("eval_in_page", {
    expression: `document.querySelectorAll("h1")[1].textContent`,
    edits: [{ selector: "section:nth-of-type(2) h1", newText: "<h1>Only in the preview</h1>" }],
  });
  expect(preview.text.split("\n")[0]).toBe('"Only in the preview"');
  expect(ed.disk()).toContain("<h1>The middle slide</h1>");
});

test("a selector that matches no element, or two, changes nothing and says how many", async ({ tab }) => {
  const { ed, fails } = await deck(tab);
  const before = ed.disk();
  expect(await fails("read", { path: "index.html", selector: "article" })).toMatch(/^"article" matches 0 elements in index\.html/);
  expect(await fails("edit", { path: "index.html", edits: [{ selector: "section h1", newText: "<h1>x</h1>" }] })).toMatch(
    /^selector: "section h1" matches 3 elements in index\.html \(at line 17, line 18, line 19\)/
  );
  expect(
    await fails("edit", {
      path: "index.html",
      edits: [
        { selector: "p.build:first-child", newText: "x" },
        { selector: "section:first-of-type p:nth-of-type(2)", newText: "y" },
      ],
    })
  ).toMatch(/^edits\[0\]: "p\.build:first-child" matches 0 elements/);
  expect(await fails("edit", { path: "index.html", edits: [{ cssRule: ".nothing", newText: "" }] })).toMatch(
    /The CSS rule "\.nothing" is not in index\.html's <style> elements/
  );
  await ed.settle();
  expect(ed.disk()).toBe(before);
});

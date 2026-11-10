// The edit tool's answer after an edit that broke the page's HTML, as an agent calls it: each fault the edit made,
// with its line (agents/document/faults.ts). The page shows that the fault is real: an open <b> takes the slides
// after it into itself. The edit that mends it says nothing more.
import { expect, servers, test } from "../../helpers/fixtures";
import { CAPTURES, deck } from "./view-page";

await servers.main();

const SLIDES = { expression: `document.querySelectorAll("body > section.slide").length` };
const GOOD = `<p class="build">Three.</p></section>`;
const BAD = `<p class="build"><b>Three.</p></section>\n  Loose words`;

test(
  "an edit that leaves an element open and text beside blocks says so, with each line; the mend says nothing",
  CAPTURES,
  async ({ tab }) => {
    const { tool } = await deck(tab);
    tab.strict = false; // (The open editor logs that the broken page does not show its HTML.)
    expect((await tool("eval_in_page", SLIDES)).text.split("\n")[0]).toBe("3");
    const broken = await tool("edit", { path: "index.html", edits: [{ oldText: GOOD, newText: BAD }] });
    expect(broken.text).toBe(
      [
        "Edited index.html (1 change).",
        "2 problems in its HTML:",
        " line 17: <b> is not closed",
        ' line 18: loose text "Loose words" beside <section>: nobody can edit it by hand',
        "Fix them now, or restore the last version.",
      ].join("\n")
    );
    expect((await tool("eval_in_page", SLIDES)).text.split("\n")[0]).toBe("1");
    const mended = await tool("edit", { path: "index.html", edits: [{ oldText: BAD, newText: GOOD }] });
    expect(mended.text).toBe("Edited index.html (1 change).");
    expect((await tool("eval_in_page", SLIDES)).text.split("\n")[0]).toBe("3");
  }
);

test("a file that isn't there: the error lists the files; an oldText that isn't there: the nearest line", CAPTURES, async ({ tab }) => {
  const { fails } = await deck(tab);
  const missing = await fails("read", { path: "nope.html" });
  expect(missing).toMatch(/^nope\.html doesn't exist\. The files: .*index\.html.*\.$/);
  const wrong = await fails("edit", { path: "index.html", edits: [{ oldText: `<p class="build">Four.</p>`, newText: "x" }] });
  expect(wrong).toMatch(
    /isn't in the current text of index\.html.*\. Nearest, line \d+:\n\s+<section class="slide">.*\nIt differs from oldText at character 63 of that line\.$/s
  );
});

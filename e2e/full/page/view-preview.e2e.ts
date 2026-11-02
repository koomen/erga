// A preview, as an agent asks for it: view_page and eval_in_page with edits (as the edit tool takes them) render a
// copy of the open page with the edits, and the document stays as it was. An edit that doesn't apply renders nothing
// and says why, as the edit tool would.
import { expect, servers, test } from "../../helpers/fixtures";
import { deck, differ } from "./view-page";

await servers.main();

const BLUE = { oldText: '<p class="build">Blue.</p>', newText: '<p class="build">Purple, in the preview.</p>' };

test("a preview shows the edit at its step; the file, the person's page and the next render are unchanged", { timeout: 30_000 }, async ({
  tab,
}) => {
  const { ed, tool } = await deck(tab);
  const before = ed.disk();
  const text = `document.querySelector(".slide.current").innerText.replace(/\\s+/g, " ").trim()`;
  const seen = await tool("eval_in_page", { expression: text, step: "3.3", edits: [BLUE] });
  expect(seen.text).toMatch(/^"Third slide Red\. Green\. Purple, in the preview\."/);
  expect(seen.text).toContain("A preview: 1 edit applied to a copy of index.html, for this render only. The document is unchanged");
  const preview = await tool("view_page", { step: "3.3", edits: [BLUE], path: "index.html" });
  expect(preview.text).toContain("A preview: 1 edit");
  const now = await tool("view_page", { step: "3.3" });
  expect(now.text).not.toContain("preview");
  expect(await differ(ed, preview.images[0], now.images[0]), "the preview shows Purple where the page shows Blue").toBeGreaterThan(50);
  expect((await tool("eval_in_page", { expression: text, step: "3.3" })).text).toMatch(/^"Third slide Red\. Green\. Blue\."/);
  await ed.settle();
  expect(ed.disk()).toBe(before);
  expect(await ed.source()).toBe(before);
});

test("an edit that doesn't apply, or a path that isn't a page: nothing renders, and the answer says why", async ({ tab }) => {
  const { fails } = await deck(tab);
  expect(await fails("view_page", { edits: [{ oldText: "Mauve.", newText: "x" }] })).toMatch(
    /^Nothing was rendered: oldText isn't in the current text of index\.html/
  );
  expect(await fails("view_page", { edits: [{ oldText: '<p class="build">', newText: "<p>" }] })).toMatch(
    /oldText matches more than once in index\.html/
  );
  expect(await fails("eval_in_page", { expression: "1", edits: [BLUE], path: "style.css" })).toMatch(
    /^Nothing was rendered: there's no page style\.css in this document/
  );
  expect(await fails("view_page", { path: "missing.html" })).toMatch(/there's no page missing\.html/);
});

test("path renders another page than the open one, as an agent in Pete's trace asked for it: with edits too", async ({ tab }) => {
  const { ed, tool } = await deck(tab, "glide");
  const h1 = `document.querySelector("h1").textContent`;
  const notes = await tool("eval_in_page", { path: "notes.html", expression: h1 });
  expect(notes.text).toMatch(/^"Speaker notes"/);
  expect(notes.text).toContain("[Rendered notes.html.]");
  const edited = await tool("eval_in_page", {
    path: "notes.html",
    expression: h1,
    edits: [{ oldText: "Speaker notes", newText: "Notes, in the preview" }],
  });
  expect(edited.text).toMatch(/^"Notes, in the preview"/);
  expect(edited.text).toContain("A preview: 1 edit applied to a copy of notes.html");
  const seen = await tool("view_page", { path: "notes.html" });
  expect(seen.images).toHaveLength(1);
  expect(seen.text).toContain("of notes.html");
  // The person's tab stays on the deck.
  expect(await ed.frame<string>(`document.querySelector(".current h2").textContent`)).toBe("First frame");
});

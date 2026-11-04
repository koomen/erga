// A deck, as the slides template makes it (e2e/fixtures/slides holds the template's slides.js and api.js): its own code
// shows one 16:9 slide at a time and gives erga/steps its steps. In the editor, its text is erga/text's, and its slide
// bar (or ⌘⇧Enter) adds a slide with the deck's own edits (api.js); an agent adds one with call_edit.
import { expect, servers, test } from "../../helpers/fixtures";
import { DISK_MS, F, openEditor, type Editor } from "../../helpers/editor";
import { deck } from "./view-page";

await servers.main();

const shown = `[...${F}.querySelectorAll("section.slide")].map((s) => !s.hidden)`;

test("a deck: type in a slide; ⌘⇧Enter adds a slide after it, shown, its title selected to type over; undo takes it back", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "slides");
  expect(await ed.frame<boolean[]>(shown)).toEqual([true, false]);
  expect(await ed.frame<number>(`${F}.defaultView.ergaSteps.count()`)).toBe(2);
  await ed.clickEnd("h1");
  await ed.type(" now");
  await expect.poll(() => ed.source()).toContain("<h1>Launch plan now</h1>");

  // Typed at once after the key: the new slide is there for it (the deck makes its edit in the key's own event).
  await ed.press("ControlOrMeta+Shift+Enter");
  await ed.type("Why");
  await expect.poll(() => ed.frame<boolean[]>(shown)).toEqual([false, true, false]);
  await expect
    .poll(() => ed.source())
    .toContain(
      `<p>For the team</p>\n  </section>\n  <section class="slide" data-layout="content">\n    <h2>Why</h2>\n    <ul>\n      <li>A point</li>\n    </ul>\n  </section>\n  <section class="slide" data-layout="content">\n    <h2>Steps</h2>`
    );
  await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain("<h2>Why</h2>");
  expect(await ed.frame<number>(`${F}.defaultView.ergaSteps.current()`)).toBe(1);

  await ed.press("ControlOrMeta+z");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.frame<number>(`${F}.querySelectorAll("section.slide").length`)).toBe(2);
});

test("an agent's add_slide (call_edit) adds a slide to the deck; document_api lists the deck's own edits and erga/text's", async ({
  tab,
}) => {
  const { ed, tool, fails } = await deck(tab, "slides");
  const { apis } = JSON.parse((await tool("document_api", { path: "index.html" })).text) as {
    apis: { api: string; edits: { name: string }[] }[];
  };
  expect(apis.map((a) => a.api)).toEqual(["slides", "erga/text"]);
  expect(apis[0].edits.map((e) => e.name)).toEqual(["add_slide", "delete_slide", "move_slide", "set_layout"]);
  expect(apis[1].edits.map((e) => e.name)).toContain("replace_text");
  expect(
    (await tool("call_edit", { path: "index.html", edit: "add_slide", input: { after: 2, layout: "title", title: "Thanks" } })).text
  ).toMatch(/^Made slides's add_slide\. Edited index\.html/);
  await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain(`<section class="slide" data-layout="title">\n    <h1>Thanks</h1>`);
  await expect.poll(() => ed.frame<number>(`${F}.querySelectorAll("section.slide").length`)).toBe(3);
  expect(await ed.frame<boolean[]>(shown)).toEqual([true, false, false]);
  // A slide with its points, in one call (the page: index.html, by default).
  expect(
    (
      await tool("call_edit", {
        edit: "add_slide",
        input: { after: 3, layout: "content", title: "Why", points: ["Fast", "A & B"] },
      })
    ).text
  ).toMatch(/^Made slides's add_slide\./);
  expect((await tool("read", { path: "index.html" })).text).toMatch(/<h2>Why<\/h2>\s*<ul>\s*<li>Fast<\/li>\s*<li>A &amp; B<\/li>\s*<\/ul>/);
  expect(await fails("call_edit", { path: "index.html", edit: "delete_slide", input: { slide: 9 } })).toMatch(
    /no slide 9: the deck has slides 1 to 4/
  );
  expect(await fails("call_edit", { path: "index.html", edit: "move_slide", input: { slide: 3, by: -1 } })).toBe(
    "move_slide's input is wrong: to is required. document_api lists its input's schema."
  );
});

/** Clicks a button of the slide bar (data-act: add, title, up, down, layout, delete) with the mouse, as a person does. */
async function clickBar(ed: Editor, act: string) {
  const r = await ed.frame<{ x: number; y: number } | null>(
    `(() => { const b = ${F}.querySelector("slide-bar")?.shadowRoot?.querySelector('[data-act="${act}"]'); if (!b || b.closest("[hidden]")) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
  );
  expect(r, `the slide bar shows its ${act} button`).not.toBeNull();
  const f = await ed.frameAt();
  await ed.page.mouse.click(f.x + r!.x, f.y + r!.y);
}

test("the slide bar's ↓, layout and Delete keep the caret, collapsed, in the slide that shows: typing adds to its text", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "slides");
  await ed.clickEnd("h1");
  await clickBar(ed, "down");
  await expect.poll(() => ed.frame<boolean[]>(shown)).toEqual([false, true]);
  await ed.shows(`
    # Launch plan|

    For the team
  `);
  await ed.type("!");
  await expect.poll(() => ed.source()).toContain("<h1>Launch plan!</h1>");

  await clickBar(ed, "layout");
  await expect.poll(() => ed.source()).toContain(`<section class="slide" data-layout="content">\n    <h1>Launch plan!</h1>`);
  await ed.shows(`
    # Launch plan!|

    For the team
  `);

  await clickBar(ed, "add");
  await clickBar(ed, "delete");
  await expect.poll(() => ed.frame<boolean[]>(shown)).toEqual([false, true]);
  await ed.type("?");
  await expect.poll(() => ed.source()).toContain("<h1>Launch plan!?</h1>");
  await ed.shows(`
    # Launch plan!?|

    For the team
  `);
});

test("undo of the slide bar's ↓ shows the slide back in its place, with the caret in it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "slides");
  await ed.clickEnd("h1");
  await clickBar(ed, "down");
  await expect.poll(() => ed.frame<boolean[]>(shown)).toEqual([false, true]);
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toContain(`<section class="slide" data-layout="title">\n    <h1>Launch plan</h1>`);
  await expect.poll(() => ed.frame<boolean[]>(shown)).toEqual([true, false]);
  await ed.shows(`
    # Launch plan|

    For the team
  `);
});

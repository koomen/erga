// erga/slides (libs/slides/): a deck imports it, and it shows one 16:9 slide at a time, with the page's steps. In the
// editor, its text is erga/text's, and its slide bar (or ⌘⇧Enter) adds a slide; an agent adds one with call_edit.
import { expect, servers, test } from "../../helpers/fixtures";
import { DISK_MS, F, openEditor } from "../../helpers/editor";
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

  await ed.press("ControlOrMeta+Shift+Enter");
  await expect.poll(() => ed.frame<boolean[]>(shown)).toEqual([false, true, false]);
  await ed.type("Why");
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

test("an agent's add_slide (call_edit) adds a slide to the deck; document_api lists erga/slides' edits", async ({ tab }) => {
  const { ed, tool, fails } = await deck(tab, "slides");
  const { apis } = JSON.parse((await tool("document_api", { path: "index.html" })).text) as {
    apis: { api: string; edits: { name: string }[] }[];
  };
  expect(apis.map((a) => a.api)).toEqual(["erga/slides"]);
  expect(apis[0].edits.map((e) => e.name)).toEqual(
    expect.arrayContaining(["add_slide", "delete_slide", "move_slide", "set_layout", "replace_text"])
  );
  expect(
    (await tool("call_edit", { path: "index.html", edit: "add_slide", input: { after: 2, layout: "title", title: "Thanks" } })).text
  ).toMatch(/^Added slide 3\. Edited index\.html/);
  await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain(`<section class="slide" data-layout="title">\n    <h1>Thanks</h1>`);
  await expect.poll(() => ed.frame<number>(`${F}.querySelectorAll("section.slide").length`)).toBe(3);
  expect(await ed.frame<boolean[]>(shown)).toEqual([true, false, false]);
  expect(await fails("call_edit", { path: "index.html", edit: "delete_slide", input: { slide: 9 } })).toMatch(
    /no slide 9: the deck has slides 1 to 3/
  );
});

// Pete's reports: typing over a block a triple-click selected, and Ctrl+K, changed the next block too.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

const FIRST =
  "First paragraph with some words in it that wrap across more than one line when the page is narrow enough to do so, which it should be at this length of text.";
/** The editing fixture as the page shows it after `title`, `first` and `apple` took the place of those blocks' text. */
const page = ({ title = "Title here", first = FIRST, apple = "• Apple", banana = "• Banana" }) => `# ${title}

${first}

## Section

${apple}
${banana}

A quote line.

code line one code line two

Last paragraph.`;

/** A triple-click on the element's text: the browser selects it to the start of the next block. */
async function tripleClick(ed: Editor, selector: string) {
  const p = await ed.charAt(selector, 2);
  await ed.click(p.x, p.y, { clickCount: 3 });
}

test("a triple-clicked paragraph, typed over, keeps its block and the heading after it; typing goes on there", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "editing");
  await tripleClick(ed, "#first");
  await ed.press("Shift+N");
  await ed.press("e");
  await ed.press("w");
  await ed.shows(page({ first: "New|" }));
  expect(await ed.source()).toContain(`<p id="first">New</p>\n  <h2>Section</h2>`);
});

test("a triple-clicked heading and list item, typed over, keep the block after them", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "editing");
  await tripleClick(ed, "h1");
  await ed.press("Shift+T");
  await ed.press("o");
  await tripleClick(ed, "li");
  await ed.press("Shift+P");
  await ed.press("e");
  await ed.shows(page({ title: "To", apple: "• Pe|" }));
  expect(await ed.source()).toContain(`<h1>To</h1>\n  <p id="first">`);
  expect(await ed.source()).toContain(`<li>Pe</li>\n    <li>Banana</li>`);
});

test("on a slide, a triple-clicked title, typed over, keeps the slide's text below it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "deck");
  await tripleClick(ed, "h1");
  await ed.press("Shift+H");
  await ed.press("i");
  await ed.shows(`# Hi|\n\nThe arrows move between slides.`);
  expect(await ed.source()).toContain(`<section class="slide current"><h1>Hi</h1><p>The arrows move between slides.</p></section>`);
});

test("Ctrl+K deletes to the end of the item, heading or paragraph only; at an item's end it joins the next; Ctrl+Y puts the text back", async ({
  tab,
}) => {
  // The Mac's text keys (Control+K, Control+Y): other systems have none.
  if (process.platform != "darwin") return;
  const ed = await openEditor(tab, await servers.main(), "editing");
  const at = async (selector: string, i: number) => {
    const p = await ed.charAt(selector, i);
    await ed.click(p.x, p.y);
  };
  await at("li", 2);
  await ed.press("Control+k");
  await ed.shows(page({ apple: "• Ap|" }));
  await ed.press("Control+y");
  await ed.shows(page({ apple: "• Apple|" }));
  await ed.press("Control+k");
  await ed.shows(page({ apple: "• Apple|Banana", banana: "" }).replace("\n\n\nA quote", "\n\nA quote"));
  await at("h1", 5);
  await ed.press("Control+k");
  await at("#first", 5);
  await ed.press("Control+k");
  await ed.shows(page({ title: "Title", first: "First|", apple: "• AppleBanana", banana: "" }).replace("\n\n\nA quote", "\n\nA quote"));
  expect(await ed.source()).toContain(`<h1>Title</h1>\n  <p id="first">First</p>\n  <h2>Section</h2>`);
});

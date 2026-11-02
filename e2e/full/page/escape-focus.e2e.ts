// Escape takes the focus off the text and leaves it in the page, so the page's own keys work (a deck's arrows);
// a click on text puts the caret back. Escape closes an open card first.
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor } from "../../helpers/editor";

await servers.main();

test("Escape leaves the text: the deck's arrows move between slides, the text stays as it was; a click on text edits again", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "deck");
  const before = await ed.source();
  await ed.clickEnd("h1");
  await ed.shows(`
    # First slide|

    The arrows move between slides.
  `);
  await ed.press("Escape");
  await expect.poll(() => ed.frame<boolean>(`!${F}.activeElement?.closest("[contenteditable]")`)).toBe(true);
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await ed.shows(`
    # Third slide

    The last one.
  `);
  // The focus stays in the page, not in the shell's controls.
  expect(await ed.eval<boolean>(`document.activeElement?.tagName == "IFRAME"`)).toBe(true);
  await ed.type("x");
  expect(await ed.source()).toBe(before);
  await ed.clickEnd(".current h1");
  await ed.type("!");
  await ed.shows(`
    # Third slide!|

    The last one.
  `);
  expect(await ed.source()).toContain("<h1>Third slide!</h1>");
});

test("Escape with the Share card open closes the card, and the caret stays in the text", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "deck");
  await ed.clickEnd("h1");
  await ed.eval(`document.getElementById("btn-share").click()`);
  expect(await ed.eval<boolean>(`!document.getElementById("sharing").hidden`)).toBe(true);
  await ed.press("Escape");
  await expect.poll(() => ed.eval<boolean>(`document.getElementById("sharing").hidden`)).toBe(true);
  // The card's box had the focus: it goes back to the text, by message, a moment later.
  await expect.poll(() => ed.caretIn("[data-erga-text]")).toBe(true);
  await ed.press("ArrowLeft");
  await ed.type("!");
  await ed.shows(`
    # First slid!|e

    The arrows move between slides.
  `);
});

test("a page opens with the caret in its first text: typing at once edits it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "one-line");
  await ed.type("x");
  await expect.poll(() => ed.source()).toContain("<h1>xOne line</h1>");
});

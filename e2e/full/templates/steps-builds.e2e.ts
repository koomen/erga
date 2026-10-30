// A presentation whose slides build up in parts (agents/document/PROMPT.md, "Presentations": next(), back(), hasNext(),
// hasBack()): → and the forward button show each part of the last slide, ← and back hide them on the first, the
// address names the part (#3.2, rule 14), and the buttons are off only when the page has nothing more to show. A page
// without next() or hasNext() steps as before (steps-view.e2e.ts).
import type { Page } from "playwright-core";
import { expect, servers, settle, test } from "../../helpers/fixtures";
import { bar, clickOn, editorReady, frameAt, inPage, openTab } from "./templates";

await servers.main();

/** The tab's hash, the page's text on the slide it shows, and the buttons: [back off, forward off], once they agree. */
async function at(page: Page, hash: string, text: string, off: [boolean, boolean]) {
  await expect
    .poll(async () => {
      const b = await bar(page);
      return [
        new URL(page.url()).hash,
        await inPage<string>(page, `document.querySelector(".slide.current").innerText.replace(/\\s+/g, " ").trim()`),
        b.back,
        b.next,
      ];
    })
    .toEqual([hash, text, ...off]);
}

const RED = "Third slide Red.",
  GREEN = "Third slide Red. Green.",
  BLUE = "Third slide Red. Green. Blue.";

async function walk(page: Page, key: (k: "ArrowLeft" | "ArrowRight") => Promise<void>) {
  await at(page, "#3", RED, [false, false]);
  // The last slide's parts, one by one: forward stays on until the last part.
  await key("ArrowRight");
  await at(page, "#3.2", GREEN, [false, false]);
  await clickOn(page, ".erga-steps-next");
  await at(page, "#3.3", BLUE, [false, true]);
  await key("ArrowRight");
  await settle(page);
  await at(page, "#3.3", BLUE, [false, true]);
  // ← hides them the same way, then goes to the slide before.
  await key("ArrowLeft");
  await at(page, "#3.2", GREEN, [false, false]);
  await clickOn(page, ".erga-steps-back");
  await at(page, "#3", RED, [false, false]);
  await key("ArrowLeft");
  await at(page, "#2", "Second slide No parts here.", [false, false]);
  // The first slide, from the one after: all its parts, and ← and back hide them down to the first.
  await clickOn(page, ".erga-steps-back");
  await at(page, "#1.3", "First slide One. Two. Three.", [false, false]);
  await key("ArrowLeft");
  await at(page, "#1.2", "First slide One. Two.", [false, false]);
  await clickOn(page, ".erga-steps-back");
  await at(page, "#1", "First slide One.", [true, false]);
  await key("ArrowLeft");
  await settle(page);
  await at(page, "#1", "First slide One.", [true, false]);
  expect((await bar(page)).at).toBe("1 / 3");
  // Forward from there shows the first slide's next part, not the next slide.
  await key("ArrowRight");
  await at(page, "#1.2", "First slide One. Two.", [false, false]);
}

test("viewing: on the last slide → and forward show each part (#3, #3.2, #3.3), then forward is off; ← and back hide them, on the first slide too", async ({
  tab,
}) => {
  const s = await servers.main();
  const { address } = await s.fixture("builds");
  const page = tab.page;
  await openTab(tab, `${address}#3`);
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  expect((await bar(page)).at).toBe("3 / 3");
  // The keys pressed in the page: a click on it, away from its text, first.
  const f = await frameAt(page);
  await page.mouse.click(f.x + 30, f.y + 300);
  await settle(page);
  await walk(page, (k) => page.keyboard.press(k));
});

test("editing: the same, with the keys pressed on the step controls", async ({ tab }) => {
  const s = await servers.main();
  const { address } = await s.fixture("builds");
  const page = tab.page;
  await openTab(tab, `${address}?edit#3`);
  await editorReady(page);
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  await walk(page, async (k) => {
    // (The toggle: forward and back can be off, and a button that is off takes no focus.)
    await page.evaluate(() => document.querySelector<HTMLElement>(".erga-steps-toggle")!.focus());
    await page.keyboard.press(k);
  });
});

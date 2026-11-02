// A presentation whose slides build up in parts (client/inline/reader.ts, Steps: each part is a step, and
// slide(i) groups them): the counter and the list show each part (3.2), → and forward go part by part and on to the
// next slide, ← and back the other way, forward is off only on the very last part, a click on a part's picture shows
// it, the address names the part (#3.2, rule 11) and a reload opens there. A deck without parts: steps-view.e2e.ts.
import type { Page } from "playwright-core";
import { expect, servers, settle, test } from "../../helpers/fixtures";
import { bar, clickOn, editorReady, frameAt, inPage, openTab } from "./templates";

await servers.main();

/** The tab's hash, the page's text on the slide it shows, the counter, and the buttons [back off, forward off], once they agree. */
async function at(page: Page, hash: string, text: string, counter: string, off: [boolean, boolean]) {
  await expect
    .poll(async () => {
      const b = await bar(page);
      return [
        new URL(page.url()).hash,
        await inPage<string>(page, `document.querySelector(".slide.current").innerText.replace(/\\s+/g, " ").trim()`),
        b.at,
        b.back,
        b.next,
      ];
    })
    .toEqual([hash, text, counter, ...off]);
}

const ONE = "First slide One.",
  TWO = "First slide One. Two.",
  THREE = "First slide One. Two. Three.",
  SECOND = "Second slide No parts here.",
  RED = "Third slide Red.",
  GREEN = "Third slide Red. Green.",
  BLUE = "Third slide Red. Green. Blue.";

async function walk(page: Page, key: (k: "ArrowLeft" | "ArrowRight") => Promise<void>) {
  await at(page, "#1", ONE, "1.1 / 3", [true, false]);
  await key("ArrowRight");
  await at(page, "#1.2", TWO, "1.2 / 3", [false, false]);
  await clickOn(page, ".erga-steps-next");
  await at(page, "#1.3", THREE, "1.3 / 3", [false, false]);
  await key("ArrowRight");
  await at(page, "#2", SECOND, "2 / 3", [false, false]);
  await clickOn(page, ".erga-steps-next");
  await at(page, "#3", RED, "3.1 / 3", [false, false]);
  await key("ArrowRight");
  await at(page, "#3.2", GREEN, "3.2 / 3", [false, false]);
  await clickOn(page, ".erga-steps-next");
  // The very last part: forward is off, and → stays.
  await at(page, "#3.3", BLUE, "3.3 / 3", [false, true]);
  await key("ArrowRight");
  await settle(page);
  await at(page, "#3.3", BLUE, "3.3 / 3", [false, true]);
  // ← and back, part by part, to the slide before with all its parts.
  await key("ArrowLeft");
  await at(page, "#3.2", GREEN, "3.2 / 3", [false, false]);
  await clickOn(page, ".erga-steps-back");
  await at(page, "#3", RED, "3.1 / 3", [false, false]);
  await key("ArrowLeft");
  await at(page, "#2", SECOND, "2 / 3", [false, false]);
  await clickOn(page, ".erga-steps-back");
  await at(page, "#1.3", THREE, "1.3 / 3", [false, false]);
}

/** The list: one picture for each part, numbered by slide and part, a new slide's first step marked; then a click on 3.2. */
async function list(page: Page) {
  await clickOn(page, ".erga-steps-toggle");
  // (The list asks for the pictures in sight: each in turn is scrolled to.)
  await expect
    .poll(async () => {
      const b = await bar(page);
      const k = b.items.findIndex((i) => !i.drawn);
      if (k >= 0) await page.evaluate((k) => document.querySelectorAll(".erga-step")[k]?.scrollIntoView({ block: "nearest" }), k);
      return b.open && b.items.length == 7 && k < 0;
    })
    .toBe(true);
  const b = await bar(page);
  expect(b.items.map((i) => i.n)).toEqual(["1.1", "1.2", "1.3", "2", "3.1", "3.2", "3.3"]);
  expect(b.items.map((i) => i.label)).toEqual([
    "First slide",
    "First slide",
    "First slide",
    "Second slide",
    "Third slide",
    "Third slide",
    "Third slide",
  ]);
  expect(b.items.map((i) => i.first)).toEqual([false, false, false, true, true, false, false]);
  expect(new Set(b.items.map((i) => i.img)).size).toBe(7);
  await page.evaluate(() => (document.querySelectorAll(".erga-step")[5] as HTMLElement).click());
  await at(page, "#3.2", GREEN, "3.2 / 3", [false, false]);
  expect((await bar(page)).items.map((i) => i.current)).toEqual([false, false, false, false, false, true, false]);
}

test("viewing: each part is a step (1.1 / 3 … 3.3 / 3): → and forward, ← and back go part by part; the list shows each part; a reload opens at #3.2", async ({
  tab,
}) => {
  const s = await servers.main();
  const { address } = await s.fixture("builds");
  const page = tab.page;
  await openTab(tab, address);
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  // The keys pressed in the page: a click on it, away from its text, first.
  const f = await frameAt(page);
  await page.mouse.click(f.x + 30, f.y + 300);
  await settle(page);
  await walk(page, (k) => page.keyboard.press(k));
  await list(page);
  await page.reload();
  await settle(page);
  await at(page, "#3.2", GREEN, "3.2 / 3", [false, false]);
});

test("editing: the same, with the keys pressed on the step controls", async ({ tab }) => {
  const s = await servers.main();
  const { address } = await s.fixture("builds");
  const page = tab.page;
  await openTab(tab, `${address}?edit`);
  await editorReady(page);
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  await walk(page, async (k) => {
    // (The toggle: forward and back can be off, and a button that is off takes no focus.)
    await page.evaluate(() => document.querySelector<HTMLElement>(".erga-steps-toggle")!.focus());
    await page.keyboard.press(k);
  });
  await list(page);
  await page.reload();
  await editorReady(page);
  await at(page, "#3.2", GREEN, "3.2 / 3", [false, false]);
});

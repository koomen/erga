// The Solar system tour template (tests/solar-system.ts): nine steps, the overview and one for each planet; going
// to a step flies the camera there, and the list shows the view from each step's camera. How soon the model moves
// is timing, so it is in solar-system.bench.e2e.ts: here, only that it moves at all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { expect, servers, test } from "../fixtures";
import { ROOT } from "../env";
import { atStep, bar, clickOn, editorReady, idOf, newDoc, openTab } from "./templates";
import { view } from "./solar";

test.beforeAll(async () => { await servers.main(); });

const LABELS = ["The solar system", "Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"];
const moves = async (page: Page) => { const a = await view(page); await expect.poll(async () => (await view(page)).pixels != a.pixels).toBe(true); return a; };

test("/new?template=solar-system opens a new document in the editor, made from templates/solar-system", async () => {
  const s = await servers.main();
  const made = await newDoc(s, "solar-system");
  expect(made.status).toBe(302);
  expect(made.location).toMatch(/#edit$/);
  const id = await idOf(made.address);
  expect(await (await fetch(`${s.root}/d/${id}/doc/index.html`)).text()).toBe(readFileSync(join(ROOT, "templates/solar-system/index.html"), "utf8"));
});

test("viewing: nine steps at the overview, its note shows and the model moves; forward three times goes to Earth, whose note shows as the camera flies", async ({ tab }) => {
  const made = await newDoc(await servers.main(), "solar-system");
  const page = tab.page;
  await openTab(tab, made.address, { width: 1200, height: 760 });
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  await atStep(page, 0, 9);
  expect((await moves(page)).note).toBe("The solar system");
  for (let k = 1; k <= 3; k++) await clickOn(page, ".erga-steps-next");
  await atStep(page, 3, 9);
  expect((await moves(page)).note).toBe("Earth");
});

test("viewing: the list has the nine steps, labelled, each with a different view, those out of sight drawn once scrolled to; a click goes to Saturn", async ({ tab }) => {
  const made = await newDoc(await servers.main(), "solar-system");
  const page = tab.page;
  await openTab(tab, made.address, { width: 1200, height: 760 });
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  await clickOn(page, ".erga-steps-toggle");
  // It asks for the pictures of the steps in sight: scrolled down, the rest.
  await expect.poll(async () => { const b = await bar(page); return b.items.length == 9 && b.items.slice(0, 5).every((i) => i.img.startsWith("blob:")); }).toBe(true);
  await page.evaluate(() => { const l = document.querySelector(".erga-steps-list")!; l.scrollTop = 1e6; l.dispatchEvent(new Event("scroll")); });
  await expect.poll(async () => (await bar(page)).items.every((i) => i.img.startsWith("blob:"))).toBe(true);
  expect((await bar(page)).items.map((i) => i.label)).toEqual(LABELS);
  // Each picture is the view from its own camera: no two the same.
  const sums = await page.evaluate(() => Promise.all([...document.querySelectorAll(".erga-steps-panel .erga-step img")].map((img) =>
    fetch((img as HTMLImageElement).src).then((r) => r.arrayBuffer()).then((b) => b.byteLength + ":" + new Uint8Array(b).slice(-64).join("")))));
  expect(new Set(sums).size).toBe(9);
  await page.evaluate(() => { document.querySelector(".erga-steps-list")!.scrollTop = 0; (document.querySelectorAll(".erga-step")[6] as HTMLElement).click(); });
  await atStep(page, 6, 9);
});

test("editing: forward goes to Mercury, and its note shows", async ({ tab }) => {
  const made = await newDoc(await servers.main(), "solar-system");
  const page = tab.page;
  await openTab(tab, `${made.address}#edit`, { width: 1200, height: 760 });
  await editorReady(page);
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  await clickOn(page, ".erga-steps-next");
  await atStep(page, 1, 9);
  expect((await view(page)).note).toBe("Mercury");
});

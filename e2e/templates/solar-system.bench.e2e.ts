// The Solar system tour's motion, timed (tests/solar-system.ts): the overview's planets move within 400 ms, and the
// camera is on its way to Earth within 700 ms of the step. Timing, so a bench (`bun run test:bench`).
import { expect, servers, test } from "../fixtures";
import { atStep, bar, clickOn, newDoc, openTab } from "./templates";
import { view } from "./solar";

test.beforeAll(async () => { await servers.main(); });

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the overview's planets move within 400 ms; going to Earth, the camera moves within 700 ms", async ({ tab }) => {
  const made = await newDoc(await servers.main(), "solar-system");
  const page = tab.page;
  await openTab(tab, made.address, { width: 1200, height: 760 });
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  await atStep(page, 0, 9);
  await pause(300);
  const a = await view(page);
  await pause(400);
  expect((await view(page)).pixels).not.toBe(a.pixels);
  for (let k = 1; k <= 3; k++) { await clickOn(page, ".erga-steps-next"); await pause(150); }
  await atStep(page, 3, 9);
  const mid = await view(page);
  await pause(700);
  expect(mid.note).toBe("Earth");
  expect((await view(page)).pixels).not.toBe(mid.pixels);
});

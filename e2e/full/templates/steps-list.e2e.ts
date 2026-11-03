// A presentation's list of steps in the viewer: the page's own pictures, labelled, the current one
// marked; a click goes to a step; the pictures are kept while the page stays the same.
import { expect, servers, test } from "../../helpers/fixtures";
import { atStep, bar, clickOn, inPage, openTab } from "./templates";

await servers.main();

test("the list shows four steps with their labels and the page's pictures; a click goes to a step; closed and opened again, the same pictures", async ({ tab }) => {
  const s = await servers.main();
  const { address } = await s.fixture("steps");
  const page = tab.page;
  await openTab(tab, address);
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  await inPage(page, "ergaSteps.go(3), true");
  await atStep(page, 3, 4);
  await clickOn(page, ".toggle");
  await expect.poll(async () => { const b = await bar(page); return b.open && b.items.length == 4 && b.items.every((i) => i.img.startsWith("blob:")); }).toBe(true);
  const b = await bar(page);
  expect(b.items.map((i) => i.label)).toEqual(["Owls at night", "Where they live", "What they eat", "How to see one"]);
  expect(b.items[3].current).toBe(true);
  const first = b.items.map((i) => i.img);
  await clickOn(page, ".step", 0);
  await atStep(page, 0, 4);
  await clickOn(page, ".toggle");
  await clickOn(page, ".toggle");
  await expect.poll(async () => (await bar(page)).open).toBe(true);
  // Drawn afresh, a picture gets a new blob: URL; kept, the same one. Not changing is checked after the list has had its chance to.
  await expect.poll(async () => (await bar(page)).items.every((i) => i.img.startsWith("blob:"))).toBe(true);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect((await bar(page)).items.map((i) => i.img)).toEqual(first);
});

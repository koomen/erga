// A card's buttons open under it on hover or keyboard focus, its height easing, and close when the pointer leaves;
// a redraw doesn't close or open again the card under the pointer; with reduced motion, they just show.
import { expect, servers, test, type Page } from "../fixtures";
import { cardBoard } from "./cards";

await servers.main();

const box = (page: Page, id: number) => page.evaluate(`(() => { const c = document.querySelector("[data-open='${id}']"), a = c.querySelector(".actions");
  return { h: c.getBoundingClientRect().height, x: c.querySelector(".x").getBoundingClientRect().height, opacity: Number(getComputedStyle(a).opacity) }; })()`) as Promise<{ h: number; x: number; opacity: number }>;
const top = (page: Page, id: number) => page.evaluate<number>(`document.querySelector("[data-open='${id}']").getBoundingClientRect().top`);

test("hover opens a card's buttons with an ease (the cards under it move down), leaving closes them; Tab to a card opens it too, and Enter opens its detail", async ({ tab }) => {
  tab.strict = true;
  const page = tab.page;
  await cardBoard(page, { width: 1540 });
  const shut = await box(page, 3), below = await top(page, 4);
  expect([shut.x, shut.opacity]).toEqual([0, 0]);
  // The page's own transition events say what eased (sampled from here, a busy machine can miss the 180 ms).
  await page.evaluate(`window.__ran = []; document.querySelector("[data-open='3']").addEventListener("transitionrun", (e) => window.__ran.push(e.propertyName + " " + e.elapsedTime))`);
  await page.locator("[data-open='3']").hover();
  await expect.poll(async () => (await box(page, 3)).opacity).toBe(1);
  const open = await box(page, 3);
  expect(open.x).toBeGreaterThan(20);
  const ran = await page.evaluate<string[]>(`window.__ran`);
  for (const p of ["grid-template-rows", "opacity", "transform"]) expect(ran.some((r) => r.startsWith(p + " ")), `${p} eases: ${ran.join(", ")}`).toBe(true);
  expect(await page.evaluate<string>(`getComputedStyle(document.querySelector("[data-open='3'] .x")).transitionDuration`)).toBe("0.18s");
  expect(await top(page, 4)).toBeCloseTo(below + open.x, 0);
  await page.mouse.move(1, 1);
  await expect.poll(async () => (await box(page, 3)).x).toBe(0);
  await page.keyboard.press("Tab");
  await page.evaluate(`document.querySelector("[data-open='5']").focus()`);
  await expect.poll(async () => (await box(page, 5)).opacity).toBe(1);
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(`document.getElementById("dlg").open && document.querySelector("#dlg h3").textContent.includes("Dark mode")`)).toBe(true);
});

test("an event for another task redraws the board, and the card under the pointer stays open, the same node, without opening again", async ({ tab }) => {
  tab.strict = true;
  const pending: string[] = [];
  const f = await cardBoard(tab.page, { width: 1540, fake: { events: () => "retry: 150\n\n" + (pending.length ? "data: " + pending.shift() + "\n\n" : "") } });
  await tab.page.locator("[data-open='6']").hover();
  await expect.poll(async () => (await box(tab.page, 6)).opacity).toBe(1);
  await tab.page.evaluate(`window.__card = document.querySelector("[data-open='6']")`);
  const t = f.tasks[2];
  t.log.push({ at: new Date().toISOString(), message: "Writing the new card" });
  pending.push(JSON.stringify({ type: "task", task: t }));
  await expect.poll(() => tab.page.evaluate<string>(`document.querySelector("[data-open='3'] .step").textContent`)).toBe("Writing the new card");
  expect(await tab.page.evaluate<boolean>(`window.__card == document.querySelector("[data-open='6']")`)).toBe(true);
  expect((await box(tab.page, 6)).opacity).toBe(1);
});

test("with reduced motion, the buttons show at once, with no transition", async ({ tab }) => {
  tab.strict = true;
  await cardBoard(tab.page, { width: 1540 });
  await tab.page.emulateMedia({ reducedMotion: "reduce" });
  expect(await tab.page.evaluate<string>(`getComputedStyle(document.querySelector("[data-open='3'] .x")).transitionDuration`)).toBe("0s");
  await tab.page.locator("[data-open='3']").hover();
  await tab.page.waitForTimeout(100);
  expect((await box(tab.page, 3)).opacity).toBe(1);
});

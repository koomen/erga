// The tree at phone width ("A phone").
import { expect, servers, test, until } from "../../helpers/fixtures";
import { multi, openTreeEditor, js } from "./tree";

await servers.main();

test("on a phone the tree fits the screen", async ({ tab }) => {
  const page = tab.page;
  await page.setViewportSize({ width: 390, height: 760 });
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  // Near its left edge: at 390 px the controls on the right (pause, track changes) cover the title's middle (a bug,
  // client/editor.html's .nav-title max-width leaves 236 px for them, and they take about 320).
  const r = await page.evaluate(`(() => { const r = document.getElementById("doc-title").getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
  await page.mouse.click(r.x, r.y);
  await until(() => page.evaluate(`!document.getElementById("pages").hidden && document.querySelectorAll("#pages .et-row[data-path]").length >= 4`), 5000, "the tree shows");
  // It pops in: measured once it has stopped moving.
  await expect.poll(() => js(page, `document.getAnimations().filter((a) => document.getElementById("pages").contains(a.effect?.target)).every((a) => a.playState != "running")`)).toBe(true);
  expect(await js(page, `(() => { const r = document.getElementById("pages").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`)).toBe(true);
});

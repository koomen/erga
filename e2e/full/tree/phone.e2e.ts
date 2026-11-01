// The tree at phone width ("A phone").
import { expect, servers, test, until } from "../../helpers/fixtures";
import { multi, openTreeEditor, js } from "./tree";

await servers.main();

test("on a phone the tree fits the screen", async ({ tab }) => {
  const page = tab.page;
  await page.setViewportSize({ width: 390, height: 760 });
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  // Near the left edge of what shows of it: the breadcrumbs' bar keeps the title's end in sight, and its start may be cut off.
  // (Once the viewer's own controls have gone from over it: client/inline/viewer.css.)
  const r = await until(
    () =>
      page.evaluate(
        `(() => { const t = document.getElementById("doc-title"), r = t.getBoundingClientRect(), nav = document.getElementById("nav-docs").getBoundingClientRect(); const p = { x: Math.max(r.left, nav.left + 8) + 8, y: r.top + r.height / 2 }; return t.contains(document.elementFromPoint(p.x, p.y)) ? p : null; })()`
      ) as Promise<{ x: number; y: number } | null>,
    5000,
    "the title can be clicked"
  );
  await page.mouse.click(r!.x, r!.y);
  await until(() => page.evaluate(`!document.getElementById("pages").hidden && document.querySelectorAll("#pages .et-row[data-path]").length >= 4`), 5000, "the tree shows");
  // It pops in: measured once it has stopped moving.
  await expect.poll(() => js(page, `document.getAnimations().filter((a) => document.getElementById("pages").contains(a.effect?.target)).every((a) => a.playState != "running")`)).toBe(true);
  expect(await js(page, `(() => { const r = document.getElementById("pages").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`)).toBe(true);
});

// Out of the editor while the page waits to load again (a change to its script: libs/text/ui/frame.ts, reload): the page
// stays as it is, out of the editor. It never loads again in the editor (?erga-edit) while the viewer shows "view".
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

test("Done while the page waits to load again: the page doesn't load again in the editor", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "long");
  const page = tab.page;
  // The pointer on Done first, so the press comes at once.
  const done = (await page.locator("body.erga-editing #btn-edit").boundingBox())!;
  await page.mouse.move(done.x + done.width / 2, done.y + done.height / 2);
  await ed.frame(`window.__marker = 1`);
  const frame = page.frames().find((f) => f != page.mainFrame() && f.url().includes("/t/"))!;
  expect((await frame.evaluate(`window.__marker`)) as number).toBe(1);

  // A change to the page's script: the page waits for the room to have its edits, then loads again.
  ed.write(ed.disk().replace("let n = 0;", "let n = 1;"));
  await frame.evaluate(`new Promise((r) => { const t = () => (window.ergaFrame?.reloading ? r(true) : requestAnimationFrame(t)); t(); })`);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("erga-editing")`)).toBe(false);

  // The wait for the room ends within 3 s: past it, the page is still this one, and not in the editor.
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const now: unknown = await frame
      .evaluate(`({ marker: window.__marker ?? null, editing: document.documentElement.hasAttribute("data-erga-editing") })`)
      .catch(() => null);
    expect(now).toEqual({ marker: 1, editing: false });
    await page.waitForTimeout(100);
  }
  expect(await ed.eval<boolean>(`document.body.classList.contains("erga-editing")`)).toBe(false);
});

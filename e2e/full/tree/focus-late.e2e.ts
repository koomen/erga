// The pages card, opened right after the shell gives the page the focus, keeps the focus: the editor in the page takes
// it only as it starts (libs/text/ui/frame.ts), never later from the card.
import type { Frame } from "playwright-core";
import { expect, servers, test, until } from "../../helpers/fixtures";
import { focused, multi, openTreeEditor } from "./tree";

await servers.main();

test.beforeAll(async () => { await servers.main(); });

test("the pages card, opened right after the shell gives the page the focus, keeps the focus", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  const frame = (await until(
    async () => {
      for (const f of page.frames()) if (await f.evaluate("!!window.ergaFrame?.page").catch(() => false)) return f;
      return null;
    },
    5000,
    "the editor's frame"
  )) as Frame;
  await page.evaluate(`(() => { ergaPage.page.focus(); document.getElementById("doc-title").click(); })()`);
  await expect.poll(() => page.evaluate(`!!document.activeElement?.closest("#pages")`)).toBe(true);
  expect((await frame.evaluate(`document.hasFocus()`)) as boolean).toBe(false);
  expect(await focused(page)).not.toBe("IFRAME");
});

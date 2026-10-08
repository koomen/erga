// A focus the shell asked of the page before a card opened doesn't take the card's focus when it reaches the frame late.
import type { Frame } from "playwright-core";
import { expect, servers, test, until } from "../../fixtures";
import { focused, multi, openTreeEditor } from "./tree";

test.beforeAll(async () => { await servers.main(); });

test("the pages card, opened right after the shell asks the page for the focus, keeps the focus", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  const frame = await until(async () => { for (const f of page.frames()) if (await f.evaluate("!!window.ergaFrame").catch(() => false)) return f; return null; }, 5000, "the editor's frame") as Frame;
  // After frame.ts's own listener (added first) has handled the shell's focus message: whether the frame has the focus.
  await frame.evaluate(`addEventListener("message", (e) => { if (e.data?.type == "focus") window.__afterFocus = document.hasFocus(); })`);
  // The ask (the shell does it on each render, main.ts onUpdate) and, before the frame gets it, the card.
  await page.evaluate(`(() => { ergaPage.page.focus(); document.getElementById("doc-title").click(); })()`);
  await until(() => frame.evaluate(`window.__afterFocus !== undefined`), 5000, "the frame gets the focus message");
  expect(await frame.evaluate(`window.__afterFocus`) as boolean).toBe(false);
  await expect.poll(() => page.evaluate(`!!document.activeElement?.closest("#pages")`)).toBe(true);
  expect(await focused(page)).not.toBe("IFRAME");
});

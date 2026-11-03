// The editor's own page actions open out of the pencil (client/shell/main.ts, #edit-group) and then settle: they stop
// clipping, and the last one loses its fade. A group that opens with no transition (open from its first frame, as a
// slow page load can make it) settles at once, and one whose transition stops on the way too: before, it waited for a
// transitionend that never came. (The style that takes the transition away comes as the page loads: before the group
// opens, or while it opens.)
import { expect, servers, test } from "../../helpers/fixtures";
import { editorReady, newDoc, openTab } from "../templates/templates";

await servers.main();

test("the editor's page actions settle when they open with no transition", async ({ tab }) => {
  const { address } = await newDoc(await servers.main(), "page");
  await tab.page.addInitScript(() => {
    if (window.top != window) return;
    addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = ".edit-group { transition: none !important; }";
      document.head.append(s);
    });
  });
  await openTab(tab, `${address}?edit`);
  await editorReady(tab.page);
  await expect.poll(() => tab.page.evaluate(() => document.getElementById("edit-group")!.classList.contains("settled"))).toBe(true);
});

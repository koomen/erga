// The share button: a prompt with this page's API and a working token (tests/page.ts, "Share with an agent").
import { expect, servers, test } from "../fixtures";
import { openEditor } from "../editor";

await servers.main();

test("the share button opens a prompt naming the page's API and a token that works; Escape closes it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "noedit");
  await ed.eval(`document.getElementById("btn-share").click()`);
  expect(await ed.eval<boolean>(`!document.getElementById("share").hidden && document.getElementById("btn-share").getAttribute("aria-expanded") == "true"`)).toBe(true);
  await expect.poll(() => ed.eval<string>(`document.getElementById("share-prompt").value`)).toContain("Token: erga_");
  const prompt = await ed.eval<string>(`document.getElementById("share-prompt").value`);
  const token = /Token: (\S+)/.exec(prompt)?.[1], api = /API: (\S+)/.exec(prompt)?.[1];
  expect(api).toBeTruthy();
  expect((await fetch(api!, { headers: { Authorization: `Bearer ${token}` } })).ok).toBe(true);
  await ed.press("Escape");
  // With the caret on the page, the key reaches the shell from the frame, by message: a moment later.
  await expect.poll(() => ed.eval<boolean>(`document.getElementById("share").hidden`)).toBe(true);
});

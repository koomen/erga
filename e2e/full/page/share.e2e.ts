// The Share button: its card's lower half, "Share with an agent", a prompt with this page's API and a working token.
import { expect, servers, test } from "../../fixtures";
import { openEditor } from "../../editor";

await servers.main();

test("the Share button opens a card whose agent half has a prompt naming the page's API and a token that works; Escape closes it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "noedit");
  await ed.eval(`document.getElementById("btn-share").click()`);
  expect(await ed.eval<boolean>(`!document.getElementById("sharing").hidden && document.getElementById("btn-share").getAttribute("aria-expanded") == "true"`)).toBe(true);
  await expect.poll(() => ed.eval<string>(`document.getElementById("share-prompt").value`)).toContain("Token: erga_");
  const prompt = await ed.eval<string>(`document.getElementById("share-prompt").value`);
  const token = /Token: (\S+)/.exec(prompt)?.[1], api = /API: (\S+)/.exec(prompt)?.[1];
  expect(api).toBeTruthy();
  expect((await fetch(api!, { headers: { Authorization: `Bearer ${token}` } })).ok).toBe(true);
  await ed.press("Escape");
  // With the caret on the page, the key reaches the shell from the frame, by message: a moment later.
  await expect.poll(() => ed.eval<boolean>(`document.getElementById("sharing").hidden`)).toBe(true);
});

test("the owner's Share card has Viewers can ask the agent, off; turned on, it says each viewer's turns a day, and it stays on", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "noedit");
  await ed.eval(`document.getElementById("btn-share").click()`);
  await expect.poll(() => ed.eval<boolean>(`!document.getElementById("viewers-agent").hidden`)).toBe(true);
  expect(await ed.eval<boolean>(`document.getElementById("viewers-agent-on").checked`)).toBe(false);
  expect(await ed.eval<string>(`document.getElementById("viewers-agent-use").textContent`)).toContain("can't ask it");
  await ed.eval(`document.getElementById("viewers-agent-on").click()`);
  await expect.poll(() => ed.eval<string>(`document.getElementById("viewers-agent-use").textContent`)).toMatch(/Each viewer may ask \d+ times a day/);
  // Kept: the document's own answer says so.
  const r = await ed.eval<{ on: boolean }>(`fetch(location.pathname.replace(/\\/?$/, "") + "/api/viewers-agent").then((r) => r.json())`);
  expect(r.on).toBe(true);
});

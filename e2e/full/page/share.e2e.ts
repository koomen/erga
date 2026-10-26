// The Share button: its card's lower half, "Share with an agent", a prompt with this page's API and a working token.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

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

test("the owner's link row shows its whole hint, wrapped under Copy link, never cut off; the add box asks for a username", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "noedit");
  await ed.eval(`document.getElementById("btn-share").click()`);
  await expect
    .poll(() => ed.eval<string>(`document.getElementById("sharing-copied").textContent`))
    .toMatch(/shared with|signed in or not|sign in first/);
  const row = await ed.eval<{ cut: boolean; label: string; placeholder: string; viewers: boolean }>(`(() => {
    const who = document.getElementById("sharing-copied").closest(".who");
    return { cut: who.scrollWidth > who.clientWidth, label: document.querySelector("label[for=sharing-anyone]").textContent, placeholder: document.querySelector("#sharing-add input[name=login]").placeholder, viewers: !!document.getElementById("viewers-agent") };
  })()`);
  expect(row).toMatchObject({ cut: false, placeholder: "Username", viewers: false });
  expect(["Link", "Anyone with the link"]).toContain(row.label);
});

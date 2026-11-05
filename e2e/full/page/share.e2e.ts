// The Share button: its card, with people (one line for each); Copy link confirms on the button, then the card closes.
// Share with an agent, its own button: it copies a one-line prompt (Erga's MCP server, then this document), with no token.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

/** A click as a person makes it: the mouse goes to the element (which brings back the controls that typing hid; they
 *  move in as they come), then clicks at its middle, once nothing covers it there. */
const clickOn = async (ed: Editor, selector: string) => {
  const centre = () =>
    ed.page.evaluate((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect(),
        x = r.x + r.width / 2,
        y = r.y + r.height / 2;
      return document.querySelector(s)!.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    }, selector);
  const box = (await ed.page.locator(selector).boundingBox())!;
  await ed.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await expect.poll(centre).toBeTruthy();
  const at = (await centre())!;
  await ed.page.mouse.click(at.x, at.y);
};
const cardOpen = (ed: Editor) => ed.eval<boolean>(`!document.getElementById("sharing").hidden`);

test("Share with an agent opens its menu; Install Erga's MCP copies one line, Erga's MCP server and then this document, says Copied in its tooltip, and opens no card", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "empty");
  const origin = new URL(ed.address).origin;
  await tab.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await ed.clickEnd("[data-erga-text]:not(.erga-locked)");
  await ed.idle();
  await clickOn(ed, "#btn-agent-share");
  await clickOn(ed, "#btn-agent-share-menu .am-mcp");
  await expect.poll(() => ed.eval<string>(`document.getElementById("btn-agent-share").dataset.tip`)).toBe("Copied ✓");
  expect(await tab.page.evaluate(() => navigator.clipboard.readText())).toBe(
    `Add Erga's MCP server, ${origin}/mcp, then open ${ed.address}.`
  );
  // Its icon stays, and its tooltip has its name back after the moment; the menu closed, and the Share card stays closed.
  expect(
    await ed.eval<boolean>(
      `!!document.querySelector("#btn-agent-share svg") && document.getElementById("sharing").hidden && document.getElementById("btn-agent-share-menu").hidden`
    )
  ).toBe(true);
  await expect.poll(() => ed.eval<string>(`document.getElementById("btn-agent-share").dataset.tip`)).toBe("Share with an agent");
});

test("the Share button opens only Share with people; Escape closes it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "noedit");
  await ed.eval(`document.getElementById("btn-share").click()`);
  expect(await ed.eval<boolean>(`!document.getElementById("sharing").hidden && document.getElementById("btn-share").getAttribute("aria-expanded") == "true"`)).toBe(true);
  expect(await ed.eval<string[]>(`[...document.querySelectorAll("#sharing h2")].map((h) => h.textContent)`)).toEqual(["Share with people"]);
  expect(await ed.eval<boolean>(`!document.getElementById("share-prompt")`)).toBe(true);
  await ed.press("Escape");
  // With the caret on the page, the key reaches the shell from the frame, by message: a moment later.
  await expect.poll(() => cardOpen(ed)).toBe(false);
});

test("the owner's card: one line for each person and for the link, Copy link at its end; the add box asks for a username", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "noedit");
  await ed.eval(`document.getElementById("btn-share").click()`);
  await expect.poll(() => ed.eval<number>(`document.querySelectorAll("#sharing-list li").length`)).toBe(1);
  const card = await ed.eval<{ rows: number[]; cut: boolean; label: string; placeholder: string; viewers: boolean }>(`(() => {
    const rows = [...document.querySelectorAll("#sharing-list li, .sharing-anyone")].map((r) => Math.round(r.getBoundingClientRect().height));
    const who = document.querySelector(".sharing-anyone .who");
    return { rows, cut: who.scrollWidth > who.clientWidth, label: document.querySelector("label[for=sharing-anyone]").textContent, placeholder: document.querySelector("#sharing-add input[name=who]").placeholder, viewers: !!document.getElementById("viewers-agent") };
  })()`);
  expect(card).toMatchObject({ cut: false, placeholder: "Username", viewers: false });
  // A login to share with, not a sign-in field: password managers leave it alone (1Password offered to fill it).
  expect(
    await ed.eval<string[]>(
      `["autocomplete", "data-1p-ignore", "data-lpignore", "data-bwignore"].map((a) => document.querySelector("#sharing-add input[name=who]").getAttribute(a))`
    )
  ).toEqual(["off", "", "true", ""]);
  expect(["Link", "Anyone with the link"]).toContain(card.label);
  // One line each, at the desktop's width: no row taller than its 32 px.
  for (const h of card.rows) expect(h).toBeLessThanOrEqual(32);
});

for (const [what, button, expected] of [
  ["Copy link", "#sharing-copy", (ed: Editor, text: string) => expect(text).toBe(ed.address)],
] as const)
  test(`${what} says "Copied ✓" on its button, puts it on the clipboard, then the card closes and the caret is back on the page`, async ({
    tab,
  }) => {
    const ed = await openEditor(tab, await servers.main(), "empty");
    await tab.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(ed.address).origin });
    await ed.clickEnd("[data-erga-text]:not(.erga-locked)");
    await ed.idle();
    await clickOn(ed, "#btn-share");
    await clickOn(ed, button);
    await expect.poll(() => ed.eval<string>(`document.querySelector(${JSON.stringify(button)}).textContent`)).toBe("Copied ✓");
    // The confirmation shows first: the card is still open.
    expect(await cardOpen(ed)).toBe(true);
    expected(ed, await tab.page.evaluate(() => navigator.clipboard.readText()));
    await expect.poll(() => cardOpen(ed)).toBe(false);
    await ed.idle();
    await ed.type("x");
    await ed.shows("x|");
    // Open again: the button has its own name back.
    await clickOn(ed, "#btn-share");
    expect(await ed.eval<string>(`document.querySelector(${JSON.stringify(button)}).textContent`)).toBe(what);
  });

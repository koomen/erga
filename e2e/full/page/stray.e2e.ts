// A paragraph whose HTML has a stray end tag: locked, saying why, and typing never lands somewhere else ("Stray end tag").
// The toast's minimum time on screen is checked in stray.bench.e2e.ts (timing).
import { expect, servers, test, type Tab } from "../../fixtures";
import { F, openEditor, type Editor } from "../../editor";

await servers.main();

// Less compressed than elsewhere (the old harness did the same): the toast's minimum, scaled, is what this file's checks wait out.
const TS = 0.4;
const open = async (tab: Tab): Promise<Editor> => openEditor(tab, await servers.main(), "stray", { timescale: TS });

test("the malformed paragraph is locked, and its neighbours aren't", async ({ tab }) => {
  const ed = await open(tab);
  expect(await ed.frame<boolean>(`${F}.querySelector(".box p").classList.contains("erga-locked")`)).toBe(true);
  expect(await ed.frame<boolean>(`!${F}.querySelector(".box h4").classList.contains("erga-locked") && !${F}.querySelector("body > p").classList.contains("erga-locked")`)).toBe(true);
});

test("clicking it says why and offers the agent's help, not a trip to the HTML; a click elsewhere, past its minimum, takes it away", async ({ tab }) => {
  const ed = await open(tab);
  const r = await ed.rectOf(".box p", 0.3);
  await ed.click(r.x, r.y);
  await expect.poll(async () => (await ed.toast()).shown).toBe(true);
  const t = await ed.toast();
  expect(t.text).toMatch(/stray <\/h2>/);
  expect(t.text).not.toMatch(/HTML view|⌘⇧P/);
  expect(await ed.eval<boolean>(`!!document.querySelector("#toast .toast-fix")`)).toBe(true);
  // Clicked elsewhere until it goes: a click inside its minimum leaves it up (that minimum is the bench's to time).
  const elsewhere = await ed.rectOf("h1", 0.5);
  await expect.poll(async () => { await ed.click(elsewhere.x, elsewhere.y); return (await ed.toast()).shown; }, { timeout: 5000 * TS + 3000 }).toBe(false);
});

test("typing into it explains again and changes nothing; the paragraph above still edits", async ({ tab }) => {
  const ed = await open(tab);
  const before = await ed.source();
  const r = await ed.rectOf(".box p", 0.3);
  await ed.click(r.x, r.y);
  await ed.type("xyz");
  await ed.settle();
  const t = await ed.toast();
  expect(t.shown).toBe(true);
  expect(t.text).toMatch(/stray/);
  expect(await ed.source()).toBe(before);
  await ed.clickEnd("body > p");
  await ed.type("!");
  await expect.poll(() => ed.source()).toContain("This paragraph is fine.!</p>");
});

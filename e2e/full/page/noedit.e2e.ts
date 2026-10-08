// Parts marked data-erga-noedit: never editable by hand, and clicking them says so ("No-edit parts").
import { expect, servers, test } from "../../fixtures";
import { F, openEditor } from "../../editor";

await servers.main();

test("a no-edit section has no editable text, and a no-edit span inside a paragraph is fenced off", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "noedit");
  expect(await ed.frame<boolean>(`[...${F}.querySelectorAll(".fixed h2, .fixed p")].every((e) => !e.hasAttribute("data-erga-id") && !e.isContentEditable)`)).toBe(true);
  expect(await ed.frame<boolean>(`${F}.querySelector(".free").isContentEditable && !${F}.querySelector(".count").isContentEditable`)).toBe(true);
});

test("clicking a no-edit part says why, typing there changes nothing, and the rest of the paragraph still edits", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "noedit");
  const before = await ed.source();
  const r = await ed.rectOf(".fixed p", 0.3);
  await ed.click(r.x, r.y);
  await expect.poll(async () => { const t = await ed.toast(); return t.shown && /not editable by hand/.test(t.text); }).toBe(true);
  await ed.type("xyz");
  await ed.settle();
  expect(await ed.source()).toBe(before);
  await ed.clickEnd(".free");
  await ed.type("!");
  await expect.poll(() => ed.source()).toContain("items.!</p>");
});

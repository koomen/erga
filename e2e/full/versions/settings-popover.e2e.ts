// The settings popover: loaded once the editor is idle, hanging from the gear, opened and closed by mouse and keyboard.
import { expect, servers, test } from "../../helpers/fixtures";
import { closeDrafts, draftDoc, MANY_VERSIONS, openDocEditor } from "./settings";

await servers.short();
test.afterEach(closeDrafts);

test("the settings' code and what they show load once the editor is idle, before the gear is reached for", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Lazy notes", 2);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  // No pointer on the gear: it's ready, its versions read.
  await expect.poll(() => s.eval<boolean>("!!window.ergaSettings")).toBe(true);
  await expect.poll(() => s.eval<number>(`document.querySelectorAll("#ds-list li[data-n]").length`)).toBe(2);
  expect(await s.isOpen()).toBe(false);
});

test(
  "the popover hangs from the gear with the latest ten versions, and Show older versions; Escape, a click outside and the keyboard open and close it",
  MANY_VERSIONS,
  async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Field notes", 12);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  const gear = (await s.steadyRect("#btn-settings"))!;
  await s.open();
  const pop = (await s.rect("#doc-settings"))!;
  expect(pop.top).toBeGreaterThan(gear.bottom);
  expect(pop.top - gear.bottom).toBeLessThan(20);
  expect(Math.abs(pop.right - gear.right)).toBeLessThan(24);
  expect(await s.attr("#btn-settings", "aria-expanded")).toBe("true");
  // No publishing: nothing to choose what viewers see.
  expect(await s.eval<boolean>(`!!document.querySelector("#ds-mode, #ds-pick, #ds-explain")`)).toBe(false);
  const listed = await s.eval<string[]>(`[...document.querySelectorAll("#ds-list li")].map((li) => li.textContent.replace(/\\s+/g, " ").trim())`);
  expect(listed).toHaveLength(10);
  expect(listed[0].startsWith("v12")).toBe(true);
  for (const part of ["Current", "Edited index.html", "tester"]) expect(listed[0]).toContain(part);
  expect(listed.join(" ")).not.toContain("Published");
  expect(await s.text("#ds-total")).toBe("12 in all");
  expect(await s.text("#ds-foot-text")).toBe("The latest 10 of 12.");
  await s.clickOn("#ds-older");
  await expect.poll(() => s.listed()).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  expect(await s.eval<boolean>(`document.getElementById("ds-foot").hidden`)).toBe(true);
  await tab.page.keyboard.press("Escape");
  await expect.poll(() => s.isOpen()).toBe(false);
  expect(await s.focused()).toBe("btn-settings");
  await tab.page.keyboard.press("Enter");
  await expect.poll(() => s.isOpen()).toBe(true);
  // A click into the page closes it.
  await tab.page.mouse.click(300, 500);
  await expect.poll(() => s.isOpen()).toBe(false);
});

// The settings popover: loaded lazily, hanging from the gear, opened and closed by mouse and keyboard.
import { expect, servers, test } from "../../fixtures";
import { closeDrafts, draftDoc, openDocEditor } from "./settings";

await servers.short();
test.afterEach(closeDrafts);

test("the settings' code loads only when the gear is reached for", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Lazy notes", 2);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  expect(await s.eval<boolean>(`!!window.ergaSettings || performance.getEntriesByType("resource").some((e) => e.name.includes("/_erga/settings-"))`)).toBe(false);
  const gear = (await s.steadyRect("#btn-settings"))!;
  await tab.page.mouse.move(gear.x, gear.y);
  await expect.poll(() => s.eval<boolean>("!!window.ergaSettings")).toBe(true);
});

test("the popover hangs from the gear with the latest ten versions; Escape, a click outside and the keyboard open and close it", async ({ tab }) => {
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
  expect(await s.text("#ds-mode")).toBe("Latest");
  expect(await s.text("#ds-explain")).toContain("up to the keystroke");
  const listed = await s.eval<string[]>(`[...document.querySelectorAll("#ds-list li")].map((li) => li.textContent.replace(/\\s+/g, " ").trim())`);
  expect(listed).toHaveLength(10);
  expect(listed[0].startsWith("v12")).toBe(true);
  for (const part of ["Current", "Published", "Edited index.html", "tester"]) expect(listed[0]).toContain(part);
  expect(await s.text("#ds-total")).toBe("12 in all");
  await tab.page.keyboard.press("Escape");
  await expect.poll(() => s.isOpen()).toBe(false);
  expect(await s.focused()).toBe("btn-settings");
  await tab.page.keyboard.press("Enter");
  await expect.poll(() => s.isOpen()).toBe(true);
  // A click into the page closes it.
  await tab.page.mouse.click(300, 500);
  await expect.poll(() => s.isOpen()).toBe(false);
});

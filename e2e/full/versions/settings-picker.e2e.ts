// Latest and Manual, and the published-version picker's windows.
import { expect, servers, test } from "../../fixtures";
import { another, closeDrafts, draftDoc, openDocEditor, viewerShows } from "./settings";

await servers.short();
test.afterEach(closeDrafts);

test("Latest to Manual by keyboard keeps what viewers see; an old version picked from the menu, the viewer shows it", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Field notes", 47);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  const viewer = await another(tab);
  await viewerShows(viewer, server, doc.address, "Draft 47");
  await s.open();
  await s.eval(`document.getElementById("ds-mode").focus()`);
  await s.ed.press("ArrowDown");
  await expect.poll(() => s.eval<boolean>("!!document.getElementById('ds-menu-mode')")).toBe(true);
  await s.ed.press("End");
  await tab.page.keyboard.press("Enter");
  await expect.poll(async () => { const v = await doc.owner.versions(doc.id); return `${v.published.mode} ${v.published.version.n}`; }).toBe("manual 47");
  await expect.poll(async () => `${await s.text("#ds-mode")} ${(await s.text("#ds-pick")).slice(0, 3)}`).toBe("Manual v47");
  await s.saved();
  await s.clickOn("#ds-pick");
  await expect.poll(() => s.menuRows()).toBe("47 46 45 44 43 42 41 40 39 38 …37");
  await s.clickOn(".ds-menu [id^=ds-more-]");
  await expect.poll(() => s.menuRows()).toContain("28");
  await s.clickOn("#ds-ver-30");
  await expect.poll(async () => (await doc.owner.versions(doc.id)).published.version.n).toBe(30);
  await s.saved();
  expect(await viewerShows(viewer, server, doc.address, "Draft 30")).not.toContain("Draft 47");
  expect(await s.text("#ds-explain")).toContain("17 newer versions aren't published");
});

test("published far back: the latest ten, a row for the gap that loads more, the version and the three before it; picked with the keyboard", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Field notes", 47);
  expect((await doc.owner.publish(doc.id, { mode: "manual", versionId: "v30" })).ok).toBe(true);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  const viewer = await another(tab);
  await s.open();
  await expect.poll(() => s.text("#ds-pick")).toMatch(/^v30/);
  // A publish made elsewhere: the popover follows it, live.
  expect((await doc.owner.publish(doc.id, { mode: "manual", versionId: "v12" })).ok).toBe(true);
  await expect.poll(() => s.text("#ds-pick")).toMatch(/^v12/);
  const shown = await viewerShows(viewer, server, doc.address, "Draft 12");
  expect(shown).not.toContain("Draft 30");
  await s.clickOn("#ds-pick");
  await expect.poll(() => s.menuRows()).toBe("47 46 45 44 43 42 41 40 39 38 …25 12 11 10 9 …8");
  expect(await s.eval<string>(`document.querySelector(".ds-menu [aria-selected=true]")?.id`)).toBe("ds-ver-12");
  await s.clickOn(".ds-menu [id^=ds-more-]");
  await expect.poll(() => s.menuRows()).toContain("…15");
  expect(await s.isOpen()).toBe(true);
  expect(await s.hasMenu()).toBe(true);
  // Version 11 with the keyboard: the menu's focus starts on the published version, 12.
  await s.eval(`document.querySelector(".ds-menu").focus()`);
  const at = await s.eval<number>(`[...document.querySelectorAll(".ds-menu [role=option]")].findIndex((o) => o.classList.contains("active"))`);
  const want = await s.eval<number>(`[...document.querySelectorAll(".ds-menu [role=option]")].findIndex((o) => o.id == "ds-ver-11")`);
  for (let i = at; i < want; i++) await s.ed.press("ArrowDown");
  await tab.page.keyboard.press("Enter");
  await expect.poll(async () => (await doc.owner.versions(doc.id)).published.version.n).toBe(11);
  await expect.poll(() => s.text("#ds-pick")).toMatch(/^v11/);
  expect(await s.hasMenu()).toBe(false);
  expect(await s.focused()).toBe("ds-pick");
  await s.saved();
  await viewerShows(viewer, server, doc.address, "Draft 11");
});

test("fewer than ten versions: all of them; published one older than current, the latest ten, the picker following live", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Small notes", 6);
  expect((await doc.owner.publish(doc.id, { mode: "manual", versionId: "v2" })).ok).toBe(true);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  await s.clickOn("#ds-pick");
  await expect.poll(() => s.menuRows()).toBe("6 5 4 3 2 1");
  await doc.versions(47);
  expect((await doc.owner.publish(doc.id, { mode: "manual", versionId: "v46" })).ok).toBe(true);
  await expect.poll(() => s.menuRows()).toBe("47 46 45 44 43 42 41 40 39 38 …37");
});

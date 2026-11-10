// The popover following the document live, Restore on an old version with its Undo, and errors.
import { expect, servers, test, type Tab } from "../../helpers/fixtures";
import { roomOf, Participant } from "./versions";
import { another, closeDrafts, draftDoc, MANY_VERSIONS, openDocEditor, viewerShows } from "./settings";
import { F } from "../../helpers/editor";

await servers.short();
test.afterEach(closeDrafts);

/** A document of 12 versions, its editor open with the popover open. */
async function twelve(tab: Tab) {
  const server = await servers.short();
  const doc = await draftDoc(server, "Field notes", 12);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  return { server, doc, s, viewer: await another(tab) };
}

test("versions update live, a new one and then its description; viewers see the document as it is", MANY_VERSIONS, async ({ tab }) => {
  const { server, doc, s, viewer } = await twelve(tab);
  doc.draft(13);
  await viewerShows(viewer, server, doc.address, "Draft 13");
  await expect.poll(() => s.firstRow(), { timeout: 5_000 }).toContain("v13");
  await expect.poll(() => s.firstRow()).toContain("Edited index.html");
});

test(
  "Restore on a version: shown on hover at once and on focus, not on the current one; a copy becomes current, live in the editor, the room and the viewer; Undo puts the document back",
  MANY_VERSIONS,
  async ({ tab }) => {
  const { server, doc, s, viewer } = await twelve(tab);
  const room = await Participant.join(roomOf(server, doc.id), "tester");
  try {
    const edit = (n: number) => `#ds-list li[data-n="${n}"] .ds-restore`;
    const opacity = (sel: string) => s.eval<string>(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).opacity`);
    expect(await s.eval<boolean>(`!!document.querySelector(${JSON.stringify(edit(12))})`)).toBe(false);
    expect(await opacity(edit(9))).toBe("0");
    // The popover scrolls (the sections above can push the list below its fold): the row in view first.
    await s.eval(`document.querySelector('#ds-list li[data-n="9"]').scrollIntoView({ block: "nearest" })`);
    const row = (await s.steadyRect(`#ds-list li[data-n="9"]`))!;
    await tab.page.mouse.move(row.left + 60, row.y);
    expect(await opacity(edit(9))).toBe("1");
    expect(await opacity(edit(8))).toBe("0");
    const inEditor = () => s.ed.frame<string>(`${F}?.getElementById("draft")?.textContent ?? ""`);
    expect(await inEditor()).toBe("Draft 12");
    await tab.page.mouse.move(300, 600);
    await tab.page.keyboard.press("Tab"); // a key first, so focus after it shows as keyboard focus
    await s.eval(`document.querySelector(${JSON.stringify(edit(8))}).focus()`);
    expect(await opacity(edit(8))).toBe("1");
    expect(await s.text(edit(8))).toBe("Restore");
    await tab.page.keyboard.press("Enter");
    await expect.poll(async () => (await doc.owner.versions(doc.id)).current.n).toBe(13);
    await expect.poll(() => s.firstRow()).toContain("Restored version 8");
    const first = await s.firstRow();
    expect(first.startsWith("v13")).toBe(true);
    expect(first).toContain("Current");
    expect(first).toContain("tester");
    await expect.poll(inEditor).toBe("Draft 8");
    await expect.poll(() => room.str()).toContain("Draft 8");
    await viewerShows(viewer, server, doc.address, "Draft 8");
    // "Restored v8. Undo": one click puts back the document as it was, as one more version.
    await expect.poll(() => s.text("#ds-restored")).toBe("Restored v8. Undo");
    await s.clickOn("#ds-undo");
    await expect.poll(async () => (await doc.owner.versions(doc.id)).current.n).toBe(14);
    await expect.poll(inEditor).toBe("Draft 12");
    await expect.poll(() => s.eval<boolean>(`document.getElementById("ds-restored").hidden`)).toBe(true);
  } finally { room.disconnect(); }
});

test("errors show inline, in plain words", MANY_VERSIONS, async ({ tab }) => {
  const { doc, s } = await twelve(tab);
  // Requests that fail as if the network were down: the browser logs each, on purpose.
  tab.strict = false;
  const down = async (pattern: RegExp) => { await tab.page.unrouteAll(); await tab.page.route(pattern, (r) => r.abort("internetdisconnected")); };
  await down(/\/api\/tools\/restore_version/);
  const row = (await s.rect(`#ds-list li[data-n="8"]`))!;
  await tab.page.mouse.move(row.left + 60, row.y);
  await s.clickOn(`#ds-list li[data-n="8"] .ds-restore`);
  await expect.poll(() => s.text("#ds-hist-error")).toMatch(/^Couldn't restore version 8: Couldn't reach the server/);
  expect((await doc.owner.versions(doc.id)).current.n).toBe(12);
  await down(/\/api\/tools\/versions/);
  await s.clickOn("#ds-older");
  await expect.poll(() => s.text("#ds-hist-error")).toMatch(/^Couldn't load older versions: Couldn't reach the server/);
  await s.close();
  // A new version while it's closed: it reads the versions again, and can't; it says so when it opens.
  await down(/\/api\/tools\/versions/);
  doc.draft(13);
  await expect.poll(async () => (await doc.owner.versions(doc.id)).total).toBe(13);
  await s.clickOn("#btn-settings");
  await expect.poll(() => s.text("#ds-hist-error")).toMatch(/^Couldn't refresh the versions: Couldn't reach the server/);
  await tab.page.unrouteAll();
  const other = tab.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource/.test(e));
  expect(other).toEqual([]);
});

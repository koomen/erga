// The popover following the document live, Publish the current version, Edit on an old version, and errors (tests/settings.ts).
import { expect, servers, test, type Tab } from "../fixtures";
import { roomOf, Participant } from "./versions";
import { another, closeDrafts, draftDoc, openDocEditor, viewerShows } from "./settings";
import { F } from "../editor";

await servers.short();
test.afterEach(closeDrafts);

/** A document of 20 versions published (manually) at version 11, its editor open with the popover open. */
async function manualAt11(tab: Tab) {
  const server = await servers.short();
  const doc = await draftDoc(server, "Field notes", 20);
  expect((await doc.owner.publish(doc.id, { mode: "manual", versionId: "v11" })).ok).toBe(true);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  return { server, doc, s, viewer: await another(tab) };
}

test("versions update live, a new one and then its description; in Manual, viewers still see the published version", async ({ tab }) => {
  const { server, doc, s, viewer } = await manualAt11(tab);
  doc.draft(21);
  await expect.poll(() => s.firstRow(), { timeout: 5_000 }).toContain("v21");
  await expect.poll(() => s.firstRow()).toContain("Edited index.html");
  expect(await s.text("#ds-explain")).toContain("10 newer versions aren't published");
  expect(await viewerShows(viewer, server, doc.address, "Draft 11")).not.toContain("Draft 21");
});

test("Publish the current version: the viewer shows it, the button goes; with edits not in a version, it publishes them too", async ({ tab }) => {
  const { server, doc, s, viewer } = await manualAt11(tab);
  expect(await s.eval<boolean>(`!document.getElementById("ds-pub-current").hidden`)).toBe(true);
  expect(await s.text("#ds-pub-current")).toBe("Publish the current version (v20)");
  await s.clickOn("#ds-pub-current");
  await expect.poll(async () => (await doc.owner.versions(doc.id)).published.version.n).toBe(20);
  await expect.poll(async () => (await s.text("#ds-pick")).startsWith("v20") && (await s.eval<boolean>(`document.getElementById("ds-pub-current").hidden`))).toBe(true);
  await s.saved();
  expect(await viewerShows(viewer, server, doc.address, "Draft 20")).not.toContain("Draft 11");
  // Edits not yet in a version: the button publishes them, up to the keystroke.
  await s.close();
  const held = await doc.hold();
  doc.draft(21);
  await expect.poll(async () => (await doc.owner.versions(doc.id)).pending).toBe(true);
  await s.open();
  // (The button has that text while hidden too: shown, once the popover hears of the pending edits.)
  await expect.poll(async () => !(await s.eval<boolean>(`document.getElementById("ds-pub-current").hidden`)) && await s.text("#ds-pub-current")).toBe("Publish the latest edits");
  expect(await s.text("#ds-explain")).toContain("The latest edits aren't published");
  held.release();
  await s.clickOn("#ds-pub-current");
  await expect.poll(async () => { const v = await doc.owner.versions(doc.id); return `${v.published.version.n} ${v.current.n} ${v.pending}`; }).toBe("21 21 false");
  await s.saved();
  await viewerShows(viewer, server, doc.address, "Draft 21");
});

test("Edit on a version: shown on hover at once and on focus, not on the current one; a copy becomes current, live in the editor and the room", async ({ tab }) => {
  const { server, doc, s, viewer } = await manualAt11(tab);
  const room = await Participant.join(roomOf(server, doc.id), "tester");
  try {
    const edit = (n: number) => `#ds-list li[data-n="${n}"] .ds-edit`;
    const opacity = (sel: string) => s.eval<string>(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).opacity`);
    expect(await s.eval<boolean>(`!!document.querySelector(${JSON.stringify(edit(20))})`)).toBe(false);
    expect(await opacity(edit(17))).toBe("0");
    const row = (await s.rect(`#ds-list li[data-n="17"]`))!;
    await tab.page.mouse.move(row.left + 60, row.y);
    expect(await opacity(edit(17))).toBe("1");
    expect(await opacity(edit(16))).toBe("0");
    const inEditor = () => s.ed.frame<string>(`${F}?.getElementById("draft")?.textContent ?? ""`);
    expect(await inEditor()).toBe("Draft 20");
    await tab.page.mouse.move(300, 600);
    await tab.page.keyboard.press("Tab"); // a key first, so focus after it shows as keyboard focus
    await s.eval(`document.querySelector(${JSON.stringify(edit(16))}).focus()`);
    expect(await opacity(edit(16))).toBe("1");
    await tab.page.keyboard.press("Enter");
    await expect.poll(async () => (await doc.owner.versions(doc.id)).current.n).toBe(21);
    await expect.poll(() => s.firstRow()).toContain("Restored version 16");
    const first = await s.firstRow();
    expect(first.startsWith("v21")).toBe(true);
    expect(first).toContain("Current");
    expect(first).toContain("tester");
    await expect.poll(inEditor).toBe("Draft 16");
    await expect.poll(() => room.str()).toContain("Draft 16");
    expect(await s.text("#ds-pick")).toMatch(/^v11/);
    await viewerShows(viewer, server, doc.address, "Draft 11");
  } finally { room.disconnect(); }
});

test("errors show inline, in plain words, and a failed publish rolls back", async ({ tab }) => {
  const { doc, s } = await manualAt11(tab);
  // Requests that fail as if the network were down: the browser logs each, on purpose.
  tab.strict = false;
  const down = async (pattern: RegExp) => { await tab.page.unrouteAll(); await tab.page.route(pattern, (r) => r.abort("internetdisconnected")); };
  await down(/\/restore$/);
  const row = (await s.rect(`#ds-list li[data-n="16"]`))!;
  await tab.page.mouse.move(row.left + 60, row.y);
  await s.clickOn(`#ds-list li[data-n="16"] .ds-edit`);
  await expect.poll(() => s.text("#ds-hist-error")).toMatch(/^Couldn't restore version 16: Couldn't reach the server/);
  expect((await doc.owner.versions(doc.id)).current.n).toBe(20);
  await down(/\/publish$/);
  await s.clickOn("#ds-pick");
  await expect.poll(() => s.eval<boolean>("!!document.getElementById('ds-ver-18')")).toBe(true);
  await s.clickOn("#ds-ver-18");
  await expect.poll(() => s.text("#ds-pub-error")).toContain("Couldn't change what's published: Couldn't reach the server");
  await expect.poll(() => s.text("#ds-pick")).toMatch(/^v11/);
  expect((await doc.owner.versions(doc.id)).published.version.n).toBe(11);
  await s.close();
  await down(/\/versions(\?|$)/);
  await s.clickOn("#btn-settings");
  await expect.poll(() => s.text("#ds-pub-error")).toMatch(/^Couldn't (load|refresh) the versions: Couldn't reach the server/);
  await tab.page.unrouteAll();
  const other = tab.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource/.test(e));
  expect(other).toEqual([]);
});

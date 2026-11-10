// A document's versions, in the editor's settings: what cuts one (an agent's turn, a pause in a person's edits, a
// restore), the list that follows them live, Restore with its Undo, what a viewer may not do, the list of ten with
// its older versions, errors in place, the sheet on a phone, the homepage's line with Deploy, which no new version
// presses by itself, and the deployed version shown apart when it is old.
//
// The page of the document says which draft it is ("Draft A", "Draft B"...): each check reads the draft that it
// expects. Only two versions wait for a person's edits to pause (SHORT.idle), and one for the pause in an agent's
// turn: restores make the others, with no wait.
import { expect, journey, servers, SHORT, test, until, type Page, type Tab } from "../helpers/fixtures";
import { runTool } from "../helpers/tools";
import {
  draftDoc,
  front,
  homeOf,
  openDocEditor,
  PHONE,
  scripted,
  served,
  settings,
  unique,
  versionsOf,
  WIDE,
  type Settings,
} from "./versions";

const s = await servers.main();

/** A scripted step: an edit of the page's file, exact text to new text. */
const edit = (oldText: string, newText: string) => ({ tool: "edit", args: { path: "index.html", edits: [{ oldText, newText }] } });
/** A version's Restore button, in the list. */
const restoreOf = (n: number) => `#ds-list li[data-n="${n}"] .ds-restore`;

journey("versions in the editor's settings", () => {
  let st: Settings;
  /** The document's id and address. */
  let id = "";
  let address = "";
  /** The page's text at version 14, the agent's. */
  let byAgent = "";
  /** Bo's tab: an editor of the document at first, then someone who may only view. */
  let reader: Page;
  const bo = unique("bo");
  const asBo = { user: bo };
  const share = async (role: string) =>
    expect((await runTool(s.root, "share_document", { document: id, login: bo, role })).error).toBeUndefined();
  /** Bo comes to the document now (their tab loads again): what the viewer shows as the draft. */
  const readerSees = async (draft: string) => {
    await reader.reload();
    const shown = () =>
      reader
        .frameLocator("#frame")
        .locator("#draft")
        .textContent({ timeout: 500 })
        .catch(() => "");
    await until(async () => (await shown()) == draft, 5_000, `the viewer shows "${draft}"`, shown);
  };
  const current = async () => (await versionsOf(s, id)).current.n;
  const restore = (version: string, as = {}) =>
    runTool<{ current: { id: string; n: number } }>(s.root, "restore_version", { document: id, version }, as);
  const blue = () => st.eval<boolean>(`document.getElementById("ds-redeploy").classList.contains("newer")`);
  const histError = () => st.text("#ds-hist-error");
  /** From now on, requests that match fail as if the network were down: the browser logs each, on purpose. */
  const down = async (tab: Tab, pattern: RegExp) => {
    await tab.page.unrouteAll();
    await tab.page.route(pattern, (r) => r.abort("internetdisconnected"));
  };
  /** The network is back; the errors that the browser logged for it are not the page's. */
  const up = async (tab: Tab) => {
    await tab.page.unrouteAll();
    const other = tab.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource/.test(e));
    tab.errors.splice(0, tab.errors.length, ...other);
    expect(other).toEqual([]);
  };
  /** Types a new draft letter in the page (the popover closes first: a click on the page closes it). */
  const typeDraft = async (n: string) => {
    await st.close();
    await st.ed.clickEnd("#draft");
    await st.ed.idle();
    await st.ed.press("Backspace");
    await st.ed.type(n);
    await expect.poll(() => st.draft()).toBe(`Draft ${n}`);
  };

  // The journey makes its document the server's homepage for a while: put back, also when a step fails.
  test.afterAll(async () => void (await runTool(s.root, "set_setting", { key: "landing_document", reset: true })));

  test("the popover hangs from the gear, with the latest ten versions of twelve", async ({ tab }) => {
    // Twelve versions with no wait: the first, one by an agent's turn (draft B), and ten restores of the two in turn.
    ({ id, address } = await draftDoc(s, unique("Field notes ")));
    expect((await scripted(s, id, [edit("Draft A", "Draft B"), { text: "Done." }])).ok).toBe(true);
    await until(async () => (await current()) == 2, 5_000, "the agent's turn is version 2");
    for (let n = 3; n <= 12; n++) expect((await restore(n % 2 ? "v1" : "v2")).result?.current.n).toBe(n);
    tab.strict = true;
    st = await openDocEditor(tab.page, s, address); // the editor's one page load
    const gear = (await st.steadyRect("#btn-settings"))!;
    await st.open();
    const pop = (await st.rect("#doc-settings"))!;
    expect(pop.top).toBeGreaterThan(gear.bottom);
    expect(pop.top - gear.bottom).toBeLessThan(20);
    expect(Math.abs(pop.right - gear.right)).toBeLessThan(24);
    expect(await st.attr("#btn-settings", "aria-expanded")).toBe("true");
    // No publishing: nothing to choose what viewers see.
    expect(await st.eval<boolean>(`!!document.querySelector("#ds-mode, #ds-pick, #ds-explain")`)).toBe(false);
    const rows = await st.rows();
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatch(/^v12 ?Restored version 2 ?Current.*tester$/);
    expect(rows.join(" ")).not.toContain("Published");
    expect(await st.text("#ds-total")).toBe("12 in all");
    expect(await st.text("#ds-foot-text")).toBe("The latest 10 of 12.");
    expect(await st.draft()).toBe("Draft B");
  });

  test("errors show in the settings, in plain words: a restore and the older versions that the server does not give", async ({ tab }) => {
    await down(tab, /\/api\/tools\/restore_version/);
    const row = (await st.steadyRect(`#ds-list li[data-n="8"]`))!;
    await tab.page.mouse.move(row.left + 60, row.y);
    await st.clickOn(restoreOf(8));
    await until(
      async () => /^Couldn't restore version 8: Couldn't reach the server/.test(await histError()),
      5_000,
      "the restore's error shows",
      histError
    );
    expect(await current()).toBe(12);
    await down(tab, /\/api\/tools\/versions/);
    await st.clickOn("#ds-older");
    await until(
      async () => /^Couldn't load older versions: Couldn't reach the server/.test(await histError()),
      5_000,
      "the older versions' error shows",
      histError
    );
    await up(tab);
  });

  test("Show older versions loads the rest; Escape, Enter on the gear and a click on the page close and open the popover", async ({
    tab,
  }) => {
    await st.clickOn("#ds-older");
    await until(async () => (await st.listed()).length == 12, 5_000, "the older versions load");
    expect(await st.listed()).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(await st.eval<boolean>(`document.getElementById("ds-foot").hidden`)).toBe(true);
    await tab.page.keyboard.press("Escape");
    await until(async () => !(await st.isOpen()), 5_000, "Escape closes it");
    expect(await st.focused()).toBe("btn-settings");
    await tab.page.keyboard.press("Enter");
    await until(() => st.isOpen(), 5_000, "Enter opens it");
    // A click into the page closes it.
    await tab.page.mouse.click(300, 500);
    await until(async () => !(await st.isOpen()), 5_000, "a click on the page closes it");
  });

  test("a new version that the closed settings can't read: they say so when they open", async ({ tab }) => {
    await down(tab, /\/api\/tools\/versions/);
    expect((await restore("v1")).result?.current.n).toBe(13);
    await st.clickOn("#btn-settings");
    await until(
      async () => /^Couldn't refresh the versions: Couldn't reach the server/.test(await histError()),
      5_000,
      "the refresh's error shows",
      histError
    );
    await up(tab);
  });

  test("an agent's turn is one version by the agent, though it pauses longer than the idle time; the open list gets it, then its description", async () => {
    // The settings are open, with the list that could not be read again: 12 is its newest version.
    expect((await st.listed())[0]).toBe(12);
    const sent = await scripted(s, id, [
      edit("Draft A", "Draft C"),
      { delay: SHORT.idle * 1.6, ...edit("says which draft", "still says which draft") },
      { text: "Done." },
    ]);
    expect(sent.ok).toBe(true);
    // The first edit shows on the page at once. A cut in the pause would come before the turn ends, as version 14 of 15.
    await expect.poll(() => st.draft()).toBe("Draft C");
    await until(async () => (await st.listed())[0] > 12, SHORT.idle * 5, "the list gets the agent's version");
    expect(await st.listed()).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const state = await versionsOf(s, id);
    expect(state.total).toBe(14);
    expect(state.current.authors.some((a) => a.endsWith("agent"))).toBe(true);
    byAgent = await served(s, id);
    expect(byAgent).toContain("still says which draft");
    // The new row, and then its description.
    await until(
      async () => /^v14 ?Edited index\.html ?Current/.test((await st.rows())[0]),
      5_000,
      "the version's description shows",
      st.rows
    );
  });

  test("someone whose right to edit goes while their editor is open: no versions, a line that says why, and nothing to press", async ({
    tab,
  }) => {
    await share("editor");
    reader = await tab.page.context().newPage();
    const theirs = await openDocEditor(reader, s, address, bo);
    await theirs.open();
    await until(
      async () => (await theirs.listed()).join() == "14,13,12,11,10,9,8,7,6,5",
      5_000,
      "Bo's list has the latest ten",
      theirs.listed
    );
    await theirs.close();
    await share("viewer");
    await theirs.open(false);
    // The versions are for those who may edit: the list they had goes, and the settings say why.
    await until(
      async () =>
        (await theirs.text("#ds-hist-error")) == "Couldn't load the versions: Only people who can edit a document read its versions.",
      5_000,
      "the settings say why"
    );
    expect(await theirs.listed()).toEqual([]);
    expect(await theirs.eval<boolean>(`!!document.querySelector("#ds-list .ds-restore")`)).toBe(false);
    expect(await theirs.eval<boolean>(`document.getElementById("ds-home").hidden`)).toBe(true);
    // Document or Project: shown, not theirs to change.
    await until(
      async () => (await theirs.eval<number>(`document.querySelectorAll('#ds-kind [aria-disabled="true"]').length`)) == 2,
      5_000,
      "the kind is locked"
    );
  });

  test("a viewer at the editor's address gets the viewer, with the document as it is; the tools give them no versions, no restore and no deploy", async () => {
    await readerSees("Draft C");
    expect(new URL(reader.url()).search).toContain("edit");
    expect(await settings(reader).rect("#btn-settings")).toBeNull();
    const versions = await runTool(s.root, "versions", { document: id }, asBo);
    expect([versions.status, versions.error]).toEqual([403, "Only people who can edit a document read its versions."]);
    expect((await restore("v1", asBo)).status).toBe(403);
    expect((await runTool(s.root, "deploy_homepage", {}, asBo)).status).toBe(403);
  });

  test("a person's edits are a version once they pause; a viewer who comes before sees them; the list has the version with its description", async () => {
    await typeDraft("D");
    // Viewers see the document as it is, whatever its versions.
    await readerSees("Draft D");
    await until(async () => (await current()) == 15, SHORT.idle * 5, "the edit is a version");
    await st.open();
    await until(
      async () => /^v15 ?Edited index\.html ?Current.*tester$/.test((await st.rows())[0]),
      5_000,
      "the list has version 15",
      st.rows
    );
  });

  test("Restore shows on the row under the pointer and on focus, never on the current version; a copy becomes current, live in the editor and the room, and for a viewer; Undo puts the document back", async ({
    tab,
  }) => {
    const opacity = (sel: string) => st.eval<string>(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).opacity`);
    expect(await st.eval<boolean>(`!!document.querySelector(${JSON.stringify(restoreOf(15))})`)).toBe(false);
    expect(await opacity(restoreOf(14))).toBe("0");
    // The popover scrolls (the sections above can push the list below its fold): the row in view first.
    await st.eval(`document.querySelector('#ds-list li[data-n="14"]').scrollIntoView({ block: "nearest" })`);
    const row = (await st.steadyRect(`#ds-list li[data-n="14"]`))!;
    await tab.page.mouse.move(row.left + 60, row.y);
    expect(await opacity(restoreOf(14))).toBe("1");
    expect(await opacity(restoreOf(13))).toBe("0");
    await tab.page.mouse.move(300, 600);
    await tab.page.keyboard.press("Tab"); // a key first, so focus after it shows as keyboard focus
    await st.eval(`document.querySelector(${JSON.stringify(restoreOf(13))}).focus()`);
    expect(await opacity(restoreOf(13))).toBe("1");
    expect(await st.text(restoreOf(13))).toBe("Restore");
    await tab.page.keyboard.press("Enter");
    await until(async () => (await current()) == 16, 5_000, "the restore is version 16");
    await until(
      async () => /^v16 ?Restored version 13 ?Current.*tester$/.test((await st.rows())[0]),
      5_000,
      "the list has the restore",
      st.rows
    );
    await expect.poll(() => st.draft()).toBe("Draft A");
    expect(await served(s, id)).toContain("Draft A");
    await readerSees("Draft A");
    // "Restored v13. Undo": one click puts back the document as it was, as one more version.
    await until(async () => (await st.text("#ds-restored")) == "Restored v13. Undo", 5_000, "the note offers Undo");
    await st.clickOn("#ds-undo");
    await until(async () => (await current()) == 17, 5_000, "the undo is version 17");
    await expect.poll(() => st.draft()).toBe("Draft D");
    await until(() => st.eval<boolean>(`document.getElementById("ds-restored").hidden`), 5_000, "the note goes");
  });

  test("the restore tool: not for a viewer, not for a version that is not there; its answer is the new current version, by the person", async () => {
    expect((await restore("v14", asBo)).status).toBe(403);
    expect((await restore("v99")).status).toBe(404);
    const r = await restore("v14");
    expect(r.ok).toBe(true);
    expect(r.result!.current).toMatchObject({ n: 18, description: "Restored version 14", authors: ["tester"] });
    expect((await versionsOf(s, id)).current.id).toBe(r.result!.current.id);
    // The room has the old version's text, and so have the open editor and a viewer who comes now.
    expect(await served(s, id)).toBe(byAgent);
    await expect.poll(() => st.draft()).toBe("Draft C");
    await readerSees("Draft C");
  });

  test("on a phone, the top row fits, the settings are a sheet from the bottom, and the versions fit the screen", async ({ tab }) => {
    await tab.page.setViewportSize(PHONE);
    expect(
      await st.eval<number>(`document.querySelector(".chrome-top").scrollWidth - document.querySelector(".chrome-top").clientWidth`)
    ).toBeLessThanOrEqual(0);
    await st.open();
    const [vw, vh] = await st.eval<[number, number]>("[innerWidth, innerHeight]");
    // It slides up.
    await until(async () => Math.round((await st.rect("#doc-settings"))!.bottom) == vh, 5_000, "the sheet is up");
    const sheet = (await st.rect("#doc-settings"))!;
    expect(sheet.left).toBe(0);
    expect(Math.round(sheet.w)).toBe(vw);
    const row = (await st.rect("#ds-list li[data-n]"))!;
    expect(row.left >= 0 && row.right <= vw && row.top >= 0 && row.bottom <= vh).toBe(true);
    expect(
      await st.eval<number>(`document.getElementById("doc-settings").scrollWidth - document.getElementById("doc-settings").clientWidth`)
    ).toBeLessThanOrEqual(0);
    await st.close();
    await tab.page.setViewportSize(WIDE);
  });

  test("the homepage's line shows only on the homepage: it comes when an admin makes the document the homepage, which deploys it at once", async () => {
    await st.open();
    // Not the homepage: nothing about it, and no switch anywhere.
    expect(await st.eval<boolean>(`document.getElementById("ds-home").hidden`)).toBe(true);
    expect(await st.eval<boolean>(`!!document.querySelector("#doc-settings [role=switch]")`)).toBe(false);
    // An admin chooses it (landing_document, as /admin/settings sets it): the open settings hear of it.
    expect((await runTool(s.root, "set_setting", { key: "landing_document", value: id })).error).toBeUndefined();
    await until(() => st.eval<boolean>(`!document.getElementById("ds-home").hidden`), 5_000, "the homepage's line shows");
    expect(await st.text("#ds-home-note")).toBe("Homepage");
    await until(async () => /^Deployed .*· version 18$/.test(await st.text("#ds-status")), 5_000, "the first deploy is done");
    expect(await front(s)).toContain("Draft C");
    expect(await blue()).toBe(false);
    expect(await st.text("#ds-redeploy")).toBe("Deploy");
  });

  test("a new version never deploys by itself: Deploy turns blue, its tip says that the live page is older, and Deploy deploys the document", async () => {
    // An edit: once it is a version, the settings say that the live page is older, and nothing deploys.
    await typeDraft("E");
    await until(async () => (await current()) == 19, SHORT.idle * 5, "the edit is a version");
    await st.open();
    await until(
      async () => (await st.attr("#ds-redeploy", "data-tip")) == "The document is at version 19: the live page is older.",
      5_000,
      "the tip says so"
    );
    expect(await blue()).toBe(true);
    expect(await st.text("#ds-status")).toMatch(/^Deployed .*· version 18$/);
    expect((await homeOf(s, id)).deploy.version).toBe(18);
    expect(await front(s)).toContain("Draft C");
    // Deploy: the button is locked while the deploy runs, and then the live page is the document.
    await st.watchStatus();
    await st.clickOn("#ds-redeploy");
    await until(
      async () => /^Deployed .*· version 19$/.test(await st.text("#ds-status")) && (await st.seen()).length >= 2,
      5_000,
      "the deploy is done",
      st.seen
    );
    expect(await st.lockedWhileDeploying()).toBe(true);
    expect(await blue()).toBe(false);
    expect(await front(s)).toContain("Draft E");
  });

  test("Deploy with an edit that no version has yet deploys the document as it is, at once", async () => {
    await typeDraft("F");
    await st.open();
    await st.watchStatus();
    await st.clickOn("#ds-redeploy");
    await until(
      async () => (await st.seen()).length >= 2 && (await st.text("#ds-status")).startsWith("Deployed "),
      5_000,
      "the deploy is done",
      st.seen
    );
    expect(await front(s)).toContain("Draft F");
  });

  test("a deployed version older than the latest ten shows apart: the latest five, a gap, then five with it third; Show older versions goes on below it; a deploy takes the gap away", async ({
    tab,
  }) => {
    const deployed = (await homeOf(s, id)).deploy.version!;
    // Sixteen more versions, none deployed: restores of two old versions in turn (the first one takes the typed edit with it).
    let at = 0;
    for (let i = 0; at < deployed + 16; i++) at = (await restore(i % 2 ? "v2" : "v1")).result!.current.n;
    expect(at).toBe(deployed + 16);
    // The settings read the versions afresh: the page loads again (a tab that has listed them keeps them all).
    st = await openDocEditor(tab.page, s, address);
    await st.open();
    const around = [deployed + 2, deployed + 1, deployed, deployed - 1, deployed - 2];
    await expect.poll(() => st.listed()).toEqual([at, at - 1, at - 2, at - 3, at - 4, ...around]);
    const r = await st.rows();
    expect(r[5]).toBe("… 9 more");
    expect(r[0]).toContain("Current");
    expect(r[8].startsWith(`v${deployed}`)).toBe(true);
    expect(r[8]).toContain("Deployed");
    expect(r.filter((x) => x.includes("Deployed"))).toHaveLength(1);
    expect(await st.text("#ds-foot-text")).toBe(`10 of ${at}.`);
    await st.clickOn("#ds-older");
    const below = Array.from({ length: 10 }, (_, i) => deployed - 3 - i);
    await expect.poll(() => st.listed()).toEqual([at, at - 1, at - 2, at - 3, at - 4, ...around, ...below]);
    // Deploy: the deployed version is the latest, in the list, with no gap.
    await st.clickOn("#ds-redeploy");
    await expect.poll(() => st.text("#ds-status")).toMatch(new RegExp(`^Deployed .*· version ${at}$`));
    await expect.poll(async () => (await st.rows())[0]).toContain("Deployed");
    expect((await st.rows()).some((x) => x.startsWith("…"))).toBe(false);
  });
});

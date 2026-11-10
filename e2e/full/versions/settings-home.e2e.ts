// The homepage in the settings: one line only on the homepage (chosen on /admin/settings), and Deploy, blue when the live page is older.
// These change which document is the server's homepage (landing_document): each puts it back after.
import { expect, servers, SHORT, test } from "../../helpers/fixtures";
import { setLanding, signedOut } from "../home/home";
import { closeDrafts, draftDoc, MANY_VERSIONS, openDocEditor } from "./settings";
import { runTool } from "../../helpers/tools";

await servers.short();
test.afterEach(async () => {
  closeDrafts();
  const s = await servers.short();
  await runTool(s.root, "set_setting", { key: "landing_document", reset: true });
});

/** What / serves now (to someone signed out: someone signed in goes to /docs): the homepage's deployed page. */
const front = async () => {
  const root = (await servers.short()).root;
  return (await fetch(`${root}/`, { headers: signedOut({ root }) })).text();
};

test("the homepage shows only on the homepage: one line, no switch; it comes when /admin/settings makes it the homepage, deployed at once", async ({
  tab,
}) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Front page", 3);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  // Not the homepage: nothing about it, and no switch anywhere.
  await expect.poll(() => s.eval<boolean>(`document.getElementById("ds-home").hidden`)).toBe(true);
  expect(await s.eval<boolean>(`!!document.querySelector("#doc-settings [role=switch]")`)).toBe(false);
  // An admin chooses it on /admin: the open settings hear of it, with the line and the deploy.
  await s.watchStatus();
  expect((await setLanding(server, doc.id)).error).toBeUndefined();
  await expect.poll(() => s.eval<boolean>(`!document.getElementById("ds-home").hidden`)).toBe(true);
  expect(await s.text("#ds-home-note")).toBe("Homepage");
  await expect.poll(() => s.text("#ds-status")).toMatch(/^Deployed .*· version 3$/);
  expect(await front()).toContain("Draft 3");
});

// A version cut by a pause (SHORT.idle), on top of the usual.
test("a new version never deploys by itself: Deploy turns blue and its tip says the live page is older, and Deploy deploys the document as it is", {
  timeout: 25_000,
}, async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Front page", 3);
  expect((await setLanding(server, doc.id)).error).toBeUndefined();
  expect((await doc.owner.home(doc.id)).isHome).toBe(true);
  await expect.poll(async () => (await doc.owner.home(doc.id)).deploy.state).toBe("deployed");
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  await expect.poll(() => s.text("#ds-status")).toMatch(/^Deployed .*· version 3$/);
  expect(await s.eval<boolean>(`document.getElementById("ds-redeploy").classList.contains("newer")`)).toBe(false);
  expect(await s.text("#ds-redeploy")).toBe("Deploy");
  // An edit: once it's a version, the open settings say the live page is older, and nothing deploys.
  doc.draft(4);
  await expect.poll(async () => (await doc.owner.versions(doc.id)).current.n, { timeout: SHORT.idle * 4 }).toBe(4); // cut once the edits pause
  await expect.poll(() => s.attr("#ds-redeploy", "data-tip")).toBe("The document is at version 4: the live page is older.");
  expect(await s.eval<boolean>(`document.getElementById("ds-redeploy").classList.contains("newer")`)).toBe(true);
  expect(await s.text("#ds-status")).toMatch(/^Deployed .*· version 3$/);
  expect((await doc.owner.home(doc.id)).deploy.version).toBe(3);
  expect(await front()).toContain("Draft 3");
  // Deploy, with an edit not yet in a version: the document as it is, at once.
  const held = await doc.hold();
  doc.draft(5);
  await expect.poll(async () => (await doc.owner.versions(doc.id)).pending).toBe(true);
  await s.watchStatus();
  await s.clickOn("#ds-redeploy");
  await expect.poll(async () => (await s.text("#ds-status")).startsWith("Deployed ") && (await s.seen()).length >= 2).toBe(true);
  expect(await s.lockedWhileDeploying()).toBe(true);
  expect(await s.eval<boolean>(`document.getElementById("ds-redeploy").classList.contains("newer")`)).toBe(false);
  expect(await front()).toContain("Draft 5");
  held.release();
});

test(
  "a deployed version older than the latest ten shows apart: the latest five, a gap, then five with it third; Show older versions goes on below it",
  MANY_VERSIONS,
  async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Front page", 8);
  expect((await setLanding(server, doc.id)).error).toBeUndefined();
  await expect.poll(async () => (await doc.owner.home(doc.id)).deploy.version).toBe(8);
  // 16 restores: versions 9 to 24, none deployed.
  for (let n = 9; n <= 24; n++) expect((await doc.owner.restore(doc.id, `v${(n % 8) + 1}`)).ok).toBe(true);
  expect((await doc.owner.versions(doc.id)).total).toBe(24);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  await expect.poll(() => s.listed()).toEqual([24, 23, 22, 21, 20, 10, 9, 8, 7, 6]);
  const rows = () =>
    s.eval<string[]>(`[...document.querySelectorAll("#ds-list li")].map((li) => li.textContent.replace(/\\s+/g, " ").trim())`);
  const r = await rows();
  expect(r[5]).toBe("… 9 more");
  expect(r[0]).toContain("Current");
  expect(r[8].startsWith("v8")).toBe(true);
  expect(r[8]).toContain("Deployed");
  expect(r.filter((t) => t.includes("Deployed"))).toHaveLength(1);
  expect(await s.text("#ds-foot-text")).toBe("10 of 24.");
  await s.clickOn("#ds-older");
  await expect.poll(() => s.listed()).toEqual([24, 23, 22, 21, 20, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  expect(await s.eval<boolean>(`document.getElementById("ds-foot").hidden`)).toBe(true);
  // Deploy: the deployed version is the latest, in the list of ten, with no gap.
  await s.clickOn("#ds-redeploy");
  await expect.poll(() => s.text("#ds-status")).toMatch(/^Deployed .*· version 24$/);
  await expect.poll(async () => (await rows())[0]).toContain("Deployed");
  expect((await rows()).some((t) => t.startsWith("…"))).toBe(false);
});

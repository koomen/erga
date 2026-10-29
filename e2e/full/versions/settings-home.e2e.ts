// The homepage in the settings: a note only on the homepage (chosen on /admin), a new version scheduling a deploy, Redeploy now.
// These change which document is the server's homepage (landing_document): each puts it back after.
import { expect, servers, SHORT, test } from "../../helpers/fixtures";
import { setLanding } from "../home/home";
import { closeDrafts, draftDoc, openDocEditor } from "./settings";
import { runTool } from "../../helpers/tools";

await servers.short();
test.afterEach(async () => {
  closeDrafts();
  const s = await servers.short();
  await runTool(s.root, "reset_setting", { key: "landing_document" });
});

/** What / serves now: the homepage's deployed page. */
const front = async () => (await fetch(`${(await servers.short()).root}/`)).text();

test("the homepage shows only on the homepage: a note, no switch; it comes when /admin makes it the homepage, deployed at once", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Front page", 3);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  // Not the homepage: nothing about it, and no switch anywhere.
  await expect.poll(() => s.eval<boolean>(`document.getElementById("ds-home").hidden`)).toBe(true);
  expect(await s.eval<boolean>(`!!document.querySelector("#doc-settings [role=switch]")`)).toBe(false);
  // An admin chooses it on /admin: the open settings hear of it, with the note and the deploy.
  await s.watchStatus();
  expect((await setLanding(server, doc.id)).error).toBeUndefined();
  await expect.poll(() => s.eval<boolean>(`!document.getElementById("ds-home").hidden`)).toBe(true);
  expect(await s.text("#ds-home-note")).toBe("This is the homepage");
  await expect.poll(() => s.text("#ds-status")).toMatch(/^Deployed at .*version 3/);
  expect(await front()).toContain("Draft 3");
});

// Two versions cut by a pause (SHORT.idle each) and a deploy after SHORT.homeDelay, on top of the usual.
test("a new version schedules a deploy, which runs by itself; Redeploy now deploys the document as it is", { timeout: 25_000 }, async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Front page", 3);
  expect((await setLanding(server, doc.id)).error).toBeUndefined();
  expect((await doc.owner.home(doc.id)).isHome).toBe(true);
  await expect.poll(async () => (await doc.owner.home(doc.id)).deploy.state).toBe("deployed");
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  await expect.poll(() => s.text("#ds-status")).toMatch(/^Deployed at .*version 3/);
  // An edit: once it's a version, the deploy is scheduled SHORT.homeDelay later, then runs by itself.
  await s.watchStatus();
  doc.draft(4);
  await expect.poll(async () => (await doc.owner.versions(doc.id)).current.n, { timeout: SHORT.idle * 4 }).toBe(4); // cut once the edits pause
  await expect.poll(async () => (await s.seen()).some((t) => t.startsWith("Scheduled for"))).toBe(true);
  await expect.poll(() => s.text("#ds-status"), { timeout: SHORT.homeDelay * 3 }).toMatch(/^Deployed at .*version 4/); // after the delay
  expect(await front()).toContain("Draft 4");
  // Redeploy now, with an edit not yet in a version: the document as it is, at once.
  const held = await doc.hold();
  doc.draft(5);
  await expect.poll(async () => (await doc.owner.versions(doc.id)).pending).toBe(true);
  await s.watchStatus();
  await s.clickOn("#ds-redeploy");
  await expect.poll(async () => (await s.text("#ds-status")).startsWith("Deployed at") && (await s.seen()).length >= 2).toBe(true);
  expect(await s.lockedWhileDeploying()).toBe(true);
  expect(await front()).toContain("Draft 5");
  held.release();
});

// The homepage in the settings: a note only on the homepage (chosen on /admin), a line when the live page is older, Deploy.
// These change which document is the server's homepage (landing_document): each puts it back after.
import { expect, servers, SHORT, test } from "../../helpers/fixtures";
import { setLanding, signedOut } from "../home/home";
import { closeDrafts, draftDoc, openDocEditor } from "./settings";
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

// A version cut by a pause (SHORT.idle), on top of the usual.
test("a new version never deploys by itself: the settings say the live page is older, and Deploy deploys the document as it is", {
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
  await expect.poll(() => s.text("#ds-status")).toMatch(/^Deployed at .*version 3/);
  expect(await s.text("#ds-home-newer")).toBe("");
  expect(await s.text("#ds-redeploy")).toBe("Deploy");
  // An edit: once it's a version, the open settings say the live page is older, and nothing deploys.
  doc.draft(4);
  await expect.poll(async () => (await doc.owner.versions(doc.id)).current.n, { timeout: SHORT.idle * 4 }).toBe(4); // cut once the edits pause
  await expect.poll(() => s.text("#ds-home-newer")).toBe("The document is at version 4: the live page is older.");
  expect(await s.text("#ds-status")).toMatch(/^Deployed at .*version 3/);
  expect((await doc.owner.home(doc.id)).deploy.version).toBe(3);
  expect(await front()).toContain("Draft 3");
  // Deploy, with an edit not yet in a version: the document as it is, at once.
  const held = await doc.hold();
  doc.draft(5);
  await expect.poll(async () => (await doc.owner.versions(doc.id)).pending).toBe(true);
  await s.watchStatus();
  await s.clickOn("#ds-redeploy");
  await expect.poll(async () => (await s.text("#ds-status")).startsWith("Deployed at") && (await s.seen()).length >= 2).toBe(true);
  expect(await s.lockedWhileDeploying()).toBe(true);
  expect(await s.text("#ds-home-newer")).toBe("");
  expect(await front()).toContain("Draft 5");
  held.release();
});

// The homepage section of the settings: blocked, the switch, a publish scheduling a deploy, Redeploy now.
// These change which document is the server's homepage (landing_document): each puts it back after.
import { expect, servers, SHORT, test } from "../../fixtures";
import { closeDrafts, draftDoc, openDocEditor } from "./settings";

await servers.short();
test.afterEach(async () => {
  closeDrafts();
  const s = await servers.short();
  await fetch(`${s.root}/admin/settings`, { method: "POST", headers: { Origin: s.root }, body: new URLSearchParams({ key: "landing_document", reset: "1" }) });
});

/** What / serves now: the homepage's deployed page. */
const front = async () => (await fetch(`${(await servers.short()).root}/`)).text();

test("a document someone who isn't an admin may edit can't be the homepage: the section says why, and the switch does nothing", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Shared notes", 2);
  await doc.owner.share(doc.id, "bo", "editor");
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  await expect.poll(() => s.eval<boolean>(`!document.getElementById("ds-home").hidden`)).toBe(true);
  await expect.poll(() => s.text("#ds-home-explain")).toContain("Only admins may edit the front page");
  expect(await s.text("#ds-home-explain")).toContain("bo may edit this document");
  expect(await s.attr("#ds-home-switch", "aria-disabled")).toBe("true");
  await s.clickOn("#ds-home-switch");
  // Nothing to wait for, as nothing happens: the server says so after the click has been handled.
  await s.ed.settle();
  expect((await doc.owner.home(doc.id)).isHome).toBe(false);
});

test("the switch makes the document the homepage, deployed at once: Deploying, then Deployed with its version; / serves it", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Front page", 3);
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  await expect.poll(() => s.eval<boolean>(`!document.getElementById("ds-home").hidden`)).toBe(true);
  expect(await s.attr("#ds-home-switch", "aria-checked")).toBe("false");
  expect(await s.rect("#ds-redeploy")).toBeNull();
  await s.watchStatus();
  await s.clickOn("#ds-home-switch");
  await expect.poll(async () => (await doc.owner.home(doc.id)).isHome).toBe(true);
  await expect.poll(() => s.text("#ds-status")).toMatch(/^Deployed at .*version 3/);
  expect((await s.seen()).some((t) => t.startsWith("Deploying"))).toBe(true);
  expect(await front()).toContain("Draft 3");
});

// Two versions cut by a pause (SHORT.idle each) and a deploy after SHORT.homeDelay, on top of the usual.
test("in Manual an edit schedules no deploy; publishing it schedules one, which runs by itself; Redeploy now deploys only what's published", { timeout: 25_000 }, async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Front page", 3);
  expect((await doc.owner.publish(doc.id, { mode: "manual", versionId: "v3" })).ok).toBe(true);
  expect((await (await doc.owner.get(`/api/docs/${doc.id}/home`, { method: "POST", headers: { Origin: server.root, "Content-Type": "application/json" }, body: JSON.stringify({ isHome: true }) })).json() as { isHome: boolean }).isHome).toBe(true);
  await expect.poll(async () => (await doc.owner.home(doc.id)).deploy.state).toBe("deployed");
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  await expect.poll(() => s.text("#ds-mode")).toBe("Manual");
  doc.draft(4);
  await expect.poll(async () => (await doc.owner.versions(doc.id)).current.n, { timeout: SHORT.idle * 4 }).toBe(4); // cut once the edits pause
  await expect.poll(() => s.text("#ds-pub-current")).toBe("Publish the current version (v4)");
  expect((await doc.owner.home(doc.id)).deploy.state).toBe("deployed");
  expect(await front()).toContain("Draft 3");
  // Publish the current version: the deploy is scheduled SHORT.homeDelay later, then runs by itself.
  await s.watchStatus();
  await s.clickOn("#ds-pub-current");
  await expect.poll(() => s.text("#ds-status")).toMatch(/^Scheduled for/);
  expect(await s.text("#ds-status")).toContain("version 3");
  expect((await doc.owner.home(doc.id)).deploy.state).toBe("scheduled");
  expect(await front()).toContain("Draft 3");
  await expect.poll(() => s.text("#ds-status"), { timeout: SHORT.homeDelay * 3 }).toMatch(/^Deployed at .*version 4/); // after the delay
  expect(await front()).toContain("Draft 4");
  // Redeploy now, with an unpublished edit: the published version, at once.
  doc.draft(5);
  await expect.poll(async () => (await doc.owner.versions(doc.id)).current.n, { timeout: SHORT.idle * 4 }).toBe(5); // cut once the edits pause
  await s.watchStatus();
  await s.clickOn("#ds-redeploy");
  await expect.poll(async () => (await s.text("#ds-status")).startsWith("Deployed at") && (await s.seen()).length >= 2).toBe(true);
  expect(await s.lockedWhileDeploying()).toBe(true);
  expect(await s.text("#ds-status")).toContain("version 4");
  const now = await front();
  expect(now).toContain("Draft 4");
  expect(now).not.toContain("Draft 5");
});

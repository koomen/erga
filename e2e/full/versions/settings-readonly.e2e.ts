// Settings for someone who may only view.
import { expect, servers, test } from "../../helpers/fixtures";
import { closeDrafts, draftDoc, openDocEditor, rect, viewerShows } from "./settings";
import { runTool } from "../../helpers/tools";

await servers.short();
test.afterEach(closeDrafts);

test("someone who may only view, in an editor's tab still open: no versions, a line that says why, and nothing to press", async ({
  tab,
}) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Read notes", 5);
  // Bo, an editor while the tab opens, then only a viewer.
  await doc.owner.share(doc.id, "bo", "editor");
  const s = await openDocEditor(tab.page, server, doc.address, { user: "Bo" });
  await s.open();
  await expect.poll(() => s.listed()).toEqual([5, 4, 3, 2, 1]);
  await s.close();
  await doc.owner.share(doc.id, "bo", "viewer");
  await s.open();
  // The versions are for those who may edit: the list they had goes, and the dialog says why.
  await expect
    .poll(() => s.eval<string>(`document.getElementById("ds-hist-error").textContent`))
    .toBe("Couldn't load the versions: Only people who can edit a document read its versions.");
  expect(await s.listed()).toEqual([]);
  expect(await s.eval<boolean>(`!!document.querySelector("#ds-list .ds-restore")`)).toBe(false);
  expect(await s.eval<boolean>(`document.getElementById("ds-home").hidden`)).toBe(true);
  // Document or Project: shown, not theirs to change.
  await expect.poll(() => s.eval<number>(`document.querySelectorAll('#ds-kind [aria-disabled="true"]').length`)).toBe(2);
});

test("a viewer at the editor's address gets the viewer, with the document as it is; the API lets them read no version, and not restore or deploy", async ({
  tab,
}) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Read notes", 5);
  await doc.owner.share(doc.id, "bo", "viewer");
  await viewerShows(tab.page, server, `${doc.address}?user=Bo&edit`, "Draft 5");
  expect(await rect(tab.page, "#btn-settings")).toBeNull();
  const versions = await runTool(server.root, "versions", { document: doc.id }, { user: "Bo" });
  expect([versions.status, versions.error]).toEqual([403, "Only people who can edit a document read its versions."]);
  expect((await runTool(server.root, "restore_version", { document: doc.id, version: "v3" }, { user: "Bo" })).status).toBe(403);
  expect((await runTool(server.root, "deploy_homepage", {}, { user: "Bo" })).status).toBe(403);
});

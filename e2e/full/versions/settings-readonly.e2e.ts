// Settings for someone who may only view.
import { expect, servers, test } from "../../helpers/fixtures";
import { closeDrafts, draftDoc, openDocEditor, rect, viewerShows } from "./settings";
import { runTool } from "../../helpers/tools";

await servers.short();
test.afterEach(closeDrafts);

test("someone who may only view, in an editor's tab still open: the versions, and nothing to press", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Read notes", 5);
  // Bo, an editor while the tab opens, then only a viewer.
  await doc.owner.share(doc.id, "bo", "editor");
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address, { user: "Bo" });
  await doc.owner.share(doc.id, "bo", "viewer");
  await s.open();
  await expect.poll(() => s.listed()).toEqual([5, 4, 3, 2, 1]);
  expect(await s.eval<boolean>(`!!document.querySelector("#ds-list .ds-edit")`)).toBe(false);
  expect(await s.eval<boolean>(`document.getElementById("ds-home").hidden`)).toBe(true);
  // Document or Project: shown, not theirs to change.
  await expect.poll(() => s.eval<number>(`document.querySelectorAll('#ds-kind [aria-disabled="true"]').length`)).toBe(2);
});

test("a viewer at the editor's address gets the viewer, with the document as it is; the API lets them read, not restore or deploy", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Read notes", 5);
  await doc.owner.share(doc.id, "bo", "viewer");
  await viewerShows(tab.page, server, `${doc.address}?user=Bo&edit`, "Draft 5");
  expect(await rect(tab.page, "#btn-settings")).toBeNull();
  const state = (await runTool(server.root, "versions", { document: doc.id }, { user: "Bo" })).result as {
    canEdit: boolean;
    current: { n: number };
  };
  expect(state).toMatchObject({ canEdit: false, current: { n: 5 } });
  expect((await runTool(server.root, "restore_version", { document: doc.id, version: "v3" }, { user: "Bo" })).status).toBe(403);
  expect((await runTool(server.root, "deploy_homepage", {}, { user: "Bo" })).status).toBe(403);
});

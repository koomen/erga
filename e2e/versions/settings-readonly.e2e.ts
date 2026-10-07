// Settings for someone who may only view.
import { expect, servers, test } from "../fixtures";
import { closeDrafts, draftDoc, openDocEditor, rect, viewerShows } from "./settings";

await servers.short();
test.afterEach(closeDrafts);

test("someone who may only view, in an editor's tab still open: what's published and why they can't change it, and nothing to press", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Read notes", 5);
  expect((await doc.owner.publish(doc.id, { mode: "manual", versionId: "v4" })).ok).toBe(true);
  // Bo, an editor while the tab opens, then only a viewer.
  await doc.owner.share(doc.id, "bo", "editor");
  tab.strict = true;
  const s = await openDocEditor(tab.page, server, doc.address, { user: "Bo" });
  await doc.owner.share(doc.id, "bo", "viewer");
  await s.open();
  await expect.poll(() => s.attr("#ds-mode", "aria-disabled")).toBe("true");
  expect((await s.text("#ds-explain")).startsWith("Only the document's editors can change what's published. Viewers see version 4")).toBe(true);
  expect(await s.eval<boolean>(`!!document.querySelector("#ds-list .ds-edit")`)).toBe(false);
  expect(await s.eval<boolean>(`document.getElementById("ds-pub-current").hidden`)).toBe(true);
  expect(await s.eval<boolean>(`document.getElementById("ds-home").hidden`)).toBe(true);
  await s.clickOn("#ds-mode");
  await s.ed.settle();
  expect(await s.hasMenu()).toBe(false);
});

test("a viewer at the editor's address gets the viewer, with the published version; the API lets them read, not publish, restore or deploy", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Read notes", 5);
  expect((await doc.owner.publish(doc.id, { mode: "manual", versionId: "v4" })).ok).toBe(true);
  await doc.owner.share(doc.id, "bo", "viewer");
  await viewerShows(tab.page, server, `${doc.address}?user=Bo#edit`, "Draft 4");
  expect(await rect(tab.page, "#btn-settings")).toBeNull();
  const bo = (path: string, method = "GET") => fetch(`${server.root}${path}?user=Bo`, { method, headers: { Origin: server.root, "Content-Type": "application/json" }, body: method == "POST" ? JSON.stringify({ mode: "latest" }) : undefined });
  const state = (await (await bo(`/api/docs/${doc.id}/versions`)).json()) as { canEdit: boolean; published: { version: { n: number } } };
  expect(state.canEdit).toBe(false);
  expect(state.published.version.n).toBe(4);
  for (const path of [`/api/docs/${doc.id}/publish`, `/api/docs/${doc.id}/versions/v3/restore`, `/api/docs/${doc.id}/home`]) expect((await bo(path, "POST")).status).toBe(403);
});

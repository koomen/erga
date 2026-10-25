// Settings for someone who may only view.
import { expect, servers, test } from "../../fixtures";
import { closeDrafts, draftDoc, openDocEditor, rect, viewerShows } from "./settings";

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
  const bo = (path: string, method = "GET") => fetch(`${server.root}${path}?user=Bo`, { method, headers: { Origin: server.root, "Content-Type": "application/json" }, body: method == "POST" ? JSON.stringify({ mode: "latest" }) : undefined });
  const state = (await (await bo(`/api/docs/${doc.id}/versions`)).json()) as { canEdit: boolean; current: { n: number } };
  expect(state).toMatchObject({ canEdit: false, current: { n: 5 } });
  for (const path of [`/api/docs/${doc.id}/versions/v3/restore`, `/api/docs/${doc.id}/home/deploy`]) expect((await bo(path, "POST")).status).toBe(403);
});

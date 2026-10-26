// What viewers see: the document as it is now, always. There's no publishing.
import { expect, servers, test } from "../../helpers/fixtures";
import { cut, intoHeading, person, someone, type Get } from "./versions";
import { framed, pagesFetch } from "../../helpers/pages-fetch";

await servers.short();

/** A document of the owner's with version v2 ("alpha"), and someone else who may view it. */
async function shared() {
  const server = await servers.short();
  const owner = await person(server, someone("v"));
  const viewer = await person(server, someone("vb"));
  const { id } = await owner.newDoc();
  const ada = await owner.join(id);
  await cut(owner, id, ada, intoHeading(" alpha"));
  expect((await owner.share(id, viewer.login, "viewer")).ok).toBe(true);
  return { server, owner, viewer, id, ada };
}

/** What the viewer's page shows `who` (the page on the document's origin, as its frame has it), each time afresh; and a file of its. */
function viewerOf(who: Get, id: string) {
  const src = async () => /<iframe id="frame"[^>]* src="([^"]+)"/.exec(await (await who(`/d/${id}`, { redirect: "follow" })).text())![1].replace(/&amp;/g, "&");
  return {
    text: async () => (await framed(await src())).text(),
    file: async (path: string) => (await pagesFetch(new URL(path, await src()).href)).text(),
  };
}

test("viewers see edits up to the keystroke, before any version is cut, in the page and its files; a viewer's copy is the document as it is", async () => {
  const { owner, viewer, id, ada } = await shared();
  try {
    ada.edit(intoHeading(" live-now"));
    const theirs = viewerOf(viewer.get, id);
    await expect.poll(() => theirs.text(), { timeout: 2_000 }).toContain("live-now");
    expect(await theirs.file("index.html")).toContain("live-now");
    expect((await owner.versions(id)).pending).toBe(true);
    const copy = (await viewer.get(`/new?from=${id}`)).headers.get("location")!.replace(/(\/edit|[?&]edit)$/, "");
    expect(await (await viewer.get(`${copy}/doc/index.html`)).text()).toContain("live-now");
  } finally { ada.disconnect(); }
});

test("the viewer in a browser shows the document as it is", async ({ tab }) => {
  const { server, viewer, id, ada } = await shared();
  ada.disconnect();
  await tab.page.goto(`${server.root}/auth/github?as=${viewer.login}&next=${encodeURIComponent(`/d/${id}`)}`);
  const view = tab.page.frameLocator("#frame").locator("h1");
  await expect.poll(() => view.textContent({ timeout: 1_000 }).catch(() => "")).toContain("alpha");
});

test("viewers may list the versions, not restore one; there's no publishing to ask for, and a bad token gets nothing", async () => {
  const { server, owner, viewer, id, ada } = await shared();
  ada.disconnect();
  const theirs = await viewer.versions(id);
  expect(theirs).toMatchObject({ total: 2, canEdit: false });
  expect(theirs).not.toHaveProperty("published");
  expect((await viewer.restore(id, "v1")).status).toBe(403);
  const publish = await owner.get(`/api/docs/${id}/publish`, { method: "POST", headers: { Origin: server.root, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "manual", versionId: "v1" }) });
  expect(publish.status).toBe(404);
  expect((await owner.get(`/d/${id}/pub/index.html`)).status).toBe(404);
  expect((await fetch(`${server.root}/api/docs/${id}/versions`, { headers: { Authorization: "Bearer erga_forged" } })).status).toBe(401);
});

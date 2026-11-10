// What viewers see: the document as it is now, always. There's no publishing.
import { expect, servers, test } from "../../helpers/fixtures";
import { cut, intoHeading, person, someone, tools, type Get } from "./versions";
import { framed, pagesFetch } from "../../helpers/pages-fetch";
import { runTool } from "../../helpers/tools";

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
  // The frame's address, as the page makes it from its metas (ergaFrames.src(), client/inline/viewer-frames.ts).
  const src = async () => {
    const html = await (await who(`/d/${id}`, { redirect: "follow" })).text();
    const meta = (name: string) => new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html)?.[1].replace(/&amp;/g, "&") ?? "";
    return meta("erga-pages") + meta("erga-page").split("/").map(encodeURIComponent).join("/");
  };
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

test("only people who can edit read the versions: a viewer lists none, reads no old file, sees no diff, restores none; a bad token gets nothing", async () => {
  const { server, owner, viewer, id, ada } = await shared();
  ada.disconnect();
  // The owner removed " alpha" again: the text is only in the old version now.
  const bea = await owner.join(id);
  await cut(owner, id, bea, (t) => t.delete(t.toString().indexOf(" alpha"), " alpha".length));
  bea.disconnect();
  // Each as their agent does (a token): the document's own tools need one.
  const asOwner = tools(server, await owner.token("Owner's agent"), id);
  const asViewer = tools(server, await viewer.token("Viewer's agent"), id);
  const ONLY = "Only people who can edit a document read its versions.";
  // The owner reads all of it.
  expect((await owner.versions(id)).total).toBe(3);
  expect((await asOwner("read", { path: "index.html", version: "v2" })).text).toContain("alpha");
  expect((await asOwner("versions", { from: "v2", to: "v3" })).text).toContain("alpha");
  // The viewer reads the document as it is, and nothing of before: in the page (a session) and as their agent.
  const now = (await asViewer("read", { path: "index.html" })).text;
  expect(now).toContain("<h1>");
  expect(now).not.toContain("alpha");
  const page = await runTool(server.root, "versions", { document: id }, { cookie: viewer.cookie, origin: server.root });
  expect([page.status, page.error]).toEqual([403, ONLY]);
  for (const [tool, args] of [
    ["versions", {}],
    ["versions", { from: "v2", to: "v3" }],
    ["versions", { from: "v2" }],
    ["read", { path: "index.html", version: "v2" }],
  ] as const) {
    const r = await asViewer(tool, args);
    expect([tool, r.ok, r.text]).toEqual([tool, false, ONLY]);
  }
  expect((await viewer.restore(id, "v1")).status).toBe(403);
  const publish = await owner.get(`/api/docs/${id}/publish`, { method: "POST", headers: { Origin: server.root, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "manual", versionId: "v1" }) });
  expect(publish.status).toBe(404);
  expect((await owner.get(`/d/${id}/pub/index.html`)).status).toBe(404);
  expect(
    (
      await fetch(`${server.root}/api/tools/versions`, {
        method: "POST",
        headers: { Authorization: "Bearer erga_forged", "Content-Type": "application/json" },
        body: JSON.stringify({ document: id }),
      })
    ).status
  ).toBe(401);
});

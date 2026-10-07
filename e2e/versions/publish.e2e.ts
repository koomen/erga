// Who may publish, and what viewers see in "manual" and "latest" (tests/versions.ts).
import { expect, servers, test } from "../fixtures";
import { cut, events, intoHeading, pagesFetch, person, someone, type Get } from "./versions";

await servers.short();

/** A document of the owner's with versions v2 ("alpha") and v3 ("beta"), and someone else who may view it. */
async function twoVersions() {
  const server = await servers.short();
  const owner = await person(server, someone("v"));
  const viewer = await person(server, someone("vb"));
  const { id, address } = await owner.newDoc();
  const ada = await owner.join(id);
  await cut(owner, id, ada, intoHeading(" alpha"));
  await cut(owner, id, ada, intoHeading(" beta"));
  expect((await owner.share(id, viewer.login, "viewer")).ok).toBe(true);
  return { server, owner, viewer, id, address, ada };
}

/** The viewer's frame and what it shows, as the viewer's page links them, for `who`. */
async function viewerOf(who: Get, id: string) {
  const html = await (await who(`/d/${id}`, { redirect: "follow" })).text();
  const frame = /<iframe id="frame"[^>]* (?:data-)?src="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
  const hostPage = await (await pagesFetch(frame)).text();
  const shown = new URL(/<iframe id="view"[^>]* src="([^"]+)"/.exec(hostPage)![1], frame).href;
  return { shown, docUrl: shown.replace("/pub/", "/doc/"), text: async (u = shown) => (await pagesFetch(u)).text() };
}

test("only editors may publish (viewers may list), only from this site's pages; a missing version or a bad token gets nothing", async () => {
  const { server, owner, viewer, id, ada } = await twoVersions();
  ada.disconnect();
  const theirs = await viewer.versions(id);
  expect(theirs.total).toBe(3);
  expect(theirs.canEdit).toBe(false);
  expect((await viewer.publish(id, { mode: "manual", versionId: "v1" })).status).toBe(403);
  expect((await owner.publish(id, { mode: "manual", versionId: "v1" }, {})).status).toBe(403);
  expect((await owner.publish(id, { mode: "manual", versionId: "v99" })).status).toBe(404);
  expect((await fetch(`${server.root}/api/docs/${id}/versions`, { headers: { Authorization: "Bearer erga_forged" } })).status).toBe(401);
});

test("manual: viewers see the published version in every file, and copy it; editors edit the draft; open tabs hear of the publish", async () => {
  const { server, owner, viewer, id, ada } = await twoVersions();
  try {
    const heard = await events(server, id, owner.cookie);
    const pub = await owner.publish(id, { mode: "manual", versionId: "v2" });
    expect(pub.ok).toBe(true);
    expect(((await pub.json()) as { published: { mode: string; version: { id: string } } }).published).toMatchObject({ mode: "manual", version: { id: "v2" } });
    await expect.poll(() => heard.of("versions").length).toBeGreaterThan(0);
    heard.close();
    ada.edit(intoHeading(" draft"));
    await expect.poll(async () => (await owner.get(`/d/${id}/doc/index.html`)).text()).toContain("draft");
    const mine = await viewerOf(owner.get, id);
    expect(mine.shown).toContain("/pub/");
    const shown = await mine.text();
    expect(shown).toContain("alpha");
    expect(shown).not.toContain("beta");
    expect(await mine.text(mine.docUrl)).toContain("draft");
    const theirs = await viewerOf(viewer.get, id);
    const theirDoc = await theirs.text(theirs.docUrl);
    expect(theirDoc).toContain("alpha");
    expect(theirDoc).not.toContain("beta");
    expect(theirDoc).not.toContain("draft");
    expect((await owner.versions(id)).published.version.id).toBe("v2");
    // A viewer's Clone copies what they see.
    const copy = (await viewer.get(`/new?from=${id}`)).headers.get("location")!.replace(/(\/edit|#edit)$/, "");
    const copied = await (await viewer.get(`${copy}/doc/index.html`)).text();
    expect(copied).toContain("alpha");
    expect(copied).not.toContain("draft");
  } finally { ada.disconnect(); }
});

test("the viewer in a browser shows the published version", async ({ tab }) => {
  const { server, viewer, owner, id, ada } = await twoVersions();
  ada.disconnect();
  expect((await owner.publish(id, { mode: "manual", versionId: "v2" })).ok).toBe(true);
  await tab.page.goto(`${server.root}/auth/github?as=${viewer.login}&next=${encodeURIComponent(`/d/${id}`)}`);
  const view = tab.page.frameLocator("#frame").frameLocator("#view").locator("h1");
  await expect.poll(() => view.textContent({ timeout: 1_000 }).catch(() => "")).toContain("alpha");
  expect(await view.textContent()).not.toContain("beta");
});

test("latest: viewers see edits up to the keystroke, before any version is cut", async () => {
  const { owner, id, ada } = await twoVersions();
  try {
    expect((await owner.publish(id, { mode: "manual", versionId: "v2" })).ok).toBe(true);
    const mine = await viewerOf(owner.get, id);
    expect((await owner.publish(id, { mode: "latest" })).ok).toBe(true);
    ada.edit(intoHeading(" live-now"));
    await expect.poll(() => mine.text(), { timeout: 2_000 }).toContain("live-now");
    expect((await owner.versions(id)).pending).toBe(true);
  } finally { ada.disconnect(); }
});

test("publishing the current version, with edits pending, cuts them first and publishes them", async () => {
  const { owner, id, ada } = await twoVersions();
  try {
    expect((await owner.publish(id, { mode: "manual", versionId: "v2" })).ok).toBe(true);
    const mine = await viewerOf(owner.get, id);
    ada.edit(intoHeading(" pending-publish"));
    await expect.poll(async () => (await owner.versions(id)).pending).toBe(true);
    const cur = (await owner.versions(id)).current;
    const pc = await owner.publish(id, { mode: "manual", versionId: cur.id });
    const body = (await pc.json()) as { published: { version: { id: string } } };
    const s = await owner.versions(id);
    expect(pc.ok).toBe(true);
    expect(s.current.n).toBe(cur.n + 1);
    expect(body.published.version.id).toBe(s.current.id);
    expect(s.pending).toBe(false);
    expect(await mine.text()).toContain("pending-publish");
  } finally { ada.disconnect(); }
});

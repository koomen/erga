// A new document's first version, and a burst of edits as one version (tests/versions.ts).
import { expect, servers, SHORT, test } from "../fixtures";
import { events, person, someone } from "./versions";

await servers.short();

test("a new document starts with version 1, published as \"latest\"", async () => {
  const owner = await person(await servers.short(), someone("v"));
  const { id } = await owner.newDoc();
  const s = await owner.versions(id);
  expect(s).toMatchObject({ total: 1, canEdit: true, current: { id: "v1", description: "First version" }, published: { mode: "latest", version: { id: "v1" } } });
  expect(s.current.authors).toContain(owner.login);
});

test("a burst of edits is one version, cut when the edits pause, with its description; open tabs hear of both", async () => {
  const server = await servers.short();
  const owner = await person(server, someone("v"));
  const { id } = await owner.newDoc();
  const heard = await events(server, id, owner.cookie);
  const ada = await owner.join(id);
  try {
    const t0 = Date.now();
    // Quicker than the pause: each edit puts the cut off again.
    for (let i = 0; i < 6; i++) {
      ada.edit((t) => t.insert(t.toString().indexOf("</h1>"), ` burst${i}`));
      await new Promise((r) => setTimeout(r, SHORT.idle / 8)); // the burst's pace is what's tested: an edit every idle/8
    }
    expect((await owner.versions(id)).total).toBe(1);
    await expect.poll(async () => (await owner.versions(id)).total).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SHORT.idle);
    const s = await owner.versions(id);
    expect(s.current.authors).toHaveLength(1);
    expect(s.pending).toBe(false);
    await expect.poll(async () => (await owner.versions(id)).current.description).toBe("Edited index.html");
    await expect.poll(() => heard.of("versions").length).toBeGreaterThanOrEqual(2);
  } finally { ada.disconnect(); heard.close(); }
});

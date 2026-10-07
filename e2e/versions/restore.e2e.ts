// Restoring a version: a new current version, live in open editors (tests/versions.ts).
import { expect, servers, test } from "../fixtures";
import { cut, intoHeading, person, someone, tools } from "./versions";

await servers.short();

/** A document with v2 ("alpha") and v3 ("beta"), published manually at v3, and someone in its room. */
async function setup() {
  const server = await servers.short();
  const owner = await person(server, someone("v"));
  const { id } = await owner.newDoc();
  const ada = await owner.join(id);
  await cut(owner, id, ada, intoHeading(" alpha"));
  await cut(owner, id, ada, intoHeading(" beta"));
  expect((await owner.publish(id, { mode: "manual", versionId: "v3" })).ok).toBe(true);
  return { server, owner, id, ada, tool: tools(server, await owner.token("versions test"), id) };
}

test("restoring a version: a new current version by the person, live in open editors, the published one unchanged; only for editors", async () => {
  const { server, owner, id, ada, tool } = await setup();
  try {
    const viewer = await person(server, someone("vb"));
    await owner.share(id, viewer.login, "viewer");
    expect((await viewer.restore(id, "v2")).status).toBe(403);
    expect((await owner.restore(id, "v99")).status).toBe(404);
    const rs = await owner.restore(id, "v2");
    const body = (await rs.json()) as { current: { id: string; n: number; description: string; authors: string[] } };
    expect(rs.ok).toBe(true);
    expect(body.current).toMatchObject({ n: 4, description: "Restored version 2", authors: [owner.login] });
    const s = await owner.versions(id);
    expect(s.current.id).toBe(body.current.id);
    const v2 = (await tool("read_version", { version: "v2", path: "index.html" })).text;
    await expect.poll(() => ada.str()).toBe(v2);
    expect(s.published).toMatchObject({ mode: "manual", version: { id: "v3" } });
  } finally { ada.disconnect(); }
});

test("restore_version, by the agent, is attributed to the person via their agent", async () => {
  const { owner, id, ada, tool } = await setup();
  try {
    const t = await tool("restore_version", { version: "v1" });
    expect(t.status).toBe(200);
    const s = await owner.versions(id);
    expect(s.current.description).toBe("Restored version 1");
    expect(s.current.authors).toContain(`${owner.login}, via a shared agent (versions test)`);
  } finally { ada.disconnect(); }
});

test("restoring one file: the others stay, the answer has its text and the new version, and an edit lands right after", async () => {
  const { owner, id, ada, tool } = await setup();
  try {
    expect((await tool("write", { path: "notes.md", content: "# Notes\n\nnotes-one\n" })).status).toBe(200);
    expect((await owner.publish(id, { mode: "manual" })).ok).toBe(true);
    const withNotes = (await owner.versions(id)).current;
    await tool("write", { path: "notes.md", content: "# Notes\n\nnotes-two\n" });
    ada.edit(intoHeading(" keeps"));
    await expect.poll(() => ada.str()).toContain("keeps");
    let t = await tool("restore_version", { version: withNotes.id, path: "notes.md" });
    const s = await owner.versions(id);
    expect(t.status).toBe(200);
    expect(s.current.description).toBe(`Restored notes.md from version ${withNotes.n}`);
    expect(t.text).toContain(`current version is now ${s.current.id}`);
    expect(t.text).toContain("notes-one");
    expect(t.text).not.toContain("notes-two");
    // The restore of notes.md has reached the room by now (its answer comes after): index.html kept the edit.
    expect((await tool("read", { path: "index.html" })).text).toContain("keeps");
    expect(ada.str()).toContain("keeps");
    t = await tool("edit", { path: "notes.md", edits: [{ oldText: "notes-one", newText: "notes-one-edited" }] });
    expect(t.status).toBe(200);
    expect((await tool("read", { path: "notes.md" })).text).toContain("notes-one-edited");
    t = await tool("restore_version", { version: withNotes.id, path: "nope.html" });
    expect(t.status).not.toBe(200);
    expect(t.text).toContain("has no file nope.html");
    const one = await owner.restore(id, withNotes.id, { path: "notes.md" });
    const oneBody = (await one.json()) as { current: { description: string }; files: string[]; from: string };
    expect(one.ok).toBe(true);
    expect(oneBody).toMatchObject({ files: ["notes.md"], from: withNotes.id, current: { description: `Restored notes.md from version ${withNotes.n}` } });
  } finally { ada.disconnect(); }
});

test("an edit against text a restore replaced says the file changed since, by which restore, and the current version", async () => {
  const { owner, id, ada, tool } = await setup();
  try {
    ada.edit(intoHeading(" keeps"));
    await expect.poll(async () => (await tool("read", { path: "index.html" })).text).toContain("keeps");
    const back = (await (await owner.restore(id, "v2")).json()) as { current: { id: string } };
    await expect.poll(() => ada.str().includes("keeps")).toBe(false);
    const t = await tool("edit", { path: "index.html", edits: [{ oldText: "keeps", newText: "changed" }] });
    expect(t.status).not.toBe(200);
    expect(t.text).toContain("the file changed since the text your edit was based on");
    expect(t.text).toContain(`restored since: ${back.current.id}, "Restored version 2", by ${owner.login}`);
    expect(t.text).toContain(`The current version is ${back.current.id}`);
    expect(t.text).not.toContain("someone could be editing");
  } finally { ada.disconnect(); }
});

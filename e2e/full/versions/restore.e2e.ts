// Restoring a version: a new current version, live in open editors.
import { expect, servers, test } from "../../helpers/fixtures";
import { cut, intoHeading, person, someone, tools } from "./versions";

await servers.short();

/** A document with v2 ("alpha") and v3 ("beta"), and someone in its room. */
async function setup() {
  const server = await servers.short();
  const owner = await person(server, someone("v"));
  const { id } = await owner.newDoc();
  const ada = await owner.join(id);
  await cut(owner, id, ada, intoHeading(" alpha"));
  await cut(owner, id, ada, intoHeading(" beta"));
  return { server, owner, id, ada, tool: tools(server, await owner.token("versions test"), id) };
}

test("restoring a version: a new current version by the person, live in open editors and for viewers; only for editors", async () => {
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
    await expect.poll(async () => (await viewer.get(`/d/${id}`, { redirect: "follow" })).text()).toContain("alpha");
    expect(await (await viewer.get(`/d/${id}`, { redirect: "follow" })).text()).not.toContain("beta");
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

test("restoring one file: the others stay, the answer has the new version, and an edit lands right after", async () => {
  const { owner, id, ada, tool } = await setup();
  try {
    const before = (await owner.versions(id)).total;
    expect((await tool("write", { path: "notes.md", content: "# Notes\n\nnotes-one\n" })).status).toBe(200);
    // An external agent's calls are one turn: a version 8 seconds after its last.
    await expect.poll(async () => (await owner.versions(id)).total, { timeout: 15_000 }).toBe(before + 1);
    const withNotes = (await owner.versions(id)).current;
    await tool("write", { path: "notes.md", content: "# Notes\n\nnotes-two\n" });
    ada.edit(intoHeading(" keeps"));
    await expect.poll(() => ada.str()).toContain("keeps");
    let t = await tool("restore_version", { version: withNotes.id, path: "notes.md" });
    const s = await owner.versions(id);
    expect(t.status).toBe(200);
    expect(s.current.description).toBe(`Restored notes.md from version ${withNotes.n}`);
    expect(JSON.parse(t.text)).toMatchObject({ current: { id: s.current.id }, files: ["notes.md"] });
    const read = (await tool("read", { path: "notes.md" })).text;
    expect(read).toContain("notes-one");
    expect(read).not.toContain("notes-two");
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

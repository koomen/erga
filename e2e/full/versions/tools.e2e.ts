// The agent's version tools, over the server's API with an agent token.
import { expect, servers, test } from "../../fixtures";
import { cut, intoHeading, person, scripted, someone, tools } from "./versions";

await servers.short();

test("diff_versions: since the agent's last turn by default, between two versions, for one file, and nothing changed", async () => {
  const server = await servers.short();
  const owner = await person(server, someone("v"));
  const { id } = await owner.newDoc();
  const ada = await owner.join(id);
  try {
    await cut(owner, id, ada, intoHeading(" alpha"));
    expect((await scripted(owner, id, [{ tool: "edit", args: { path: "index.html", edits: [{ oldText: "</h1>", newText: " agent-done</h1>" }] } }, { text: "Done." }])).ok).toBe(true);
    await expect.poll(async () => ada.str().includes("agent-done") && (await owner.versions(id)).total == 3).toBe(true);
    const turn = (await owner.versions(id)).current;
    ada.edit(intoHeading(" live-now"));
    await expect.poll(async () => (await owner.versions(id)).pending).toBe(true);
    const tool = tools(server, await owner.token("versions test"), id);
    let t = await tool("diff_versions", {});
    expect(t.status).toBe(200);
    expect(t.text.startsWith(`From ${turn.id} (where your last turn ended) to current`)).toBe(true);
    expect(t.text).toContain("--- a/index.html\n+++ b/index.html\n@@ ");
    expect(t.text).toMatch(/^\+.*live-now/m);
    expect(t.text).toMatch(/^-.*agent-done/m);
    t = await tool("diff_versions", { from: "v1", to: "v2", path: "index.html", context: 0 });
    expect(t.status).toBe(200);
    expect(t.text.startsWith("From v1 to v2 in index.html: 1 file(s) differ")).toBe(true);
    expect(t.text).toMatch(/^\+.*alpha/m);
    expect(t.text).not.toContain("agent-done");
    t = await tool("diff_versions", { from: "v2", to: "2" });
    expect(t).toMatchObject({ status: 200, text: "No changes from v2 to v2." });
    t = await tool("diff_versions", { from: "v99" });
    expect(t.status).not.toBe(200);
    expect(t.text).toContain('no version "v99"');
  } finally { ada.disconnect(); }
});

test("list_versions and read_version; there's no publish_version", async () => {
  const server = await servers.short();
  const owner = await person(server, someone("v"));
  const { id } = await owner.newDoc();
  const ada = await owner.join(id);
  try {
    await cut(owner, id, ada, intoHeading(" alpha"));
    await cut(owner, id, ada, intoHeading(" beta"));
    await expect.poll(async () => (await owner.versions(id)).versions.find((v) => v.n == 2)?.description).toBe("Edited index.html");
    const token = await owner.token("versions test");
    const tool = tools(server, token, id);
    let t = await tool("list_versions", {});
    expect(t.status).toBe(200);
    for (const s of ["Current: v3", "v2", "Edited index.html"]) expect(t.text).toContain(s);
    expect(t.text).not.toContain("Published");
    t = await tool("read_version", { version: "v1" });
    expect(t.status).toBe(200);
    expect(t.text).toContain("index.html");
    t = await tool("read_version", { version: "v2", path: "index.html" });
    expect(t.text).toContain("alpha");
    expect(t.text).not.toContain("beta");
    t = await tool("publish_version", { mode: "manual", version: "v3" });
    expect(t.status).not.toBe(200);
    const listed = (await (await fetch(`${server.root}/api/ext/tools`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { tools: { name: string }[] };
    expect(listed.tools.map((x) => x.name)).toContain("restore_version");
    expect(listed.tools.map((x) => x.name)).not.toContain("publish_version");
  } finally { ada.disconnect(); }
});

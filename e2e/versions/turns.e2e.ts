// What cuts a version besides a pause: an agent's turn, the last editor leaving; and paging the list (tests/versions.ts).
import { expect, servers, SHORT, test } from "../fixtures";
import { cut, intoHeading, person, scripted, someone } from "./versions";

test.beforeAll(async () => { await servers.short(); });

test("an agent's turn is one version, attributed to the agent, though it pauses longer than the idle time", async () => {
  const owner = await person(await servers.short(), someone("v"));
  const { id } = await owner.newDoc();
  const ada = await owner.join(id);
  try {
    const before = (await owner.versions(id)).total;
    const sent = await scripted(owner, id, [
      { tool: "edit", args: { path: "index.html", edits: [{ oldText: "</h1>", newText: " agent-one</h1>" }] } },
      { delay: SHORT.idle * 1.6, tool: "edit", args: { path: "index.html", edits: [{ oldText: "</h1>", newText: " agent-two</h1>" }] } },
      { text: "Done." },
    ]);
    expect(sent.ok).toBe(true);
    // A cut in the pause would have come idle after agent-one, before the turn ends: so one version at its end is one for the turn.
    await expect.poll(async () => ada.str().includes("agent-two") && (await owner.versions(id)).total > before, { timeout: SHORT.idle * 5 }).toBe(true); // the turn has a pause of 1.6 idle in it
    const s = await owner.versions(id);
    expect(s.total).toBe(before + 1);
    expect(s.current.authors.some((a) => a.endsWith("agent"))).toBe(true);
  } finally { ada.disconnect(); }
});

test("versions list newest first, paging back with before= and limit=", async () => {
  const owner = await person(await servers.short(), someone("v"));
  const { id } = await owner.newDoc();
  const ada = await owner.join(id);
  try {
    for (const w of [" one", " two", " three"]) await cut(owner, id, ada, intoHeading(w));
    const all = await owner.versions(id);
    expect(all.versions.map((v) => v.n)).toEqual([4, 3, 2, 1]);
    const page = await owner.versions(id, "?limit=1&before=v4");
    expect(page.versions.map((v) => v.n)).toEqual([3]);
    expect(page.total).toBe(4);
  } finally { ada.disconnect(); }
});

test("the last editor leaving cuts a version at once, without waiting for the pause", async () => {
  const owner = await person(await servers.short(), someone("v"));
  const { id } = await owner.newDoc();
  const ada = await owner.join(id);
  ada.edit(intoHeading(" leaving"));
  await expect.poll(async () => (await owner.versions(id)).pending).toBe(true);
  const left = Date.now();
  ada.disconnect();
  await expect.poll(async () => (await owner.versions(id)).total, { timeout: SHORT.idle * 0.9 }).toBe(2); // before the pause would cut it
  expect(Date.now() - left).toBeLessThan(SHORT.idle);
});

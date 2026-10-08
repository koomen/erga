// Titles and addresses (front.ts, directory.ts, worker/doc-host.ts): what counts as an edit, the
// title that follows the page's heading and the slug that follows the title until they're set, old addresses that
// redirect, the agent's get_title and set_title, and open tabs following a rename.
import { expect, test, until } from "../../fixtures";
import { person, retitle, servers, tools, type Person } from "./front";

await servers.script();

/** Whether a document's row on the list is marked unedited. */
const unedited = async (p: Person, id: string) => p.row(id, await p.docs()).includes("Unedited");
/** When the directory last heard the document was edited (list_documents' `modified`): its row's sync after an edit. */
async function modifiedOf(p: Person, token: string, id: string): Promise<string | null> {
  const docs = (await tools(p.base, token).call("list_documents")).data as { id: string; modified: string | null }[];
  return docs.find((d) => d.id == id)?.modified ?? null;
}

test("opening a document, being in its room and moving a caret don't count as editing it", async () => {
  const p = await person(await servers.script());
  const [id, control] = [await p.make(), await p.make()];
  for (const who of ["Ada", "Bo"]) for (const doc of [id, control]) await p.share(doc, who, "editor");
  expect(await p.exists(id)).toBe(true);
  const ada = await p.join(id), bo = await p.join(id, "Bo"), other = await p.join(control);
  try {
    ada.setCursor(10);
    await until(() => [...bo.provider.awareness.getStates().values()].some((s) => s.user?.name == "Ada" && s.cursor), 5000, "Bo sees Ada's caret");
    // An edit to another document, made after: once its mark goes, the caret's would have too, had it been an edit.
    other.insertAfter("<p>", "An edit. ");
    await until(async () => !(await unedited(p, control)), 10_000, "the other document's mark goes");
    expect(await unedited(p, id)).toBe(true);
  } finally { for (const x of [ada, bo, other]) x.destroy(); }
});

test("an edit retitles the document after its heading; its slug follows; the list links to the new address and stops saying unedited; the old address redirects, and requests under it still reach it", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  await p.share(id, "Ada", "editor");
  const ada = await p.join(id);
  try {
    retitle(ada, "Untitled", "Field &amp; notes");
    await expect.poll(() => p.docs()).toContain(">Field &amp; notes<");
    await expect.poll(async () => (await p.nameOf(id)).slug).toBe("field-notes");
    expect(await p.docs()).toContain(`href="/${p.login}/field-notes#edit"`);
    // The title and the edit's time are recorded separately, so the mark can go a moment after the title changes.
    await expect.poll(() => unedited(p, id)).toBe(false);
    expect(await p.location(`/${p.login}/untitled`)).toBe(`/${p.login}/field-notes`);
    expect((await p.get(`/${p.login}/untitled/api/doc`)).ok).toBe(true);
  } finally { ada.destroy(); }
});

test("a set title stays put when the heading changes, and a following slug moves with it; a set slug stays when the title changes; an empty title follows the heading again; every old address redirects", async () => {
  const p = await person(await servers.script());
  const token = await p.token();
  const id = await p.make();
  await p.share(id, "Ada", "editor");
  const ada = await p.join(id);
  try {
    retitle(ada, "Untitled", "Field notes");
    await expect.poll(async () => (await p.nameOf(id)).slug).toBe("field-notes");
    let r = await p.rename(id, { title: "Launch plan" });
    expect(r.ok).toBe(true);
    expect(await r.json()).toMatchObject({ title: "Launch plan", titleSet: true, slug: "launch-plan", slugSet: false });
    const before = await modifiedOf(p, token, id);
    retitle(ada, "Field notes", "Something else");
    // The directory has read the page since the heading changed: a title that followed it would have changed.
    await until(async () => (await modifiedOf(p, token, id)) != before, 10_000, "the document's row synced after the edit");
    expect((await p.nameOf(id)).title).toBe("Launch plan");
    r = await p.rename(id, { slug: "Q4 Launch!" });
    expect(await r.json()).toMatchObject({ slug: "q4-launch", slugSet: true });
    await p.rename(id, { title: "Launch plan, final" });
    expect((await p.nameOf(id)).slug).toBe("q4-launch");
    for (const old of ["untitled", "field-notes", "launch-plan"]) expect(await p.location(`/${p.login}/${old}`), old).toBe(`/${p.login}/q4-launch`);
    expect(await (await p.rename(id, { title: "" })).json()).toMatchObject({ title: "Something else", titleSet: false, slug: "q4-launch" });
  } finally { ada.destroy(); }
});

test("a slug another of your documents has, or a reserved one, is refused, saying why; one a document only used to have can be taken, its old address going to the new owner", async () => {
  const p = await person(await servers.script());
  const [a, b] = [await p.make(), await p.make()];
  await p.rename(a, { slug: "field-notes" });
  await p.rename(a, { slug: "q4-launch" });
  let r = await p.rename(b, { slug: "q4-launch" });
  expect(r.status).toBe(409);
  expect(((await r.json()) as { error?: string }).error).toContain("already");
  r = await p.rename(b, { slug: "docs" });
  expect(r.status).toBe(409);
  expect(((await r.json()) as { error?: string }).error).toContain("reserved");
  r = await p.rename(b, { slug: "field-notes" });
  expect(r.ok).toBe(true);
  expect(await p.location(`/${p.login}/field-notes`)).toBe("(200)");
});

test("the list shows a renamed document at its new address", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  expect((await p.rename(id, { title: "Demo copy", slug: "my-demo" })).ok).toBe(true);
  expect(await p.docs()).toContain(`href="/${p.login}/my-demo#edit"`);
});

test("the agent's get_title and set_title, over /api/ext with the share button's token: the guide lists them; set_title renames (an empty slug follows the title) and is refused a taken slug; the API under the old /<owner>/<id> still answers", async () => {
  const p = await person(await servers.script());
  const [taken, id] = [await p.make(), await p.make()];
  await p.rename(taken, { slug: "q4-launch" });
  await p.rename(id, { title: "Demo copy", slug: "my-demo" });
  const { token } = (await (await p.get(`/d/${id}/api/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as { token: string };
  const tool = async (name: string, args: unknown) => {
    const res = await fetch(`${p.base}/d/${id}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    const body = (await res.json()) as { content?: { text?: string }[]; error?: string };
    return { status: res.status, text: body.content?.map((c) => c.text ?? "").join("") ?? body.error ?? "" };
  };
  const guide = await (await fetch(`${p.base}/d/${id}/api/ext`, { headers: { Authorization: `Bearer ${token}` } })).text();
  expect(guide).toContain("set_title");
  expect(guide).toContain(`/d/${id}/api/ext`);
  let t = await tool("get_title", {});
  expect(t.status).toBe(200);
  expect(t.text).toContain("Title: Demo copy");
  expect(t.text).toContain(`/${p.login}/my-demo`);
  t = await tool("set_title", { title: "Agent's pick", slug: "" });
  expect(t.status).toBe(200);
  expect(await p.nameOf(id)).toMatchObject({ title: "Agent's pick", slug: "agents-pick", slugSet: false });
  t = await tool("set_title", { slug: "q4-launch" });
  expect(t.status).toBe(400);
  expect(t.text).toContain("already");
  // Share links from before the directory used /<owner>/<id>.
  expect((await fetch(`${p.base}/${p.login}/${id}/api/ext/tools`, { headers: { Authorization: `Bearer ${token}` } })).ok).toBe(true);
});

test("open tabs follow a rename, by anyone or by an edit to the heading: the address bar and the title, without reloading", async ({ tab }) => {
  const p = await person(await servers.script());
  const id = await p.make();
  await p.rename(id, { title: "Agent's pick" });
  const page = tab.page;
  // (The fragment survives the redirects: the browser keeps it.)
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=${encodeURIComponent(`/${p.login}/agents-pick`)}#edit`);
  await expect.poll(() => page.evaluate(`document.getElementById("doc-title-text")?.textContent ?? ""`), { timeout: 10_000 }).toBe("Agent's pick");
  await page.evaluate(`window.__sameTab = true`);
  await p.rename(id, { title: "Renamed elsewhere" });
  await expect.poll(() => page.evaluate("location.pathname")).toBe(`/${p.login}/renamed-elsewhere`);
  expect(await page.evaluate("document.title") as string).toBe("Renamed elsewhere");
  expect(await page.evaluate(`document.getElementById("doc-title-text").textContent`) as string).toBe("Renamed elsewhere");
  expect(await page.evaluate(`window.__sameTab === true`) as boolean).toBe(true);
  // A title following the heading moves the tab too.
  await p.rename(id, { title: "", slug: "" });
  await p.share(id, "Bo", "editor");
  const bo = await p.join(id, "Bo");
  try {
    const heading = /<h1[^>]*>([^<]*)<\/h1>/.exec(bo.text()?.toString() ?? "")?.[1] ?? "";
    bo.edit((y) => { const s = y.toString(), i = s.indexOf(heading, s.indexOf("<h1")); y.delete(i, heading.length); y.insert(i, "Heading moves tabs"); });
    await expect.poll(() => page.evaluate("location.pathname"), { timeout: 8000 }).toBe(`/${p.login}/heading-moves-tabs`);
    expect(await page.evaluate(`window.__sameTab === true`) as boolean).toBe(true);
  } finally { bo.destroy(); }
});

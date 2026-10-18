// The file tree's API: making, refusing, moving and deleting, and the events open editors hear.
import { expect, servers, test } from "../../fixtures";
import { events } from "../versions/versions";
import { paths, site } from "./tree";

await servers.short();

test("new folders and pages (from the template), listed with their titles; every change an event to open editors", async () => {
  const server = await servers.short();
  const s = await site(server);
  const t = await s.readTree();
  expect(t.status).toBe(200);
  expect(t.body.canEdit).toBe(true);
  expect(paths(t.body.entries)).toBe("index.html style.css*");
  expect(t.body.entries?.[0].title).toBe("Home");
  const heard = await events(server, s.id, s.owner.cookie);
  try {
    let r = await s.treeOp({ op: "new_folder", path: "blog" });
    expect(r.status).toBe(200);
    expect(paths(r.body.entries)).toBe("blog/ index.html style.css*");
    expect((await s.treeOp({ op: "new_page", path: "blog/index.html" })).status).toBe(200);
    r = await s.treeOp({ op: "new_page", path: "blog/post" });
    expect(r.status).toBe(200);
    expect(paths(r.body.entries)).toBe("blog/ blog/index.html blog/post.html index.html style.css*");
    await s.treeOp({ op: "new_page", path: "about.html" });
    const template = await (await s.get(`/d/${s.id}/doc/about.html`)).text();
    expect(template).toContain("<h1>Untitled</h1>");
    expect(template).toContain("Start writing here.");
    await expect.poll(() => heard.of("tree").length).toBeGreaterThanOrEqual(4);
  } finally { heard.close(); }
});

test("tree operations refuse what they can't do, saying why", async () => {
  const s = await site(await servers.short());
  await s.treeOp({ op: "new_folder", path: "blog" });
  await s.treeOp({ op: "new_page", path: "blog/post" });
  await s.treeOp({ op: "new_page", path: "about.html" });
  const refusals: [unknown, number, RegExp][] = [
    [{ op: "new_page", path: "../up.html" }, 400, /leaves the document/],
    [{ op: "new_page", path: "blog/post.html" }, 409, /already a file/],
    [{ op: "new_folder", path: "blog" }, 409, /already a folder/],
    [{ op: "new_folder", path: "api" }, 400, /own addresses/],
    [{ op: "new_page", path: "notes.txt" }, 400, /an \.html file/],
    [{ op: "new_page", path: "a<b>.html" }, 400, /can't contain/],
    [{ op: "delete", path: "index.html" }, 400, /own page/],
    [{ op: "move", from: "index.html", to: "home.html" }, 400, /own page/],
    [{ op: "move", from: "blog", to: "blog/inside" }, 400, /inside itself/],
    [{ op: "move", from: "about.html", to: "style.css" }, 409, /already a file/],
    [{ op: "delete", path: "ghost.html" }, 404, /nothing at/],
    [{ op: "explode" }, 400, /no operation/],
  ];
  for (const [op, status, why] of refusals) {
    const x = await s.treeOp(op);
    expect({ op, status: x.status }).toEqual({ op, status });
    expect(x.body.error).toMatch(why);
  }
});

test("move renames a folder with what's in it, delete takes a folder; the events say what moved where and what went", async () => {
  const server = await servers.short();
  const s = await site(server);
  const heard = await events(server, s.id, s.owner.cookie);
  try {
    await s.treeOp({ op: "new_folder", path: "drafts/old" });
    let r = await s.treeOp({ op: "move", from: "drafts", to: "archive" });
    expect(r.status).toBe(200);
    expect(paths(r.body.entries)).toContain("archive/ archive/old/");
    expect(paths(r.body.entries)).not.toContain("drafts");
    await expect.poll(() => heard.of("tree").some((e) => JSON.stringify(e.moved) == JSON.stringify({ from: "drafts", to: "archive" }))).toBe(true);
    r = await s.treeOp({ op: "delete", path: "archive" });
    expect(r.status).toBe(200);
    expect(paths(r.body.entries)).not.toContain("archive");
    await expect.poll(() => heard.of("tree").some((e) => e.deleted == "archive")).toBe(true);
  } finally { heard.close(); }
});

test("a single-page document (/new) works as before: its tree is its one page", async () => {
  const server = await servers.short();
  const s = await site(server);
  const blank = await s.get("/new");
  const at = blank.headers.get("location") ?? "";
  expect(blank.status).toBe(302);
  expect(at.endsWith("#edit")).toBe(true);
  const id = ((await (await s.get(`${at.replace(/#edit$/, "")}/api/name`)).json()) as { id: string }).id;
  expect(paths(((await (await s.get(`/api/docs/${id}/tree`)).json()) as { entries: [] }).entries)).toBe("index.html");
  expect((await s.get(at.replace(/#edit$/, ""))).status).toBe(200);
});

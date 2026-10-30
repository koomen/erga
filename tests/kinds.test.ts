// Documents and projects (document/pages.ts, DocKind): a document is one page (index.html) and any files beside it; a
// project is a folder of pages. A document refuses a second page however it comes (the tree, a move, an upload, an
// agent's write, a publish), saying how to make it a project; make_project does, in its object and in the directory.
// make_document turns a project back, only while it has one page: else it says how many it has, and what to delete.
// One from before kinds decides its kind as it opens. The documents list shows a project's chevron, and none for a document.

import * as Effect from "effect/Effect";
import { expect, test } from "bun:test";
import { Document } from "../document/document";
import { KEYS, MemoryStorage } from "../document/storage";
import { kindOf, pageRefusal, type TreeOp } from "../document/pages";
import { docsPage } from "../server/pages/docs";
import type { Listed, Session } from "../server/platform";
import { setup } from "./helpers/files-fixture";
import { promised } from "./helpers/promised";

/** The document of the files tests, with its tree's calls (as the operations make them) and its agent's tools as its owner. */
async function withTree() {
  const s = await setup();
  await s.doc.setPermissions([{ login: "ada", role: "owner" }]);
  const who = { "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }), "x-erga-who": JSON.stringify({ login: "ada" }) };
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await s.doc.handle(new Request(`http://doc${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...who, ...headers } }));
    return { status: r.status, body: (await r.json()) as { error?: string; kind?: string; ok?: boolean; content?: { text: string }[] } };
  };
  /** A tree operation: its answer as an HTTP status (200, or the refusal's) and the error, as the operations answer it. */
  const treeOp = async (op: TreeOp) => {
    const r = (await Effect.runPromise(s.doc.self.call((c) => c.treeOp(op))))!;
    return { status: r.ok ? 200 : r.status, body: r.ok ? { kind: r.kind } : { error: r.error } };
  };
  const tool = (name: string, args: object) => post(`/api/ext/tools/${name}`, args, { "x-erga-agent": "token-1" });
  const kind = async () => (await Effect.runPromise(s.doc.self.call((c) => c.tree())))!.kind;
  return { ...s, treeOp, tool, kind };
}

test("a document's kind: a project if it has more than one page; a new page is refused only in a document", () => {
  expect(kindOf(["index.html", "style.css", "photo.png"])).toBe("document");
  expect(kindOf(["index.html", "about.html"])).toBe("project");
  expect(pageRefusal("document", "about.html", "index.html")).toContain("make it a project first");
  expect(pageRefusal("document", "index.html", "index.html")).toBeNull();
  expect(pageRefusal("document", "notes.md", "index.html")).toBeNull();
  expect(pageRefusal("project", "about.html", "index.html")).toBeNull();
});

test("a document refuses a second page however it comes, saying how to make it a project; other files go in", async () => {
  const { treeOp, tool, put, doc, kind } = await withTree();
  expect(await kind()).toBe("document");
  const tree = await treeOp({ op: "new_page", path: "about" });
  expect(tree.status).toBe(409);
  expect(tree.body.error).toContain("make it a project first");
  // An upload, a publish, an agent's write and a move that would make a page.
  expect((await put("about.html", "<h1>About</h1>")).status).toBe(409);
  expect((await doc.publish({ "blog/post.html": "<h1>Post</h1>" }, [])).refused[0].why).toContain("make it a project first");
  const w = await tool("write", { path: "contact.html", content: "<h1>Contact</h1>" });
  expect(w.body.ok).toBe(false);
  expect(JSON.stringify(w.body)).toContain("make it a project first");
  expect((await put("notes.txt", "some notes")).status).toBe(200);
  expect((await treeOp({ op: "move", from: "notes.txt", to: "notes.html" })).status).toBe(409);
  // Files that aren't pages, and folders, are fine; so is the page it has.
  expect((await treeOp({ op: "new_folder", path: "scans" })).status).toBe(200);
  expect((await tool("write", { path: "index.html", content: "<h1>Still the one page</h1>" })).body.ok).toBe(true);
  expect(await doc.paths()).toEqual(["index.html", "notes.txt"]);
});

test("make_project: the document becomes a project, in its object and in the directory, and takes more pages", async () => {
  const { treeOp, tool, dir, kind } = await withTree();
  expect((await treeOp({ op: "make_project" })).status).toBe(200);
  expect(await kind()).toBe("project");
  expect((await dir.get("doc12345"))!.kind).toBe("project");
  expect((await treeOp({ op: "new_page", path: "about" })).status).toBe(200);
  expect((await tool("write", { path: "blog/post.html", content: "<h1>Post</h1>" })).body.ok).toBe(true);
  // Again: nothing to do.
  expect((await treeOp({ op: "make_project" })).status).toBe(200);
});

test("make_document: a project with one page becomes a document again; with more, it says how many and which to delete", async () => {
  const { treeOp, tool, dir, kind } = await withTree();
  expect((await treeOp({ op: "make_project" })).status).toBe(200);
  expect((await treeOp({ op: "new_page", path: "about" })).status).toBe(200);
  expect((await treeOp({ op: "new_page", path: "blog/post" })).status).toBe(200);
  // Three pages: refused, in words, and nothing changes.
  const no = await treeOp({ op: "make_document" });
  expect(no.status).toBe(409);
  expect(no.body.error).toBe("It has 3 pages, and a document has one. Delete the others first: about.html, blog/post.html.");
  expect(await kind()).toBe("project");
  // The others gone (a file that isn't a page may stay): a document, in its object and in the directory, which refuses a second page again.
  expect((await treeOp({ op: "delete", path: "about.html" })).status).toBe(200);
  expect((await treeOp({ op: "delete", path: "blog" })).status).toBe(200);
  expect((await treeOp({ op: "make_document" })).status).toBe(200);
  expect(await kind()).toBe("document");
  expect((await dir.get("doc12345"))!.kind).toBe("document");
  expect((await treeOp({ op: "new_page", path: "about" })).status).toBe(409);
  // Again: nothing to do.
  expect((await treeOp({ op: "make_document" })).status).toBe(200);
});

test("a document from before kinds decides its kind as it opens: a project if it has more than one page; the directory hears it", async () => {
  const { deps, dir } = await withTree();
  // Its row as the directory had it before kinds (no kind), and its object without one, as a Worker from before kinds left it.
  const storage = new MemoryStorage();
  await dir.add({ id: "old12345", owner: "ada", title: "Old site", created: Date.now(), expires: null });
  await promised(new Document({ ...deps, storage })).create(
    "ada",
    "old12345",
    { "index.html": "<h1>Home</h1>", "about.html": "<h1>About</h1>" },
    "index.html",
    { expires: null, modified: Date.now() }
  );
  const info = (await storage.get<Record<string, unknown>>(KEYS.meta))!;
  delete info.kind;
  await storage.put(KEYS.meta, info);
  expect((await dir.get("old12345"))!.kind).toBeNull();
  const opened = promised(new Document({ ...deps, storage }));
  expect(await opened.paths()).toEqual(["about.html", "index.html"]);
  expect((await storage.get<{ kind?: string }>(KEYS.meta))!.kind).toBe("project");
  await new Promise((r) => setTimeout(r, 10));
  expect((await dir.get("old12345"))!.kind).toBe("project");
});

test("the documents list: a project's row has its chevron and says so; a document's has none", () => {
  const session = { login: "ada", name: "Ada" } as unknown as Session;
  const row = (id: string, title: string, kind?: "document" | "project"): Listed => ({ id, owner: "ada", slug: id, title, titleSet: false, slugSet: false, created: 1, modified: 1, role: "owner", ...(kind ? { kind } : {}) });
  const html = docsPage(session, [row("aaaaaaaa", "Taxes", "document"), row("bbbbbbbb", "Site", "project"), row("cccccccc", "Old")], 2, null);
  expect(html).not.toContain('data-id="aaaaaaaa" data-base');
  expect(html).toContain('data-id="bbbbbbbb" data-base');
  expect(html).toContain('data-id="cccccccc" data-base');
  expect(html.match(/class="note kind"[^>]*>Project</g)?.length).toBe(1);
});

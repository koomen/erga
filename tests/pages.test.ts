// A document's file tree without a server: which page an address is,
// the tree as entries, the names it takes, and its operations in the room
// on storage in memory: files and folders made, moved
// and deleted, storage following, and everyone hearing of it.

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Y from "yjs";
import { Awareness } from "../shared/yjs-protocol";
import { FileStore, Room, StateStore, joinLocal } from "../document/room";
import { relativeUrl, runTreeOp } from "../document/host";
import { checkNewName, cleanTreePath, pageAddress, pageUrl, resolvePage, titleOf, TreeError, treeEntries } from "../document/pages";
import { files, folders } from "../document/content";

test("an address is <path>.html, then <path>/index.html; never with a slash added", () => {
  const all = new Set(["index.html", "about.html", "blog/index.html", "blog/post.html", "notes/index.md", "style.css", "deep/a/b.html"]);
  const has = (p: string) => all.has(p);
  expect(resolvePage(has, "")).toEqual({ file: "index.html", canonical: "" });
  expect(resolvePage(has, "/")).toEqual({ file: "index.html", canonical: "" });
  expect(resolvePage(has, "about")).toEqual({ file: "about.html", canonical: "about" });
  expect(resolvePage(has, "blog")).toEqual({ file: "blog/index.html", canonical: "blog" });
  expect(resolvePage(has, "blog/")).toEqual({ file: "blog/index.html", canonical: "blog" });
  expect(resolvePage(has, "blog/post")).toEqual({ file: "blog/post.html", canonical: "blog/post" });
  expect(resolvePage(has, "notes")).toBeNull();
  expect(resolvePage(has, "deep/a/b")).toEqual({ file: "deep/a/b.html", canonical: "deep/a/b" });
  // A page by its file's name is that page, at its own address.
  expect(resolvePage(has, "blog/post.html")).toEqual({ file: "blog/post.html", canonical: "blog/post" });
  expect(resolvePage(has, "blog/index")).toEqual({ file: "blog/index.html", canonical: "blog" });
  expect(resolvePage(has, "index")).toEqual({ file: "index.html", canonical: "" });
  // Not pages, and nothing there.
  expect(resolvePage(has, "style")).toBeNull();
  expect(resolvePage(has, "style.css")).toBeNull();
  expect(resolvePage(has, "nope")).toBeNull();
  expect(resolvePage(has, "deep")).toBeNull();
  expect(resolvePage(has, "../etc/passwd")).toBeNull();
  expect(resolvePage(has, ".git/config")).toBeNull();
  // blog.html wins over blog/index.html; the shadowed one is still that page by its own name.
  all.add("blog.html");
  expect(resolvePage(has, "blog")).toEqual({ file: "blog.html", canonical: "blog" });
  expect(resolvePage(has, "blog/index")).toEqual({ file: "blog/index.html", canonical: "blog/index" });
  expect(resolvePage(has, "blog/post")).toEqual({ file: "blog/post.html", canonical: "blog/post" });
  expect(resolvePage(has, "caf%C3%A9")).toBeNull();
  expect(resolvePage((p) => p == "café.html", "caf%C3%A9")).toEqual({ file: "café.html", canonical: "café" });
});

test("a page's title: its h1, its <title>, then its first heading; a <title> of Untitled is no name", () => {
  expect(titleOf("<title>T</title><h1>One</h1>")).toBe("One");
  expect(titleOf("<title>Notes &amp; more</title><h2>Two</h2>")).toBe("Notes & more");
  // A deck like Pete's: slides with h2s, and a blank page's <title>.
  expect(titleOf("<title>Untitled</title><section><h2>How we use AI at YC</h2></section>")).toBe("How we use AI at YC");
  expect(titleOf("<title>Untitled</title><p>No heading</p>")).toBe(null);
});

test("a page's address", () => {
  expect(pageAddress("index.html")).toBe("");
  expect(pageAddress("about.html")).toBe("about");
  expect(pageAddress("blog/index.html")).toBe("blog");
  expect(pageAddress("blog/post.html")).toBe("blog/post");
  expect(pageUrl("/ada/site", "index.html")).toBe("/ada/site");
  expect(pageUrl("/ada/site", "blog/index.html")).toBe("/ada/site/blog");
  expect(pageUrl("/ada/site", "blog/my post.html")).toBe("/ada/site/blog/my%20post");
});

test("the tree lists every folder, folders first, then by name", () => {
  const entries = treeEntries(["index.html", "style.css", "blog/post.html", "blog/index.html", "img/a/logo.png", "about.html"], ["drafts", "blog/old"]);
  expect(entries).toEqual([
    { path: "blog", type: "folder" },
    { path: "blog/old", type: "folder" },
    { path: "blog/index.html", type: "page" },
    { path: "blog/post.html", type: "page" },
    { path: "drafts", type: "folder" },
    { path: "img", type: "folder" },
    { path: "img/a", type: "folder" },
    { path: "img/a/logo.png", type: "file" },
    { path: "about.html", type: "page" },
    { path: "index.html", type: "page" },
    { path: "style.css", type: "file" },
  ]);
});

test("names: inside the document, sensible, and not the document's own addresses", () => {
  expect(cleanTreePath("/blog//post.html/")).toBe("blog/post.html");
  expect(cleanTreePath("./a\\b")).toBe("a/b");
  for (const bad of ["../x.html", "a/../../b", "", "/", ".git", "a/.hidden", "node_modules/x", "a?b", "a<b", "trailing.", " lead", 42]) {
    expect(() => cleanTreePath(bad)).toThrow(TreeError);
  }
  expect(() => checkNewName("api", "folder")).toThrow(/own addresses/);
  expect(() => checkNewName("doc.html", "page")).toThrow(/own addresses/);
  expect(() => checkNewName("edit.html", "page")).not.toThrow();
  expect(() => checkNewName("blog/edit", "folder")).not.toThrow();
  expect(() => checkNewName("blog/api", "folder")).not.toThrow();
  expect(() => checkNewName("api.json", "file")).not.toThrow();
  expect(() => checkNewName("docs", "folder")).not.toThrow();
});

test("a redirect to a page's file is relative, keeping what's before the document", () => {
  expect(relativeUrl("blog", "blog/index.html")).toBe("blog/index.html");
  expect(relativeUrl("blog", "blog.html")).toBe("blog.html");
  expect(relativeUrl("blog/", "blog/index.html")).toBe("index.html");
  expect(relativeUrl("blog/", "blog.html")).toBe("../blog.html");
  expect(relativeUrl("a/b", "a/b/index.html")).toBe("b/index.html");
  expect(relativeUrl("", "index.html")).toBe("index.html");
  expect(relativeUrl("my blog", "my blog/index.html")).toBe("my%20blog/index.html");
});

// ------------------------------------------------------------ the room

/** Files and folders in memory, as a Durable Object keeps them. */
function memoryStore(init: Record<string, string>, dirs: string[] = []) {
  const data = new Map<string, Uint8Array>(Object.entries(init).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  const folderSet = new Set(dirs);
  const layer = StateStore.none.pipe(Layer.provideMerge(Layer.succeed(FileStore, {
    list: Effect.sync(() => [...data.keys()]),
    read: (p) => Effect.sync(() => data.get(p) ?? null),
    write: (p, text) => Effect.sync(() => { data.set(p, new TextEncoder().encode(text)); }),
    writeBytes: (p, bytes) => Effect.sync(() => { data.set(p, bytes); }),
    remove: (p) => Effect.sync(() => { data.delete(p); }),
    folders: Effect.sync(() => [...folderSet]),
    mkdir: (p) => Effect.sync(() => { p.split("/").forEach((_, i, a) => folderSet.add(a.slice(0, i + 1).join("/"))); }),
    rmdir: (p) => Effect.sync(() => {
      for (const d of [...folderSet]) if (d == p || d.startsWith(p + "/")) folderSet.delete(d);
      for (const f of [...data.keys()]) if (f.startsWith(p + "/")) data.delete(f);
    }),
  })));
  return { layer, data, folders: folderSet, text: (p: string) => data.has(p) ? new TextDecoder().decode(data.get(p)) : null };
}

const withRoom = (m: ReturnType<typeof memoryStore>, f: (room: Room) => Promise<void>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const room = yield* Room.make({ writeDelay: 5 });
    yield* Effect.promise(() => f(room));
  })).pipe(Effect.provide(m.layer)));

const tick = () => new Promise((r) => setTimeout(r, 0));
const opts = { index: "index.html", newPage: "<h1>New</h1>" };
const op = (room: Room, o: unknown) => Effect.runPromise(runTreeOp(room, o, opts));
const tree = (room: Room) => treeEntries(room.paths(), room.folderPaths()).map((e) => `${e.path}${e.type == "folder" ? "/" : e.type == "page" ? "" : "*"}`);

test("tree operations change storage and the room together, and everyone hears", async () => {
  const m = memoryStore({ "index.html": "<h1>Home</h1>", "style.css": "body{}", "img/logo.png": "\u0089PNG\u0000" }, ["empty"]);
  await withRoom(m, async (room) => {
    // A peer's replica sees the same tree, empty folders included.
    const doc = new Y.Doc();
    joinLocal(room, doc, new Awareness(doc));
    await tick();
    expect(tree(room)).toEqual(["empty/", "img/", "img/logo.png*", "index.html", "style.css*"]);
    expect([...folders(doc).keys()]).toEqual(["empty"]);
    let heard = 0;
    room.onTree(() => heard++);

    expect(await op(room, { op: "new_page", path: "blog/index" })).toEqual({ op: "new_page", path: "blog/index.html" });
    expect(m.text("blog/index.html")).toBe("<h1>New</h1>");
    await op(room, { op: "new_page", path: "blog/post.html" });
    await op(room, { op: "new_folder", path: "blog/drafts/old" });
    await tick();
    expect(heard).toBeGreaterThan(0);
    expect(files(doc).get("blog/post.html")?.toString()).toBe("<h1>New</h1>");
    expect(m.folders.has("blog/drafts/old") && m.folders.has("blog/drafts")).toBe(true);

    // Refused, saying why.
    const refused = async (o: unknown, status: number, why: RegExp) => {
      const e = await op(room, o).then(() => null, (err) => err);
      expect(e).toBeInstanceOf(TreeError);
      expect([e.status, e.message]).toEqual([status, expect.stringMatching(why)]);
    };
    await refused({ op: "new_page", path: "blog/post.html" }, 409, /already a file/);
    await refused({ op: "new_folder", path: "blog" }, 409, /already a folder/);
    await refused({ op: "new_page", path: "style.css/x.html" }, 409, /is a file/);
    await refused({ op: "new_page", path: "notes.txt" }, 400, /an \.html file/);
    await refused({ op: "new_page", path: "../up.html" }, 400, /leaves the document/);
    await refused({ op: "new_folder", path: "api" }, 400, /own addresses/);
    await refused({ op: "delete", path: "index.html" }, 400, /own page/);
    await refused({ op: "move", from: "index.html", to: "home.html" }, 400, /own page/);
    await refused({ op: "move", from: "blog", to: "blog/inner" }, 400, /inside itself/);
    await refused({ op: "move", from: "nothing", to: "x" }, 404, /nothing at/);
    await refused({ op: "move", from: "blog/post.html", to: "style.css" }, 409, /already a file/);
    await refused({ op: "delete", path: "nothing" }, 404, /nothing at/);
    await refused({ op: "rename", path: "x" }, 400, /no operation/);
    await refused(null, 400, /JSON/);

    // A page's unsaved edits go with it; renamed without an extension, it keeps its own.
    files(doc).get("blog/post.html")!.insert(0, "<!-- edited -->");
    await tick();
    expect(await op(room, { op: "move", from: "blog/post.html", to: "blog/hello" })).toEqual({ op: "move", from: "blog/post.html", to: "blog/hello.html" });
    expect(m.text("blog/hello.html")).toBe("<!-- edited --><h1>New</h1>");
    expect(m.text("blog/post.html")).toBeNull();
    await tick();
    expect(files(doc).has("blog/post.html")).toBe(false);
    expect(files(doc).get("blog/hello.html")?.toString()).toBe("<!-- edited --><h1>New</h1>");

    // A folder moves with everything in it: pages, images, empty folders.
    await op(room, { op: "move", from: "img", to: "blog/img" });
    await op(room, { op: "move", from: "blog", to: "posts" });
    expect(tree(room)).toEqual(["empty/", "posts/", "posts/drafts/", "posts/drafts/old/", "posts/img/", "posts/img/logo.png*", "posts/hello.html", "posts/index.html", "index.html", "style.css*"]);
    expect(m.text("posts/img/logo.png")).toBe("\u0089PNG\u0000");
    expect([...m.data.keys()].sort()).toEqual(["index.html", "posts/hello.html", "posts/img/logo.png", "posts/index.html", "style.css"]);
    expect([...m.folders].sort()).toEqual(["empty", "posts", "posts/drafts", "posts/drafts/old", "posts/img"]);

    // Deleting a file leaves its folder; deleting a folder takes everything in it.
    await op(room, { op: "delete", path: "posts/img/logo.png" });
    expect(tree(room)).toContain("posts/img/");
    await op(room, { op: "delete", path: "posts" });
    await op(room, { op: "delete", path: "empty" });
    expect(tree(room)).toEqual(["index.html", "style.css*"]);
    expect([...m.data.keys()].sort()).toEqual(["index.html", "style.css"]);
    expect([...m.folders]).toEqual([]);
    await tick();
    expect([...files(doc).keys()].sort()).toEqual(["index.html", "style.css"]);
  });
});

test("a file a participant deletes from the room is deleted from storage too", async () => {
  const m = memoryStore({ "index.html": "<h1>Home</h1>", "extra.html": "<p>x</p>" });
  await withRoom(m, async (room) => {
    const doc = new Y.Doc();
    joinLocal(room, doc, new Awareness(doc));
    await tick();
    files(doc).delete("extra.html");
    await new Promise((r) => setTimeout(r, 50));
    expect(m.text("extra.html")).toBeNull();
    expect(m.text("index.html")).toBe("<h1>Home</h1>");
  });
});

test("a single file opened on its own has no tree to change", async () => {
  const m = memoryStore({ "notes.html": "<h1>Notes</h1>" });
  await withRoom(m, async (room) => {
    const e = await Effect.runPromise(
      runTreeOp(room, { op: "new_page", path: "x.html" }, { index: "notes.html", only: "notes.html" })
    ).catch((err) => err);
    expect(e).toBeInstanceOf(TreeError);
    expect(e.status).toBe(403);
  });
});

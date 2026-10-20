// One document (document/document.ts) on MemoryStorage, with the real
// directory on bun:sqlite: made, read while its room is closed, edited by a
// publish (a version cut once edits pause), published at a version, restored,
// deleted when unedited.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Document, type DocumentDeps } from "../document/document";
import { KEYS, MemoryStorage } from "../document/storage";
import { Directory, type Param, type Sql } from "../server/directory/index.ts";

const MIGRATIONS = new URL("../server/migrations/", import.meta.url).pathname;
function memory(): Sql {
  const db = new Database(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + f, "utf8"));
  return {
    all: async <T>(sql: string, ...params: Param[]) => db.query(sql).all(...(params as never[])) as T[],
    run: async (sql: string, ...params: Param[]) => { db.query(sql).run(...(params as never[])); },
    batch: async (statements) => { db.transaction(() => { for (const [sql, ...params] of statements) db.query(sql).run(...(params as never[])); })(); },
  };
}

/** A document's deps on memory: the real directory, no sockets, no agent, short version timers. */
function setup(dir = new Directory(memory(), { admins: ["ada"] })) {
  const log: string[] = [];
  const forgotten: string[] = [];
  let storage!: MemoryStorage;
  const deps: DocumentDeps = {
    get storage() { return storage; },
    directory: dir,
    tabs: { count: () => 0, closeAll: () => {} },
    agentSettings: async () => ({ missing: "no key in the tests" }),
    serverTools: async () => [],
    takeDownSite: async () => null,
    home: { forget: async (id) => { forgotten.push(id); }, publishedChanged: async () => {} },
    siteChanged: async () => {},
    timing: { idleMs: 40, maxMs: 400, writeDelay: 10 },
    background: () => {},
    log: (line) => log.push(line),
  };
  const make = () => { storage = new MemoryStorage(() => doc.wake()); const doc = new Document(deps); return doc; };
  return { dir, log, forgotten, make, storage: () => storage };
}

const get = (doc: Document, path: string, headers: Record<string, string> = {}) => doc.handle(new Request(`http://doc${path}`, { headers: { "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }), "x-erga-who": JSON.stringify({ login: "ada" }), ...headers } }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a document is made from files, read from storage while closed, edited by a publish, versioned, published at a version and restored", async () => {
  const { dir, make, storage } = setup();
  await dir.add({ id: "doc12345", owner: "ada", title: "Notes", created: Date.now(), expires: Date.now() + 60_000 });
  const doc = make();
  expect(await doc.exists()).toBe(false);
  expect(await doc.create("ada", "doc12345", { "index.html": "<h1>One</h1>", "logo.png": new Uint8Array([1, 2]) }, "index.html", { expires: Date.now() + 60_000 })).toBe(true);
  expect(await doc.create("ada", "doc12345", {}, "index.html", { expires: null })).toBe(false);
  expect([...storage().data.keys()].sort()).toEqual(["files/index.html", "files/logo.png", "info", "perms", "versions/00000001", "versions/head"].sort().filter((k) => !k.startsWith("blobs/")).concat([...storage().data.keys()].filter((k) => k.startsWith("blobs/"))).sort());
  expect(storage().data.has(KEYS.meta)).toBe(true);

  // Read while the room is closed: straight from storage.
  const closed = await get(doc, "/doc/index.html");
  expect(closed.status).toBe(200);
  expect(closed.headers.get("Server-Timing")).toContain("stored");
  expect(await closed.text()).toBe("<h1>One</h1>");
  expect((await get(doc, "/doc/")).status).toBe(200);
  expect((await get(doc, "/doc/nope.html")).status).toBe(404);

  // A publish opens the room and edits; once edits pause, a version is cut.
  const out = await doc.publish({ "index.html": "<h1>Two</h1>" }, [], "ada");
  expect(out).toEqual({ written: ["index.html"], removed: [], refused: [] });
  expect(await doc.paths()).toEqual(["index.html", "logo.png"]);
  await sleep(120);
  let state = (await doc.versionsState())!;
  expect(state.total).toBe(2);
  expect(state.published.mode).toBe("latest");
  expect(state.current.n).toBe(2);
  expect((await dir.get("doc12345"))!.modified).not.toBeNull();

  // Published at version 1: /pub/ serves it, /doc/ the current; a copy for viewers is the published one.
  const pub = await doc.setPublished({ mode: "manual", versionId: "v1" });
  expect(pub.ok).toBe(true);
  expect(await (await get(doc, "/pub/index.html")).text()).toBe("<h1>One</h1>");
  expect(await (await get(doc, "/doc/index.html")).text()).toBe("<h1>Two</h1>");
  expect(new TextDecoder().decode((await doc.snapshot({ published: true }))!.files["index.html"] as Uint8Array)).toBe("<h1>One</h1>");
  expect((await doc.snapshot())!.files["index.html"]).toBe("<h1>Two</h1>");
  expect(await doc.setPublished({ mode: "nope" } as never)).toMatchObject({ ok: false, status: 400 });

  // Restore version 1: a new version with its files; what's published stays.
  const restored = await doc.restore("v1", "ada");
  expect(restored).toMatchObject({ ok: true, from: "v1", files: ["index.html", "logo.png"] });
  state = (await doc.versionsState())!;
  expect(state.total).toBe(3);
  expect(state.current.description).toBe("Restored version 1");
  expect(state.published.mode).toBe("manual");
  expect(await (await get(doc, "/doc/index.html")).text()).toBe("<h1>One</h1>");
  expect(await doc.versionFile("v2", "index.html")).toEqual(new TextEncoder().encode("<h1>Two</h1>"));
  expect(await doc.restore("v9", "ada")).toMatchObject({ ok: false, status: 404 });

  // Deleted: storage empties, the row goes, the homepage hears of it.
  expect(await doc.delete()).toBe(true);
  expect(storage().data.size).toBe(0);
  expect(await dir.get("doc12345")).toBeNull();
  expect(await doc.exists()).toBe(false);
  expect((await get(doc, "/doc/index.html")).status).toBe(404);
});

test("an unedited document goes when its alarm comes; an edited one stays", async () => {
  const { dir, make, forgotten } = setup();
  await dir.add({ id: "gone12345", owner: "ada", title: "Gone", created: Date.now() - 10, expires: Date.now() + 30 });
  const gone = make();
  await gone.create("ada", "gone12345", { "index.html": "<h1>Gone</h1>" }, "index.html", { expires: Date.now() + 30 });
  await sleep(120);
  expect(await gone.exists()).toBe(false);
  expect(await dir.get("gone12345")).toBeNull();
  expect(forgotten).toEqual(["gone12345"]);

  await dir.add({ id: "kept12345", owner: "ada", title: "Kept", created: Date.now() - 10, expires: Date.now() + 30 });
  const kept = make();
  await kept.create("ada", "kept12345", { "index.html": "<h1>Kept</h1>" }, "index.html", { expires: Date.now() + 30 });
  await kept.publish({ "index.html": "<h1>Kept, edited</h1>" }, [], "ada");
  await sleep(120);
  expect(await kept.exists()).toBe(true);
  expect(await dir.get("kept12345")).not.toBeNull();
});

test("the document decides who may do what from its own copy of its permissions, which the directory pushes; a file read with a checked key reads only", async () => {
  const pushed: string[] = [];
  let doc!: Document;
  const dir = new Directory(memory(), { admins: ["ada"], permissionsChanged: async (id, list) => { pushed.push(id); await doc.setPermissions(list); } });
  const { make } = setup(dir);
  doc = make();
  await dir.add({ id: "perm1234", owner: "ada", title: "Notes", created: Date.now() });
  await doc.create("ada", "perm1234", { "index.html": "<h1>One</h1>" }, "index.html", { expires: null });
  const as = (login: string, path = "/doc/index.html", init: RequestInit = {}) => doc.handle(new Request(`http://doc${path}`, { ...init, headers: { "x-erga-person": JSON.stringify({ id: login, name: login }), "x-erga-who": JSON.stringify({ login }), ...((init.headers as Record<string, string>) ?? {}) } }));
  // Nobody said: refused. The owner: read from the directory once, then from the copy.
  expect((await doc.handle(new Request("http://doc/doc/index.html"))).status).toBe(401);
  expect((await as("ada")).status).toBe(200);
  expect((await as("bo")).status).toBe(403);
  // Shared, then not: the directory tells the document at once, and it decides with what it heard.
  await dir.share({ login: "ada" }, "perm1234", "bo", "viewer");
  expect(pushed).toEqual(["perm1234"]);
  expect((await as("bo")).status).toBe(200);
  expect(await doc.roleOf({ login: "bo" })).toBe("viewer");
  expect((await as("bo", "/api/stored/index.html", { method: "PUT", body: "<h1>Bo</h1>" })).status).toBe(403);
  await dir.share({ login: "ada" }, "perm1234", "bo", null);
  expect((await as("bo")).status).toBe(403);
  // What the browser claims is never taken: x-erga-access is the document's own to set.
  expect((await as("bo", "/doc/index.html", { headers: { "x-erga-access": "edit" } })).status).toBe(403);
  // A checked key reads files, and nothing else.
  const checked = (path: string, method = "GET") => doc.handle(new Request(`http://doc${path}`, { method, headers: { "x-erga-checked": "files" }, ...(method == "GET" ? {} : { body: "x" }) }));
  expect((await checked("/pub/index.html")).status).toBe(200);
  expect((await checked("/api/doc")).status).toBe(403);
  expect((await checked("/api/stored/index.html", "PUT")).status).toBe(403);
});

test("a viewer's page in one call: the role, the file an address is, a version that changes with the files and only then, the text unless the caller has it", async () => {
  const { dir, make } = setup();
  const doc = make();
  await dir.add({ id: "view1234", owner: "ada", title: "Notes", created: Date.now() });
  await doc.create("ada", "view1234", { "index.html": "<h1>One</h1>", "blog.html": "<h1>Blog</h1>", "style.css": "h1{}" }, "index.html", { expires: null });
  const first = (await doc.view({ login: "ada" }, { page: "" }))!;
  expect(first).toMatchObject({ role: "owner", file: "index.html", canonical: "", html: "<h1>One</h1>" });
  expect(first.ver).toMatch(/^l[0-9a-f]+$/);
  expect(await doc.view({ login: "bo" }, { page: "" })).toMatchObject({ role: null });
  expect((await doc.view({ login: "bo" }, { page: "" }))!.html).toBeUndefined();
  // The front page: anyone sees it.
  expect(await doc.view(null, { page: "", anyone: true })).toMatchObject({ role: null, file: "index.html" });
  // Another page by its address; one that isn't there.
  expect(await doc.view({ login: "ada" }, { page: "blog" })).toMatchObject({ file: "blog.html", canonical: "blog", html: "<h1>Blog</h1>" });
  expect(await doc.view({ login: "ada" }, { page: "nope" })).toMatchObject({ file: null });
  // The same files: the same version, and no text for a caller who has it.
  const again = (await doc.view({ login: "ada" }, { page: "", have: first.ver }))!;
  expect(again.ver).toBe(first.ver);
  expect(again.html).toBeUndefined();
  // A file changes (not the page): another version.
  await doc.publish({ "style.css": "h1{color:red}" }, [], "ada");
  const changed = (await doc.view({ login: "ada" }, { page: "", have: first.ver }))!;
  expect(changed.ver).not.toBe(first.ver);
  expect(changed.html).toBe("<h1>One</h1>");
  // Published at version 1: its version, its files.
  await sleep(120);
  await doc.setPublished({ mode: "manual", versionId: "v1" });
  const pub = (await doc.view({ login: "ada" }, { page: "" }))!;
  expect(pub.ver).toMatch(/^p/);
  expect(pub.html).toBe("<h1>One</h1>");
});

test("a viewer's page holds its own small stylesheets inline, where their links were; others stay links", async () => {
  const { dir, make } = setup();
  const doc = make();
  await dir.add({ id: "styl1234", owner: "ada", title: "Notes", created: Date.now() });
  const page = `<!doctype html><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="print.css" media="print"><link rel="stylesheet" href="https://example.com/x.css"><link rel="stylesheet" href="css/far.css"><link rel="stylesheet" href="css/plain.css"><h1>One</h1>`;
  await doc.create("ada", "styl1234", { "index.html": page, "style.css": "h1{color:red}", "print.css": "h1{}", "css/far.css": "h1{background:url(a.png)}", "css/plain.css": "p{margin:0}" }, "index.html", { expires: null });
  const html = (await doc.view({ login: "ada" }, { page: "" }))!.html!;
  expect(html).toContain('<style data-erga-href="style.css">h1{color:red}</style>');
  expect(html).toContain('<style data-erga-href="css/plain.css">p{margin:0}</style>');
  // Its own media, another site's, and one whose url() would mean another file from the page's folder: links still.
  expect(html).toContain('<link rel="stylesheet" href="print.css" media="print">');
  expect(html).toContain('<link rel="stylesheet" href="https://example.com/x.css">');
  expect(html).toContain('<link rel="stylesheet" href="css/far.css">');
  expect(html.endsWith("<h1>One</h1>")).toBe(true);
});

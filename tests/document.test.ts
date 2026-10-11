// One document (document/document.ts) on MemoryStorage, with the real
// directory on bun:sqlite: made, read while its room is closed, edited by a
// publish (a version cut once edits pause), published at a version, restored,
// deleted when unedited, and brought back from the cutover's export.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Document, type DocumentDeps } from "../document/document";
import { KEYS, MemoryStorage } from "../document/storage";
import { Directory, type Param, type Sql } from "../server/directory";
import { decodeFile } from "../server/admin/cutover";

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

const get = (doc: Document, path: string, headers: Record<string, string> = {}) => doc.handle(new Request(`http://doc${path}`, { headers: { "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }), "x-erga-access": "edit", ...headers } }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a document is made from files, read from storage while closed, edited by a publish, versioned, published at a version and restored", async () => {
  const { dir, make, storage } = setup();
  await dir.add({ id: "doc12345", owner: "ada", title: "Notes", created: Date.now(), expires: Date.now() + 60_000 });
  const doc = make();
  expect(await doc.exists()).toBe(false);
  expect(await doc.create("ada", "doc12345", { "index.html": "<h1>One</h1>", "logo.png": new Uint8Array([1, 2]) }, "index.html", { expires: Date.now() + 60_000 })).toBe(true);
  expect(await doc.create("ada", "doc12345", {}, "index.html", { expires: null })).toBe(false);
  expect([...storage().data.keys()].sort()).toEqual(["files/index.html", "files/logo.png", "info", "versions/00000001", "versions/head"].sort().filter((k) => !k.startsWith("blobs/")).concat([...storage().data.keys()].filter((k) => k.startsWith("blobs/"))).sort());
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

test("the cutover's import brings an exported document back: its files as the latest version, the published files as the first, still published", async () => {
  const { dir, make } = setup();
  const row = (await dir.add({ id: "back12345", owner: "ada", title: "Back", created: 1700000000000, modified: 1700000001000 })).doc;
  const doc = make();
  const r = await doc.importExported({
    record: row, permissions: [], index: "index.html", published: null,
    files: { "index.html": { text: "<h1>Now</h1>" }, "img/a.png": { base64: "AQID" } },
    publishedFiles: { "index.html": { text: "<h1>Then</h1>" } },
  }, decodeFile);
  expect(r).toEqual({ ok: true, versions: 2 });
  expect(await doc.importExported({ record: row, permissions: [], index: "index.html", published: null, files: {} }, decodeFile)).toMatchObject({ ok: false });
  expect(await (await get(doc, "/pub/index.html")).text()).toBe("<h1>Then</h1>");
  expect(await (await get(doc, "/doc/index.html")).text()).toBe("<h1>Now</h1>");
  expect(new Uint8Array(await (await get(doc, "/doc/img/a.png")).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  const state = (await doc.versionsState())!;
  expect(state.total).toBe(2);
  expect(state.published).toMatchObject({ mode: "manual", version: { n: 1 } });
  expect(state.current.n).toBe(2);
  expect(await doc.paths()).toEqual(["img/a.png", "index.html"]);

  // Without published files: one version, published as it is typed.
  const plain = (await dir.add({ id: "plain2345", owner: "ada", title: "Plain", created: 1700000000000 })).doc;
  const p = make();
  expect(await p.importExported({ record: plain, permissions: [], index: "index.md", published: null, files: { "index.md": { text: "# Plain" } } }, decodeFile)).toEqual({ ok: true, versions: 1 });
  expect((await p.versionsState())!.published.mode).toBe("latest");
});

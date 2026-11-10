// One document (document/document.ts) on MemoryStorage, with the real
// directory on bun:sqlite: made, read while its room is closed, edited by a
// publish (a version cut once edits pause), restored, deleted when unedited.

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Document, type DocumentDeps } from "../document/document";
import { KEYS, MemoryStorage } from "../document/storage";
import { Directory } from "../server/directory/index.ts";
import { documentAgents } from "../agents/document/session";
import { testSandbox } from "./helpers/sandbox";
import { sleep } from "../shared/time";
import { until } from "./helpers/until";
import { promised, type Promised } from "./helpers/promised";
import { memory } from "./helpers/memory-sql";

/** A Document as the tests await it. */
type Doc = Promised<Document>;

/** A document's deps on memory: the real directory, no sockets, no agent, short version timers. */
function setup(dir = new Directory(memory(), { admins: ["ada"] })) {
  const log: string[] = [];
  const forgotten: string[] = [];
  let storage!: MemoryStorage;
  const deps: DocumentDeps = {
    get storage() { return storage; },
    directory: dir,
    tabs: { count: () => 0, closeAll: () => {} },
    agents: documentAgents({ settings: async () => ({ missing: "no key in the tests" }), sandbox: testSandbox }),
    home: {
      forget: async (id) => {
        forgotten.push(id);
      },
    },
    timing: { idleMs: 40, maxMs: 400, writeDelay: 10 },
    background: () => {},
    log: (line) => log.push(line),
  };
  const make = () => {
    storage = new MemoryStorage(() => doc.wake());
    const doc = promised(new Document(deps));
    return doc;
  };
  return { dir, log, forgotten, make, deps, storage: () => storage };
}

const get = (doc: Doc, path: string, headers: Record<string, string> = {}) =>
  doc.handle(
    new Request(`http://doc${path}`, {
      headers: { "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }), "x-erga-who": JSON.stringify({ login: "ada" }), ...headers },
    })
  );

test("a document is made from files, read from storage while closed, edited by a publish, versioned and restored", async () => {
  const { dir, make, storage } = setup();
  await dir.add({ id: "doc12345", owner: "ada", title: "Notes", created: Date.now(), expires: Date.now() + 60_000 });
  const doc = make();
  expect(await doc.index()).toBeNull();
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
  await until(async () => (await doc.versionsState())!.total == 2);
  let state = (await doc.versionsState())!;
  expect(state.current.n).toBe(2);
  await until(async () => (await dir.get("doc12345"))!.modified != null);

  // Viewers, and a copy, see the document as it is now.
  expect(await (await get(doc, "/doc/index.html")).text()).toBe("<h1>Two</h1>");
  expect((await doc.snapshot())!.files["index.html"]).toBe("<h1>Two</h1>");

  // Restore version 1: a new version with its files, which viewers see.
  const restored = await doc.restore("v1", "ada");
  expect(restored).toMatchObject({ ok: true, from: "v1", files: ["index.html", "logo.png"] });
  state = (await doc.versionsState())!;
  expect(state.total).toBe(3);
  expect(state.current.description).toBe("Restored version 1");
  expect(await (await get(doc, "/doc/index.html")).text()).toBe("<h1>One</h1>");
  expect(await doc.versionFile("v2", "index.html")).toEqual(new TextEncoder().encode("<h1>Two</h1>"));
  expect(await doc.restore("v9", "ada")).toMatchObject({ ok: false, status: 404 });

  // Deleted: storage empties, the row goes, the homepage hears of it.
  expect(await doc.delete()).toBe(true);
  expect(storage().data.size).toBe(0);
  expect(await dir.get("doc12345")).toBeNull();
  expect(await doc.index()).toBeNull();
  expect((await get(doc, "/doc/index.html")).status).toBe(404);
});

test("an unedited document goes when its alarm comes; an edited one stays", async () => {
  const { dir, make, forgotten, storage } = setup();
  await dir.add({ id: "gone12345", owner: "ada", title: "Gone", created: Date.now() - 10, expires: Date.now() + 30 });
  const gone = make();
  await gone.create("ada", "gone12345", { "index.html": "<h1>Gone</h1>" }, "index.html", { expires: Date.now() + 30 });
  // The homepage hears last.
  await until(() => forgotten.length > 0);
  expect(await gone.index()).toBeNull();
  expect(await dir.get("gone12345")).toBeNull();
  expect(forgotten).toEqual(["gone12345"]);

  // (Its alarm is far off, so the edit is first on a busy machine too: the test brings the alarm.)
  await dir.add({ id: "kept12345", owner: "ada", title: "Kept", created: Date.now() - 10, expires: Date.now() + 60_000 });
  const kept = make();
  await kept.create("ada", "kept12345", { "index.html": "<h1>Kept</h1>" }, "index.html", { expires: Date.now() + 60_000 });
  expect(await storage().getAlarm()).not.toBeNull();
  await kept.publish({ "index.html": "<h1>Kept, edited</h1>" }, [], "ada");
  // The edit took its alarm away; and an alarm that comes all the same leaves it.
  expect(await storage().getAlarm()).toBeNull();
  await kept.wake();
  expect(await kept.index()).not.toBeNull();
  expect(await dir.get("kept12345")).not.toBeNull();
});

test("the document decides who may do what from its own copy of its permissions, which the directory pushes; a file read with a checked key reads only", async () => {
  const pushed: string[] = [];
  let doc!: Doc;
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
  // Bo may sign in here (a share goes only to someone who may).
  await dir.users.add({ login: "ada", admin: true }, "bo");
  await dir.share({ login: "ada" }, "perm1234", "bo", "viewer");
  expect(pushed).toEqual(["perm1234"]);
  expect((await as("bo")).status).toBe(200);
  expect(await doc.roleOf({ login: "bo" })).toBe("viewer");
  expect((await doc.view({ login: "bo" }, { page: "" }))!.shares).toBe(0);
  expect((await as("bo", "/api/stored/index.html", { method: "PUT", body: "<h1>Bo</h1>" })).status).toBe(403);
  await dir.share({ login: "ada" }, "perm1234", "bo", null);
  expect((await as("bo")).status).toBe(403);
  // What the browser claims is never taken: x-erga-access is the document's own to set.
  expect((await as("bo", "/doc/index.html", { headers: { "x-erga-access": "edit" } })).status).toBe(403);
  // A checked key reads files, and nothing else. It says its pass's share counter: Bo's share ended, so the counter went
  // up, and a pass from before (Bo's, kept) reads nothing.
  const checked = (path: string, method = "GET", shares = 1) =>
    doc.handle(
      new Request(`http://doc${path}`, {
        method,
        headers: { "x-erga-checked": "files", "x-erga-shares": String(shares) },
        ...(method == "GET" ? {} : { body: "x" }),
      })
    );
  expect((await doc.view({ login: "ada" }, { page: "" }))!.shares).toBe(1);
  expect((await checked("/doc/index.html")).status).toBe(200);
  expect((await checked("/doc/index.html", "GET", 0)).status).toBe(403);
  // A new share, or a changed role, ends nobody's: the counter stays.
  await dir.share({ login: "ada" }, "perm1234", "bo", "viewer");
  await dir.share({ login: "ada" }, "perm1234", "bo", "editor");
  expect((await checked("/doc/index.html")).status).toBe(200);
  expect((await checked("/pub/index.html")).status).toBe(403);
  expect((await checked("/api/doc")).status).toBe(403);
  expect((await checked("/api/stored/index.html", "PUT")).status).toBe(403);
});

test("a viewer's page in one call: the role, the file an address is, a version that changes with the files and only then", async () => {
  const { dir, make } = setup();
  const doc = make();
  await dir.add({ id: "view1234", owner: "ada", title: "Notes", created: Date.now() });
  await doc.create("ada", "view1234", { "index.html": "<h1>One</h1>", "blog.html": "<h1>Blog</h1>", "style.css": "h1{}" }, "index.html", { expires: null });
  const first = (await doc.view({ login: "ada" }, { page: "" }))!;
  expect(first).toMatchObject({ role: "owner", file: "index.html", canonical: "" });
  expect(first.ver).toMatch(/^l[0-9a-f]+$/);
  expect(await doc.view({ login: "bo" }, { page: "" })).toMatchObject({ role: null });
  // The homepage: anyone sees it.
  expect(await doc.view(null, { page: "", anyone: true })).toMatchObject({ role: null, file: "index.html" });
  // Another page by its address; one that isn't there.
  expect(await doc.view({ login: "ada" }, { page: "blog" })).toMatchObject({ file: "blog.html", canonical: "blog" });
  expect(await doc.view({ login: "ada" }, { page: "nope" })).toMatchObject({ file: null });
  // The same files: the same version.
  const again = (await doc.view({ login: "ada" }, { page: "" }))!;
  expect(again.ver).toBe(first.ver);
  // A file changes (not the page): another version.
  await doc.publish({ "style.css": "h1{color:red}" }, [], "ada");
  const changed = (await doc.view({ login: "ada" }, { page: "" }))!;
  expect(changed.ver).not.toBe(first.ver);
});

test("a document stored before publishing went (its record names a published version) opens as it is now, for viewers and editors", async () => {
  const { dir, make, deps, storage } = setup();
  const doc = make();
  await dir.add({ id: "old12345", owner: "ada", title: "Old", created: Date.now() });
  await doc.create("ada", "old12345", { "index.html": "<h1>One</h1>" }, "index.html", { expires: null });
  await doc.publish({ "index.html": "<h1>Two</h1>" }, [], "ada");
  await until(async () => (await doc.versionsState())!.total == 2);
  // Its record as an older Erga left it: viewers saw version 1 ("manual").
  const stored = storage();
  await doc.flush();
  stored.data.set(KEYS.meta, { ...(stored.data.get(KEYS.meta) as object), published: { n: 1 } });
  stored.data.delete("view");
  // The object starts again on that storage: what it shows is the document as it is now.
  const again = promised(new Document({ ...deps, storage: stored }));
  expect(await (await get(again, "/doc/index.html")).text()).toBe("<h1>Two</h1>");
  expect(await again.view({ login: "ada" }, { page: "" })).toMatchObject({ role: "owner", file: "index.html" });
  expect((await again.snapshot())!.files["index.html"]).toBe("<h1>Two</h1>");
  const state = (await again.versionsState())!;
  expect(state).toMatchObject({ total: 2, current: { n: 2 } });
  expect(state).not.toHaveProperty("published");
  expect((await again.currentFiles())!.version.n).toBe(2);
});


/** The setting's read waits for `open()`: what happens meanwhile lands while the alarm waits for D1. */
function slowSetting(dir: Directory) {
  const get = dir.config.get.bind(dir.config);
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let asked!: () => void;
  const reading = new Promise<void>((r) => (asked = r));
  dir.config.get = (async (key: Parameters<typeof get>[0]) => {
    asked();
    await gate;
    return get(key);
  }) as typeof dir.config.get;
  return { reading, open };
}

test("a scratch document saved while its alarm reads the setting stays, saved", async () => {
  const { dir, make } = setup();
  await dir.add({ id: "save1234", owner: "ada", title: "Scratch", created: Date.now(), expires: null, scratch: true });
  const doc = make();
  await doc.create("ada", "save1234", { "index.html": "<h1>Scratch</h1>" }, "index.html", { expires: null, scratch: true });
  const setting = slowSetting(dir);
  const woke = doc.wake();
  await setting.reading;
  expect(await doc.keep()).toBe(true);
  setting.open();
  await woke;
  expect(await doc.index()).toBe("index.html");
  expect(await dir.get("save1234")).toMatchObject({ scratch: false, expires: null });
});

test("an unedited document edited while its alarm reads the setting stays; one an agent works on waits an hour", async () => {
  const { dir, make, storage } = setup();
  await dir.add({ id: "edit1234", owner: "ada", title: "Edit", created: Date.now(), expires: null });
  const edited = make();
  await edited.create("ada", "edit1234", { "index.html": "<h1>Edit</h1>" }, "index.html", { expires: null });
  const setting = slowSetting(dir);
  const woke = edited.wake();
  await setting.reading;
  await edited.publish({ "index.html": "<h1>Edited</h1>" }, [], "ada");
  setting.open();
  await woke;
  expect(await edited.index()).toBe("index.html");
  expect(await dir.get("edit1234")).not.toBeNull();

  // An agent's call with no socket (tabs: 0): the alarm comes in the middle of it.
  await dir.add({ id: "agent123", owner: "ada", title: "Agent", created: Date.now(), expires: null });
  const busy = make();
  await busy.create("ada", "agent123", { "index.html": "<h1>Agent</h1>" }, "index.html", { expires: null });
  let done!: () => void;
  const call = Effect.runPromise(busy.self.hold(Effect.promise(() => new Promise<void>((r) => (done = r)))));
  await busy.wake();
  done();
  await call;
  expect(await busy.index()).toBe("index.html");
  expect((await storage().getAlarm())! - Date.now()).toBeGreaterThan(59 * 60_000);
  await storage().deleteAlarm();
});

test("a call while the document is deleted finds no document, and opens nothing again", async () => {
  const { dir, make, storage } = setup();
  await dir.add({ id: "del12345", owner: "ada", title: "Del", created: Date.now(), expires: null });
  const doc = make();
  await doc.create("ada", "del12345", { "index.html": "<h1>Del</h1>" }, "index.html", { expires: null, modified: Date.now() });
  await doc.publish({ "index.html": "<h1>Del, edited</h1>" }, [], "ada");
  // Storage is slow to empty; a publish comes meanwhile.
  const s = storage();
  const deleteAll = s.deleteAll.bind(s);
  let began!: () => void, empty!: () => void;
  const emptying = new Promise<void>((r) => (began = r));
  const gate = new Promise<void>((r) => (empty = r));
  s.deleteAll = async () => {
    began();
    await gate;
    await deleteAll();
  };
  const deleted = doc.delete();
  await emptying;
  const late = doc.publish({ "index.html": "<h1>Back</h1>" }, [], "ada").then(
    () => "published",
    (e: { message?: string }) => e.message
  );
  expect(await late).toBe("There's no such document.");
  empty();
  expect(await deleted).toBe(true);
  // Nothing opened: nothing writes later. (No state shows that: a short time.)
  await sleep(60);
  expect(storage().data.size).toBe(0);
  expect(await doc.index()).toBeNull();
});

test("two publishes at once: each file's edit is by its own publisher", async () => {
  const { dir, make } = setup();
  await dir.add({ id: "two12345", owner: "ada", title: "Two", created: Date.now(), expires: null });
  const doc = make();
  await doc.create("ada", "two12345", { "index.html": "<h1>Two</h1>", "a.css": "a{}", "b.css": "b{}" }, "index.html", {
    expires: null,
    modified: Date.now(),
  });
  await Promise.all([doc.publish({ "a.css": "a{color:red}" }, [], "ada"), doc.publish({ "b.css": "b{color:red}" }, [], "bob")]);
  await until(async () => (await doc.versionsState())!.total == 2);
  const state = (await doc.versionsState())!;
  expect(state.current.authors).toEqual(["ada", "bob"]);
});

test("a file asked for at a version comes with the version viewers see now: the same until a file changes", async () => {
  const { dir, make } = setup();
  const doc = make();
  await dir.add({ id: "vers1234", owner: "ada", title: "Notes", created: Date.now() });
  await doc.create(
    "ada",
    "vers1234",
    { "index.html": '<link rel="stylesheet" href="style.css"><h1>One</h1>', "style.css": "h1{color:red}" },
    "index.html",
    { expires: null }
  );
  const file = (path: string, ver?: string) =>
    doc.handle(
      new Request(`http://doc/doc/${path}`, {
        headers: { "x-erga-checked": "files", "x-erga-shares": "0", ...(ver ? { "x-erga-ver": ver } : {}) },
      })
    );
  const ver = (await doc.view({ login: "ada" }, { page: "" }))!.ver!;
  const first = await file("style.css", ver);
  expect([first.status, first.headers.get("x-erga-ver"), await first.text()]).toEqual([200, ver, "h1{color:red}"]);
  // Not asked at a version: no word of it.
  expect((await file("style.css")).headers.get("x-erga-ver")).toBeNull();
  // The file changes: the same address is asked, and the answer names another version.
  const put = await doc.handle(
    new Request("http://doc/api/stored/style.css", {
      method: "PUT",
      body: "h1{color:blue}",
      headers: { "x-erga-person": JSON.stringify({ id: "ada", name: "ada" }), "x-erga-who": JSON.stringify({ login: "ada" }) },
    })
  );
  expect(put.ok).toBe(true);
  const after = await file("style.css", ver);
  expect(after.status).toBe(200);
  expect(after.headers.get("x-erga-ver")).not.toBe(ver);
  expect(after.headers.get("x-erga-ver")).toBe((await doc.view({ login: "ada" }, { page: "" }))!.ver!);
});

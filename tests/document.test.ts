// One document (document/document.ts) on MemoryStorage, with the real
// directory on bun:sqlite: made, read while its room is closed, edited by a
// publish (a version cut once edits pause), restored, deleted when unedited.
// Then with tabs in its room (Document.joinRoom): what is served and stored, a publish against the room's write, what
// counts as an edit, the versions a leave and a restore make, and the agent's tools on its files.

import { afterAll, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Y from "yjs";
import { files, introduce } from "../document/content";
import { Document, type DocumentDeps } from "../document/document";
import { KEYS, MemoryStorage } from "../document/storage";
import { Directory } from "../server/directory/index.ts";
import { documentAgents } from "../agents/document/session";
import { testSandbox } from "./helpers/sandbox";
import { sleep } from "../shared/time";
import {
  applyAwarenessUpdate,
  Awareness,
  type AwarenessChange,
  Decoder,
  Encoder,
  encodeAwarenessUpdate,
  readSyncMessage,
  writeSyncStep1,
  writeUpdate,
} from "../shared/yjs-protocol";
import { until } from "./helpers/until";
import { promised, type Promised } from "./helpers/promised";
import { memory } from "./helpers/memory-sql";
import { person, server, tool as apiTool } from "./helpers/app";
import { useAssets } from "../server/pages/index.ts";

// The whole app in memory (tests/helpers/app.ts) names a build's files: none after this file, as before it.
afterAll(() => useAssets(null));

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

// ---------------------------------------------------------------- with someone in its room

const tick = () => new Promise((r) => setTimeout(r, 0));
const MSG_SYNC = 0,
  MSG_AWARENESS = 1;
const message = (type: number, write: (e: Encoder) => void) => {
  const e = new Encoder();
  e.writeUint(type);
  write(e);
  return e.toBytes();
};

/**
 * A tab in the document's room, as a socket's adapter joins one (Document.admit, then joinRoom): its own replica and
 * presence, which speak the room's protocol. Each message goes in a microtask, in order, as a socket's would.
 */
async function tab(doc: Doc, who: string) {
  const person = { id: who, name: who };
  const request = new Request("http://doc/api/room", { headers: { "x-erga-person": JSON.stringify(person), "x-erga-access": "edit" } });
  const opened = (await doc.admit(request))!;
  const ydoc = new Y.Doc();
  const aw = new Awareness(ydoc);
  const room = {};
  let open = true;
  function receive(m: Uint8Array) {
    const d = new Decoder(m);
    const type = d.readUint();
    if (type == MSG_AWARENESS) return applyAwarenessUpdate(aw, d.readBytes(), room);
    if (type != MSG_SYNC) return;
    const reply = new Encoder();
    reply.writeUint(MSG_SYNC);
    readSyncMessage(d, reply, ydoc, room);
    if (reply.length > 1) toRoom(reply.toBytes());
  }
  const joined = doc.joinRoom(opened, {
    epoch: null,
    readOnly: false,
    send: (m) => queueMicrotask(() => (open && typeof m != "string" ? receive(m) : undefined)),
  })!;
  const toRoom = (m: Uint8Array) => queueMicrotask(() => (open ? void joined.receive(m) : undefined));
  ydoc.on("update", (u: Uint8Array, from: unknown) => {
    if (from !== room) toRoom(message(MSG_SYNC, (e) => writeUpdate(e, u)));
  });
  aw.on("update", ({ added, updated, removed }: AwarenessChange, from: unknown) => {
    if (from !== room) toRoom(message(MSG_AWARENESS, (e) => e.writeBytes(encodeAwarenessUpdate(aw, [...added, ...updated, ...removed]))));
  });
  toRoom(message(MSG_SYNC, (e) => writeSyncStep1(e, ydoc)));
  await until(() => files(ydoc).has("index.html"));
  // It says who it is, as an editor's tab does when it joins.
  introduce(ydoc, { user: who, name: who, color: "#2f6fec", kind: "person" });
  const text = (path = "index.html") => files(ydoc).get(path)!;
  return {
    ydoc,
    aw,
    text,
    str: (path = "index.html") => text(path).toString(),
    /** Types `s` after the first `anchor` of the page. */
    insertAfter: (anchor: string, s: string) => text().insert(text().toString().indexOf(anchor) + anchor.length, s),
    /** The tab closes: its socket's end. */
    leave: () => {
      open = false;
      joined.left();
    },
  };
}

/** A document made of `files`, in the directory (unedited unless `opts` says). */
async function madeOf(id: string, init: Record<string, string>, world = setup()) {
  await world.dir.add({ id, owner: "ada", title: "Notes", created: Date.now(), expires: null });
  const doc = world.make();
  await doc.create("ada", id, init, "index.html", { expires: null, modified: Date.now() });
  return { ...world, doc };
}

/** What storage holds of a file (GET /api/stored): its text and its ETag, as a publish reads them. */
async function stored(doc: Doc, path = "index.html") {
  const r = await get(doc, `/api/stored/${path}`);
  return { text: await r.text(), etag: r.headers.get("etag")!.replace(/"/g, "") };
}

/** A file pushed whole (PUT /api/stored), made from the version of storage `ifMatch` names. */
const push = (doc: Doc, text: string, ifMatch: string, path = "index.html") =>
  doc.handle(
    new Request(`http://doc/api/stored/${path}`, {
      method: "PUT",
      body: text,
      headers: {
        "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }),
        "x-erga-who": JSON.stringify({ login: "ada" }),
        "If-Match": `"${ifMatch}"`,
      },
    })
  );

test("the page is served the room's latest text, before it's stored", async () => {
  const world = setup();
  // The room writes an edit a minute after it: within this test, never.
  world.deps.timing = { idleMs: 60_000, maxMs: 60_000, writeDelay: 60_000 };
  const { doc, storage } = await madeOf("serve123", { "index.html": "<h1>Garden</h1>" }, world);
  const ada = await tab(doc, "ada");
  ada.insertAfter("<h1>", "Served ");
  await until(async () => (await (await get(doc, "/doc/index.html")).text()) == "<h1>Served Garden</h1>");
  expect(new TextDecoder().decode(storage().data.get("files/index.html") as Uint8Array)).toBe("<h1>Garden</h1>");
  ada.leave();
});

test("a push based on an old version is refused, not merged backwards", async () => {
  const { doc } = await madeOf("stale123", { "index.html": "<h1>Garden</h1>" });
  const ada = await tab(doc, "ada");
  const old = await stored(doc);
  ada.insertAfter("<h1>", "NEWER ");
  // The newer edit is stored, by the room's own write.
  await until(async () => (await stored(doc)).text.includes("NEWER "));
  const r = await push(doc, old.text.replace("<h1>", "<h1>STALE "), old.etag);
  expect(r.status).toBe(412);
  // The room is untouched, and so is storage.
  await tick();
  expect(ada.str()).toBe("<h1>NEWER Garden</h1>");
  expect((await stored(doc)).text).toBe("<h1>NEWER Garden</h1>");
  ada.leave();
});

test("publishes landing just as the room writes are never lost", async () => {
  const world = setup();
  // The room writes only when the test says (flush): each round aims a publish at a write, in an order it chooses.
  world.deps.timing = { idleMs: 60_000, maxMs: 60_000, writeDelay: 60_000 };
  const { doc } = await madeOf("race1234", { "index.html": "<h1>Garden</h1>" }, world);
  const ada = await tab(doc, "ada");
  const expected: string[] = [];
  let stale = 0,
    merged = 0;
  for (let i = 0; i < 18; i++) {
    const live = `⟦live${i}⟧`,
      pub = `⟦pub${i}⟧`;
    ada.insertAfter("<h1>", live);
    expected.push(live);
    // The live edit is in the room, not in storage.
    await until(async () => (await (await get(doc, "/doc/index.html")).text()).includes(live));
    for (let first = true; ; first = false) {
      const s = await stored(doc);
      const publish = () => push(doc, s.text.replace("</h1>", `${pub}</h1>`), s.etag);
      // The room's write and the publish at the same time, each started first in its round; in the third, the publish alone.
      const r =
        !first || i % 3 == 2
          ? await publish()
          : i % 3
            ? (await Promise.all([publish(), doc.flush()]))[0]
            : (await Promise.all([doc.flush(), publish()]))[1];
      if (r.ok) {
        if (first) merged++;
        break;
      }
      // Stale: the room's write landed first. Made again from what storage holds now.
      expect(r.status).toBe(412);
      stale++;
    }
    expected.push(pub);
  }
  await doc.flush();
  expect((await stored(doc)).text).toBe(ada.str());
  expect(expected.filter((t) => !ada.str().includes(t))).toEqual([]);
  // Both orders came: a publish that the room's write made stale, and one that landed on edits the room had not written.
  expect([stale > 0, merged > 0]).toEqual([true, true]);
  ada.leave();
});

test("opening a document, being in its room and moving a caret don't count as editing it", async () => {
  const world = setup();
  const soon = () => Date.now() + 60_000;
  /** An unedited document: it has its alarm, and the directory no time of an edit. */
  const unedited = async (id: string, on = setup(world.dir)) => {
    await world.dir.add({ id, owner: "ada", title: "Notes", created: Date.now(), expires: soon() });
    const doc = on.make();
    await doc.create("ada", id, { "index.html": "<h1>Garden</h1><p>Rows.</p>" }, "index.html", { expires: soon() });
    return { doc, storage: on.storage() };
  };
  const { doc, storage } = await unedited("open1234", world);
  const control = await unedited("ctrl1234");
  const ada = await tab(doc, "ada"),
    bo = await tab(doc, "bo"),
    other = await tab(control.doc, "ada");
  ada.aw.setLocalState({ user: { name: "Ada" }, cursor: { anchor: 10, head: 10 } });
  type Presence = { user?: { name: string }; cursor?: unknown };
  await until(() => [...bo.aw.getStates().values()].some((s) => (s as Presence).user?.name == "Ada" && (s as Presence).cursor));
  // An edit to another document, made after: once its mark goes, the caret's would have too, had it been an edit.
  other.insertAfter("<p>", "An edit. ");
  await until(async () => (await world.dir.get("ctrl1234"))!.modified != null);
  expect(await control.storage.getAlarm()).toBeNull();
  expect((await world.dir.get("open1234"))!.modified).toBeNull();
  expect(await storage.getAlarm()).not.toBeNull();
  for (const t of [ada, bo, other]) t.leave();
});

test("the last editor leaving cuts a version at once, without waiting for the pause", async () => {
  const world = setup();
  // The pause that cuts a version is a minute: within this test, never.
  world.deps.timing = { idleMs: 60_000, maxMs: 60_000, writeDelay: 10 };
  const { doc } = await madeOf("leave123", { "index.html": "<h1>Garden</h1>" }, world);
  expect((await doc.versionsState())!.total).toBe(1);
  const ada = await tab(doc, "ada");
  ada.insertAfter("Garden", " leaving");
  await until(async () => (await doc.versionsState())!.pending);
  ada.leave();
  await until(async () => (await doc.versionsState())!.total == 2);
  expect(await doc.versionFile("v2", "index.html")).toEqual(new TextEncoder().encode("<h1>Garden leaving</h1>"));
});

/** A tool of the document's, as the server runs it for an agent with one of Ada's tokens (POST /api/tools/<name>): its text, or the error. */
async function tool(doc: Doc, name: string, args: object) {
  const r = await doc.handle(
    new Request(`http://doc/api/tools/${name}`, {
      method: "POST",
      body: JSON.stringify(args),
      headers: {
        "content-type": "application/json",
        "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }),
        "x-erga-who": JSON.stringify({ login: "ada" }),
        "x-erga-agent": "token-1",
      },
    })
  );
  const body = (await r.json()) as { ok: boolean; content?: { type: string; text?: string }[]; error?: string };
  const text = (body.content ?? []).filter((c) => c.type == "text").map((c) => c.text);
  return { status: r.status, ok: body.ok, text: body.ok ? text.join("\n") : (body.error ?? "") };
}

/** A document with v2 ("alpha") and v3 ("beta"), and Ada in its room: versions are cut 5 ms after an edit. */
async function versioned(id: string) {
  const world = setup();
  world.deps.timing = { idleMs: 5, maxMs: 400, writeDelay: 5 };
  const { doc } = await madeOf(id, { "index.html": "<h1>Garden</h1>" }, world);
  const ada = await tab(doc, "ada");
  for (const [n, word] of [" alpha", " beta"].entries()) {
    ada.insertAfter("</h1>", `<p>${word}</p>`);
    await until(async () => (await doc.versionsState())!.total == n + 2);
  }
  return { doc, ada };
}

test("restoring one file: the others stay, the answer has the new version, and an edit lands right after", async () => {
  const { doc, ada } = await versioned("one12345");
  const before = (await doc.versionsState())!.total;
  await doc.publish({ "notes.md": "# Notes\n\nnotes-one\n" }, [], "ada");
  await until(async () => (await doc.versionsState())!.total == before + 1);
  const withNotes = (await doc.versionsState())!.current;
  expect((await tool(doc, "write", { path: "notes.md", content: "# Notes\n\nnotes-two\n" })).status).toBe(200);
  ada.insertAfter("Garden", " keeps");
  await until(async () => (await tool(doc, "read", { path: "index.html" })).text.includes("keeps"));
  const restored = await doc.restore(withNotes.id, "ada", "notes.md");
  const s = (await doc.versionsState())!;
  expect(s.current.description).toBe(`Restored notes.md from version ${withNotes.n}`);
  expect(restored).toMatchObject({ ok: true, current: { id: s.current.id }, files: ["notes.md"], from: withNotes.id });
  const read = (await tool(doc, "read", { path: "notes.md" })).text;
  expect(read).toContain("notes-one");
  expect(read).not.toContain("notes-two");
  // The restore of notes.md has reached the room by now (its answer comes after): index.html kept the edit.
  expect((await tool(doc, "read", { path: "index.html" })).text).toContain("keeps");
  expect(ada.str()).toContain("keeps");
  const edit = await tool(doc, "edit", { path: "notes.md", edits: [{ oldText: "notes-one", newText: "notes-one-edited" }] });
  expect(edit.status).toBe(200);
  expect((await tool(doc, "read", { path: "notes.md" })).text).toContain("notes-one-edited");
  const none = await doc.restore(withNotes.id, "ada", "nope.html");
  expect(none.ok).toBe(false);
  expect(!none.ok && none.error).toContain("has no file nope.html");
  ada.leave();
});

test("an edit against text a restore replaced says the file changed since, by which restore, and the current version", async () => {
  const { doc, ada } = await versioned("stale234");
  ada.insertAfter("Garden", " keeps");
  await until(async () => (await tool(doc, "read", { path: "index.html" })).text.includes("keeps"));
  const back = await doc.restore("v2", "ada");
  if (!back.ok) throw new Error(back.error);
  await until(() => !ada.str().includes("keeps"));
  const t = await tool(doc, "edit", { path: "index.html", edits: [{ oldText: "keeps", newText: "changed" }] });
  expect(t.status).not.toBe(200);
  expect(t.text).toContain("the file changed since the text your edit was based on");
  expect(t.text).toContain(`restored since: ${back.current.id}, "Restored version 2", by ada`);
  expect(t.text).toContain(`The current version is ${back.current.id}`);
  expect(t.text).not.toContain("someone could be editing");
  ada.leave();
});

// The deck of e2e/fixtures/builds, without its script: three slides, and a style with a rule for #progress.
const DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<script type="module" src="https://erga.dev/erga/steps/editor.js"></script>
<title>Builds</title>
<style>
  body { background: #fff; font: 20px/1.5 sans-serif; margin: 0; }
  .slide { display: none; padding: 60px; }
  .slide.current { display: block; }
  .build:not(.shown) { display: none; }
  /* How far into the deck: it grows to each step's place in 1.5 s. */
  #progress { position: fixed; left: 0; bottom: 0; height: 24px; width: 0; background: rgb(200, 0, 0); transition: width 1.5s linear; }
</style>
</head>
<body>
  <section class="slide"><h1>First slide</h1><p class="build">One.</p><p class="build">Two.</p><p class="build">Three.</p></section>
  <section class="slide"><h1>Second slide</h1><p class="build">No parts here.</p></section>
  <section class="slide"><h1>Third slide</h1><p class="build">Red.</p><p class="build">Green.</p><p class="build">Blue.</p></section>
  <div id="progress"></div>
</body>
</html>
`;

test("read by selector gives the element; edit by selector and by cssRule replaces it, in the file", async () => {
  const { doc } = await madeOf("deck1234", { "index.html": DECK });
  const read = await tool(doc, "read", { path: "index.html", selector: "section:nth-of-type(2)" });
  expect(read.text).toBe(
    `[index.html, line 18: the element "section:nth-of-type(2)"]\n<section class="slide"><h1>Second slide</h1><p class="build">No parts here.</p></section>`
  );
  expect((await tool(doc, "read", { path: "index.html", css_rule: "#progress" })).text).toMatch(
    /^\[index\.html, line 1\d: the CSS rule "#progress"\]\n#progress \{ position: fixed;.*\}$/
  );
  const edited = await tool(doc, "edit", {
    path: "index.html",
    edits: [
      { selector: "section:nth-of-type(2) h1", newText: "<h1>The middle slide</h1>" },
      {
        cssRule: "#progress",
        newText: "#progress { position: fixed; left: 0; bottom: 0; height: 24px; width: 0; background: rgb(0, 0, 200); }",
      },
    ],
  });
  expect(edited.text).toMatch(/^Edited index\.html/);
  // The file, once the room has written it.
  await doc.flush();
  const file = (await stored(doc)).text;
  expect(file).toContain("<h1>The middle slide</h1>");
  expect(file).toContain("background: rgb(0, 0, 200); }");
  expect(file).not.toContain("Second slide");
  // Only those two parts changed.
  expect(file).toBe(
    DECK.replace("<h1>Second slide</h1>", "<h1>The middle slide</h1>").replace(
      "background: rgb(200, 0, 0); transition: width 1.5s linear; }",
      "background: rgb(0, 0, 200); }"
    )
  );
});

test("restore_version, by the agent, is attributed to the person via their agent", async () => {
  // The whole app in memory (tests/helpers/app.ts): the operation says who restores, the document records it.
  const s = server();
  const owner = await person(s);
  const id = await owner.make();
  const token = await owner.token("versions test");
  expect((await apiTool(s, token, "write", { document: id, path: "index.html", content: "<h1>Changed</h1>" })).status).toBe(200);
  const t = await apiTool(s, token, "restore_version", { document: id, version: "v1" });
  expect(t.status).toBe(200);
  const state = (await owner.tool<{ current: { description: string; authors: string[] } }>("versions", { document: id })).result!;
  expect(state.current.description).toBe("Restored version 1");
  expect(state.current.authors).toContain(`${owner.login}, via a shared agent (versions test)`);
});

test("a new file made by one participant reaches the others and storage", async () => {
  const { doc } = await madeOf("newf1234", { "index.html": "<h1>Garden</h1>" });
  const ada = await tab(doc, "ada"),
    bo = await tab(doc, "bo");
  const name = "notes/new-1.md";
  ada.ydoc.transact(() => {
    const t = new Y.Text();
    t.insert(0, "# Hello\n");
    files(ada.ydoc).set(name, t);
  });
  await until(() => files(bo.ydoc).get(name)?.toString() == "# Hello\n");
  // Storage has it, by the room's own write; and it's served.
  await until(async () => (await get(doc, `/api/stored/${name}`)).status == 200);
  expect((await stored(doc, name)).text).toBe("# Hello\n");
  expect(await (await get(doc, `/doc/${name}`)).text()).toBe("# Hello\n");
  for (const t of [ada, bo]) t.leave();
});

test("a stylesheet is edited like the page", async () => {
  const { doc } = await madeOf("style123", { "index.html": "<h1>Garden</h1>", "style.css": "h1 { color: green; }\n" });
  const ada = await tab(doc, "ada");
  expect([...files(ada.ydoc).keys()]).toContain("style.css");
  ada.text("style.css").insert(ada.str("style.css").length, "\nh1 { letter-spacing: 1px; }\n");
  const edited = "h1 { color: green; }\n\nh1 { letter-spacing: 1px; }\n";
  await until(async () => (await (await get(doc, "/doc/style.css")).text()) == edited);
  await until(async () => (await stored(doc, "style.css")).text == edited);
  ada.leave();
});

// The document room without a browser: participants converge, files are
// written back and merged in from storage, the agent's workspace aims edits
// by exact match, and every edit is attributed to whoever made it.

import { expect, test } from "bun:test";
import * as Y from "yjs";
import { Awareness } from "../shared/yjs-protocol";
import * as Layer from "effect/Layer";
import { FileStore, Room, StateStore, StoreError, joinLocal } from "../document/room";
import * as Effect from "effect/Effect";
import { YjsWorkspace, type Cursor, type WorkspaceError } from "../agents/document/workspace";
import { assets, authorOf, files, introduce, roomInfo, type Author } from "../document/content";
import { until } from "./helpers/until";

/** Files in memory, as the room's storage (no saved state: each room starts afresh). */
function memoryStore(init: Record<string, string>) {
  const data = new Map(Object.entries(init).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  const writes: string[] = [];
  const files = Layer.succeed(FileStore, {
    list: Effect.sync(() => [...data.keys()]),
    read: (p) => Effect.sync(() => data.get(p) ?? null),
    write: (p, text) => Effect.sync(() => { writes.push(p); data.set(p, new TextEncoder().encode(text)); }),
  });
  return {
    layer: StateStore.none.pipe(Layer.provideMerge(files)),
    writes,
    get: (p: string) => new TextDecoder().decode(data.get(p)),
    set: (p: string, t: string) => data.set(p, new TextEncoder().encode(t)),
    /** A file that isn't text, as storage has it now. */
    put: (p: string, bytes: Uint8Array<ArrayBuffer>) => data.set(p, bytes),
  };
}

/** Runs a test against a room on that storage, closed when the test ends. */
const withRoom = (m: ReturnType<typeof memoryStore>, f: (room: Room) => Promise<void>, opts: { writeDelay?: number } = {}) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const room = yield* Room.make(opts);
    yield* Effect.promise(() => f(room));
  })).pipe(Effect.provide(m.layer)));

/** Why a workspace operation failed, and what it told the model. */
const failure = (op: Effect.Effect<unknown, WorkspaceError>) => Effect.runSync(Effect.flip(op));

const tick = () => new Promise((r) => setTimeout(r, 0));
const person = (name: string): Author => ({ user: name.toLowerCase(), name, color: "#2f6fec", kind: "person" });

async function peer(room: Room, me: Author) {
  const doc = new Y.Doc();
  const aw = new Awareness(doc);
  aw.setLocalState({ user: me });
  const joined = joinLocal(room, doc, aw);
  await tick();
  introduce(doc, me);
  await tick();
  return { doc, aw, joined, text: (p = "index.html") => files(doc).get(p)! };
}

test("participants converge and the room writes files back", async () => {
  const m = memoryStore({ "index.html": "<p>Hello world</p>", "style.css": "p { color: red }", "logo.png": "\u0089PNG" });
  await withRoom(m, async (room) => {
    expect(room.text("index.html")).toBe("<p>Hello world</p>");
    expect(room.text("logo.png")).toBeNull();

    const a = await peer(room, person("Ada")), b = await peer(room, person("Bo"));
    expect(b.text().toString()).toBe("<p>Hello world</p>");
    a.text().insert(3, "Hi! ");
    b.text().insert(14, " again");
    await tick();
    expect(a.text().toString()).toBe("<p>Hi! Hello world again</p>");
    expect(b.text().toString()).toBe(a.text().toString());
    await Effect.runPromise(room.flush);
    expect(m.get("index.html")).toBe("<p>Hi! Hello world again</p>");
    expect(m.writes).toEqual(["index.html"]);
  });
});

test("an edit on disk merges with the room's unsaved edits", async () => {
  const m = memoryStore({ "index.md": "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n" });
  await withRoom(m, async (room) => {
    const a = await peer(room, person("Ada"));
    // In the room, not yet on disk:
    a.text("index.md").insert(a.text("index.md").toString().indexOf("Second"), "A new ");
    await tick();
    // Meanwhile, on disk:
    m.set("index.md", "# A better title\n\nFirst paragraph.\n\nSecond paragraph.\n");
    await Effect.runPromise(room.fileChanged("index.md"));
    await tick();
    expect(a.text("index.md").toString()).toBe("# A better title\n\nFirst paragraph.\n\nA new Second paragraph.\n");
    await Effect.runPromise(room.flush);
    expect(m.get("index.md")).toBe("# A better title\n\nFirst paragraph.\n\nA new Second paragraph.\n");
    // Our own write doesn't come back as a change.
    await Effect.runPromise(room.fileChanged("index.md"));
    expect(room.text("index.md")).toBe("# A better title\n\nFirst paragraph.\n\nA new Second paragraph.\n");
  });
});

test("the agent's edits aim at the current text and keep others' edits", async () => {
  const m = memoryStore({ "index.html": "<h1>Notes</h1>\n<p>The quick brown fox.</p>\n<p>Jumps over the dog.</p>\n" });
  await withRoom(m, async (room) => {
    const ada = await peer(room, person("Ada"));
    const agentMe: Author = { user: "ada", name: "Ada’s agent", color: "#12a594", kind: "agent" };
    const agent = await peer(room, agentMe);
    const ws = new YjsWorkspace(agent.doc, agentMe, () => true, {});

    // Ada types while the agent works; the agent's edit lands on top.
    ada.text().insert(ada.text().toString().indexOf("dog"), "lazy ");
    await tick();
    Effect.runSync(ws.edit("index.html", [{ oldText: "quick brown fox", newText: "quick red fox" }]));
    await tick();
    expect(ada.text().toString()).toBe("<h1>Notes</h1>\n<p>The quick red fox.</p>\n<p>Jumps over the lazy dog.</p>\n");

    // Text the agent remembers but that's since changed: a clean failure.
    const stale = failure(ws.edit("index.html", [{ oldText: "over the dog", newText: "under the dog" }]));
    expect(stale.reason).toBe("notFound");
    expect(stale.message).toMatch(/isn't in the current text/);
    expect(failure(ws.edit("index.html", [{ oldText: "<p>", newText: "<p class=x>" }])).reason).toBe("ambiguous");

    // write applies only the differences, so a concurrent edit elsewhere survives.
    const draft = Effect.runSync(ws.read("index.html")).replace("Notes", "Field notes");
    ada.text().insert(ada.text().toString().indexOf("Jumps"), "It ");
    await tick();
    Effect.runSync(ws.write("index.html", draft));
    await tick();
    expect(ada.text().toString()).toBe("<h1>Field notes</h1>\n<p>The quick red fox.</p>\n<p>It Jumps over the lazy dog.</p>\n");

    // New files, and no escaping the folder; a viewer's agent can't edit.
    Effect.runSync(ws.write("notes/extra.md", "hi\n"));
    await tick();
    expect(room.text("notes/extra.md")).toBe("hi\n");
    expect(failure(ws.read("../secret")).reason).toBe("outside");
    const viewer = new YjsWorkspace(agent.doc, agentMe, () => false, {});
    expect(failure(viewer.edit("index.html", [{ oldText: "red", newText: "blue" }])).reason).toBe("readOnly");
  });
});

test("an edit based on text the file no longer has says the file changed since", async () => {
  const m = memoryStore({ "index.html": "<h1>Notes</h1>\n<p>Old line.</p>\n" });
  await withRoom(m, async (room) => {
    const ada = await peer(room, person("Ada"));
    const agentMe: Author = { user: "ada", name: "Ada’s agent", color: "#12a594", kind: "agent" };
    const agent = await peer(room, agentMe);
    const ws = new YjsWorkspace(agent.doc, agentMe, () => true, {});
    expect(ws.seenAt("index.html")).toBeNull();
    const before = Date.now();
    Effect.runSync(ws.read("index.html"));
    expect(ws.seenAt("index.html")!).toBeGreaterThanOrEqual(before);

    // The file is written over after the agent read it (a restore, say).
    ada.text().delete(0, ada.text().length);
    ada.text().insert(0, "<h1>Notes</h1>\n<p>Restored line.</p>\n");
    await tick();
    const stale = failure(ws.edit("index.html", [{ oldText: "Old line.", newText: "New line." }]));
    expect(stale.reason).toBe("changed");
    expect(stale.message).toMatch(/isn't in the current text of index.html: the file changed since the text your edit was based on/);
    expect(stale.message).not.toMatch(/someone could be editing/);

    // Text that was never in the file, unchanged since the agent read it: check oldText.
    Effect.runSync(ws.read("index.html"));
    const wrong = failure(ws.edit("index.html", [{ oldText: "No such line.", newText: "x" }]));
    expect(wrong.reason).toBe("notFound");
    expect(wrong.message).toMatch(/same as when you last read it/);
    // The error says what to do next: nothing like it in the file, check oldText; else the nearest line, and where it differs.
    expect(wrong.message).toEndWith("Check oldText against it.");
    const near = failure(ws.edit("index.html", [{ oldText: "<p>Restored lime.</p>", newText: "x" }]));
    expect(near.message).toEndWith(" Nearest, line 2:\n  <p>Restored line.</p>\nIt differs from oldText at character 15 of that line.");
    // A file that isn't there: the files that are.
    const missing = failure(ws.edit("nope.html", [{ oldText: "a", newText: "b" }]));
    expect([missing.reason, missing.message]).toEqual(["missing", "nope.html doesn't exist. The files: index.html."]);

    // Read again, the edit lands.
    Effect.runSync(ws.edit("index.html", [{ oldText: "Restored line.", newText: "New line." }]));
    await tick();
    expect(ada.text().toString()).toBe("<h1>Notes</h1>\n<p>New line.</p>\n");
  });
});

test("every edit is attributed, deletions included", async () => {
  const m = memoryStore({ "index.html": "<p>one two three</p>" });
  await withRoom(m, async (room) => {
    const ada = await peer(room, person("Ada"));
    const bo = await peer(room, person("Bo"));
    const agentMe: Author = { user: "bo", name: "Bo’s agent", color: "#12a594", kind: "agent" };
    const agent = await peer(room, agentMe);
    const ws = new YjsWorkspace(agent.doc, agentMe, () => true, {});
    const seen: (string | undefined)[] = [];
    ada.text().observe((_e, tr) => seen.push(authorOf(ada.doc, tr)?.name));

    bo.doc.transact(() => bo.text().insert(3, "zero "));
    await tick();
    Effect.runSync(ws.edit("index.html", [{ oldText: " two", newText: "" }])); // only deletes
    await tick();
    m.set("index.html", "<p>zero one three!</p>");
    await Effect.runPromise(room.fileChanged("index.html"));
    await tick();
    expect(seen).toEqual(["Bo", "Bo’s agent", "On disk"]);
  });
});

test("the room writes an edit after its delay, and what's left when it closes", async () => {
  const m = memoryStore({ "index.html": "<p>one</p>" });
  await withRoom(m, async (room) => {
    const a = await peer(room, person("Ada"));
    a.text().insert(3, "just ");
    await tick();
    expect(m.writes).toEqual([]);
    await until(() => m.get("index.html") == "<p>just one</p>");
    a.text().insert(3, "not ");
    await tick();
  }, { writeDelay: 30 });
  // Closed before the delay was up: written on the way out.
  expect(m.get("index.html")).toBe("<p>not just one</p>");
  expect(m.writes).toEqual(["index.html", "index.html"]);
});

test("an agent's edit lands at once, in one undo step, keeps others' edits, and puts the agent's caret at its end", async () => {
  const start = "<h1>Notes</h1>\n<p>The quick brown fox.</p>\n<p>Jumps over the dog.</p>\n";
  const edits = [
    { oldText: "<h1>Notes</h1>", newText: "<h1>Field notes from the coast</h1>" },
    { oldText: " brown", newText: "" },
    { oldText: "the dog", newText: "the lazy old dog, twice" },
  ];
  const agentMe: Author = { user: "ada", name: "Ada’s agent", color: "#12a594", kind: "agent" };
  await withRoom(memoryStore({ "index.html": start }), async (room) => {
    const ada = await peer(room, person("Ada"));
    const agent = await peer(room, agentMe);
    const origin = {};
    const undo = new Y.UndoManager(files(agent.doc), { trackedOrigins: new Set([origin]), captureTimeout: Infinity });
    const abs = (r: Y.RelativePosition) => Y.createAbsolutePositionFromRelativePosition(r, agent.doc)!.index;
    const carets: number[] = [];
    const cursor: Cursor = (_path, anchor) => carets.push(abs(anchor));
    const ws = new YjsWorkspace(
      agent.doc,
      agentMe,
      () => true,
      origin,
      null,
      () => null,
      cursor
    );
    ada.text().insert(ada.text().length, "<p>Ada's line.</p>\n");
    await tick();
    const seen: string[] = [];
    ada.doc.on("update", () => seen.push(ada.text().toString()));
    const r = await Effect.runPromise(ws.edit("index.html", edits));
    await tick();
    const done =
      "<h1>Field notes from the coast</h1>\n<p>The quick fox.</p>\n<p>Jumps over the lazy old dog, twice.</p>\n<p>Ada's line.</p>\n";
    expect(ada.text().toString()).toBe(done);
    // At once: Ada's replica takes it in one update.
    expect(seen).toEqual([done]);
    expect(r.at).toBe(done.indexOf(", twice") + ", twice".length);
    expect(carets).toEqual([r.at]);
    // One undo step takes back the whole call, and keeps Ada's line.
    undo.stopCapturing();
    expect(undo.undoStack.length).toBe(1);
    undo.undo();
    expect(agent.text().toString()).toBe(start + "<p>Ada's line.</p>\n");
  });
});

test("the lock for source edits: only its holder's edits land; everyone sees whose it is; let go, the others' edits come", async () => {
  await withRoom(memoryStore({ "index.html": "<p>One</p>\n" }), async (room) => {
    const ada = await peer(room, person("Ada"));
    const agent = await peer(room, { user: "bo", name: "Bo’s agent", color: "#12a594", kind: "agent" });
    expect(agent.joined.lock("Bo’s agent")).toBeNull();
    await tick();
    // Everyone sees it, and another can't take it.
    expect(roomInfo(ada.doc).get("lock")).toBe("Bo’s agent");
    expect(ada.joined.lock("Ada")).toBe("Bo’s agent");
    expect(ada.joined.lockedBy()).toBe("Bo’s agent");
    // The holder's edit lands; Ada's, meanwhile, doesn't reach the room.
    agent.text().insert(0, "<h1>Notes</h1>\n");
    ada.text().insert(ada.text().length, "<p>Ada's</p>\n");
    await tick();
    await tick();
    expect(files(room.doc).get("index.html")!.toString()).toBe("<h1>Notes</h1>\n<p>One</p>\n");
    // Let go: everyone may edit again, and what Ada typed meanwhile comes in, merged.
    agent.joined.unlock();
    await tick();
    for (let i = 0; i < 5; i++) await tick();
    expect(roomInfo(ada.doc).get("lock")).toBeUndefined();
    expect(files(room.doc).get("index.html")!.toString()).toBe("<h1>Notes</h1>\n<p>One</p>\n<p>Ada's</p>\n");
    expect(agent.text().toString()).toBe(ada.text().toString());
  });
});

test("a write that fails is tried again, later each time, until it lands; then storage has everything", async () => {
  const data = new Map([["index.html", new TextEncoder().encode("<p>one</p>")]]);
  let failing = true;
  const tries: number[] = [];
  const write = (p: string, text: string) => {
    tries.push(Date.now());
    if (failing) return Effect.fail(new StoreError({ message: "storage is down" }));
    data.set(p, new TextEncoder().encode(text));
    return Effect.void;
  };
  const store = Layer.succeed(FileStore, {
    list: Effect.sync(() => [...data.keys()]),
    read: (p) => Effect.sync(() => data.get(p) ?? null),
    write: (p, text) => Effect.suspend(() => write(p, text)),
  });
  const check = async (room: Room) => {
    const a = await peer(room, person("Ada"));
    a.text().insert(3, "just ");
    await until(() => tries.length >= 3);
    // After 10 ms, then 20 more, then 40 more: twice as long each time (a timer is never early, but for its last millisecond).
    expect(tries[1] - tries[0]).toBeGreaterThanOrEqual(19);
    expect(tries[2] - tries[1]).toBeGreaterThanOrEqual(39);
    expect(room.saved).toBe(false);
    failing = false;
    await Effect.runPromise(room.flush);
    expect(room.saved).toBe(true);
    expect(new TextDecoder().decode(data.get("index.html"))).toBe("<p>just one</p>");
  };
  const run = Effect.flatMap(Room.make({ writeDelay: 10, fileDelay: 0 }), (room) => Effect.promise(() => check(room)));
  await Effect.runPromise(Effect.scoped(run).pipe(Effect.provide(StateStore.none.pipe(Layer.provideMerge(store)))));
});

test("a changed image updates its versioned reference", async () => {
  const m = memoryStore({ "index.html": '<img src="pic.png">' });
  await withRoom(m, async (room) => {
    const a = await peer(room, person("Ada"));
    const refs = assets(a.doc);
    expect(refs.has("pic.png")).toBe(false);
    // The image is written to storage behind the room (a file on disk), which hears of the change.
    m.put("pic.png", new Uint8Array([137, 80, 78, 71, 1]));
    await Effect.runPromise(room.fileChanged("pic.png"));
    await tick();
    const h = refs.get("pic.png");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    m.put("pic.png", new Uint8Array([137, 80, 78, 71, 2]));
    await Effect.runPromise(room.fileChanged("pic.png"));
    await tick();
    expect(refs.get("pic.png")).toMatch(/^[0-9a-f]{16}$/);
    expect(refs.get("pic.png")).not.toBe(h);
  });
});

/** mulberry32: the same seed gives the same run. */
function seeded(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(next, {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(list: T[]) => list[Math.floor(next() * list.length)],
  });
}

test("arbitrary edits (any text, any range, unicode) from many hands converge", async () => {
  const start = `<!doctype html>\n<h1>Leads</h1>\n<figure><img src="funnel.png"><figcaption>Where the leads go.</figcaption></figure>\n<ul>\n<li>First</li>\n<li>Second</li>\n</ul>\n`;
  const m = memoryStore({ "index.html": start });
  const rng = seeded(20261110);
  const pieces = ["a", " ", "word ", "\n", "<b>x</b>", "é", "日本語", "🙂", "👩‍👩‍👧", "\r\n", "&amp;", "\t", "—"];
  const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  await withRoom(m, async (room) => {
    const ps: (Awaited<ReturnType<typeof peer>> & { connected: boolean })[] = [];
    for (let i = 0; i < 5; i++) ps.push({ ...(await peer(room, person(`P${i}`))), connected: true });
    const reconnect = (p: (typeof ps)[number]) => {
      p.joined = joinLocal(room, p.doc, p.aw);
      p.connected = true;
    };
    for (let r = 0; r < 400; r++) {
      const p = rng.pick(ps),
        t = p.text().toString();
      const roll = rng();
      const safe = (i: number) => (isLowSurrogate(t.charCodeAt(i)) ? i - 1 : i);
      if (roll < 0.55) p.text().insert(safe(rng.int(t.length + 1)), rng.pick(pieces));
      else if (roll < 0.9 && t.length > 50) {
        const from = safe(rng.int(t.length - 1));
        const to = safe(Math.min(t.length, from + 1 + rng.int(12)));
        if (to > from) p.text().delete(from, to - from);
      } else if (roll < 0.95 && p.connected) {
        // Off the network: its edits wait in its own replica.
        p.joined.leave();
        p.connected = false;
      } else if (!p.connected) reconnect(p);
      // Now and then some of the messages on their way land before the next edit (each goes in a microtask).
      if (rng() < 0.2) for (let i = 0; i < 3; i++) await null;
    }
    for (const p of ps) if (!p.connected) reconnect(p);
    const text = () => ps[0].text().toString();
    await until(() => ps.every((p) => p.text().toString() == text()) && room.text("index.html") == text());
    // Every hand made edits, and the text is not the start's.
    expect(text()).not.toBe(start);
    // Storage has the same text, unicode and all; so does a newcomer.
    await Effect.runPromise(room.flush);
    expect(m.get("index.html")).toBe(text());
    const late = await peer(room, person("Late"));
    expect(late.text().toString()).toBe(text());
  });
});

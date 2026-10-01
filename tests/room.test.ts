// The document room without a browser: participants converge, files are
// written back and merged in from storage, the agent's workspace aims edits
// by exact match, and every edit is attributed to whoever made it.

import { expect, test } from "bun:test";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import * as Layer from "effect/Layer";
import { FileStore, Room, StateStore, joinLocal } from "../room";
import * as Effect from "effect/Effect";
import { YjsWorkspace, type WorkspaceError } from "../workspace";
import { authorOf, files, introduce, type Author } from "../src/room/doc";

/** Files in memory, as the room's storage (no saved state: each room starts afresh). */
function memoryStore(init: Record<string, string>) {
  const data = new Map(Object.entries(init).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  const writes: string[] = [];
  const files = Layer.succeed(FileStore, {
    list: Effect.sync(() => [...data.keys()]),
    read: (p) => Effect.sync(() => data.get(p) ?? null),
    write: (p, text) => Effect.sync(() => { writes.push(p); data.set(p, new TextEncoder().encode(text)); }),
  });
  return { layer: Layer.merge(files, StateStore.none), writes, get: (p: string) => new TextDecoder().decode(data.get(p)), set: (p: string, t: string) => data.set(p, new TextEncoder().encode(t)) };
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
  joinLocal(room, doc, aw);
  await tick();
  introduce(doc, me);
  await tick();
  return { doc, aw, text: (p = "index.html") => files(doc).get(p)! };
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
    await new Promise((r) => setTimeout(r, 80));
    expect(m.get("index.html")).toBe("<p>just one</p>");
    a.text().insert(3, "not ");
    await tick();
  }, { writeDelay: 30 });
  // Closed before the delay was up: written on the way out.
  expect(m.get("index.html")).toBe("<p>not just one</p>");
  expect(m.writes).toEqual(["index.html", "index.html"]);
});

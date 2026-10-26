// The document room without a browser: participants converge, files are
// written back and merged in from storage, the agent's workspace aims edits
// by exact match, and every edit is attributed to whoever made it.

import { expect, test } from "bun:test";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import * as Layer from "effect/Layer";
import { FileStore, Room, StateStore, joinLocal } from "../document/room";
import * as Effect from "effect/Effect";
import { PACE, YjsWorkspace, type Pacer, type WorkspaceError } from "../agents/document/workspace";
import { authorOf, files, introduce, type Author } from "../document/content";

/** Files in memory, as the room's storage (no saved state: each room starts afresh). */
function memoryStore(init: Record<string, string>) {
  const data = new Map(Object.entries(init).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  const writes: string[] = [];
  const files = Layer.succeed(FileStore, {
    list: Effect.sync(() => [...data.keys()]),
    read: (p) => Effect.sync(() => data.get(p) ?? null),
    write: (p, text) => Effect.sync(() => { writes.push(p); data.set(p, new TextEncoder().encode(text)); }),
  });
  return { layer: StateStore.none.pipe(Layer.provideMerge(files)), writes, get: (p: string) => new TextDecoder().decode(data.get(p)), set: (p: string, t: string) => data.set(p, new TextEncoder().encode(t)) };
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
    await new Promise((r) => setTimeout(r, 80));
    expect(m.get("index.html")).toBe("<p>just one</p>");
    a.text().insert(3, "not ");
    await tick();
  }, { writeDelay: 30 });
  // Closed before the delay was up: written on the way out.
  expect(m.get("index.html")).toBe("<p>not just one</p>");
  expect(m.writes).toEqual(["index.html", "index.html"]);
});

test("a paced edit shows the old text, types the new in steps, and ends as the edit at once would", async () => {
  const start = "<h1>Notes</h1>\n<p>The quick brown fox.</p>\n<p>Jumps over the dog.</p>\n";
  const edits = [
    { oldText: "<h1>Notes</h1>", newText: "<h1>Field notes from the coast</h1>" },
    { oldText: " brown", newText: "" },
    { oldText: "the dog", newText: "the lazy old dog, twice" },
  ];
  const agentMe: Author = { user: "ada", name: "Ada’s agent", color: "#12a594", kind: "agent" };
  // At once, for the text it should end with.
  let once = "";
  await withRoom(memoryStore({ "index.html": start }), async (room) => {
    const agent = await peer(room, agentMe);
    Effect.runSync(new YjsWorkspace(agent.doc, agentMe, () => true, {}).edit("index.html", edits));
    once = agent.text().toString();
  });
  await withRoom(memoryStore({ "index.html": start }), async (room) => {
    const ada = await peer(room, person("Ada"));
    const agent = await peer(room, agentMe);
    const origin = {};
    const undo = new Y.UndoManager(files(agent.doc), { trackedOrigins: new Set([origin]), captureTimeout: Infinity });
    const shown: { anchor: number; head: number | null }[] = [];
    const abs = (r: Y.RelativePosition) => Y.createAbsolutePositionFromRelativePosition(r, agent.doc)!.index;
    let waits = 0,
      during: (() => void) | null = null;
    const pacer: Pacer = {
      cursor: (_path, anchor, head) => shown.push({ anchor: abs(anchor), head: head && abs(head) }),
      wait: async () => {
        waits++;
        during?.();
        during = null;
        await tick();
      },
      revert: () => {
        undo.undo();
        undo.stopCapturing();
      },
    };
    const ws = new YjsWorkspace(
      agent.doc,
      agentMe,
      () => true,
      origin,
      null,
      () => null,
      pacer
    );
    // Ada types at the end while the agent shows its first selection.
    during = () => ada.text().insert(ada.text().length, "<p>Ada's line.</p>\n");
    const r = await Effect.runPromise(ws.edit("index.html", edits));
    await tick();
    expect(agent.text().toString()).toBe(once + "<p>Ada's line.</p>\n");
    expect(ada.text().toString()).toBe(agent.text().toString());
    // First the old heading selected, then the caret after each step of the new text.
    expect(shown[0]).toEqual({ anchor: 4, head: 9 });
    expect(shown.filter((s) => s.head == null).length).toBeGreaterThan(3);
    expect(waits).toBeGreaterThan(3);
    expect(r.at).toBe(agent.text().toString().indexOf(", twice") + ", twice".length);
    // One undo step takes back the whole call, and keeps Ada's line.
    undo.stopCapturing();
    expect(undo.undoStack.length).toBe(1);
    undo.undo();
    expect(agent.text().toString()).toBe(start + "<p>Ada's line.</p>\n");

    // Someone types in the old text of a later change while it shows: the call takes back what it applied, and fails.
    during = () => {};
    let selections = 0;
    const cursor = pacer.cursor;
    pacer.cursor = (path, anchor, head) => {
      if (head && ++selections == 2) during = () => ada.text().insert(ada.text().toString().indexOf("brown") + 2, "o");
      cursor(path, anchor, head);
    };
    undo.clear();
    const err = await Effect.runPromise(Effect.flip(ws.edit("index.html", edits)));
    await tick();
    expect(err.reason).toBe("changed");
    expect(agent.text().toString()).toBe(start.replace("brown", "broown") + "<p>Ada's line.</p>\n");
  });
});

test("a paced edit streams long text with tags in many steps, and others never see a half tag", async () => {
  const para =
    '<p>The <b>spring release</b> brings three things: faster pages, a new <a href="/docs">guide</a> for teams &amp; their agents, and <i>live</i> carets. ' +
    "Each of them took a season of work, and each of them shows on every page from today, for every reader and every writer of a document.</p>\n";
  const start = "<h1>Notes</h1>\n";
  const agentMe: Author = { user: "ada", name: "Ada’s agent", color: "#12a594", kind: "agent" };
  await withRoom(memoryStore({ "index.html": start }), async (room) => {
    const bo = await peer(room, person("Bo"));
    const agent = await peer(room, agentMe);
    let waited = 0;
    const pacer: Pacer = {
      cursor: () => {},
      wait: async (ms) => {
        waited += ms;
        await tick();
      },
      revert: () => {},
    };
    const ws = new YjsWorkspace(
      agent.doc,
      agentMe,
      () => true,
      {},
      null,
      () => null,
      pacer
    );
    const seen: string[] = [];
    bo.doc.on("update", () => seen.push(bo.text().toString()));
    // A tag whole: what's left with every tag and entity out has no < > or &.
    const whole = (s: string) => !/[<>&]/.test(s.replace(/<[^<>]*>|&[#\w]+;/g, ""));
    const balanced = (s: string) =>
      ["p", "b", "a", "i"].every((n) => s.split(`<${n}>`).length + s.split(`<${n} `).length - 1 == s.split(`</${n}>`).length);

    await Effect.runPromise(ws.edit("index.html", [{ oldText: start, newText: start + para }]));
    await tick();
    expect(bo.text().toString()).toBe(start + para);
    // About 0.5 s at 600 characters a second, in many steps; each a whole page.
    expect(para.length).toBeGreaterThan(280);
    expect(waited).toBeGreaterThan(350);
    expect(waited).toBeLessThan(700);
    expect(seen.length).toBeGreaterThan(10);
    expect(seen.filter((s) => !whole(s) || !balanced(s))).toEqual([]);

    // Text that doesn't fit the time streams faster, and never jumps to the end.
    seen.length = waited = 0;
    const long = para.repeat(10);
    await Effect.runPromise(ws.edit("index.html", [{ oldText: para, newText: long }]));
    await tick();
    expect(bo.text().toString()).toBe(start + long);
    expect(waited).toBeLessThanOrEqual(PACE.budgetMs);
    expect(waited).toBeGreaterThan(PACE.budgetMs / 2);
    expect(seen.length).toBeGreaterThan(50);
    expect(seen.filter((s) => !whole(s) || !balanced(s))).toEqual([]);

    // A write streams the same way: its changes from the merge.
    seen.length = waited = 0;
    await Effect.runPromise(ws.read("index.html"));
    await Effect.runPromise(ws.write("index.html", start + para));
    await tick();
    expect(bo.text().toString()).toBe(start + para);
    expect(seen.filter((s) => !whole(s) || !balanced(s))).toEqual([]);
    seen.length = waited = 0;
    await Effect.runPromise(ws.write("index.html", start + para + para.replace("spring", "autumn")));
    await tick();
    expect(seen.length).toBeGreaterThan(10);
    expect(waited).toBeGreaterThan(350);
    expect(seen.filter((s) => !whole(s) || !balanced(s))).toEqual([]);

    // A very large call applies at once.
    seen.length = waited = 0;
    const huge = "<p>" + "word ".repeat(PACE.wholeChars / 5) + "</p>\n";
    await Effect.runPromise(ws.write("big.html", huge));
    await tick();
    expect(bo.text("big.html").toString()).toBe(huge);
    expect(waited).toBe(0);
  });
});

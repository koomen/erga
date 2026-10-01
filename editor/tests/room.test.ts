// The document room without a browser: participants converge, files are
// written back and merged in from storage, the agent's workspace aims edits
// by exact match, and every edit is attributed to whoever made it.

import { expect, test } from "bun:test";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Room, joinLocal, type FileStore } from "../room";
import { YjsWorkspace } from "../workspace";
import { authorOf, files, introduce, type Author } from "../src/room/doc";

function memoryStore(init: Record<string, string>) {
  const data = new Map(Object.entries(init).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  const writes: string[] = [];
  const store: FileStore = {
    list: async () => [...data.keys()],
    read: async (p) => data.get(p) ?? null,
    write: async (p, text) => { writes.push(p); data.set(p, new TextEncoder().encode(text)); },
  };
  return { store, writes, get: (p: string) => new TextDecoder().decode(data.get(p)), set: (p: string, t: string) => data.set(p, new TextEncoder().encode(t)) };
}

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
  const room = await Room.open(m.store);
  expect(room.text("index.html")).toBe("<p>Hello world</p>");
  expect(room.text("logo.png")).toBeNull();

  const a = await peer(room, person("Ada")), b = await peer(room, person("Bo"));
  expect(b.text().toString()).toBe("<p>Hello world</p>");
  a.text().insert(3, "Hi! ");
  b.text().insert(14, " again");
  await tick();
  expect(a.text().toString()).toBe("<p>Hi! Hello world again</p>");
  expect(b.text().toString()).toBe(a.text().toString());
  await room.flush();
  expect(m.get("index.html")).toBe("<p>Hi! Hello world again</p>");
  expect(m.writes).toEqual(["index.html"]);
});

test("an edit on disk merges with the room's unsaved edits", async () => {
  const m = memoryStore({ "index.md": "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n" });
  const room = await Room.open(m.store);
  const a = await peer(room, person("Ada"));
  // In the room, not yet on disk:
  a.text("index.md").insert(a.text("index.md").toString().indexOf("Second"), "A new ");
  await tick();
  // Meanwhile, on disk:
  m.set("index.md", "# A better title\n\nFirst paragraph.\n\nSecond paragraph.\n");
  await room.fileChanged("index.md");
  await tick();
  expect(a.text("index.md").toString()).toBe("# A better title\n\nFirst paragraph.\n\nA new Second paragraph.\n");
  await room.flush();
  expect(m.get("index.md")).toBe("# A better title\n\nFirst paragraph.\n\nA new Second paragraph.\n");
  // Our own write doesn't come back as a change.
  await room.fileChanged("index.md");
  expect(room.text("index.md")).toBe("# A better title\n\nFirst paragraph.\n\nA new Second paragraph.\n");
});

test("the agent's edits aim at the current text and keep others' edits", async () => {
  const m = memoryStore({ "index.html": "<h1>Notes</h1>\n<p>The quick brown fox.</p>\n<p>Jumps over the dog.</p>\n" });
  const room = await Room.open(m.store);
  const ada = await peer(room, person("Ada"));
  const agentMe: Author = { user: "ada", name: "Ada’s agent", color: "#12a594", kind: "agent" };
  const agent = await peer(room, agentMe);
  const ws = new YjsWorkspace(agent.doc, agentMe, () => true, {});

  // Ada types while the agent works; the agent's edit lands on top.
  ada.text().insert(ada.text().toString().indexOf("dog"), "lazy ");
  await tick();
  ws.edit("index.html", [{ oldText: "quick brown fox", newText: "quick red fox" }]);
  await tick();
  expect(ada.text().toString()).toBe("<h1>Notes</h1>\n<p>The quick red fox.</p>\n<p>Jumps over the lazy dog.</p>\n");

  // Text the agent remembers but that's since changed: a clean failure.
  expect(() => ws.edit("index.html", [{ oldText: "over the dog", newText: "under the dog" }])).toThrow(/isn't in the current text/);
  expect(() => ws.edit("index.html", [{ oldText: "<p>", newText: "<p class=x>" }])).toThrow(/more than once/);

  // write applies only the differences, so a concurrent edit elsewhere survives.
  const draft = ws.read("index.html").replace("Notes", "Field notes");
  ada.text().insert(ada.text().toString().indexOf("Jumps"), "It ");
  await tick();
  ws.write("index.html", draft);
  await tick();
  expect(ada.text().toString()).toBe("<h1>Field notes</h1>\n<p>The quick red fox.</p>\n<p>It Jumps over the lazy dog.</p>\n");

  // New files, and no escaping the folder; a viewer's agent can't edit.
  ws.write("notes/extra.md", "hi\n");
  await tick();
  expect(room.text("notes/extra.md")).toBe("hi\n");
  expect(() => ws.read("../secret")).toThrow(/outside/);
  const viewer = new YjsWorkspace(agent.doc, agentMe, () => false, {});
  expect(() => viewer.edit("index.html", [{ oldText: "red", newText: "blue" }])).toThrow(/only view/);
});

test("every edit is attributed, deletions included", async () => {
  const m = memoryStore({ "index.html": "<p>one two three</p>" });
  const room = await Room.open(m.store);
  const ada = await peer(room, person("Ada"));
  const bo = await peer(room, person("Bo"));
  const agentMe: Author = { user: "bo", name: "Bo’s agent", color: "#12a594", kind: "agent" };
  const agent = await peer(room, agentMe);
  const ws = new YjsWorkspace(agent.doc, agentMe, () => true, {});
  const seen: (string | undefined)[] = [];
  ada.text().observe((_e, tr) => seen.push(authorOf(ada.doc, tr)?.name));

  bo.doc.transact(() => bo.text().insert(3, "zero "));
  await tick();
  ws.edit("index.html", [{ oldText: " two", newText: "" }]); // only deletes
  await tick();
  m.set("index.html", "<p>zero one three!</p>");
  await room.fileChanged("index.html");
  await tick();
  expect(seen).toEqual(["Bo", "Bo’s agent", "On disk"]);
});

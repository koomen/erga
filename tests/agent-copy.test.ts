// cp, and mv into another document, as an agent calls them (POST /api/tools/<name>, with a token), on the whole app in
// memory (tests/helpers/app.ts): Pete's task, "move this presentation into the project as index.html, and the notes as
// a separate notes page", in three calls. Before cp, the agent read both pages and typed them back through write: 31
// calls, and most of its time.

import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { person, server, tool, type Server } from "./helpers/app";
import { until } from "./helpers/until";

const GLIDE = new URL("../e2e/fixtures/glide/", import.meta.url).pathname;
const DECK = readFileSync(`${GLIDE}index.html`, "utf8");
const NOTES = readFileSync(`${GLIDE}notes.html`, "utf8");
// A 1×1 PNG: an image, which the copy keeps whole.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A person with a token, and their calls: `call` gives the answer, `ok` checks that it passed first. */
async function agent(s: Server, label: string) {
  const p = await person(s);
  const token = await p.token(label);
  const call = (name: string, args: Record<string, unknown>) => tool(s, token, name, args);
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    expect(r.ok, `${name}: ${r.text}`).toBe(true);
    return r;
  };
  return { p, call, ok };
}

test("Pete's task in three calls: the notes to notes.html, the deck and its images into the project, the old slides page gone", async () => {
  const { p, ok } = await agent(server(), "Copy test");
  const deck = await p.make(),
    project = await p.make();
  // The presentation, a document with an image; the project, its notes as its page and an old copy of the slides.
  await ok("write", { document: deck, path: "index.html", content: DECK });
  await ok("write", { document: deck, path: "shots/one.png", content_base64: PNG });
  await ok("set_kind", { document: project, kind: "project" });
  await ok("write", { document: project, path: "index.html", content: NOTES });
  await ok("write", { document: project, path: "slides.html", content: DECK.replace("First frame", "An old first frame") });

  // The task.
  const notes = JSON.parse((await ok("cp", { document: project, from: "index.html", to: "notes.html" })).text);
  expect([notes.written, notes.replaced]).toEqual([["notes.html"], []]);
  const moved = JSON.parse((await ok("cp", { document: deck, from: ".", to: ".", to_document: project })).text);
  expect(moved.written.sort()).toEqual(["index.html", "shots/one.png"]);
  expect(moved.replaced).toEqual(["index.html"]);
  await ok("rm", { document: project, path: "slides.html" });

  // The project now: the deck as its page, the notes beside it, the image whole. (Its title: the next case.)
  expect((await ok("read", { document: project, path: "index.html" })).text).toBe(DECK);
  expect((await ok("read", { document: project, path: "notes.html" })).text).toBe(NOTES);
  const image = await ok("read", { document: project, path: "shots/one.png" });
  expect((image.result as { type: string; data?: string }[]).find((c) => c.type == "image")?.data).toBe(PNG);
  const pages = JSON.parse((await ok("ls", { document: project })).text);
  expect(
    pages.entries
      .filter((e: { type: string }) => e.type == "page")
      .map((e: { path: string }) => e.path)
      .sort()
  ).toEqual(["index.html", "notes.html"]);
  // The presentation is as it was: a copy leaves it be.
  expect((await ok("read", { document: deck, path: "index.html" })).text).toBe(DECK);
});

// In a case of its own: a document's row follows its edits at most every 2 seconds (document/document.ts,
// DIRECTORY_EVERY_MS), and at once for the first edit. Here the copy is the project's first edit, so no case waits.
test("the deck copied over a project's page: the project's title follows the deck's", async () => {
  const { p, ok } = await agent(server(), "Title test");
  const deck = await p.make();
  await ok("write", { document: deck, path: "index.html", content: DECK });
  const project = JSON.parse((await ok("create_document", { kind: "project", files: { "index.html": NOTES } })).text).id as string;
  expect(JSON.parse((await ok("ls", { document: project })).text).title).toBe("Speaker notes");
  await ok("cp", { document: deck, from: ".", to: ".", to_document: project });
  await until(async () => JSON.parse((await ok("ls", { document: project })).text).title == "Glide");
});

test("mv into another document takes a folder whole and deletes it here; a document's own page can't leave it; nothing copies onto itself", async () => {
  const { p, call } = await agent(server(), "Move test");
  const a = await p.make(),
    b = await p.make();
  expect((await call("write", { document: a, path: "shots/one.png", content_base64: PNG })).ok).toBe(true);
  expect((await call("write", { document: a, path: "shots/data.json", content: '{"n": 1}' })).ok).toBe(true);
  const moved = JSON.parse((await call("mv", { document: a, from: "shots", to: "images/", to_document: b })).text);
  expect(moved.written.sort()).toEqual(["images/shots/data.json", "images/shots/one.png"]);
  expect(moved.removed.sort()).toEqual(["shots/data.json", "shots/one.png"]);
  expect((await call("ls", { document: a })).text).not.toContain("shots");
  expect((await call("read", { document: b, path: "images/shots/data.json" })).text).toBe('{"n": 1}');
  const own = await call("mv", { document: a, from: "index.html", to: "index.html", to_document: b });
  expect(own.ok).toBe(false);
  expect(own.text).toMatch(/index\.html is .*'s own page, which can't leave it: cp it instead/);
  const self = await call("cp", { document: b, from: "images", to: "images/inner/" });
  expect(self.ok).toBe(false);
  expect(self.text).toMatch(/can't be copied onto itself, or into itself/);
  const none = await call("cp", { document: a, from: "nothing.css", to: "x.css" });
  expect(none.text).toMatch(/There's no file or folder nothing\.css in/);
});

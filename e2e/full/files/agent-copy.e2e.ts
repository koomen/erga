// cp, and mv into another document, as an agent calls them (POST /api/tools/<name>, with a token): Pete's task, "move
// this presentation into the project as index.html, and the notes as a separate notes page", in three calls. Before
// cp, the agent read both pages and typed them back through write: 31 calls, and most of its time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test } from "../../helpers/fixtures";
import { ROOT } from "../../helpers/env";
import { person } from "../versions/versions";
import { runTool, textOf } from "../../helpers/tools";

await servers.main();

const DECK = readFileSync(join(ROOT, "e2e/fixtures/glide/index.html"), "utf8");
const NOTES = readFileSync(join(ROOT, "e2e/fixtures/glide/notes.html"), "utf8");
// A 1×1 PNG: an image, which the copy keeps whole.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("Pete's task in three calls: the notes to notes.html, the deck and its images into the project, the old slides page gone", async () => {
  const s = await servers.main();
  const pete = await person(s, `pete${crypto.randomUUID().slice(0, 6)}`);
  const token = await pete.token("Copy test");
  const deck = await pete.newDoc(),
    project = await pete.newDoc();
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await runTool(s.root, name, args, { token });
    return { ok: r.ok, text: r.ok ? textOf(r.result) : (r.error ?? ""), result: r.result };
  };
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    expect(r.ok, `${name}: ${r.text}`).toBe(true);
    return r;
  };
  // The presentation, a document with an image; the project, its notes as its page and an old copy of the slides.
  await ok("write", { document: deck.id, path: "index.html", content: DECK });
  await ok("write", { document: deck.id, path: "shots/one.png", content_base64: PNG });
  await ok("make_project", { document: project.id });
  await ok("write", { document: project.id, path: "index.html", content: NOTES });
  await ok("write", { document: project.id, path: "slides.html", content: DECK.replace("First frame", "An old first frame") });

  // The task.
  const notes = JSON.parse((await ok("cp", { document: project.id, from: "index.html", to: "notes.html" })).text);
  expect([notes.written, notes.replaced]).toEqual([["notes.html"], []]);
  const moved = JSON.parse((await ok("cp", { document: deck.id, from: ".", to: ".", to_document: project.id })).text);
  expect(moved.written.sort()).toEqual(["index.html", "shots/one.png"]);
  expect(moved.replaced).toEqual(["index.html"]);
  await ok("rm", { document: project.id, path: "slides.html" });

  // The project now: the deck as its page, the notes beside it, the image whole; the title follows the deck's.
  expect((await ok("read", { document: project.id, path: "index.html" })).text).toBe(DECK);
  expect((await ok("read", { document: project.id, path: "notes.html" })).text).toBe(NOTES);
  const image = await ok("read", { document: project.id, path: "shots/one.png" });
  expect((image.result as { type: string; data?: string }[]).find((c) => c.type == "image")?.data).toBe(PNG);
  const pages = JSON.parse((await ok("list_pages", { document: project.id })).text);
  expect(
    pages.entries
      .filter((e: { type: string }) => e.type == "page")
      .map((e: { path: string }) => e.path)
      .sort()
  ).toEqual(["index.html", "notes.html"]);
  await expect
    .poll(async () => JSON.parse((await ok("get_title", { document: project.id })).text).title, { timeout: 10_000 })
    .toBe("Glide");
  // The presentation is as it was: a copy leaves it be.
  expect((await ok("read", { document: deck.id, path: "index.html" })).text).toBe(DECK);
});

test("mv into another document takes a folder whole and deletes it here; a document's own page can't leave it; nothing copies onto itself", async () => {
  const s = await servers.main();
  const ada = await person(s, `ada${crypto.randomUUID().slice(0, 6)}`);
  const token = await ada.token("Move test");
  const a = await ada.newDoc(),
    b = await ada.newDoc();
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await runTool(s.root, name, args, { token });
    return { ok: r.ok, text: r.ok ? textOf(r.result) : (r.error ?? "") };
  };
  expect((await call("write", { document: a.id, path: "shots/one.png", content_base64: PNG })).ok).toBe(true);
  expect((await call("write", { document: a.id, path: "shots/data.json", content: '{"n": 1}' })).ok).toBe(true);
  const moved = JSON.parse((await call("mv", { document: a.id, from: "shots", to: "images/", to_document: b.id })).text);
  expect(moved.written.sort()).toEqual(["images/shots/data.json", "images/shots/one.png"]);
  expect(moved.removed.sort()).toEqual(["shots/data.json", "shots/one.png"]);
  expect((await call("ls", { document: a.id })).text).not.toContain("shots");
  expect((await call("read", { document: b.id, path: "images/shots/data.json" })).text).toBe('{"n": 1}');
  const own = await call("mv", { document: a.id, from: "index.html", to: "index.html", to_document: b.id });
  expect(own.ok).toBe(false);
  expect(own.text).toMatch(/index\.html is .*'s own page, which can't leave it: cp it instead/);
  const self = await call("cp", { document: b.id, from: "images", to: "images/inner/" });
  expect(self.ok).toBe(false);
  expect(self.text).toMatch(/can't be copied onto itself, or into itself/);
  const none = await call("cp", { document: a.id, from: "nothing.css", to: "x.css" });
  expect(none.text).toMatch(/There's no file or folder nothing\.css in/);
});

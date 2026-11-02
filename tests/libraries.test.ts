// Erga's editing libraries (libs/): each at one address, /erga/<name>/editor.js, its newest build; Erga adds erga/text to
// a page that brings no editor of its own (server/pages/reader.ts).
import { expect, test } from "bun:test";
import { libraryOf } from "../server/pages/index.ts";
import { bringsEditor } from "../shared/page-html.ts";

test("a library's address names one of Erga's libraries", () => {
  expect(libraryOf("/erga/text/editor.js")).toBe("text");
  expect(libraryOf("/erga/nothing/editor.js")).toBeNull();
  expect(libraryOf("/erga/text/other.js")).toBeNull();
  expect(libraryOf("/erga/text")).toBeNull();
});

test("a page brings its own editor when it imports a library or says so; else Erga adds erga/text", () => {
  expect(bringsEditor(`<html><head><script type="module" src="https://erga.dev/erga/slides/editor.js"></script></head></html>`)).toBe(true);
  expect(bringsEditor(`<meta name="erga-editor" content="own">`)).toBe(true);
  expect(bringsEditor(`<meta content=own name=erga-editor>`)).toBe(true);
  expect(bringsEditor(`<html><head><script src="app.js"></script><meta name="erga-editor" content="text"></head></html>`)).toBe(false);
  expect(bringsEditor(`<p>See https://erga.dev/erga/text/editor.js</p>`)).toBe(false);
});

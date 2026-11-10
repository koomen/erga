// The line an edit's error names (agents/document/nearest.ts): the file's line nearest to an oldText that isn't there.
import { expect, test } from "bun:test";
import { filesNote, nearestLine, nearestNote } from "../agents/document/nearest.ts";

const FILE = `<!doctype html>
<body>
  <h1>Trip</h1>
  <p>Hello</p>
  <p>We go to Lisbon in May.</p>
</body>`;

test("one line: the file's line that starts like it, and where they differ", () => {
  expect(nearestLine(FILE, "<p>Hello, world</p>")).toEqual({ line: 4, text: "  <p>Hello</p>", at: 11 });
  expect(nearestLine(FILE, "We go to Lisbon in June.")).toEqual({ line: 5, text: "  <p>We go to Lisbon in May.</p>", at: 25 });
});

test("many lines: the first line that differs", () => {
  expect(nearestLine(FILE, "<h1>Trip</h1>\n  <p>Hallo</p>")).toEqual({ line: 4, text: "  <p>Hello</p>", at: 7 });
  // The indent of a later line counts.
  expect(nearestLine(FILE, "<h1>Trip</h1>\n<p>Hello</p>")).toEqual({ line: 4, text: "  <p>Hello</p>", at: 1 });
});

test("nothing like it: no line", () => {
  expect(nearestLine(FILE, "zzz")).toBeNull();
  expect(nearestLine(FILE, "\n \n")).toBeNull();
  expect(nearestNote(FILE, "zzz")).toBe("");
});

test("the note says the line and the character", () => {
  expect(nearestNote(FILE, "<p>Hello, world</p>")).toBe(
    " Nearest, line 4:\n    <p>Hello</p>\nIt differs from oldText at character 11 of that line."
  );
});

test("the files, at most 40", () => {
  expect(filesNote(["a.html", "b.js"])).toBe(" The files: a.html, b.js.");
  expect(filesNote(Array.from({ length: 42 }, (_, i) => `f${i}`))).toEndWith("f39, and 2 more (ls lists them).");
  expect(filesNote([])).toBe(" The document has no files.");
});

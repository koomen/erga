// Erga's libraries (libs/): each at one address, /erga/<name>/editor.js, its newest build; Erga adds erga/text to a page
// that brings no editor of its own (server/pages/reader.ts).
import { expect, test } from "bun:test";
import { libraryOf } from "../server/pages/index.ts";
import { bringsEditor } from "../shared/page-html.ts";
import { readerPage } from "../server/pages/reader.ts";

test("a library's address names one of Erga's libraries", () => {
  expect(libraryOf("/erga/text/editor.js")).toBe("text");
  expect(libraryOf("/erga/nothing/editor.js")).toBeNull();
  expect(libraryOf("/erga/text/other.js")).toBeNull();
  expect(libraryOf("/erga/text")).toBeNull();
});

test("a page brings its own editor when it imports erga/text or says so; else Erga adds erga/text", () => {
  expect(bringsEditor(`<html><head><script type="module" src="https://erga.dev/erga/text/editor.js"></script></head></html>`)).toBe(true);
  // erga/steps is a presentation's steps, not an editor: Erga adds erga/text to its page.
  expect(bringsEditor(`<html><head><script type="module" src="https://erga.dev/erga/steps/editor.js"></script></head></html>`)).toBe(false);
  expect(bringsEditor(`<meta name="erga-editor" content="own">`)).toBe(true);
  expect(bringsEditor(`<meta content=own name=erga-editor>`)).toBe(true);
  expect(bringsEditor(`<html><head><script src="app.js"></script><meta name="erga-editor" content="text"></head></html>`)).toBe(false);
  expect(bringsEditor(`<p>See https://erga.dev/erga/text/editor.js</p>`)).toBe(false);
});

test("a page loads Erga's libraries from the server it's on; its other scripts and its text stay as written", () => {
  const html = `<html><head><script type="module" src="https://erga.dev/erga/steps/editor.js"></script><script src="https://erga.dev/app.js"></script></head><body><p>https://erga.dev/erga/text/editor.js</p></body></html>`;
  const page = readerPage(html, { shell: "https://staging.erga.dev", prefix: "/t/x/", src: "", editor: false });
  expect(page).toContain(`<script type="module" src="https://staging.erga.dev/erga/steps/editor.js"></script>`);
  expect(page).toContain(`<script src="https://erga.dev/app.js"></script>`);
  expect(page).toContain(`<p>https://erga.dev/erga/text/editor.js</p>`);
  expect(libraryOf("/erga/steps/editor.js")).toBe("steps");
  expect(libraryOf("/erga/slides/editor.js")).toBeNull();
});

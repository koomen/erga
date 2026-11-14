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
  expect(bringsEditor(`<html><head><script type="module" src="/erga/text/editor.js"></script></head></html>`)).toBe(true);
  // erga/steps is a presentation's steps, not an editor: Erga adds erga/text to its page.
  expect(bringsEditor(`<html><head><script type="module" src="/erga/steps/editor.js"></script></head></html>`)).toBe(false);
  expect(bringsEditor(`<meta name="erga-editor" content="own">`)).toBe(true);
  expect(bringsEditor(`<meta content=own name=erga-editor>`)).toBe(true);
  expect(bringsEditor(`<html><head><script src="app.js"></script><meta name="erga-editor" content="text"></head></html>`)).toBe(false);
  expect(bringsEditor(`<p>See /erga/text/editor.js</p>`)).toBe(false);
});

test("a page names Erga's libraries by their path alone, and loads them from the server it's on; its other scripts and its text stay as written", () => {
  const html = `<html><head><script type="module" src="/erga/steps/editor.js"></script><script src="/app.js"></script><script src="https://other.example/erga/steps/editor.js"></script></head><body><p>/erga/text/editor.js</p></body></html>`;
  for (const shell of ["https://erga.example", "https://staging.erga.example", "http://localhost:4712"]) {
    const page = readerPage(html, { shell, prefix: "/t/x/", src: "", editor: false });
    expect(page).toContain(`<script type="module" src="${shell}/erga/steps/editor.js"></script>`);
    // Another server's library is that page's own choice: no address of any server is special.
    expect(page).toContain(`<script src="/app.js"></script><script src="https://other.example/erga/steps/editor.js"></script>`);
    expect(page).toContain(`<p>/erga/text/editor.js</p>`);
  }
  expect(libraryOf("/erga/steps/editor.js")).toBe("steps");
  expect(libraryOf("/erga/slides/editor.js")).toBeNull();
});

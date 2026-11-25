// Offline editing's pure parts: the page the editor puts in the browser's copy is the page the pages origin makes from
// the same text (shared/page-html.ts, pageAgain), the address a page is kept under, and where Erga's service worker
// may be (server/documents/pages-origin.ts, workerHere).

import { afterAll, afterEach, expect, test } from "bun:test";
import { bringsEditor, headIn, pageAgain, sourceDigest } from "../shared/page-html.ts";
import { keptAddress, pencilAddress } from "../shared/offline.ts";
import type { AssetManifest } from "../shared/assets.ts";
import { useAssets } from "../server/pages/index.ts";
import { inlineCall } from "../server/pages/inline.ts";
import { readerPage } from "../server/pages/reader.ts";
import { workerHere } from "../server/documents/index.ts";
import type { Platform } from "../server/platform.ts";

const SHELL = "https://erga.test",
  PREFIX = "/t/tok/";

const MANIFEST: AssetManifest = {
  files: { "frame.js": "/_erga/frame-bbbb2222.js", "tools.js": "/_erga/tools-cccc3333.js" },
  deps: { "frame.js": ["/_erga/chunk-gggg7777.js"], "tools.js": [] },
  frame: ["/_erga/frame-bbbb2222.js", "/_erga/chunk-gggg7777.js", "/_erga/tools-cccc3333.js"],
  integrity: {
    "/_erga/frame-bbbb2222.js": "sha384-frame",
    "/_erga/chunk-gggg7777.js": "sha384-chunk",
    "/_erga/tools-cccc3333.js": "sha384-tools",
  },
  fonts: {
    css: "@font-face{font-family:'Erga Inter';font-display:swap;src:url(/_erga/fonts/inter-iiii9999.woff2) format('woff2')}",
    preload: "/_erga/fonts/inter-iiii9999.woff2",
    page: '@font-face{font-family:"Literata";src:url(/_erga/fonts/literata-llll0000.woff2) format("woff2")}',
  },
};

afterEach(() => useAssets(null));
afterAll(() => useAssets(null));

test("the page made again from another text is the page the pages origin makes from it, for a reader and an editor", () => {
  const before = `<!doctype html><html><head><title>A</title></head><body><p>Milk</p></body></html>`;
  const after = `<!doctype html><html><head><title>A</title></head><body><p>Milk, <b>eggs</b></p></body></html>`;
  const bare = `<p>Milk</p>`,
    doctype = `<!doctype html><p>Milk</p>`,
    html = `<html><body><p>Milk</p></body></html>`;
  for (const editor of [false, true])
    for (const from of [before, bare, doctype, html]) {
      const served = readerPage(from, { shell: SHELL, fonts: "", prefix: PREFIX, src: sourceDigest(from), editor, worker: true });
      const head = headIn(served);
      expect(head).not.toBeNull();
      expect(pageAgain(head!, after)).toBe(
        readerPage(after, { shell: SHELL, fonts: "", prefix: PREFIX, src: sourceDigest(after), editor, worker: true })
      );
    }
  expect(headIn(before), "a page Erga didn't make").toBeNull();
  expect(pageAgain("<script data-erga>x</script>", after), "a head that names no text").toBeNull();
});

test("headIn and pageAgain keep <style data-erga> fonts and all four editor scripts after them", () => {
  useAssets(MANIFEST);
  const before = `<!doctype html><html><head><title>A</title></head><body><p>Milk</p></body></html>`;
  const after = `<!doctype html><html><head><title>A</title></head><body><p>Milk, <b>eggs</b></p></body></html>`;
  for (const editor of [false, true]) {
    const served = readerPage(before, { shell: SHELL, fonts: SHELL, prefix: PREFIX, src: sourceDigest(before), editor, worker: true });
    const head = headIn(served);
    expect(head).not.toBeNull();
    expect(head!).toContain(`<style data-erga>@font-face{font-family:"Literata"`);
    if (editor) {
      expect(head!).toContain(`<script type="importmap" data-erga>`);
      for (const name of ["page-problems", "page-live-watch", "page-text-guard", "page-editing-api"] as const)
        expect(head!, name).toContain(`<script data-erga>${inlineCall(name)}</script>`);
    }
    expect(pageAgain(head!, after)).toBe(
      readerPage(after, { shell: SHELL, fonts: SHELL, prefix: PREFIX, src: sourceDigest(after), editor, worker: true })
    );
  }
});

test("pageAgain updates only the reader config's src, never an importmap, style or editor.src", () => {
  const after = `<p>After</p>`;
  const digest = sourceDigest(after);
  expect(pageAgain(`<script type="importmap" data-erga>{"imports":{"src":"fake"}}</script>`, after)).toBeNull();
  expect(pageAgain(`<style data-erga>/* "prefix":"/t/x/","src":"fake" */</style>`, after)).toBeNull();
  const fakeHead =
    `<script type="importmap" data-erga>{"imports":{"src":"keep-map","prefix":"/t/x/"}}</script>` +
    `<script data-erga>r({"shell":"${SHELL}","prefix":"/t/a\\"b/","src":"old","worker":true,"editor":{"src":"/erga/text/editor.js"}});</script>` +
    `<style data-erga>/* "src":"keep-css" */</style>`;
  const rebuilt = pageAgain(fakeHead, after)!;
  expect(rebuilt).toContain(`"src":"keep-map"`);
  expect(rebuilt).toContain(`"src":"keep-css"`);
  expect(rebuilt).toContain(`"editor":{"src":"/erga/text/editor.js"}`);
  expect(rebuilt).toContain(`"prefix":"/t/a\\"b/","src":"${digest}"`);
});

test("bringsEditor ignores HTML comments", () => {
  expect(bringsEditor(`<!-- <script type="module" src="/erga/text/editor.js"></script> --><p>Hi</p>`)).toBe(false);
  expect(bringsEditor(`<!--\n<meta name="erga-editor" content="own">\n--><p>Hi</p>`)).toBe(false);
  expect(bringsEditor(`<!-- <meta name="erga-editor" content="own">`)).toBe(false);
  expect(bringsEditor(`<!-- note --><meta name="erga-editor" content="own">`)).toBe(true);
  expect(bringsEditor(`<!-- note --><script type="module" src="/erga/text/editor.js"></script>`)).toBe(true);
});

test("a page is kept under its address without the editor's marks or its hash, apart from the file as a script fetches it", () => {
  expect(keptAddress("https://a-b.erga-pages.test/t/tok/blog/x.html?erga-edit&erga-y=40#3")).toBe(
    "https://a-b.erga-pages.test/t/tok/blog/x.html?erga-page="
  );
  expect(keptAddress("https://erga.test/ada/notes?edit")).toBe("https://erga.test/ada/notes?edit=&erga-page=");
});

// Was a bug (erga.dev, 22 November): a tab opened in the viewer, then the pencil, had no copy at ?edit. A reload with
// no answer from the server failed.
test("a page's other address is the same page's with ?edit or without, as the pencil writes it: one copy answers both", () => {
  const viewer = keptAddress("https://erga.test/ada/notes?user=Ada#3"),
    editor = keptAddress("https://erga.test/ada/notes?user=Ada&edit#3");
  expect(pencilAddress(viewer)).toBe(editor);
  expect(pencilAddress(editor)).toBe(viewer);
  expect(pencilAddress(keptAddress("https://erga.test/ada/notes"))).toBe(keptAddress("https://erga.test/ada/notes?edit"));
});

test("Erga's worker is on the app's origin and a document's own pages origin, never on a shared pages host", () => {
  const own = { pagesDomain: () => "erga-pages.test", pagesShared: () => null } as unknown as Platform;
  const shared = { pagesDomain: () => "erga-pages.test", pagesShared: () => "pages.erga.test" } as unknown as Platform;
  expect(workerHere(new URL("https://erga.test/erga-sw.js"), own)).toBe(true);
  expect(workerHere(new URL("https://abcd1234-ada.erga-pages.test/erga-sw.js"), own)).toBe(true);
  expect(workerHere(new URL("https://pages.erga.test/erga-sw.js"), shared)).toBe(false);
  expect(workerHere(new URL("https://erga.test/erga-sw.js"), shared)).toBe(true);
});

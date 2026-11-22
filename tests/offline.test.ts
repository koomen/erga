// Offline editing's pure parts: the page the editor puts in the browser's copy is the page the pages origin makes from
// the same text (shared/page-html.ts, pageAgain), the address a page is kept under, and where Erga's service worker
// may be (server/documents/pages-origin.ts, workerHere).

import { expect, test } from "bun:test";
import { headIn, pageAgain, sourceDigest } from "../shared/page-html.ts";
import { keptAddress, pencilAddress } from "../shared/offline.ts";
import { readerPage } from "../server/pages/reader.ts";
import { workerHere } from "../server/documents/index.ts";
import { runOn } from "../server/http.ts";
import type { Platform } from "../server/platform.ts";

const SHELL = "https://erga.test",
  PREFIX = "/t/tok/";

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

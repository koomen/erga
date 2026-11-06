// Offline editing's pure parts: the page the editor puts in the browser's copy is the page the pages origin makes from
// the same text (shared/page-html.ts, pageAgain), the address a page is kept under, and where Erga's service worker
// may be (server/documents/pages-origin.ts, workerHere; server/identity/admins-only.ts).

import { expect, test } from "bun:test";
import { headIn, pageAgain, sourceDigest } from "../shared/page-html.ts";
import { keptAddress } from "../shared/offline.ts";
import { readerPage } from "../server/pages/reader.ts";
import { workerHere } from "../server/documents/index.ts";
import { adminsOnlyGate } from "../server/identity/admins-only.ts";
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
      const served = readerPage(from, { shell: SHELL, prefix: PREFIX, src: sourceDigest(from), editor });
      const head = headIn(served);
      expect(head).not.toBeNull();
      expect(pageAgain(head!, after, SHELL)).toBe(readerPage(after, { shell: SHELL, prefix: PREFIX, src: sourceDigest(after), editor }));
    }
  expect(headIn(before), "a page Erga didn't make").toBeNull();
  expect(pageAgain("<script data-erga>x</script>", after, SHELL), "a head that names no text").toBeNull();
});

test("a page is kept under its address without the editor's marks or its hash, apart from the file as a script fetches it", () => {
  expect(keptAddress("https://a-b.erga-pages.test/t/tok/blog/x.html?erga-edit&erga-y=40#3")).toBe(
    "https://a-b.erga-pages.test/t/tok/blog/x.html?erga-page="
  );
  expect(keptAddress("https://erga.test/ada/notes?edit")).toBe("https://erga.test/ada/notes?edit=&erga-page=");
});

test("Erga's worker is on the app's origin and a document's own pages origin, never on a shared pages host", () => {
  const own = { pagesDomain: () => "erga-pages.test", pagesShared: () => null } as unknown as Platform;
  const shared = { pagesDomain: () => "erga-pages.test", pagesShared: () => "pages.erga.test" } as unknown as Platform;
  expect(workerHere(new URL("https://erga.test/erga-sw.js"), own)).toBe(true);
  expect(workerHere(new URL("https://abcd1234-ada.erga-pages.test/erga-sw.js"), own)).toBe(true);
  expect(workerHere(new URL("https://pages.erga.test/erga-sw.js"), shared)).toBe(false);
  expect(workerHere(new URL("https://erga.test/erga-sw.js"), shared)).toBe(true);
});

test("staging lets anyone fetch the worker's script, and nothing else at its name", async () => {
  const staging = { adminsOnly: true, sessionOf: async () => null, pagesDomain: () => "", directory: { users: {} } } as unknown as Platform;
  const gate = (path: string, method = "GET") =>
    runOn(adminsOnlyGate, new Request(`https://staging.erga.test${path}`, { method }), staging);
  expect(await gate("/erga-sw.js")).toBeNull();
  expect((await gate("/erga-sw.js", "POST"))?.status).toBe(403);
  expect((await gate("/erga-sw.json"))?.status).toBe(403);
});

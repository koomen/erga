// A reader's page is at an address with the document's version in it (/t/<token>/@<ver>/...): an address always means
// the same files, so the browser keeps them and asks nothing on a repeat visit. An edit gives a new version, so a new
// address. A page asked for at an old version goes to the same page at the version now. An editor's page has no
// version in its address, and is checked each time, as before.

import { expect, test } from "bun:test";
import { pagesRoutes, pagesToken } from "../server/documents/pages-origin.ts";
import { respond } from "../server/http.ts";

/** A pages origin on a document at version `now`: what the document was asked, and its answers. */
async function origin(now: string, edit = false) {
  const token = await pagesToken("s", "ada", "abcd1234", "https://erga.dev", undefined, edit ? { edit: true } : {});
  const asked: Request[] = [];
  const platform = {
    secret: "s",
    directory: { route: async () => ({ id: "abcd1234", owner: "ada", test: false }) },
    docs: {
      fetch: async (_: unknown, r: Request) => {
        asked.push(r);
        const html = new URL(r.url).pathname.endsWith(".html");
        return new Response(html ? "<!doctype html><p>x</p>" : "body{}", {
          headers: {
            "Content-Type": html ? "text/html; charset=utf-8" : "text/css",
            "Cache-Control": "no-cache",
            ETag: '"e1"',
            // The document says its version to whoever asks at one.
            ...(r.headers.get("x-erga-ver") ? { "x-erga-ver": now } : {}),
          },
        });
      },
    },
  } as never;
  const get = (path: string, dest = "style") =>
    respond(
      pagesRoutes({ owner: "ada", id: "abcd1234" }),
      new Request(`https://abcd1234-ada.erga-pages.dev/t/${token}${path}`, { headers: { "sec-fetch-dest": dest } }),
      platform
    );
  return { token, asked, get };
}

test("a reader's file at the version now is kept by the browser for good; at an old version, checked as before", async () => {
  const { get, asked } = await origin("l5");
  const kept = await get("/@l5/style.css");
  expect([kept.status, kept.headers.get("cache-control"), await kept.text()]).toEqual([
    200,
    "private, max-age=31536000, immutable",
    "body{}",
  ]);
  // The document is asked for the file by its own path, with the version the address names.
  expect([new URL(asked[0].url).pathname, asked[0].headers.get("x-erga-ver")]).toEqual(["/doc/style.css", "l5"]);
  expect((await get("/@l4/style.css")).headers.get("cache-control")).toBe("no-cache");
  // With no version in the address: as before.
  expect((await get("/style.css")).headers.get("cache-control")).toBe("no-cache");
});

test("a reader's page at an old version goes to the version now; at the version now, it is the page, checked each time", async () => {
  const { get, token } = await origin("l5");
  const old = await get("/@l4/blog/post.html?erga-y=40", "iframe");
  expect([old.status, old.headers.get("location"), old.headers.get("cache-control")]).toEqual([
    302,
    `/t/${token}/@l5/blog/post.html?erga-y=40`,
    "no-store",
  ]);
  const page = await get("/@l5/blog/post.html", "iframe");
  expect([page.status, page.headers.get("cache-control")]).toEqual([200, "no-cache"]);
  // Its links and files are under the same version.
  expect(await page.text()).toContain(`"prefix":"/t/${token}/@l5/"`);
});

test("an editor's files are never kept for good, whatever the address says", async () => {
  const { get, asked } = await origin("l5", true);
  expect((await get("/@l5/style.css")).headers.get("cache-control")).toBe("no-cache");
  expect(asked[0].headers.get("x-erga-ver")).toBeNull();
  expect((await get("/@l4/index.html", "iframe")).status).toBe(200);
});

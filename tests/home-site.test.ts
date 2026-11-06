// The homepage project as a site (server/home/site.ts): its clean addresses, folders, redirects and settings.

import { expect, test } from "bun:test";
import { fileOf, redirectOf, siteOf } from "../server/home/site.ts";

const files = new Set([
  "index.html",
  "about.html",
  "blog/index.html",
  "blog/2026/post.html",
  "img/a b.png",
  "404.html",
  "_redirects",
  "site.json",
]);
const has = (p: string) => files.has(p);

test("an address is a file, a page without .html, or a folder with its slash", () => {
  expect(fileOf(has, "/")).toEqual({ file: "index.html" });
  expect(fileOf(has, "/about")).toEqual({ file: "about.html" });
  expect(fileOf(has, "/about.html")).toEqual({ file: "about.html" });
  expect(fileOf(has, "/blog/2026/post")).toEqual({ file: "blog/2026/post.html" });
  expect(fileOf(has, "/blog")).toEqual({ slash: "/blog/" });
  expect(fileOf(has, "/blog/")).toEqual({ file: "blog/index.html" });
  expect(fileOf(has, "/img/a%20b.png")).toEqual({ file: "img/a b.png" });
  for (const p of ["/missing", "/blog/2026", "/_redirects", "/site.json", "/../index.html", "/%E0%A4%A"])
    expect(fileOf(has, p), p).toBeNull();
});

test("the settings: _redirects' rules, and the bars from site.json", async () => {
  const read = (texts: Record<string, string>) => async (p: string) => texts[p] ?? null;
  const site = await siteOf(
    read({
      _redirects: "# moved\n/old /new\n/go https://example.com/x 302\n/blog/* /posts/:splat 308\n/bad\nnot-a-path /x\n/odd /y 200\n",
      "site.json": `{"bars": false}`,
    })
  );
  expect(site.bars).toBe(false);
  expect(site.redirects).toEqual([
    { from: "/old", to: "/new", status: 301 },
    { from: "/go", to: "https://example.com/x", status: 302 },
    { from: "/blog/*", to: "/posts/:splat", status: 308 },
  ]);
  expect(redirectOf(site, "/old", "?a=1")).toEqual({ to: "/new?a=1", status: 301 });
  expect(redirectOf(site, "/old/", "")).toEqual({ to: "/new", status: 301 });
  expect(redirectOf(site, "/blog/2026/post", "")).toEqual({ to: "/posts/2026/post", status: 308 });
  expect(redirectOf(site, "/older", "")).toBeNull();
  expect(await siteOf(read({}))).toEqual({ bars: true, redirects: [] });
  expect((await siteOf(read({ "site.json": "{oops" }))).bars).toBe(true);
});

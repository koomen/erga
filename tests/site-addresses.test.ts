// A published document as a site (server/sites/addresses.ts): its clean addresses, folders and redirects.

import { expect, test } from "bun:test";
import { addressesOf, fileOf, redirectOf } from "../server/sites/addresses.ts";

const files = new Set([
  "index.html",
  "about.html",
  "blog/index.html",
  "blog/2026/post.html",
  "img/a b.png",
  "404.html",
  "_redirects",
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
  for (const p of ["/missing", "/blog/2026", "/_redirects", "/../index.html", "/%E0%A4%A"]) expect(fileOf(has, p), p).toBeNull();
});

test("_redirects' rules", () => {
  const site = addressesOf(
    "# moved\n/old /new\n/go https://example.com/x 302\n/blog/* /posts/:splat 308\n/bad\nnot-a-path /x\n/odd /y 200\n"
  );
  expect(site.redirects).toEqual([
    { from: "/old", to: "/new", status: 301 },
    { from: "/go", to: "https://example.com/x", status: 302 },
    { from: "/blog/*", to: "/posts/:splat", status: 308 },
  ]);
  expect(redirectOf(site, "/old", "?a=1")).toEqual({ to: "/new?a=1", status: 301 });
  expect(redirectOf(site, "/old/", "")).toEqual({ to: "/new", status: 301 });
  expect(redirectOf(site, "/blog/2026/post", "")).toEqual({ to: "/posts/2026/post", status: 308 });
  expect(redirectOf(site, "/older", "")).toBeNull();
  expect(addressesOf(null)).toEqual({ redirects: [] });
});

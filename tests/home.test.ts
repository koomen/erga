// The homepage's page as a deploy renders it: the
// document's page as it is, with what the viewer would give it, its files
// linked where the deploy serves them, and the place for the controls.

import { expect, test } from "bun:test";
import { homeHeader, renderHome } from "../server/home/index.ts";

const files = {
  "index.html": "",
  "style.css": "body { background: url(img/bg.png); }",
  "img/bg.png": new Uint8Array([1, 2, 3]),
  "img/a b.png": new Uint8Array([1]),
  "script.js": "1",
  "about.html": "<p>about</p>",
  "fonts/x.woff2": new Uint8Array([0]),
};
const render = (index: string, more: Record<string, string | Uint8Array> = {}) =>
  renderHome({ index: "index.html", files: { ...files, ...more, "index.html": index }, gen: "g1", title: "The Title" });

test("its files point at the deploy's addresses; everything else stays as it is", async () => {
  const r = await render(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=500"><title>Own</title>
<link rel="stylesheet" href="style.css?v=2"><link rel="preconnect" href="https://fonts.googleapis.com">
<style>@import "style.css"; .x { background: url('img/bg.png') } .y { background: url(/abs.png) } .z { background: url(data:image/png;base64,AA==) }</style>
<script src="./script.js"></script></head>
<body><svg><title>An icon</title></svg><img src="img/a%20b.png" srcset="img/bg.png 1x, img/a%20b.png 2x, https://x.test/c.png 3x"><img src="missing.png">
<a href="about.html">About</a><a href="#top">Top</a><div style="background-image: url(img/bg.png)"></div><video poster="img/bg.png"></video>
</body></html>`);
  const html = r.before + r.after;
  expect(html).toContain('href="/_home/g1/style.css?v=2"');
  expect(html).toContain('href="https://fonts.googleapis.com"');
  expect(html).toContain('@import "/_home/g1/style.css"');
  expect(html).toContain("url('/_home/g1/img/bg.png')");
  expect(html).toContain("url(/abs.png)");
  expect(html).toContain("url(data:image/png;base64,AA==)");
  expect(html).toContain('src="/_home/g1/script.js"');
  expect(html).toContain('src="/_home/g1/img/a%20b.png"');
  expect(html).toContain('srcset="/_home/g1/img/bg.png 1x, /_home/g1/img/a%20b.png 2x, https://x.test/c.png 3x"');
  expect(html).toContain('src="missing.png"');
  // Links to its pages and anchors stay relative: / serves its files at the root too.
  expect(html).toContain('href="about.html"');
  expect(html).toContain('href="#top"');
  expect(html).toContain('style="background-image: url(/_home/g1/img/bg.png)"');
  expect(html).toContain('poster="/_home/g1/img/bg.png"');
  // The viewer's viewport, not the page's; the document's title for the tab, as the viewer gives it, but an SVG's own title stays.
  expect(html).not.toContain("width=500");
  expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">');
  expect(html).toContain("<title>The Title</title>");
  expect(html).toContain("<title>An icon</title>");
  expect(html.startsWith("<!doctype html>")).toBe(true);
  // The controls go just before </body>.
  expect(r.after.startsWith("</body>")).toBe(true);
});

test("a page without a head, a body or a title still gets them where they belong", async () => {
  const r = await render("<!DOCTYPE html><h1>Hi</h1><img src=img/bg.png>");
  const html = r.before + r.after;
  expect(html.startsWith("<!DOCTYPE html><meta name=\"viewport\"")).toBe(true);
  expect(html).toContain("<title>The Title</title>");
  expect(html).toContain('src="/_home/g1/img/bg.png"');
  expect(r.after).toBe("");
  const r2 = await render("<html><body><p>x</p></html>");
  expect(r2.after).toBe("</html>");
});

test("a <base> moves where its URLs resolve; a Markdown page can't be served directly", async () => {
  const r = await render(`<!doctype html><head><base href="img/"></head><body><img src="bg.png"><img src="../style.css"></body>`);
  expect(r.before).toContain('src="/_home/g1/img/bg.png"');
  expect(r.before).toContain('src="/_home/g1/style.css"');
  await expect(renderHome({ index: "index.md", files: { "index.md": "# Hi" }, gen: "g", title: "t" })).rejects.toThrow(/only an HTML page/);
});

test("the controls: in a declarative shadow root, Edit only when given", () => {
  const h = homeHeader({ clone: "/new?from=landing", edit: "/ada/home#edit", account: null, here: "/" });
  expect(h).toMatch(/^<erga-controls><template shadowrootmode="open">/);
  expect(homeHeader({ clone: "/c", edit: null, account: null, here: "/", doc: "abcdefgh" })).toMatch(/^<erga-controls data-doc="abcdefgh">/);
  expect(h).toContain('href="/new?from=landing"');
  expect(h).toContain('href="/ada/home#edit"');
  expect(h).toContain('data-erga-account="out"');
  expect(homeHeader({ clone: "/c", edit: null, account: null, here: "/" })).not.toContain("erga-edit-button");
});

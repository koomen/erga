// A document's page as a publish renders it: the page as it is, with what the viewer would give it, its files linked
// where the snapshot serves them, and the place for the controls.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { renderSite, siteHeader } from "../server/sites/index.ts";
import { withBand, withControls, withLlm } from "../server/sites/render.ts";

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
  renderSite({
    index: "index.html",
    files: { ...files, ...more, "index.html": index },
    gen: "g1",
    title: "The Title",
    doc: "abcd1234",
    address: "/ada/site",
  });

test("its files point at the snapshot's addresses; everything else stays as it is", async () => {
  const r = await render(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=500"><title>Own</title>
<link rel="stylesheet" href="style.css?v=2"><link rel="preconnect" href="https://fonts.googleapis.com"><meta property="og:image" content="img/bg.png">
<style>@import "style.css"; .x { background: url('img/bg.png') } .y { background: url(/abs.png) } .z { background: url(data:image/png;base64,AA==) }</style>
<script src="./script.js"></script></head>
<body><svg><title>An icon</title></svg><img src="img/a%20b.png" srcset="img/bg.png 1x, img/a%20b.png 2x, https://x.test/c.png 3x"><img src="missing.png">
<a href="about.html">About</a><a href="#top">Top</a><div style="background-image: url(img/bg.png)"></div><video poster="img/bg.png"></video>
</body></html>`);
  const html = r.before + r.after;
  expect(html).toContain('href="/_home-files/g1/style.css?v=2"');
  expect(html).toContain('href="https://fonts.googleapis.com"');
  expect(html).toContain('@import "/_home-files/g1/style.css"');
  expect(html).toContain("url('/_home-files/g1/img/bg.png')");
  expect(html).toContain("url(/abs.png)");
  expect(html).toContain("url(data:image/png;base64,AA==)");
  expect(html).toContain('src="/_home-files/g1/script.js"');
  expect(html).toContain('src="/_home-files/g1/img/a%20b.png"');
  expect(html).toContain('srcset="/_home-files/g1/img/bg.png 1x, /_home-files/g1/img/a%20b.png 2x, https://x.test/c.png 3x"');
  expect(html).toContain('src="missing.png"');
  // Links to its pages and anchors stay relative: / serves its files at the root too.
  expect(html).toContain('href="about.html"');
  expect(html).toContain('href="#top"');
  expect(html).toContain('style="background-image: url(/_home-files/g1/img/bg.png)"');
  expect(html).toContain('poster="/_home-files/g1/img/bg.png"');
  // The picture a link shows is a file of the deploy too.
  expect(html).toContain('<meta property="og:image" content="/_home-files/g1/img/bg.png">');
  // The viewer's viewport, not the page's; the page's own title for the tab, as the viewer gives it, and an SVG's own title stays.
  expect(html).not.toContain("width=500");
  expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">');
  expect(html).toContain("<title>Own</title>");
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
  expect(html).toContain('src="/_home-files/g1/img/bg.png"');
  expect(r.after).toBe("");
  const r2 = await render("<html><body><p>x</p></html>");
  expect(r2.after).toBe("</html>");
});

test("a <base> moves where its URLs resolve; a page that isn't HTML can't be served directly", async () => {
  const r = await render(`<!doctype html><head><base href="img/"></head><body><img src="bg.png"><img src="../style.css"></body>`);
  expect(r.before).toContain('src="/_home-files/g1/img/bg.png"');
  expect(r.before).toContain('src="/_home-files/g1/style.css"');
  await expect(
    renderSite({ index: "index.md", files: { "index.md": "# Hi" }, gen: "g", title: "t", doc: "abcd1234", address: "/ada/site" })
  ).rejects.toThrow(/only an HTML page/);
});

test("the controls: in a declarative shadow root, Edit only when given", () => {
  const h = siteHeader({ clone: "/new?from=abcdefgh", edit: "/ada/home?edit", account: null, here: "/" });
  expect(h).toMatch(/^<erga-controls><template shadowrootmode="open">/);
  expect(siteHeader({ clone: "/c", edit: null, account: null, here: "/", doc: "abcdefgh" })).toMatch(
    /^<erga-controls data-doc="abcdefgh">/
  );
  expect(h).toContain('href="/new?from=abcdefgh"');
  expect(h).toContain('href="/ada/home?edit"');
  expect(h).toContain('data-erga-account="out"');
  expect(siteHeader({ clone: "/c", edit: null, account: null, here: "/" })).not.toContain("erga-edit-button");
});

test("the header bar is the site's setting, read when the page is served: only with it does the page start below the band", async () => {
  const r = await render("<!doctype html><html><head></head><body><h1>Hi</h1></body></html>");
  expect(r.before).not.toContain("padding-top");
  expect(withBand(r.before)).toMatch(/html:root:root \{ padding-top: calc\(/);
  // Another page of the site: the model's script first, and with the bars, a start below the band and the controls before </body>.
  const about = withLlm(
    "<!doctype html><html><head><title>About</title></head><body><p>about</p></body></html>",
    "abcd1234",
    "tok",
    "/ada/site"
  );
  expect(about).toMatch(/<head><script>.*"abcd1234","tok","\/ada\/site"/s);
  const barred = withControls(about, "<erga-controls></erga-controls>");
  expect(barred).toMatch(/<head><style>html:root:root \{ padding-top/);
  expect(barred).toContain("<erga-controls></erga-controls></body>");
});


test("Erga's typeface has a family name of its own: no style of the app's names Inter, which is a page's name for its own", async () => {
  const named: string[] = [];
  for (const pattern of ["client/**/*.{css,ts,html}", "libs/**/*.ts", "deploy/cli/*.css"])
    for await (const file of new Bun.Glob(pattern).scan(join(import.meta.dir, "..")))
      for (const rule of (await Bun.file(join(import.meta.dir, "..", file)).text()).match(/font[\w-]*\s*:[^;{}]*/g) ?? [])
        if (/\bInter\b/.test(rule.replaceAll("Erga Inter", ""))) named.push(`${file}: ${rule}`);
  expect(named).toEqual([]);
});

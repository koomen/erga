// The editor's hashed files as the server names and serves them (server/pages/assets.ts,
// client/build.ts): each page names this build's addresses; the frame's host page names the
// frame's script at the app's origin with its integrity; the Worker, when it serves them,
// keeps them a year and lets any origin load them; and staging lets anyone have them, and
// nothing else under the same guard.

import { afterAll, expect, test } from "bun:test";
import { HEADERS } from "../client/build.ts";
import { adminsOnlyGate } from "../server/identity/admins-only.ts";
import { asset, assetScripts, fontTags, scriptTag, serveAsset, useAssets } from "../server/pages/index.ts";
import { readerPage, readerVersion } from "../server/pages/reader.ts";
import type { Platform } from "../server/platform.ts";
import { ASSET_PREFIX, stemOf, type AssetManifest } from "../shared/assets.ts";

const MANIFEST: AssetManifest = {
  files: { "page.js": "/_erga/main-aaaa1111.js", "frame.js": "/_erga/frame-bbbb2222.js", "style.css": "/_erga/style-cccc3333.css", "editor.html": "/_erga/editor-dddd4444.html", "inter.css": "/_erga/inter-eeee5555.css" },
  deps: { "page.js": ["/_erga/chunk-ffff6666.js"], "frame.js": ["/_erga/chunk-gggg7777.js"] },
  frame: ["/_erga/frame-bbbb2222.js", "/_erga/chunk-gggg7777.js", "/_erga/chunk-hhhh8888.js"],
  integrity: { "/_erga/frame-bbbb2222.js": "sha384-frame", "/_erga/chunk-gggg7777.js": "sha384-chunk", "/_erga/chunk-hhhh8888.js": "sha384-later", "/_erga/main-aaaa1111.js": "sha384-main" },
  fonts: { css: "@font-face{font-family:'Inter';font-display:swap;src:url(/_erga/fonts/inter-latin-normal-iiii9999.woff2) format('woff2')}", preload: "/_erga/fonts/inter-latin-normal-iiii9999.woff2" },
};

afterAll(() => useAssets(null));

test("a page names this build's files: its scripts as modules, with the chunks they import first, and the typeface in the page itself", () => {
  useAssets(MANIFEST);
  expect(asset("page.js")).toBe("/_erga/main-aaaa1111.js");
  expect(assetScripts("page.js")).toEqual(["/_erga/main-aaaa1111.js", "/_erga/chunk-ffff6666.js"]);
  expect(scriptTag("live.js")).toBe(`<script type="module" src="/_erga/live.js"></script>`);
  expect(fontTags()).toBe(`<style id="erga-fonts">${MANIFEST.fonts.css}</style>`);
  expect(fontTags(true)).toStartWith(`<link rel="preload" as="font" type="font/woff2" crossorigin href="/_erga/fonts/inter-latin-normal-iiii9999.woff2">`);
  // A build's file and the next one's have the same stem: how an open page tells it has another build's (client/live.ts).
  expect(stemOf("/_erga/main-aaaa1111.js")).toBe(stemOf("/_erga/main-zzzz0000.js"));
  expect(stemOf("/_erga/fonts/inter-latin-normal-iiii9999.woff2")).toBe("/_erga/fonts/inter-latin-normal");
});

test("the control Worker names the app's files at the app's origin", () => {
  useAssets(MANIFEST, "https://erga.test/");
  expect(asset("style.css")).toBe("https://erga.test/_erga/style-cccc3333.css");
  expect(fontTags()).toContain("url(https://erga.test/_erga/fonts/inter-latin-normal-iiii9999.woff2)");
  useAssets(MANIFEST);
});

test("an editor's page names the editor's half at the app's origin, with the integrity of every script it may load, before any of the page's own", () => {
  useAssets(MANIFEST);
  const page = readerPage("<!doctype html><html><head><script type=\"module\" src=\"app.js\"></script></head><body></body></html>", { shell: "https://erga.test", prefix: "/t/x/", src: "s", editor: true });
  const map = JSON.parse(/<script type="importmap" data-erga>(.*?)<\/script>/.exec(page)![1]) as { integrity: Record<string, string> };
  expect(map.integrity).toEqual({ "https://erga.test/_erga/frame-bbbb2222.js": "sha384-frame", "https://erga.test/_erga/chunk-gggg7777.js": "sha384-chunk", "https://erga.test/_erga/chunk-hhhh8888.js": "sha384-later" });
  expect(page.indexOf('type="importmap"')).toBeLessThan(page.indexOf('src="app.js"'));
  const config = JSON.parse(/var C = (\{.*?\});\n/.exec(page)![1]);
  expect(config.editor).toMatchObject({ src: "https://erga.test/_erga/frame-bbbb2222.js", integrity: "sha384-frame", preload: ["https://erga.test/_erga/chunk-gggg7777.js"] });
  // A reader's page has none of the editor's.
  const reader = readerPage("<p>x</p>", { shell: "https://erga.test", prefix: "/t/x/", src: "s", editor: false });
  expect(reader).not.toContain("importmap");
  expect(reader).not.toContain("frame-bbbb2222");
  // Another frame build is another version of what goes in a page: a page kept by its ETag never names a script that's gone.
  const before = readerVersion();
  useAssets({ ...MANIFEST, files: { ...MANIFEST.files, "frame.js": "/_erga/frame-zzzz0000.js" } });
  expect(readerVersion()).not.toBe(before);
  useAssets(MANIFEST);
});

test("served by the Worker (local development), a hashed file is kept a year and any origin may load it; a missing one is never kept", async () => {
  const platform = { assets: async (r: Request) => new URL(r.url).pathname == "/_erga/main-aaaa1111.js" ? new Response("export {}", { headers: { "Content-Type": "text/javascript" } }) : new Response("Not found", { status: 404 }) } as unknown as Platform;
  const ok = await serveAsset(new Request("https://erga.test/_erga/main-aaaa1111.js"), platform);
  expect(ok.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(ok.headers.get("access-control-allow-origin")).toBe("*");
  expect(ok.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  expect(await ok.text()).toBe("export {}");
  const missing = await serveAsset(new Request("https://erga.test/_erga/main-zzzz0000.js"), platform);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  // Cloudflare's own serving gives the same headers (the build's _headers).
  expect(HEADERS).toStartWith(`${ASSET_PREFIX}*\n`);
  for (const h of ["Cache-Control: public, max-age=31536000, immutable", "Access-Control-Allow-Origin: *"]) expect(HEADERS).toContain(h);
});

test("staging (admins only) lets anyone read the hashed files and the logo, and nothing else under the same names", async () => {
  const staging = { adminsOnly: true, sessionOf: async () => null, pagesDomain: () => "", directory: { users: {} } } as unknown as Platform;
  const gate = (path: string, method = "GET") => { const url = new URL(`https://staging.erga.test${path}`); return adminsOnlyGate(new Request(url, { method }), staging, url); };
  expect(await gate("/_erga/main-aaaa1111.js")).toBeNull();
  expect(await gate("/_erga/fonts/inter-latin-normal-iiii9999.woff2", "HEAD")).toBeNull();
  expect(await gate("/logo.png")).toBeNull();
  expect((await gate("/_erga/main-aaaa1111.js", "POST"))?.status).toBe(403);
  expect((await gate("/manifest.json"))?.status).toBe(403);
  expect((await gate("/api/release"))?.status).toBe(403);
});

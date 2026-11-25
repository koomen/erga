// The editor's hashed files as the server names and serves them (server/pages/assets.ts,
// client/build.ts): each page names this build's addresses; the frame's host page names the
// frame's script at the app's origin with its integrity; the Worker, when it serves them,
// keeps them a year and lets any origin load them; and staging lets anyone have them, and
// nothing else under the same guard.

import { afterAll, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { HEADERS } from "../client/build.ts";
import { runOn } from "../server/http.ts";
import { asset, assetScripts, fontTags, scriptTag, serveAsset, serveLibrary, useAssets } from "../server/pages/index.ts";
import { fontsAt } from "../server/identity/index.ts";
import { readerPage, readerVersion } from "../server/pages/reader.ts";
import type { Platform } from "../server/platform.ts";
import { ASSET_PREFIX, stemOf, type AssetManifest } from "../shared/assets.ts";
import { respond } from "../server/http.ts";
import { person, server } from "./helpers/app";

const MANIFEST: AssetManifest = {
  files: {
    "page.js": "/_erga/main-aaaa1111.js",
    "viewer.js": "/_erga/viewer-vvvv2222.js",
    "frame.js": "/_erga/frame-bbbb2222.js",
    "clipboard.js": "/_erga/clipboard-cccc1111.js",
    "style.css": "/_erga/style-cccc3333.css",
    "editor.html": "/_erga/editor-dddd4444.html",
    "inter.css": "/_erga/inter-eeee5555.css",
  },
  deps: { "page.js": ["/_erga/chunk-ffff6666.js"], "frame.js": ["/_erga/chunk-gggg7777.js"] },
  frame: ["/_erga/frame-bbbb2222.js", "/_erga/chunk-gggg7777.js", "/_erga/chunk-hhhh8888.js", "/_erga/clipboard-cccc1111.js"],
  integrity: {
    "/_erga/frame-bbbb2222.js": "sha384-frame",
    "/_erga/chunk-gggg7777.js": "sha384-chunk",
    "/_erga/chunk-hhhh8888.js": "sha384-later",
    "/_erga/clipboard-cccc1111.js": "sha384-clip",
    "/_erga/main-aaaa1111.js": "sha384-main",
    "/_erga/viewer-vvvv2222.js": "sha384-viewer",
  },
  fonts: {
    css: "@font-face{font-family:'Erga Inter';font-display:swap;src:url(/_erga/fonts/inter-latin-normal-iiii9999.woff2) format('woff2')}",
    preload: "/_erga/fonts/inter-latin-normal-iiii9999.woff2",
    page: '@font-face{font-family:"Literata";src:url(/_erga/fonts/literata-llll0000.woff2) format("woff2")}',
  },
};

afterAll(() => useAssets(null));

test("a page names this build's files: its scripts as modules, with the chunks they import first, and the typeface in the page itself", () => {
  useAssets(MANIFEST);
  expect(asset("page.js")).toBe("/_erga/main-aaaa1111.js");
  expect(assetScripts("page.js")).toEqual(["/_erga/main-aaaa1111.js", "/_erga/chunk-ffff6666.js"]);
  expect(scriptTag("live.js")).toBe(`<script type="module" src="/_erga/live.js"></script>`);
  expect(fontTags()).toBe(`<style id="erga-fonts">${MANIFEST.fonts.css}</style>`);
  expect(fontTags(true)).toStartWith(`<link rel="preload" as="font" type="font/woff2" crossorigin href="/_erga/fonts/inter-latin-normal-iiii9999.woff2">`);
  // A build's file and the next one's have the same stem: how an open page tells it has another build's (client/live/live.ts).
  expect(stemOf("/_erga/main-aaaa1111.js")).toBe(stemOf("/_erga/main-zzzz0000.js"));
  expect(stemOf("/_erga/fonts/inter-latin-normal-iiii9999.woff2")).toBe("/_erga/fonts/inter-latin-normal");
});

test("an editor's page names the editor's half on its own origin, with the integrity of every script it may load, before any of the page's own", () => {
  useAssets(MANIFEST);
  const page = readerPage('<!doctype html><html><head><script type="module" src="app.js"></script></head><body></body></html>', {
    shell: "https://erga.test",
    fonts: "",
    prefix: "/t/x/",
    src: "s",
    editor: true,
    worker: true,
  });
  const map = JSON.parse(/<script type="importmap" data-erga>(.*?)<\/script>/.exec(page)![1]) as { integrity: Record<string, string> };
  expect(map.integrity).toEqual({
    "/_erga/frame-bbbb2222.js": "sha384-frame",
    "/_erga/chunk-gggg7777.js": "sha384-chunk",
    "/_erga/chunk-hhhh8888.js": "sha384-later",
    "/_erga/clipboard-cccc1111.js": "sha384-clip",
  });
  // A document's page calls only its own origin: nothing in it names the app's origin but the viewer's (`shell`).
  expect(page.replace('"shell":"https://erga.test"', "")).not.toContain("https://erga.test");
  expect(page.indexOf('type="importmap"')).toBeLessThan(page.indexOf('src="app.js"'));
  const config = JSON.parse(/\((\{"shell":.*?\})\);<\/script>/.exec(page)![1]);
  expect(page).toContain('<script type="module" src="/_erga/clipboard-cccc1111.js" crossorigin data-erga></script>');
  // erga/text at its one address, its build and first chunk preloaded (each pinned by the map).
  expect(config.editor).toMatchObject({
    src: "/erga/text/editor.js",
    integrity: "",
    preload: ["/_erga/frame-bbbb2222.js", "/_erga/chunk-gggg7777.js"],
  });
  // A page that brings its own editor gets none added.
  const own = readerPage(`<meta name="erga-editor" content="own"><p>x</p>`, {
    shell: "https://erga.test",
    fonts: "",
    prefix: "/t/x/",
    src: "s",
    editor: true,
    worker: true,
  });
  expect(JSON.parse(/\((\{"shell":.*?\})\);<\/script>/.exec(own)![1]).editor).toMatchObject({ src: "", preload: [] });
  // A reader's page has none of the editor's.
  const reader = readerPage("<p>x</p>", { shell: "https://erga.test", fonts: "", prefix: "/t/x/", src: "s", editor: false, worker: true });
  expect(reader).not.toContain("importmap");
  expect(reader).not.toContain("frame-bbbb2222");
  // The templates' typefaces: at the app's origin, one address for every document. Behind a gate in front, which
  // refuses a font's request from another origin (it has no cookie), at the page's own origin.
  const open = { signIn: { mode: "oauth" } } as Parameters<typeof fontsAt>[0];
  const gated = { signIn: { mode: "gate" } } as Parameters<typeof fontsAt>[0];
  const fontsOf = (fonts: string) =>
    /<style data-erga>(@font-face.*?)<\/style>/.exec(
      readerPage("<p>x</p>", { shell: "https://erga.test", fonts, prefix: "/t/x/", src: "s", editor: false, worker: true })
    )![1];
  expect(fontsOf(fontsAt(open, "https://erga.test"))).toContain("src:url(https://erga.test/_erga/fonts/literata-llll0000.woff2)");
  expect(fontsOf(fontsAt(gated, "https://erga.test"))).toContain("src:url(/_erga/fonts/literata-llll0000.woff2)");
  // Another frame or clipboard build is another version of what goes in a page: a page kept by its ETag never names a script that's gone.
  const before = readerVersion();
  useAssets({ ...MANIFEST, files: { ...MANIFEST.files, "frame.js": "/_erga/frame-zzzz0000.js" } });
  expect(readerVersion()).not.toBe(before);
  useAssets({ ...MANIFEST, files: { ...MANIFEST.files, "clipboard.js": "/_erga/clipboard-zzzz0000.js" } });
  expect(readerVersion()).not.toBe(before);
  useAssets(MANIFEST);
});

test("a library's address imports its newest build, asked for again each time, from any origin", async () => {
  useAssets(MANIFEST);
  const r = await respond(Effect.succeed(serveLibrary("text")), new Request("https://erga.test/erga/text/editor.js"), {} as Platform);
  expect(await r.text()).toBe('import "/_erga/frame-bbbb2222.js";\n');
  expect(r.headers.get("cache-control")).toBe("no-cache");
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
  expect(r.headers.get("content-type")).toMatch(/^text\/javascript/);
});

test("served by the Worker, a hashed file is kept a year and any origin may load it; a missing one is never kept", async () => {
  const platform = { assets: async (r: Request) => new URL(r.url).pathname == "/_erga/main-aaaa1111.js" ? new Response("export {}", { headers: { "Content-Type": "text/javascript" } }) : new Response("Not found", { status: 404 }) } as unknown as Platform;
  const ok = await respond(serveAsset, new Request("https://erga.test/_erga/main-aaaa1111.js"), platform);
  expect(ok.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(ok.headers.get("access-control-allow-origin")).toBe("*");
  expect(ok.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  expect(await ok.text()).toBe("export {}");
  const missing = await respond(serveAsset, new Request("https://erga.test/_erga/main-zzzz0000.js"), platform);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  // The static assets' own headers are the same (the build's _headers), for what Cloudflare serves from them.
  expect(HEADERS).toStartWith(`${ASSET_PREFIX}*\n`);
  for (const h of ["Cache-Control: public, max-age=31536000, immutable", "Access-Control-Allow-Origin: *"]) expect(HEADERS).toContain(h);
});

test("a file has an ETag, is checked each time, and is a 304 with no body when unchanged; so is the page, with what goes in it; an editor's page names the editor's half at the app's origin; the viewer preloads the editor's files", async () => {
  // The whole app in memory (tests/helpers/app.ts), with its own list of the build's files.
  const s = server();
  const p = await person(s);
  const id = await p.make();
  const address = (await p.tool<{ address: string }>("ls", { document: id })).result!.address;
  const viewer = await (await p.get(address)).text();
  // The address of the document's files on its own origin, with the token: the viewer names it.
  const url = /<meta name="erga-pages" content="([^"]+)">/.exec(viewer)![1];
  const at = new URL(url);
  const framed = (u: string, headers: Record<string, string> = {}) => s.fetch(u, { headers: { ...headers, "Sec-Fetch-Dest": "iframe" } });
  const file = await s.fetch(`${url}index.html`);
  const etag = file.headers.get("etag");
  expect(etag).toBeTruthy();
  expect(file.headers.get("cache-control")).toBe("no-cache");
  const again = await s.fetch(`${url}index.html`, { headers: { "If-None-Match": etag! } });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
  // The page: its own ETag (the file's, and what goes in it), a 304 when neither changed; its address is the file's own.
  expect(await (await framed(url)).text()).toBe(await (await framed(`${url}index.html`)).text());
  const page = await framed(`${url}index.html`);
  const pageTag = page.headers.get("etag")!;
  expect(pageTag).toMatch(/^"[^"]+\.[a-z0-9]+w"$/);
  expect(pageTag).not.toBe(etag!);
  expect((await framed(`${url}index.html`, { "If-None-Match": pageTag })).status).toBe(304);
  expect((await framed(`${url}index.html`, { "If-None-Match": etag! })).status).toBe(200);
  // The editor (erga/text) loads from the page's own origin at one address, its newest build; the build and its chunks
  // preloaded, each with its integrity.
  const html = await page.text();
  const config = JSON.parse(/\((\{"shell":.*?\})\);<\/script>/.exec(html)?.[1] ?? "null") as {
    shell: string;
    prefix: string;
    editor: { src: string; integrity: string; preload: string[]; map: Record<string, string> };
  };
  expect(config.shell).toBe(p.origin);
  expect(config.prefix).toBe(at.pathname);
  expect(config.editor.src).toBe("/erga/text/editor.js");
  expect(html).toContain('<script type="importmap" data-erga>');
  const build = config.editor.preload[0];
  expect(build).toMatch(/^\/_erga\/frame-[a-z0-9]+\.js$/);
  expect(config.editor.map[build]).toMatch(/^sha384-/);
  // The library's address, on the document's own origin: asked again each time, and it imports that build.
  const library = await s.fetch(`${at.origin}${config.editor.src}`);
  expect(library.headers.get("cache-control")).toBe("no-cache");
  expect(library.headers.get("access-control-allow-origin")).toBe("*");
  expect(await library.text()).toBe(`import ${JSON.stringify(build)};\n`);
  // A file that isn't there is never kept.
  expect((await s.fetch("/_erga/frame-none.js")).headers.get("cache-control")).toBe("no-store");
  // The editor's shell is in the page (no page of its own to fetch); its script and chunks are preloaded, and its start
  // and socket asked for, as the page parses, opened with ?edit.
  expect(viewer).toContain("ergaEditAddress()");
  expect(viewer).toContain('<template id="erga-shell"><style>');
  expect(viewer).not.toMatch(/\/_erga\/editor-[a-z0-9]+\.html","fetch"/);
  expect(viewer).toMatch(/\["\/_erga\/main-[a-z0-9]+\.js"(,"\/_erga\/chunk-[a-z0-9]+\.js")*\]/);
  expect(viewer).toMatch(/rel:\s*"modulepreload"/);
  expect(viewer).toContain("shell=1");
  expect(viewer).toContain('id="erga-viewer" type="module" src="/_erga/viewer');
});

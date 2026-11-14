// The editor's hashed files as the server names and serves them (server/pages/assets.ts,
// client/build.ts): each page names this build's addresses; the frame's host page names the
// frame's script at the app's origin with its integrity; the Worker, when it serves them,
// keeps them a year and lets any origin load them; and staging lets anyone have them, and
// nothing else under the same guard.

import { afterAll, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { HEADERS } from "../client/build.ts";
import { adminsOnlyGate } from "../server/identity/admins-only.ts";
import { runOn } from "../server/http.ts";
import { asset, assetScripts, fontTags, scriptTag, serveAsset, serveLibrary, useAssets } from "../server/pages/index.ts";
import { readerPage, readerVersion } from "../server/pages/reader.ts";
import type { Platform } from "../server/platform.ts";
import { ASSET_PREFIX, stemOf, type AssetManifest } from "../shared/assets.ts";
import { respond } from "../server/http.ts";
import { person, server } from "./helpers/app";

const MANIFEST: AssetManifest = {
  files: { "page.js": "/_erga/main-aaaa1111.js", "frame.js": "/_erga/frame-bbbb2222.js", "style.css": "/_erga/style-cccc3333.css", "editor.html": "/_erga/editor-dddd4444.html", "inter.css": "/_erga/inter-eeee5555.css" },
  deps: { "page.js": ["/_erga/chunk-ffff6666.js"], "frame.js": ["/_erga/chunk-gggg7777.js"] },
  frame: ["/_erga/frame-bbbb2222.js", "/_erga/chunk-gggg7777.js", "/_erga/chunk-hhhh8888.js"],
  integrity: {
    "/_erga/frame-bbbb2222.js": "sha384-frame",
    "/_erga/chunk-gggg7777.js": "sha384-chunk",
    "/_erga/chunk-hhhh8888.js": "sha384-later",
    "/_erga/main-aaaa1111.js": "sha384-main",
  },
  fonts: {
    css: "@font-face{font-family:'Inter';font-display:swap;src:url(/_erga/fonts/inter-latin-normal-iiii9999.woff2) format('woff2')}",
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

test("an editor's page names the editor's half at the app's origin, with the integrity of every script it may load, before any of the page's own", () => {
  useAssets(MANIFEST);
  const page = readerPage("<!doctype html><html><head><script type=\"module\" src=\"app.js\"></script></head><body></body></html>", { shell: "https://erga.test", prefix: "/t/x/", src: "s", editor: true });
  const map = JSON.parse(/<script type="importmap" data-erga>(.*?)<\/script>/.exec(page)![1]) as { integrity: Record<string, string> };
  expect(map.integrity).toEqual({ "https://erga.test/_erga/frame-bbbb2222.js": "sha384-frame", "https://erga.test/_erga/chunk-gggg7777.js": "sha384-chunk", "https://erga.test/_erga/chunk-hhhh8888.js": "sha384-later" });
  expect(page.indexOf('type="importmap"')).toBeLessThan(page.indexOf('src="app.js"'));
  const config = JSON.parse(/\((\{"shell":.*?\})\);<\/script>/.exec(page)![1]);
  // erga/text at its one address, its build and first chunk preloaded (each pinned by the map).
  expect(config.editor).toMatchObject({
    src: "https://erga.test/erga/text/editor.js",
    integrity: "",
    preload: ["https://erga.test/_erga/frame-bbbb2222.js", "https://erga.test/_erga/chunk-gggg7777.js"],
  });
  // A page that brings its own editor gets none added.
  const own = readerPage(`<meta name="erga-editor" content="own"><p>x</p>`, {
    shell: "https://erga.test",
    prefix: "/t/x/",
    src: "s",
    editor: true,
  });
  expect(JSON.parse(/\((\{"shell":.*?\})\);<\/script>/.exec(own)![1]).editor).toMatchObject({ src: "", preload: [] });
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

test("staging (admins only) lets anyone read the hashed files, their list and the logo, and nothing else under the same names", async () => {
  const staging = { adminsOnly: true, sessionOf: async () => null, pagesDomain: () => "", directory: { users: {} } } as unknown as Platform;
  const gate = (path: string, method = "GET") => {
    const url = new URL(`https://staging.erga.test${path}`);
    return runOn(adminsOnlyGate, new Request(url, { method }), staging);
  };
  expect(await gate("/_erga/main-aaaa1111.js")).toBeNull();
  expect(await gate("/_erga/fonts/inter-latin-normal-iiii9999.woff2", "HEAD")).toBeNull();
  expect(await gate("/logo.png")).toBeNull();
  expect((await gate("/_erga/main-aaaa1111.js", "POST"))?.status).toBe(403);
  expect((await gate("/manifest.json"))?.status).toBe(403);
  // The list: a page's check of its code, with no admin's session (the sign-in page, the server's browser), and the deploy.
  expect(await gate("/api/release")).toBeNull();
  expect((await gate("/api/release", "POST"))?.status).toBe(403);
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
  // The editor (erga/text) loads from the app's origin at one address, its newest build; the build and its chunks
  // preloaded, each with its integrity.
  const html = await page.text();
  const config = JSON.parse(/\((\{"shell":.*?\})\);<\/script>/.exec(html)?.[1] ?? "null") as {
    shell: string;
    prefix: string;
    editor: { src: string; integrity: string; preload: string[]; map: Record<string, string> };
  };
  expect(config.shell).toBe(p.origin);
  expect(config.prefix).toBe(at.pathname);
  expect(config.editor.src).toBe(`${p.origin}/erga/text/editor.js`);
  expect(html).toContain('<script type="importmap" data-erga>');
  const build = config.editor.preload[0];
  expect(build).toMatch(new RegExp(`^${p.origin}/_erga/frame-[a-z0-9]+\\.js$`));
  expect(config.editor.map[build]).toMatch(/^sha384-/);
  // The library's address: asked again each time, loadable from the document's origin, and it imports that build.
  const library = await s.fetch(config.editor.src, { headers: { Origin: at.origin } });
  expect(library.headers.get("cache-control")).toBe("no-cache");
  expect(library.headers.get("access-control-allow-origin")).toBe("*");
  expect(await library.text()).toBe(`import ${JSON.stringify(new URL(build).pathname)};\n`);
  // A file that isn't there is never kept.
  expect((await s.fetch("/_erga/frame-none.js")).headers.get("cache-control")).toBe("no-store");
  // The editor's shell is in the page (no page of its own to fetch); its script and chunks are preloaded, and its start
  // and socket asked for, as the page parses, opened with ?edit.
  expect(viewer).toContain("ergaEditAddress()");
  expect(viewer).toContain('<template id="erga-shell"><style>');
  expect(viewer).not.toMatch(/\/_erga\/editor-[a-z0-9]+\.html","fetch"/);
  expect(viewer).toMatch(/\["\/_erga\/main-[a-z0-9]+\.js"(,"\/_erga\/chunk-[a-z0-9]+\.js")*\]/);
  expect(viewer).toMatch(/rel:\s*"modulepreload"/);
  expect(viewer).toContain('"/api/start"');
});

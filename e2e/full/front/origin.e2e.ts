// A document's page runs on the document's own origin, for readers and editors alike, whose files open only with the
// token the viewer's page hands out, and loads fast: files checked by ETag, the page too (with what goes in it).
import { createHash } from "node:crypto";
import { expect, test } from "../../helpers/fixtures";
import { framed, pagesFetch } from "../../helpers/pages-fetch";
import { person, servers, type Person } from "./front";

await servers.script();

/** A new document's page in the viewer, and the address of its files it names on the document's origin (with the token). */
async function pages(p: Person) {
  const id = await p.make();
  const viewer = await (await p.get((await p.nameOf(id)).address)).text();
  const url = /<meta name="erga-pages" content="([^"]+)">/.exec(viewer)?.[1] ?? "";
  expect(url, viewer.slice(0, 1500)).toBeTruthy();
  return { id, viewer, url, at: new URL(url) };
}


test("the viewer names the document's own origin, which serves the page only to this site's frame, and the document's files without a cookie; a forged token, or a good one at another document's origin, opens nothing; none of this site's pages are there", async () => {
  const p = await person(await servers.script());
  const { id, url, at } = await pages(p);
  expect(at.hostname.startsWith(`${id}-${p.login}.`), url).toBe(true);
  expect(at.origin).not.toBe(p.origin);
  // The page, as a frame's: only this site may frame it; its HTML as written, the viewer's script first.
  const page = await framed(`${url}index.html`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy") ?? "").toContain(`frame-ancestors ${p.origin}`);
  const html = await page.text();
  expect(html.replace(/<script[^]*?<\/script>/g, "")).not.toContain("data-erga-text");
  expect(html.indexOf("erga-hello")).toBeGreaterThan(0);
  // The file itself, as a page's own fetch has it: as it is.
  expect(await (await pagesFetch(`${url}index.html`)).text()).toBe(await (await p.get(`/d/${id}/doc/index.html`)).text());
  const forged = url.replace(/\/t\/([^/.]+)\.[^/]+\//, "/t/$1.forged/");
  expect((await pagesFetch(`${forged}index.html`)).status).toBe(403);
  expect((await pagesFetch(`${at.origin.replace(id, "aaaaaaaa")}${at.pathname}index.html`)).status).toBe(403);
  expect((await pagesFetch(`${at.origin}/docs`)).status).toBe(404);
});

test("a file has an ETag, is checked each time, and is a 304 with no body when unchanged; so is the page, with what goes in it; an editor's page names the editor's half at the app's origin with its integrity; the editor's page preloads its files with ?edit; responses say where their time went", async () => {
  const p = await person(await servers.script());
  const { viewer, url, at } = await pages(p);
  const file = await pagesFetch(`${url}index.html`);
  const etag = file.headers.get("etag");
  expect(etag).toBeTruthy();
  expect(file.headers.get("cache-control")).toBe("no-cache");
  const again = await pagesFetch(`${url}index.html`, { "If-None-Match": etag! });
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
  const library = await fetch(config.editor.src, { headers: { Origin: at.origin } });
  expect(library.headers.get("cache-control")).toBe("no-cache");
  expect(library.headers.get("access-control-allow-origin")).toBe("*");
  expect(await library.text()).toBe(`import ${JSON.stringify(new URL(build).pathname)};\n`);
  // The build: kept a year, and loadable from the document's origin (CORS), as the bytes the integrity names.
  const script = await fetch(build, { headers: { Origin: at.origin } });
  expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(script.headers.get("access-control-allow-origin")).toBe("*");
  const digest = createHash("sha384").update(new Uint8Array(await script.arrayBuffer())).digest("base64");
  expect(`sha384-${digest}`).toBe(config.editor.map[build]);
  // A file that isn't there is never kept.
  expect((await fetch(`${p.origin}/_erga/frame-none.js`)).headers.get("cache-control")).toBe("no-store");
  // The editor's shell is in the page (no page of its own to fetch); its script and chunks are preloaded, and its start
  // and socket asked for, as the page parses, opened with ?edit.
  expect(viewer).toContain("ergaEditAddress()");
  expect(viewer).toContain('<template id="erga-shell"><style>');
  expect(viewer).not.toMatch(/\/_erga\/editor-[a-z0-9]+\.html","fetch"/);
  expect(viewer).toMatch(/\["\/_erga\/main-[a-z0-9]+\.js"(,"\/_erga\/chunk-[a-z0-9]+\.js")*\]/);
  expect(viewer).toMatch(/rel:\s*"modulepreload"/);
  expect(viewer).toContain('"/api/start"');
  expect((await framed(url)).headers.get("server-timing") ?? "").toContain("worker;dur=");
});

test("a reader's viewer holds the page in one frame on its own origin (allow-same-origin there), with an ETag (304 when unchanged); the page comes with nothing of the editor's; someone it isn't shared with gets no page; an edit shows on the next load", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  expect((await p.share(id, "Ada", "viewer")).status).toBe(200);
  const { address } = await p.nameOf(id);
  const view = await p.as("Ada", address);
  expect(view.status).toBe(200);
  expect(view.headers.get("cache-control")).toBe("private, no-cache");
  const html = await view.text();
  const frame = /<iframe id="frame"[^>]*>/.exec(html)![0];
  expect(frame).toContain('sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"');
  expect(frame).toContain(`allow="autoplay 'none'; fullscreen 'none'"`);
  expect(frame).not.toContain("srcdoc");
  // The frame's address is made in the page from its metas, as ergaFrames.src() does (client/inline/viewer-frames.ts):
  // the frame has no src of its own.
  expect(frame).not.toContain(" src=");
  const meta = (name: string) => new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html)?.[1].replace(/&amp;/g, "&") ?? "";
  const src = meta("erga-pages") + meta("erga-page").split("/").map(encodeURIComponent).join("/");
  expect(new URL(src).origin).not.toBe(p.origin);
  // (A reader's files are at an address with the document's version: the browser keeps them until it changes.)
  expect(new URL(src).pathname).toMatch(/^\/t\/[^/]+\/@[^/]+\/index\.html$/);
  expect(html).not.toContain('name="erga-base"');
  // Unchanged: a 304, with no body.
  const etag = view.headers.get("etag")!;
  expect(etag).toBeTruthy();
  expect((await p.as("Ada", address, { headers: { "If-None-Match": etag } })).status).toBe(304);
  // The page: none of the editor's (its half, its integrity, its watches).
  const page = await (await framed(src)).text();
  expect(page).toContain("erga-hello");
  expect(page).not.toContain("importmap");
  expect(page).not.toContain("__ergaReport");
  // Someone it isn't shared with gets no page.
  expect((await p.as("Zed", address)).status).toBe(403);
  // Edited: the next load shows it (readers see the document as it is now).
  expect((await p.get(`/d/${id}/api/stored/index.html`, { method: "PUT", body: "<h1>Edited</h1>" })).status).toBe(200);
  // (The address the viewer gave names the version from before: the page is at the version now.)
  const moved = await framed(src);
  expect(moved.status).toBe(302);
  expect(await (await framed(new URL(moved.headers.get("location")!, src).href)).text()).toContain("<h1>Edited</h1>");
});

// A document's page runs on the document's own origin, for readers and editors alike, whose files open only with the
// token the viewer's page hands out, and loads fast: files checked by ETag, the page too (with what goes in it).
import { createHash } from "node:crypto";
import { expect, test } from "../../fixtures";
import { framed, pagesFetch } from "../../pages-fetch";
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
  // The page, as a frame's: only this site may frame it; its text blocks marked, the viewer's script first.
  const page = await framed(`${url}index.html`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy") ?? "").toContain(`frame-ancestors ${p.origin}`);
  const html = await page.text();
  expect(html).toContain("data-erga-id=");
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
  // The editor's half loads from the app's origin (one address for every document), each script with its integrity.
  const html = await page.text();
  const config = JSON.parse(/\((\{"shell":.*?\})\);<\/script>/.exec(html)?.[1] ?? "null") as {
    shell: string;
    prefix: string;
    editor: { src: string; integrity: string; map: Record<string, string> };
  };
  expect(config.shell).toBe(p.origin);
  expect(config.prefix).toBe(at.pathname);
  expect(config.editor.src).toMatch(new RegExp(`^${p.origin}/_erga/frame-[a-z0-9]+\\.js$`));
  expect(config.editor.integrity).toMatch(/^sha384-/);
  expect(html).toContain('<script type="importmap" data-erga>');
  expect(config.editor.map[config.editor.src]).toBe(config.editor.integrity);
  // There: kept a year, and loadable from the document's origin (CORS), as the bytes the integrity names.
  const script = await fetch(config.editor.src, { headers: { Origin: at.origin } });
  expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(script.headers.get("access-control-allow-origin")).toBe("*");
  const digest = createHash("sha384").update(new Uint8Array(await script.arrayBuffer())).digest("base64");
  expect(`sha384-${digest}`).toBe(config.editor.integrity);
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
  const src = /src="([^"]+)"/.exec(frame)![1].replace(/&amp;/g, "&");
  expect(new URL(src).origin).not.toBe(p.origin);
  expect(new URL(src).pathname).toMatch(/^\/t\/[^/]+\/index\.html$/);
  expect(html).not.toContain('name="erga-base"');
  // Unchanged: a 304, with no body.
  const etag = view.headers.get("etag")!;
  expect(etag).toBeTruthy();
  expect((await p.as("Ada", address, { headers: { "If-None-Match": etag } })).status).toBe(304);
  // The page: none of the editor's (its half, its integrity, its watches).
  const page = await (await framed(src)).text();
  expect(page).toContain("erga-hello");
  expect(page).not.toContain("importmap");
  expect(page).not.toContain("__ergaProblems");
  // Someone it isn't shared with gets no page.
  expect((await p.as("Zed", address)).status).toBe(403);
  // Edited: the next load shows it (readers see the document as it is now).
  expect((await p.get(`/d/${id}/api/stored/index.html`, { method: "PUT", body: "<h1>Edited</h1>" })).status).toBe(200);
  expect(await (await framed(src)).text()).toContain("<h1 data-erga-id=\"0\">Edited</h1>");
});

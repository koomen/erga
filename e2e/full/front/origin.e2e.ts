// A document's page runs on the document's own origin, whose files
// open only with the editor's token, and loads fast: files checked by ETag, the frame's host page kept by version.
import { createHash } from "node:crypto";
import { request } from "node:http";
import { expect, test } from "../../fixtures";
import { person, servers, type Person } from "./front";

await servers.script();

/** Browsers send <anything>.localhost to this machine; Node's fetch doesn't, and won't send a Host header of its own, so node:http asks. */
function pagesFetch(u: string, headers: Record<string, string> = {}): Promise<Response> {
  const url = new URL(u);
  if (!url.hostname.endsWith(".localhost")) return fetch(u, { headers });
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: url.port, path: url.pathname + url.search, headers: { ...headers, Host: url.host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v != null) h.set(k, Array.isArray(v) ? v.join(", ") : v);
        const status = res.statusCode ?? 0;
        resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: h }));
      });
    });
    req.on("error", reject);
    req.end();
  });
}
/** A new document's editor page, and the origin it names for the page. */
async function pages(p: Person) {
  const id = await p.make();
  const editor = await (await p.get((await p.nameOf(id)).address)).text();
  const url = /<meta name="erga-pages" content="([^"]+)">/.exec(editor)?.[1] ?? "";
  expect(url, editor.slice(0, 1500)).toBeTruthy();
  return { id, editor, url, at: new URL(url) };
}

test("the editor names the document's own origin, which serves the page editor's frame only to this site, and the document's files without a cookie; a forged token, or a good one at another document's origin, opens nothing; none of this site's pages are there", async () => {
  const p = await person(await servers.script());
  const { id, url, at } = await pages(p);
  expect(at.hostname.startsWith(`${id}-${p.login}.`), url).toBe(true);
  expect(at.origin).not.toBe(p.origin);
  const frame = await pagesFetch(url);
  expect(frame.status).toBe(200);
  expect(frame.headers.get("content-security-policy") ?? "").toContain(`frame-ancestors ${p.origin}`);
  expect(await (await pagesFetch(`${url}doc/index.html`)).text()).toBe(await (await p.get(`/d/${id}/doc/index.html`)).text());
  const forged = url.replace(/\/t\/([^/.]+)\.[^/]+\//, "/t/$1.forged/");
  expect((await pagesFetch(`${forged}doc/index.html`)).status).toBe(403);
  expect((await pagesFetch(`${at.origin.replace(id, "aaaaaaaa")}${at.pathname}doc/index.html`)).status).toBe(403);
  expect((await pagesFetch(`${at.origin}/docs`)).status).toBe(404);
});

test("doc/ is the page; a file has an ETag, is checked each time, and is a 304 with no body when unchanged; the frame's host page is kept by version (another version is checked each time); the editor's page preloads its files with #edit; responses say where their time went", async () => {
  const p = await person(await servers.script());
  const { editor, url, at } = await pages(p);
  const file = await pagesFetch(`${url}doc/index.html`);
  const etag = file.headers.get("etag");
  expect(await (await pagesFetch(`${url}doc/`)).text()).toBe(await file.text());
  expect(etag).toBeTruthy();
  expect(file.headers.get("cache-control")).toBe("no-cache");
  const again = await pagesFetch(`${url}doc/index.html`, { "If-None-Match": etag! });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
  const src = /<iframe id="frame"[^>]* (?:data-)?src="([^"]+)"/.exec(editor)?.[1]?.replace(/&amp;/g, "&") ?? "";
  expect(src).toMatch(/[?&]v=[a-z0-9]+/);
  expect(editor).toContain('f.src = inline.dataset.src + "&edit=1"');
  const host = await pagesFetch(src);
  expect(host.headers.get("cache-control") ?? "").toMatch(/max-age=\d+/);
  const hostPage = await host.text();
  expect(hostPage).toContain(`<base href="${at.pathname}doc/">`);
  // The editor's half loads from the app's origin (one address for every document), each script with its integrity.
  const frame = JSON.parse(/<script type="application\/json" id="erga-frame">(.*?)<\/script>/.exec(hostPage)?.[1] ?? "null") as { src: string; integrity: string; map: Record<string, string> };
  expect(frame.src).toMatch(new RegExp(`^${p.origin}/_erga/frame-[a-z0-9]+\\.js$`));
  expect(frame.integrity).toMatch(/^sha384-/);
  expect(hostPage).toContain('<script type="importmap">');
  expect(frame.map[frame.src]).toBe(frame.integrity);
  // There: kept a year, and loadable from the document's origin (CORS), as the bytes the integrity names.
  const script = await fetch(frame.src, { headers: { Origin: at.origin } });
  expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(script.headers.get("access-control-allow-origin")).toBe("*");
  const digest = createHash("sha384").update(new Uint8Array(await script.arrayBuffer())).digest("base64");
  expect(`sha384-${digest}`).toBe(frame.integrity);
  // A file that isn't there is never kept.
  expect((await fetch(`${p.origin}/_erga/frame-none.js`)).headers.get("cache-control")).toBe("no-store");
  expect((await pagesFetch(src.replace(/([?&])v=[^&]+/, "$1v=old"))).headers.get("cache-control")).toBe("no-cache");
  expect(editor).toContain('if (location.hash == "#edit") {');
  // The editor's shell is in the page (no page of its own to fetch); its script and chunks are preloaded, and its start
  // and socket asked for, as the page parses.
  expect(editor).toContain('<template id="erga-shell"><style>');
  expect(editor).not.toMatch(/\/_erga\/editor-[a-z0-9]+\.html","fetch"/);
  expect(editor).toMatch(/\["\/_erga\/main-[a-z0-9]+\.js"(,"\/_erga\/chunk-[a-z0-9]+\.js")*\]/);
  expect(editor).toContain('rel: "modulepreload"');
  expect(editor).toContain('"/api/start"');
  expect((await pagesFetch(url)).headers.get("server-timing") ?? "").toContain("worker;dur=");
});

test("the viewer holds the page inline, in an opaque origin, with an ETag (304 when unchanged); its files are at their version's address, kept a year, readable from any origin, each in a sandbox of its own; a forged key opens nothing; an edit gives a new version", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  const { address } = await p.nameOf(id);
  const view = await p.get(address);
  expect(view.status).toBe(200);
  expect(view.headers.get("cache-control")).toBe("private, no-cache");
  const html = await view.text();
  const frame = /<iframe id="frame"[^>]*srcdoc="([^"]*)"/.exec(html)![0];
  expect(frame).toContain('sandbox="allow-scripts allow-forms allow-modals allow-popups"');
  expect(frame).not.toContain("allow-same-origin");
  const base = /&lt;base href=&quot;([^&]+)&quot;&gt;/.exec(frame)![1];
  expect(new URL(base).origin).toBe(p.origin);
  expect(new URL(base).pathname).toMatch(new RegExp(`^/_f/${id}\\.l[0-9a-f]+\\.[A-Za-z0-9_-]+/$`));
  // Unchanged: a 304, with no body.
  const etag = view.headers.get("etag")!;
  expect(etag).toBeTruthy();
  const again = await p.get(address, { headers: { "If-None-Match": etag } });
  expect(again.status).toBe(304);
  // A file at the version's address: anyone holding the key (no cookie), kept for good.
  const file = await fetch(`${base}index.html`, { headers: { Origin: "null" } });
  expect(file.status).toBe(200);
  expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(file.headers.get("access-control-allow-origin")).toBe("*");
  expect(file.headers.get("content-security-policy")).toBe(`sandbox allow-scripts allow-forms allow-modals allow-popups; frame-ancestors ${p.origin}`);
  expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await file.text()).toContain("<script>(function () {");
  // Forged, or another document's id under this key: nothing.
  const forged = base.replace(/\.[A-Za-z0-9_-]+\/$/, ".AAAAAAAAAAAAAAAAAAAAAA/");
  expect((await fetch(`${forged}index.html`)).status).toBe(404);
  expect((await fetch(`${base.replace(id, "aaaaaaaa")}index.html`)).status).toBe(404);
  // Someone it isn't shared with gets no page.
  expect((await p.as("Zed", address)).status).toBe(403);
  // Edited: another version, at another address; the old address still answers, with what it was.
  expect((await p.get(`/d/${id}/api/stored/index.html`, { method: "PUT", body: "<h1>Edited</h1>" })).status).toBe(200);
  let next = base;
  for (let i = 0; i < 40 && next == base; i++) {
    // (Its address follows its new heading.)
    const page = await (await p.get((await p.nameOf(id)).address)).text();
    next = /&lt;base href=&quot;([^&]+)&quot;&gt;/.exec(page)?.[1] ?? base;
    if (next == base) await new Promise((r) => setTimeout(r, 300));
  }
  expect(next).not.toBe(base);
  const old = await fetch(`${base}index.html`);
  expect(old.status).toBe(200);
  expect(await old.text()).not.toContain("<h1>Edited</h1>");
  expect(await (await fetch(`${next}index.html`)).text()).toContain("<h1>Edited</h1>");
});

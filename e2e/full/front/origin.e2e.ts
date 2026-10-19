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
  expect(editor).toContain('f.src = f.dataset.src + (location.hash == "#edit" ? "&edit=1"');
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
  expect(editor).toMatch(/\["\/_erga\/editor-[a-z0-9]+\.html","fetch"\]/);
  expect(editor).toMatch(/\["\/_erga\/main-[a-z0-9]+\.js","modulepreload"\]/);
  expect(editor).toContain('rel: "preload"');
  expect((await pagesFetch(url)).headers.get("server-timing") ?? "").toContain("worker;dur=");
});

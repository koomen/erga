// A document's page calls only its own origin (server/app.ts, server/documents/routes.ts): what the page's editor asks
// for with its edit key (the room's start, the comment ops) and the editor's own files are there, and the app's
// origin answers none of the keyed ones. So a gate in front checks one cookie for each origin (gate/core.ts).

import { expect, test } from "bun:test";
import { person, ROOT, server } from "./helpers/app.ts";

test("the page's start and comment ops answer on the document's own origin only; the editor's files are there too", async () => {
  const s = server();
  const p = await person(s);
  const id = await p.make();
  const address = (await p.tool<{ address: string }>("ls", { document: id })).result!.address;
  const viewer = await (await p.get(`${address}?edit`)).text();
  const own = new URL(/<meta name="erga-pages" content="([^"]+)">/.exec(viewer)![1]).origin;
  expect(own).not.toBe(ROOT);
  const key = ((await (await p.get(`/d/${id}/api/key`, { method: "POST", headers: { Origin: ROOT } })).json()) as { key: string }).key;
  expect(key).toBeTruthy();

  // The room's start: on the page's origin, as the page's own GET (no Origin), or with its Origin.
  const start = (origin: string, headers: Record<string, string> = {}) =>
    s.fetch(`${origin}/d/${id}/api/start?key=${encodeURIComponent(key)}`, { headers });
  expect((await start(own)).status).toBe(200);
  expect((await start(own, { Origin: own })).status).toBe(200);
  // From another site's page, or on the app's origin: refused, also with the person's own session.
  expect((await start(own, { Origin: "https://evil.example.org" })).status).toBe(403);
  expect((await start(ROOT, { Origin: own })).status).toBe(403);
  expect((await start(ROOT, { Cookie: p.cookie })).status).toBe(403);
  // Another document's origin does not answer for this one; a bad key opens nothing.
  const other = own.replace(id, "zzzzzzzz");
  expect((await start(other)).status).toBe(403);
  expect((await s.fetch(`${own}/d/${id}/api/start?key=nope`)).status).toBe(403);
  // Nothing else of the document's host is on its pages origin: its API needs the app's origin and a session.
  expect((await s.fetch(`${own}/d/${id}/api/doc`)).status).toBe(404);
  expect((await s.fetch(`${own}/d/${id}/api/doc?key=${encodeURIComponent(key)}`)).status).toBe(404);

  // The comment ops, with the key: there, from that page; nowhere else.
  const comments = (origin: string, from: string | null) =>
    s.fetch(`${origin}/api/tools/comments?doc=${id}&key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(from ? { Origin: from } : {}) },
      body: JSON.stringify({ document: id }),
    });
  // (This server in memory has no comments to read: the op runs, and is not refused. The journey
  // e2e/security/boundaries.e2e.ts writes a comment so, in a browser.)
  const read = await comments(own, own);
  expect([403, 404]).not.toContain(read.status);
  expect(read.headers.get("access-control-allow-origin")).toBeNull();
  expect((await comments(ROOT, own)).status).toBe(403);
  expect((await comments(own, "https://evil.example.org")).status).toBe(403);
  expect((await comments(own, null)).status).toBe(403);
  // No other tool is on a pages origin, key or not.
  const list = await s.fetch(`${own}/api/tools/list_documents?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Origin: own },
    body: "{}",
  });
  expect(list.status).toBe(404);

  // The editor's files and its library: on the page's origin, as on the app's.
  const library = await s.fetch(`${own}/erga/text/editor.js`);
  expect(library.status).toBe(200);
  const build = /import "([^"]+)"/.exec(await library.text())![1];
  expect(build.startsWith("/_erga/")).toBe(true);
  expect((await s.fetch(`${own}${build}`)).status).toBe((await s.fetch(`${ROOT}${build}`)).status);
});

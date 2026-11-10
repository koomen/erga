// POST /api/publish (server/api.ts), as an outside agent uses it with its person's token: a folder becomes a document
// at its title's address; publishing again into the document replaces its files. The whole app, in memory.

import { expect, test } from "bun:test";
import { person, server, tool, type Person, type Server } from "./helpers/app";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaPhfDwAEgQHAp0dVPQAAAABJRU5ErkJggg=="), (c) =>
  c.charCodeAt(0)
);

/** Publishes a small folder (a page, a stylesheet, a script, a picture) titled `title`, with multipart parts named by their paths. */
async function publish(s: Server, token: string, title = "Published app") {
  const site = new FormData();
  site.set("title", title);
  site.set(
    "index.html",
    new Blob([
      `<!doctype html><title>x</title><link rel="stylesheet" href="css/app.css"><h1>Hello from a folder</h1><img src="img/dot.png"><script src="app.js"></script>`,
    ]),
    "index.html"
  );
  site.set("css/app.css", new Blob(["h1 { color: rebeccapurple }"]), "app.css");
  site.set("file", new Blob(["console.log('hi')"]), "app.js");
  site.set("img/dot.png", new Blob([PNG]), "dot.png");
  const res = await s.fetch("/api/publish", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: site });
  return { res, pub: (await res.json()) as { ok: boolean; id: string; address: string; url: string; files: string[] } };
}

/** A server, a fresh person on it and a documents token of theirs. */
async function setup(): Promise<{ s: Server; p: Person; token: string }> {
  const s = server();
  const p = await person(s);
  return { s, p, token: await p.token() };
}

test("POST /api/publish makes a document of a folder at its title's address: images byte for byte, styles as text; it's listed, and doesn't expire", async () => {
  const { s, p, token } = await setup();
  const { res, pub } = await publish(s, token);
  expect(res.ok).toBe(true);
  expect(pub).toMatchObject({ address: `/${p.login}/published-app`, url: `${p.origin}/${p.login}/published-app` });
  expect(pub.files).toEqual(["app.js", "css/app.css", "img/dot.png", "index.html"]);
  expect(new Uint8Array(await (await p.get(`/d/${pub.id}/doc/img/dot.png`)).arrayBuffer())).toEqual(PNG);
  expect(await (await p.get(`/d/${pub.id}/doc/css/app.css`)).text()).toContain("rebeccapurple");
  const list = await p.docs();
  expect(list).toContain(`href="/${p.login}/published-app?edit"`);
  expect(list.slice(list.indexOf(`/${p.login}/published-app?edit"`)).split("</li>")[0]).not.toContain("Unedited");
});

test("publishing again into the same document replaces its files; rename_document renames it; delete_document deletes yours", async () => {
  const { s, p, token } = await setup();
  const { pub } = await publish(s, token);
  const res = await s.fetch("/api/publish", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ document: pub.id, files: { "index.html": "<!doctype html><h1>Version two</h1>" } }),
  });
  const again = (await res.json()) as { written: string[]; removed: string[] };
  expect(res.ok).toBe(true);
  expect(again.written).toEqual(["index.html"]);
  expect(again.removed.sort()).toEqual(["app.js", "css/app.css", "img/dot.png"]);
  expect(await (await p.get(`/d/${pub.id}/doc/index.html`)).text()).toContain("Version two");
  expect((await p.get(`/d/${pub.id}/doc/app.js`)).status).toBe(404);
  const r = await tool(s, token, "rename_document", { document: pub.id, slug: "v2" });
  expect(r.status).toBe(200);
  expect(r.data?.address).toBe(`/${p.login}/v2`);
  expect((await p.tool<{ slug: string }>("ls", { document: pub.id })).result!.slug).toBe("v2");
  expect((await tool(s, token, "delete_document", { document: pub.id })).status).toBe(200);
  expect(await p.exists(pub.id)).toBe(false);
});

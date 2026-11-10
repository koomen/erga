// /new and /scratch (server/documents/make.ts): each template's document, and another site's link or form, which asks
// first and makes nothing. The whole app, in memory.

import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { TEMPLATES } from "../server/pages/index.ts";
import { person, server, signedOut, type Server } from "./helpers/app";

const template = (files: string) => readFileSync(new URL(`../${files}/index.html`, import.meta.url), "utf8");

/** Makes a document from a template (/new?template=<id>), as the dev login: the answer, and the document's address (no ?edit). */
async function newDoc(s: Server, id: string) {
  const r = await s.fetch(`/new?template=${id}`);
  const location = r.headers.get("location") ?? "";
  return { status: r.status, location, address: location.replace(/[?&]edit=?$/, "") };
}

/** A document's page as it is stored, from its address. */
async function fileOf(s: Server, address: string) {
  const id = ((await (await s.fetch(`${address}/api/doc`)).json()) as { docName: { id: string } }).docName.id;
  return (await s.fetch(`/d/${id}/doc/index.html`)).text();
}

test("/new?template=<id> makes each template's document, Document (id page) first; an unknown one (or the demo page) is a 404", async () => {
  const s = server();
  const page = await newDoc(s, "page");
  expect(page.status).toBe(302);
  expect(page.location).toMatch(/[?&]edit=?$/);
  expect(TEMPLATES[0].id).toBe("page");
  expect(await fileOf(s, page.address)).toBe(template("assets/templates/doc"));
  for (const t of TEMPLATES.slice(1)) expect(await fileOf(s, (await newDoc(s, t.id)).address), t.name).toBe(template(t.files));
  expect((await newDoc(s, "nope")).status).toBe(404);
  expect((await newDoc(s, "demo")).status).toBe(404);
});

test("another site's link or form to /new asks first and makes nothing; the button, posted from here, makes the document", async () => {
  const p = await person(server());
  const before = await p.docs();
  const linked = await p.get("/new?from=landing", { headers: { "Sec-Fetch-Site": "cross-site" } });
  expect(linked.status).toBe(200);
  expect(await linked.text()).toContain(`<form method="post" action="/new?from=landing">`);
  expect(await p.docs()).toBe(before);
  expect((await p.get("/new", { method: "POST", headers: { Origin: "https://elsewhere.example" } })).status).toBe(200);
  expect(await p.docs()).toBe(before);
  const posted = await p.get("/new", { method: "POST", headers: { Origin: p.origin } });
  expect(posted.status).toBe(302);
  expect(posted.headers.get("location") ?? "").toMatch(new RegExp(`^/${p.login}/`));
});

test("signed out, /scratch signs in first; another site's link asks first and makes nothing", async () => {
  const s = server();
  const out = await s.fetch("/scratch", { headers: signedOut() });
  expect(out.status).toBe(302);
  expect(out.headers.get("location")).toBe(`/auth/sign-in?next=${encodeURIComponent("/scratch")}`);
  const p = await person(s);
  const linked = await p.get("/scratch", { headers: { "Sec-Fetch-Site": "cross-site" } });
  expect(linked.status).toBe(200);
  expect(await linked.text()).toContain(`<form method="post" action="/scratch">`);
  // Nothing was made: no scratch document of theirs is in the directory.
  expect(await s.sql.all("SELECT id FROM documents WHERE owner = ?", p.login)).toEqual([]);
});

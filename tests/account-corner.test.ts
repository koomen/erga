// The account corner in the pages the server sends (server/pages/bars.ts, server/pages/account-menu.ts): every page
// of the site's own has it, the editor has its own, a document's files have none. The whole app, in memory.

import { expect, test } from "bun:test";
import type { LivePage } from "../server/home/snapshot.ts";
import { server, signedOut, type Server } from "./helpers/app";

/** The dev login signs in with a pretend GitHub account, so it has GitHub's picture, by its id: that picture. */
async function githubPicture(s: Server): Promise<string> {
  await s.fetch("/auth/dev?provider=github&subject=4242&handle=tester");
  return "https://avatars.githubusercontent.com/u/4242?s=64";
}

/** A new document from /new, as the dev login: its editor address (with ?edit) and id. */
async function newDoc(s: Server): Promise<{ at: string; id: string }> {
  const at = (await s.fetch("/new")).headers.get("location")!;
  expect(at).toMatch(/[?&]edit=?$/);
  const id = ((await (await s.fetch(`${at.replace(/[?&]edit=?$/, "")}/api/doc`)).json()) as { docName: { id: string } }).docName.id;
  return { at, id };
}

test("every page of the site's own has your avatar in its corner", async () => {
  const s = server();
  const picture = await githubPicture(s);
  // (/ is /docs for someone signed in; the homepage project's page is /_home.)
  for (const path of ["/_home", "/docs", "/admin", "/settings", "/nobody-here"]) {
    const html = await (await s.fetch(path)).text();
    expect(html, path).toContain('data-erga-account="in"');
    expect(html, path).toContain(`<img src="${picture}" alt="" draggable="false"`);
    // Never GitHub's picture for the username: it may be another GitHub person's.
    expect(html, path).not.toContain("avatars.githubusercontent.com/tester");
  }
});

test("the editor's page has the corner, and the links for its own menu, Admin among them for an admin", async () => {
  const s = server();
  const { at } = await newDoc(s);
  const html = await (await s.fetch(at)).text();
  expect(html).toContain('data-erga-account="in"');
  expect(html).toContain('name="erga-account"');
  expect(JSON.parse(/name="erga-account" content="([^"]+)"/.exec(html)![1].replaceAll("&quot;", '"')).admin).toBe("/admin");
});

test("a document's own files, and the homepage's document on its pages origin, have no corner", async () => {
  const s = server();
  const { id } = await newDoc(s);
  expect(await (await s.fetch(`/d/${id}/doc/index.html`)).text()).not.toContain("data-erga-account");
  // The homepage (signed out: someone signed in goes to /docs). Until its first deploy is done it is the viewer, whose
  // frame is the page on its pages origin.
  const viewer = await (await s.fetch("/", { headers: signedOut() })).text();
  expect(viewer).toContain('<iframe id="frame" class="erga-view"');
  const pages = /name="erga-pages" content="([^"]+)"/.exec(viewer)![1];
  const framed = await s.fetch(`${pages}index.html`, { headers: { "Sec-Fetch-Dest": "iframe" } });
  expect(framed.status).toBe(200);
  expect(await framed.text()).not.toContain("data-erga-account");
  // Then it is the page itself, served from the deploy, whose one corner is in its controls.
  const page: LivePage = {
    gen: "g1",
    docId: /name="erga-doc" content="([^"]+)"/.exec(viewer)![1],
    address: "/_home",
    before: "<!doctype html><html><head><title>Erga</title></head><body><h1>Erga</h1>",
    after: "</body></html>",
    files: ["index.html"],
    site: { bars: true, redirects: [] },
    at: 1,
    version: 1,
  };
  s.platform.home.page = async () => ({ same: false, page });
  const front = await (await s.fetch("/", { headers: signedOut() })).text();
  expect(front).toContain("<h1>Erga</h1>");
  const at = front.indexOf("<erga-controls");
  expect(at).toBeGreaterThan(0);
  expect(front.split("data-erga-account").length).toBe(2);
  expect(front.indexOf("data-erga-account")).toBeGreaterThan(at);
});

test("someone who isn't an admin has no Admin, and a local tab's ?user= stays on the links", async () => {
  const html = await (await server().fetch("/docs?user=Ada")).text();
  expect(html).toContain('data-erga-account="in"');
  expect(html).toContain('href="/docs?user=Ada"');
  expect(html).not.toContain('href="/admin');
});

test("signed out, /docs asks you to sign in first, and the homepage's corner offers it", async () => {
  const s = server();
  const out = await s.fetch("/auth/logout", { method: "POST", headers: { Origin: s.root } });
  const cookie = out.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect((await s.fetch("/docs", { headers: { Cookie: cookie } })).headers.get("location")).toBe("/auth/sign-in?next=%2Fdocs");
  const front = await (await s.fetch("/", { headers: { Cookie: cookie } })).text();
  expect(front).toContain('data-erga-account="out"');
  expect(front).toContain('href="/auth/sign-in?next=%2F"');
});

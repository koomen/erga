// The homepage project is a site (server/home/site.ts): clean addresses, folders at any depth, its 404 page, its
// redirects, and whether the bars show. On the Erga domain, Erga's paths win: its pages, and documents that are there.
import { expect, servers, test } from "../../helpers/fixtures";
import { adminToken, front, get, openHome, publish, resetLanding, setLanding, signedOut } from "./home";

await servers.short();
test.afterEach(async () => {
  await resetLanding(await servers.short());
});

const html = (title: string, body = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="${body.includes("deep") ? "../../" : body.includes("folder") ? "../" : ""}style.css"></head><body><h1>${title}</h1>${body}</body></html>`;
const files = {
  "index.html": html("Site home", `<a href="about">About</a>`),
  "about.html": html("About me"),
  "blog/index.html": html("The blog", `<p>folder</p><a id="post" href="2026/post">Post</a>`),
  "blog/2026/post.html": html("A post", "<p>deep</p>"),
  "docs.html": html("My docs page"),
  "404.html": html("Lost", "<p>No page here.</p>"),
  "style.css": "h1 { color: rgb(1, 2, 3); }",
  _redirects: "/old /about\n/blog/old/* /blog/2026/:splat 302\n",
};

/** A site of DEV_LOGIN's made the homepage, deployed: its server, token, id and address. */
async function site(more: Record<string, string> = {}) {
  const server = await servers.short();
  const token = await adminToken(server);
  const made = await publish(server, token, { ...files, ...more }, { title: "Site home" });
  expect((await setLanding(server, made.id)).error).toBeUndefined();
  await expect.poll(async () => (await front(server)).html.includes("<h1>Site home</h1>")).toBe(true);
  return { server, token, ...made, address: new URL(made.url).pathname };
}

/** An address as someone signed out gets it: its status, where it goes, and its text. */
const out = async (server: Awaited<ReturnType<typeof site>>["server"], path: string) => {
  const r = await get(server, path, { headers: signedOut(server) });
  return { status: r.status, location: r.headers.get("location"), text: await r.text() };
};

test("pages at clean addresses, folders at any depth, the redirects and the 404 page", async () => {
  const { server } = await site();
  expect(await out(server, "/about")).toMatchObject({ status: 200, text: expect.stringContaining("<h1>About me</h1>") });
  expect(await out(server, "/about.html")).toMatchObject({ status: 200, text: expect.stringContaining("<h1>About me</h1>") });
  expect(await out(server, "/blog?x=1")).toMatchObject({ status: 301, location: "/blog/?x=1" });
  expect(await out(server, "/blog/")).toMatchObject({ status: 200, text: expect.stringContaining("<h1>The blog</h1>") });
  expect(await out(server, "/blog/2026/post")).toMatchObject({ status: 200, text: expect.stringContaining("<h1>A post</h1>") });
  expect(await out(server, "/old")).toMatchObject({ status: 301, location: "/about" });
  expect(await out(server, "/blog/old/post")).toMatchObject({ status: 302, location: "/blog/2026/post" });
  expect(await out(server, "/nothing")).toMatchObject({ status: 404, text: expect.stringContaining("<h1>Lost</h1>") });
  // The site's settings are never served.
  expect((await out(server, "/_redirects")).status).toBe(404);
});

test("on the Erga domain, Erga's pages and its documents win over the site's files", async () => {
  const s = await site();
  // The site's own address for its document is a page of the site too: the document wins.
  const [, owner, slug] = s.address.split("/");
  await publish(s.server, s.token, { [`${owner}/${slug}.html`]: html("Not the document") }, { document: s.id });
  expect((await out(s.server, "/docs")).text).not.toContain("My docs page");
  const doc = await (await get(s.server, s.address)).text();
  expect(doc).not.toContain("Not the document");
  expect(doc).toContain('<meta name="erga-doc"');
  // A document's address with nothing there is Erga's too: signed out, it asks to sign in.
  expect((await out(s.server, `/${owner}/no-such-document`)).text).not.toContain("<h1>Lost</h1>");
});

test("site.json turns the bars off: / has no controls and no room for them", async ({ tab }) => {
  const { server } = await site({ "site.json": `{"bars": false}` });
  const home = await front(server);
  expect(home.html).not.toContain("<erga-controls");
  expect(home.html).not.toContain("padding-top");
  // The page's own links work at their clean addresses, and its relative files load from a folder's page.
  await openHome(tab.page, server.root);
  await Promise.all([tab.page.waitForURL((u) => u.pathname == "/about"), tab.page.click("a")]);
  expect(await tab.page.locator("h1").textContent()).toBe("About me");
  await tab.page.goto(`${server.root}/blog`);
  expect(new URL(tab.page.url()).pathname).toBe("/blog/");
  await expect.poll(() => tab.page.evaluate(() => getComputedStyle(document.querySelector("h1")!).color)).toBe("rgb(1, 2, 3)");
  await Promise.all([tab.page.waitForURL((u) => u.pathname == "/blog/2026/post"), tab.page.click("#post")]);
  await expect.poll(() => tab.page.evaluate(() => getComputedStyle(document.querySelector("h1")!).color)).toBe("rgb(1, 2, 3)");
});

// Addresses resolving to pages, and the pages origin's relative redirects (tests/pages.ts).
import { expect, servers, test } from "../fixtures";
import { pagesFetch } from "../versions/versions";
import { PAGE, site, type Site } from "./tree";

await servers.short();

const at = async (s: Site, path: string) => { const r = await s.get(path); return { status: r.status, location: r.headers.get("location"), page: /<meta name="erga-page" content="([^"]*)"/.exec(await r.text())?.[1] ?? null }; };

test("/blog is blog/index.html, /about about.html; no slash added; file names redirect to the address; missing pages are 404s", async () => {
  const s = await site(await servers.short(), { pages: true });
  const a = s.address;
  const cases: [string, number, string | null, string | null][] = [
    [a, 200, null, null], // (the document's own page, which its frame asks for as doc/)
    [`${a}/blog`, 200, null, "blog/index.html"],
    [`${a}/blog/`, 200, null, "blog/index.html"],
    [`${a}/blog/post`, 200, null, "blog/post.html"],
    [`${a}/about`, 200, null, "about.html"],
    [`${a}/about.html`, 302, `${a}/about`, null],
    [`${a}/blog/index`, 302, `${a}/blog`, null],
    [`/d/${s.id}/blog/post`, 302, `${a}/blog/post`, null],
    [`${a}/nope`, 404, null, null],
    [`${a}/edit`, 404, null, null],
    [`${a}/blog/edit`, 404, null, null],
    [`${a}/style`, 404, null, null],
  ];
  for (const [path, status, location, page] of cases) {
    const r = await at(s, path);
    expect({ path, status: r.status, location: r.location, ...(page ? { page: r.page } : {}) }).toEqual({ path, status, location, ...(page ? { page } : {}) });
  }
  const missing = await (await s.get(`${a}/nope`)).text();
  expect(missing).toContain("no page here");
  expect(missing).toContain(`href="${a}"`);
});

test("blog.html wins over blog/index.html; a page or folder may be called edit, and /edit is that page, not the editor", async () => {
  const s = await site(await servers.short(), { pages: true });
  const a = s.address;
  await s.write("blog.html", PAGE("Blog, the file", `<h1>blog.html</h1>`));
  expect((await at(s, `${a}/blog`)).page).toBe("blog.html");
  expect((await at(s, `${a}/blog/post`)).page).toBe("blog/post.html");
  await s.treeOp({ op: "delete", path: "blog.html" });
  expect((await at(s, `${a}/blog`)).page).toBe("blog/index.html");
  for (const op of [{ op: "new_page", path: "edit.html" }, { op: "new_folder", path: "blog/edit" }, { op: "new_page", path: "blog/edit/index.html" }]) expect((await s.treeOp(op)).status).toBe(200);
  expect((await at(s, `${a}/edit`)).page).toBe("edit.html");
  expect((await at(s, `${a}/blog/edit`)).page).toBe("blog/edit/index.html");
  await s.treeOp({ op: "delete", path: "edit.html" });
  await s.treeOp({ op: "delete", path: "blog/edit" });
  expect((await at(s, `${a}/edit`)).status).toBe(404);
});

test("on the pages origin, a page's address goes to its file, relatively, so relative links and assets resolve", async () => {
  const s = await site(await servers.short(), { pages: true });
  const viewer = await (await s.get(`${s.address}/blog`)).text();
  const frameSrc = /<iframe id="frame"[^>]* (?:data-)?src="([^"]+)"/.exec(viewer)?.[1]?.replace(/&amp;/g, "&") ?? "";
  const frame = new URL(frameSrc);
  expect(frame.searchParams.get("view")).toBe("blog/index.html");
  const onPages = (path: string) => pagesFetch(`${frame.origin}${frame.pathname}${path}`);
  for (const [path, location] of [["doc/blog", "blog/index.html"], ["doc/blog/", "index.html"], ["doc/blog/post", "post.html"]]) {
    const r = await onPages(path);
    expect({ path, status: r.status, location: r.location }).toEqual({ path, status: 302, location });
  }
  const root = await onPages("doc/");
  expect(root.status).toBe(200);
  expect(await root.text()).toContain("<h1>Home</h1>");
  expect((await onPages("doc/blog/blog.css")).status).toBe(200);
  expect((await onPages("doc/nope")).status).toBe(404);
});

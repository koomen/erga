// The site's own pages say no other site may frame them (server/security.ts): each kind of page sends frame-ancestors
// 'self' and X-Frame-Options, and its Content-Security-Policy; a document's page on its pages origin names only its
// viewer. A page of another site that frames /docs gets nothing, and the editor works with the headers on.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";
import { framed } from "../../helpers/pages-fetch";
import { signedOut } from "../home/home";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

await servers.main();

/**
 * The pages of the site's own, one of each kind (the local server's person is signed in, and an admin; / is the
 * homepage only signed out: signed in, it goes to /docs, and the homepage project's page is /_home).
 */
const PAGES = ["/", "/_home", "/docs", "/settings", "/tokens", "/admin", "/admin/users", "/admin/auth", "/admin/changes", "/no/such-page"];

test("every kind of the site's own page sends frame-ancestors 'self', X-Frame-Options, and its policy; a document's page names its viewer", async () => {
  const s = await servers.main();
  const { address } = await s.fixture("page");
  for (const path of [...PAGES, new URL(address).pathname, `${new URL(address).pathname}?edit`]) {
    const res = await fetch(s.root + path, { headers: { Accept: "text/html", ...(path == "/" ? signedOut(s) : {}) }, redirect: "manual" });
    expect([200, 404], path).toContain(res.status);
    expect(res.headers.get("content-type"), path).toMatch(/^text\/html/);
    expect(res.headers.get("x-frame-options"), path).toBe("SAMEORIGIN");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp, path).toContain("frame-ancestors 'self'");
    // The homepage is its authors' (only the frame rule); every other page has the site's whole policy.
    if (path != "/") expect(csp, path).toContain("object-src 'none'; base-uri 'self'");
    // And only the scripts the server wrote in, each with this answer's nonce.
    const nonce = /script-src 'nonce-([^']+)' 'strict-dynamic'/.exec(csp)?.[1];
    if (path != "/") {
      expect(nonce, path).toBeTruthy();
      const html = await res.clone().text();
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      expect(scripts.length, path).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag, path).toContain(`nonce="${nonce}"`);
      expect(html, path).not.toMatch(/\son(error|load|click)=/);
    }
    // Not over HTTPS here: no HSTS on this machine.
    expect(res.headers.get("strict-transport-security"), path).toBeNull();
    await res.body?.cancel();
  }
  // The document's page, on its pages origin: only its viewer may frame it, and nothing of the site's is added.
  const viewer = await (await fetch(address)).text();
  // The frame's address, as the page makes it from its metas (ergaFrames.src(), client/inline/viewer-frames.ts).
  const meta = (name: string) => new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(viewer)?.[1].replaceAll("&amp;", "&");
  const src = meta("erga-pages") && meta("erga-pages")! + (meta("erga-page") ?? "").split("/").map(encodeURIComponent).join("/");
  expect(src, "the viewer's frame").toBeTruthy();
  const page = await framed(src!);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toBe(`frame-ancestors ${s.root}`);
  expect(page.headers.get("x-frame-options")).toBeNull();
});

test("a page of another site can't frame /docs; one of its own frames loads", async ({ tab }) => {
  const s = await servers.main(), page = tab.page;
  // Another site on this machine (localhost, where the server is 127.0.0.1), with a frame of /docs and one of its own.
  const other = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(req.url == "/own" ? "<!doctype html><h1>Its own</h1>" : `<!doctype html><title>Elsewhere</title><iframe name="docs" src="${s.root}/docs"></iframe><iframe name="own" src="/own"></iframe>`);
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  try {
    await page.goto(`http://localhost:${(other.address() as AddressInfo).port}/`);
    const frame = (name: string) => page.frames().find((f) => f.name() == name);
    // Its own frame loads (so frames load here at all); /docs's is the browser's error page, with nothing of /docs in it.
    await until(() => frame("own")?.evaluate(() => document.querySelector("h1")?.textContent == "Its own").catch(() => false), 10_000, "the page's own frame loads");
    await until(() => frame("docs")?.url().startsWith("chrome-error:"), 10_000, "the browser refuses to frame /docs", () => frame("docs")?.url());
    expect(await frame("docs")!.evaluate(() => document.querySelectorAll("a[href^='/']").length).catch(() => 0)).toBe(0);
  } finally { other.close(); }
});

test("the editor works with the headers on: typing reaches the page and the file", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("h1");
  await ed.type(" safe");
  await expect.poll(() => ed.textOf("h1")).toBe("Launch notes safe");
  await expect.poll(() => ed.disk()).toContain("<h1>Launch notes safe</h1>");
});

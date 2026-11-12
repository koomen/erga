// The viewer, for its journeys: a document's page in the test's tab.
// The tab holds Erga's two bars and the document's frame (#frame): the page on the document's own origin, viewing
// and editing alike (the editor runs in it). `inDoc` evaluates in that page.

import type { Frame, Page } from "playwright-core";
import { settle, until, type Server } from "../helpers/fixtures";
import { idOf, runTool } from "../helpers/tools";

/** Opens `url` in the tab at this size, as someone who keeps the agent pane closed unless `agent`. */
export async function openViewer(page: Page, url: string, opts: { width?: number; height?: number; agent?: boolean } = {}) {
  await page.setViewportSize({ width: opts.width ?? 1200, height: opts.height ?? 760 });
  await page.addInitScript((agent) => {
    if (window.top != window || agent) return;
    try {
      if (!sessionStorage.getItem("erga-test:agent-seeded")) {
        sessionStorage.setItem("erga-test:agent-seeded", "1");
        if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}');
      }
    } catch {
      /* no storage */
    }
  }, opts.agent ?? false);
  await page.goto(url);
}

/** The document's page: the tab's frame on the document's own origin; null while it loads. */
export const docFrame = (page: Page): Frame | null =>
  page.frames().find((f) => f.parentFrame() == page.mainFrame() && /\/t\//.test(f.url())) ?? null;

/** Evaluates `expr` in the document's page; null while the page loads or is replaced. */
export const inDoc = <T>(page: Page, expr: string): Promise<T | null> =>
  docFrame(page)
    ?.evaluate(expr)
    .then((v) => v as T)
    .catch(() => null) ?? Promise.resolve(null);

/** The page's heading and how it is styled: its colour, and the body's width limit. */
export const styled = (page: Page) =>
  inDoc<{ h1: string; color: string; width: string }>(
    page,
    `(() => { const h = document.querySelector("h1"); return h ? { h1: h.textContent, color: getComputedStyle(h).color, width: getComputedStyle(document.body).maxWidth } : null; })()`
  );

/** Waits until the document's page shows a heading that includes `text`. */
export const docShows = (page: Page, text: string, ms = 10_000) =>
  until(
    async () => (await inDoc<string>(page, `document.querySelector("h1")?.textContent ?? ""`))?.includes(text),
    ms,
    `the page shows "${text}"`
  );

/** The tab's address: its path and query. */
export const where = (page: Page) => page.evaluate(() => location.pathname + location.search).catch(() => "");

/** The editor is up: its controls in the tab, and its half in the page, which has joined the room. */
export const editorUp = async (page: Page) =>
  (await page
    .evaluate(() => ["erga-editor-ready", "erga-editing", "erga-listening"].every((c) => document.body.classList.contains(c)))
    .catch(() => false)) && !!(await inDoc<boolean>(page, "!!window.ergaFrame?.page && !ergaFrame.reloading"));

/** The viewer shows the page alone: nothing of the editor's is on it. */
export const viewing = async (page: Page) =>
  (await page.evaluate(() => !document.body.classList.contains("erga-editing")).catch(() => false)) &&
  !!(await inDoc<boolean>(
    page,
    `!window.ergaFrame && !document.querySelector('[contenteditable], [data-erga-editing], style[data-erga="page"]')`
  ));

/** Signs `login` in on the dev server (/auth/github?as=): the session's cookie, for requests as that person. */
export async function signIn(server: Server, login: string): Promise<string> {
  const r = await fetch(`${server.root}/auth/github?as=${login}&next=/docs`, { redirect: "manual" });
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => /^erga_session(_\d+)?=/.test(c));
  if (!cookie) throw new Error(`signing in as ${login}: ${r.status}`);
  return cookie;
}

export type Box = { l: number; t: number; r: number; b: number };
/** The parts of Erga's two bars, by one name for the viewer's and the editor's. */
const PARTS = {
  view: {
    left: ".erga-crumbs",
    right: ".erga-view-buttons",
    brand: ".erga-brand",
    new: ".erga-new-btn",
    full: ".erga-full-button",
    edit: ".erga-edit-button",
    agent: ".erga-agent-share",
    docs: ".erga-docs-button",
    me: ".erga-account-btn",
  },
  edit: {
    left: "#nav-docs",
    right: ".chrome-top",
    brand: "#nav-brand",
    new: "#btn-new",
    full: "#btn-full",
    edit: "#btn-edit",
    agent: "#btn-agent-share",
    docs: "#btn-docs",
    me: ".me-slot .avatar",
  },
};
export const GLASS = { radius: "14px", blur: true, shadow: true };

/** The parts that show (each on top where it is) with their boxes, and each bar's glass. */
export const bars = (page: Page, mode: "view" | "edit") =>
  page.evaluate((parts) => {
    const out: Record<string, { l: number; t: number; r: number; b: number }> = {};
    for (const [name, sel] of Object.entries(parts)) {
      const el = document.querySelector(sel);
      const r = el?.getBoundingClientRect();
      if (!el || !r?.width) continue;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top || !el.contains(top)) continue;
      out[name] = {
        l: Math.round(r.left * 2) / 2,
        t: Math.round(r.top * 2) / 2,
        r: Math.round(r.right * 2) / 2,
        b: Math.round(r.bottom * 2) / 2,
      };
    }
    const glass = (sel: string) => {
      const s = getComputedStyle(document.querySelector(sel)!);
      return { radius: s.borderTopLeftRadius, blur: s.backdropFilter.includes("blur"), shadow: s.boxShadow != "none" };
    };
    return { parts: out, glass: [glass(parts.left), glass(parts.right)] };
  }, PARTS[mode]);

/** A page of the site: the document's stylesheet (`up` folders above), its folder's own if `blog`, and a body. */
const PAGE = (title: string, body: string, up = "", blog = false) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <link rel="stylesheet" href="${up}style.css">${blog ? '\n  <link rel="stylesheet" href="blog.css">' : ""}
</head>
<body>
  <main>
${body}
  </main>
</body>
</html>
`;

/**
 * A document with several pages, for a reader: a copy of e2e/fixtures/multi (a home page, an about page, a blog
 * folder, a stylesheet, an image and a font), with links between its pages and a stylesheet of the blog's own
 * (its headings are red). The links are written in each way a page may write one: relative, as the page's Erga
 * address, with the server's name, and out of the document.
 */
export async function site(server: Server) {
  const { dir, address } = await server.fixture("multi");
  const id = await idOf(address);
  const path = new URL(address).pathname;
  const nav = (links: string) => `    <nav data-erga-noedit>${links}</nav>`;
  const w = await runTool(server.root, "write", {
    document: id,
    files: {
      "blog/blog.css": "h1 { color: rgb(180, 40, 30); }\n",
      "blog/spring-migration.html": PAGE(
        "Spring migration",
        `${nav('<a href="./">Blog</a>')}\n    <h1>Spring migration</h1>\n    <p>The first birds are back.</p>`,
        "../",
        true
      ),
      "blog/index.html": PAGE(
        "The blog",
        `${nav(`<a href="${path}/about">About</a> · <a href="/docs">Docs</a> · <a href="${server.root}/docs">Full docs</a>`)}\n    <h1>The blog</h1>\n    <p>Every post, newest first.</p>\n    <p>Read <a href="../about.html">about us</a> here.</p>`,
        "../",
        true
      ),
      "about.html": PAGE(
        "About us",
        `${nav(`<a href="blog/spring-migration.html">A post</a> · <a href="${server.root}${path}/blog">Blog</a>`)}\n    <h1>About us</h1>\n    <p>Who writes the field guide, and why.</p>`
      ),
    },
  });
  if (!w.ok || w.result.refused.length) throw new Error(`the site's pages: ${w.status} ${w.error ?? JSON.stringify(w.result.refused)}`);
  return { dir, address, id, path };
}

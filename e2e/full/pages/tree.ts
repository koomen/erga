// Helpers for the tests of documents with many pages (document/pages.ts,
// client/pages/pages-tree.ts, the agents' file tools): a sample document of DEV_LOGIN's
// with a home page, a blog folder with its own stylesheet, and an about page,
// made through the server's API with an agent token, and the tree's API.

import { until, type Server } from "../../helpers/fixtures";
import { person, tools } from "../versions/versions";
import { runTool, textOf, treeOp } from "../../helpers/tools";

export const PAGE = (title: string, body: string, up = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="${up}style.css">
</head>
<body>
${body}
</body>
</html>
`;

export type Entry = { path: string; type: string; title?: string };
/** A tree's entries in short: folders end in /, files that aren't pages in *. */
export const paths = (entries: Entry[] = []) => entries.map((e) => `${e.path}${e.type == "folder" ? "/" : e.type == "file" ? "*" : ""}`).join(" ");

/** A new project of DEV_LOGIN's with just its home page and stylesheet (create_document), and its tree's API. */
export async function site(server: Server, opts: { pages?: boolean } = {}) {
  const owner = await person(server, "tester");
  const token = await owner.token("Pages test");
  const auth = { Authorization: `Bearer ${token}` };
  const slug = `site-${crypto.randomUUID().slice(0, 8)}`;
  const anyTool = async (name: string, args: Record<string, unknown>) => {
    const r = await runTool(server.root, name, args, { token });
    return { status: r.status, ok: r.ok, text: r.ok ? textOf(r.result) : (r.error ?? "") };
  };
  const made = await anyTool("create_document", { title: "Pages test", slug, kind: "project", files: {
    "index.html": PAGE("Home", `<nav data-erga-noedit><a href="blog">Blog</a> · <a href="about.html">About</a></nav>\n<h1>Home</h1>\n<p>The first page of a document with several.</p>`),
    "style.css": "body { background: rgb(250, 246, 236); font-family: Georgia, serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; } nav a { margin-right: .5rem; }\n",
  } });
  if (!made.ok) throw new Error(`create_document: ${made.text}`);
  const doc = JSON.parse(made.text) as { id: string; address: string };
  const tool = tools(server, token, doc.id);
  const s = {
    ...doc, owner, token, auth, slug, get: owner.get, tool, anyTool,
    /** The page tree, as `who` reads it (list_pages). */
    async readTree(who: { cookie: string } = owner) {
      const r = await runTool(server.root, "list_pages", { document: doc.id }, { cookie: who.cookie });
      return { status: r.status, body: (r.ok ? r.result : { error: r.error }) as { entries?: Entry[]; canEdit?: boolean; error?: string } };
    },
    /** A change to the page tree, as `who` makes it in the tree (from `origin`: the site's own, unless given). */
    async treeOp(op: Record<string, unknown>, who: { cookie: string } = owner, origin?: string) {
      const r = await treeOp(server.root, doc.id, op, { cookie: who.cookie, ...(origin ? { origin } : {}) });
      return { status: r.status, body: (r.ok ? r.result : { error: r.error }) as { entries?: Entry[]; error?: string } };
    },
    async write(path: string, content: string) { const w = await tool("write", { path, content }); if (!w.ok) throw new Error(`write ${path}: ${w.text}`); },
    /** The owner's agent's log (its conversation, agents/person/sessions.ts). */
    agentLog: async () =>
      (
        (await (await owner.get("/api/agent/conversation")).json()) as {
          log: { busy: boolean; items: { kind: string; name?: string; status?: string; detail?: string; text?: string }[] };
        }
      ).log,
    /** A scripted turn of the owner's agent, from the document's page; the tool calls it made, once it's done. */
    async agentTurn(text: string, steps: unknown[], context?: string) {
      const before = (await s.agentLog()).items.length;
      const tools = steps.filter((x) => (x as { tool?: string }).tool).length;
      const sent = await owner.get("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: server.root },
        body: JSON.stringify({ text: `${text} @script ${JSON.stringify(steps)}`, doc: doc.id, ...(context ? { context } : {}) }),
      });
      if (!sent.ok) throw new Error(`the agent didn't take the prompt: ${sent.status}`);
      const log = await until(async () => { const l = await s.agentLog(); return !l.busy && l.items.slice(before).filter((i) => i.kind == "tool").length >= tools ? l : null; }, 10_000, "the agent's turn ends") as Awaited<ReturnType<typeof s.agentLog>>;
      return log.items.slice(before).filter((i) => i.kind == "tool");
    },
  };
  if (opts.pages) await blog(s);
  return s;
}
export type Site = Awaited<ReturnType<typeof site>>;

/** The sample's other pages: blog/ (an index, a post, its own stylesheet) and about.html. */
async function blog(s: Site) {
  await s.treeOp({ op: "new_folder", path: "blog" });
  await s.write("blog/index.html", PAGE("Blog", `<link rel="stylesheet" href="blog.css">\n<nav data-erga-noedit><a href="post.html">A post</a> · <a href="../about.html">About</a> · <a href="../">Home</a></nav>\n<h1>Blog</h1>\n<p>Posts, one page each, in this folder.</p>`, "../"));
  await s.write("blog/post.html", PAGE("A post", `<link rel="stylesheet" href="blog.css">\n<nav data-erga-noedit><a href="./">Blog</a> · <a href="../about.html">About</a></nav>\n<h1>A post</h1>\n<p>A page two folders down, styled by its folder's stylesheet and the document's.</p>`, "../"));
  await s.write("blog/blog.css", "h1 { color: rgb(180, 40, 30); }\n");
  await s.write("about.html", PAGE("About", `<nav data-erga-noedit><a href="index.html">Home</a> · <a href="blog/post.html">A post</a></nav>\n<h1>About</h1>\n<p>Who made this.</p>`));
}

/** Evaluates `expr` in every frame of the tab, and gives the first answer that isn't null (the page is in a frame in a frame). */
export async function inFrames<T>(page: import("playwright-core").Page, expr: string): Promise<T | null> {
  for (const f of page.frames()) {
    const v = await f.evaluate(expr).catch(() => null);
    if (v != null) return v as T;
  }
  return null;
}

/** The page's heading and how it's styled, wherever it renders (the viewer's frame, or the editor's). */
export const styled = (page: import("playwright-core").Page) => inFrames<{ h1: string; color: string; bg: string }>(page,
  `document.querySelector("h1") && !document.getElementById("frame") ? { h1: document.querySelector("h1").textContent, color: getComputedStyle(document.querySelector("h1")).color, bg: getComputedStyle(document.body).backgroundColor } : null`);

/** The tab's address, path and hash. */
export const where = (page: import("playwright-core").Page) => page.evaluate(() => location.pathname + location.search).catch(() => "");
/** The editor is ready and listening: open_page and new_page reach only the tabs whose event channel is up (erga-listening). */
/** The editor is up: its controls in the tab, and its half in the page, which has joined the room (libs/text/ui/frame.ts). */
export const ready = async (page: import("playwright-core").Page) =>
  (await page
    .evaluate(() => ["erga-editor-ready", "erga-editing", "erga-listening"].every((c) => document.body.classList.contains(c)))
    .catch(() => false)) &&
  (
    await Promise.all(
      page
        .frames()
        .filter((f) => f != page.mainFrame())
        .map((f) => f.evaluate("!!window.ergaFrame?.page").catch(() => false))
    )
  ).some(Boolean);
/** The page the editor edits (window.ergaPage.pagePath). */
export const editing = (page: import("playwright-core").Page) => page.evaluate(() => (window as any).ergaPage?.pagePath ?? "").catch(() => "");

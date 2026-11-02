// A document's file tree: its pages, other files and folders, and how
// addresses map to pages. A document is a folder; index.html at its root is
// the document's own page, and any other .html file in it is a page too, with
// an address of its own under the document's:
//
//   index.html            /<owner>/<slug>
//   about.html            /<owner>/<slug>/about
//   blog/index.html       /<owner>/<slug>/blog
//   blog/post.html        /<owner>/<slug>/blog/post
//
// An address resolves to <path>.html first, then <path>/index.html, so
// blog.html wins over blog/index.html. No address ends in a
// slash, and none is added: the page renders in a frame at its file's own
// path, so its relative links and assets resolve as they would on disk.
// The editor for a page is its address with ?edit (the pencil goes there and
// back without a reload): an address always means a page, so a page may be called edit too.
//
// A document is one of two kinds. A "document" has one page (index.html) and any other files beside
// it; a "project" is a folder of pages, each with its own address. A document becomes a project only
// when someone asks (make_project), never as a side effect of a write: so a new page, or a file that
// would be one, is refused in a document with a message that says how (pageRefusal). A project with
// one page becomes a document again the same way (make_document).
//
// Shared by the host (document/host.ts: the tree's API and its operations), the app
// (server/documents/routes.ts: which page an address is) and the browser (the editor and
// the tree's UI), so it holds only plain functions and the operations' shape.

/** One entry in the tree: a page (.html), any other file, or a folder. */
export interface TreeEntry { path: string; type: "page" | "file" | "folder"; /** A page's title, when it has one (the API adds it). */ title?: string }

/** What can be done to the tree (the operations new_page, mkdir, mv, rm, make_project, make_document): rename is a move. */
export type TreeOp =
  | { op: "new_page"; path: string }
  | { op: "new_folder"; path: string }
  | { op: "move"; from: string; to: string }
  | { op: "delete"; path: string }
  | { op: "make_project" }
  | { op: "make_document" };

/** A document (one page, index.html, and other files) or a project (a folder of pages). */
export type DocKind = "document" | "project";
export const isDocKind = (k: unknown): k is DocKind => k == "document" || k == "project";

/** The kind of a new document made from these files: a project if it has more than one page. */
export const kindOf = (paths: Iterable<string>): DocKind => {
  let pages = 0;
  for (const p of paths) if (isPage(p) && ++pages > 1) return "project";
  return "document";
};

/**
 * Why a document can't take `path` as a new file: it would be a second page. Null when it can (a project, the
 * document's own page, a file that isn't a page). In words for a person or an agent.
 */
export function pageRefusal(kind: DocKind, path: string, index: string): string | null {
  if (kind != "document" || !isPage(path) || path == index) return null;
  return `This is a document: its one page is ${index}, so ${path} can't be a page of it. To have more pages, make it a project first (Project in the document's settings, or the set_kind tool).`;
}

/** A tree operation that can't be done, with why, in words for a person or an agent. */
export class TreeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const PAGE = /\.html$/i;
/** Whether a file is a page: .html. */
export const isPage = (path: string) => PAGE.test(path);

/** Names a document never holds or serves: dotfiles and node_modules. */
const ignoredName = (seg: string) => seg.startsWith(".") || seg == "node_modules";
/** Paths a document never holds or serves: one with a dotfile or node_modules in it. */
export const ignored = (rel: string) => rel.split(/[\\/]/).some(ignoredName);

/**
 * A path inside the document as it is given ("/" or "\\" between names; empty
 * names and "." left out): null if it leaves the document (".."), "" if it
 * names nothing. Every path a person, an agent or a request gives goes
 * through it (cleanRel, cleanTreePath, the agent's workspace).
 */
export function cleanPath(raw: string): string | null {
  const parts: string[] = [];
  for (const seg of raw.split(/[\\/]/)) {
    if (!seg || seg == ".") continue;
    if (seg == "..") return null;
    parts.push(seg);
  }
  return parts.join("/");
}

/** A request's path inside the document (URL-encoded), or null if it would leave it, names nothing, or is ignored. */
export function cleanRel(raw: string | undefined): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(raw ?? ""); } catch { return null; }
  const rel = cleanPath(decoded);
  return rel && !ignored(rel) ? rel : null;
}

/**
 * Names that would collide with the document's own addresses: under
 * /<owner>/<slug>, /api/... and /doc/... are the document's host (its API,
 * its sockets and its files, which older tabs and share links reach under
 * any of its addresses). So no page or folder may be called api or doc at
 * the top of a document.
 */
const RESERVED_TOP = new Set(["api", "doc"]);

/**
 * A path in the tree as given (by a person, an agent or a request): "/"
 * separated, no leading or trailing slash, each name sensible. Throws a
 * TreeError saying what's wrong.
 */
export function cleanTreePath(raw: unknown, what = "path"): string {
  if (typeof raw != "string") throw new TreeError(`Give ${what} as a string.`);
  const path = cleanPath(raw);
  if (path == null) throw new TreeError(`${raw} leaves the document: ".." isn't allowed.`);
  if (!path) throw new TreeError(`Give ${what}: a path inside the document, like "blog/post.html".`);
  const parts = path.split("/");
  for (const seg of parts) {
    if (ignoredName(seg)) throw new TreeError(`${raw}: names can't start with "." or be node_modules.`);
    if (seg.length > 120) throw new TreeError(`${raw}: a name can be at most 120 characters.`);
    if (/[\x00-\x1f\x7f<>:"|?*#%]/.test(seg)) throw new TreeError(`${raw}: names can't contain control characters or any of < > : " | ? * # %.`);
    if (/[ .]$/.test(seg) || /^ /.test(seg)) throw new TreeError(`${raw}: a name can't start with a space or end with a space or a dot.`);
  }
  if (parts.length > 20) throw new TreeError(`${raw} is too deep: at most 20 folders down.`);
  return parts.join("/");
}

/** Refuses a name for a new page or folder that would collide with the document's own addresses (see RESERVED_TOP). */
export function checkNewName(path: string, type: "page" | "folder" | "file"): void {
  const parts = path.split("/");
  const last = parts[parts.length - 1];
  const stem = type == "page" ? last.replace(PAGE, "") : last;
  const named = (n: string) => stem.toLowerCase() == n;
  if (parts.length == 1 && (type != "file" || !last.includes(".")) && [...RESERVED_TOP].some(named)) {
    throw new TreeError(`"${last}" can't be a page or folder at the top of a document: /api and /doc are the document's own addresses. Pick another name.`);
  }
}

/** The folder a path is in ("a/b/c.html" → "a/b"; "" at the top). */
export const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
/** A path's last name ("a/b/c.html" → "c.html"). */
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** A name in a folder ("" is the top). */
export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
/** A path as an address has it: each name encoded. */
export const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** How long a slug may be: a document's (/<owner>/<slug>); a page's file name may be longer (the tree's). */
export const SLUG_MAX = 60;

/** A slug from any text: "Field & notes, 2026" → "field-notes-2026" ("" if it has no letters or digits); longer than `max`, cut at a word if one ends late enough. */
export function slugify(text: string, max = SLUG_MAX): string {
  const s = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1),
    dash = cut.lastIndexOf("-");
  return (dash > max / 2 ? cut.slice(0, dash) : s.slice(0, max)).replace(/-+$/, "");
}

/** Every folder a path is in ("a/b/c.html" → ["a", "a/b"]). */
export function parentsOf(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}


/**
 * The tree, from the files the document holds and the folders made as such:
 * every folder listed (empty ones too, and those that only hold files),
 * folders first at each level, then by name.
 */
export function treeEntries(files: Iterable<string>, folders: Iterable<string> = []): TreeEntry[] {
  const dirs = new Set<string>();
  const out: TreeEntry[] = [];
  for (const f of files) {
    out.push({ path: f, type: isPage(f) ? "page" : "file" });
    for (const p of parentsOf(f)) dirs.add(p);
  }
  for (const d of folders) { dirs.add(d); for (const p of parentsOf(d)) dirs.add(p); }
  for (const d of dirs) out.push({ path: d, type: "folder" });
  return out.sort((a, b) => compareTree(a, b));
}

/** Tree order: by folder, a folder's own entries after it, folders before files at each level, then by name. */
function compareTree(a: TreeEntry, b: TreeEntry): number {
  const pa = a.path.split("/"), pb = b.path.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] == pb[i]) continue;
    // Which of the two is a folder at this level: a deeper path, or a folder entry here.
    const fa = i < pa.length - 1 || a.type == "folder", fb = i < pb.length - 1 || b.type == "folder";
    if (fa != fb) return fa ? -1 : 1;
    return pa[i].localeCompare(pb[i], "en", { numeric: true, sensitivity: "base" }) || (pa[i] < pb[i] ? -1 : 1);
  }
  return pa.length - pb.length;
}

/**
 * A page's address under the document's, without a leading slash: "" for
 * the root page, "blog" for blog.html or blog/index.html, "blog/post" for
 * blog/post.html.
 */
export function pageAddress(file: string): string {
  const stem = file.replace(PAGE, "");
  if (stem == "index") return "";
  return stem.endsWith("/index") ? stem.slice(0, -"/index".length) : stem;
}

/** A page's full address, given the document's (/<owner>/<slug>): no trailing slash, ever. */
export const pageUrl = (docAddress: string, file: string) => {
  const rest = pageAddress(file),
    base = docAddress.replace(/\/+$/, "");
  return rest ? `${base}/${encodePath(rest)}` : base;
};

/**
 * Which page an address under the document is (its path after
 * /<owner>/<slug>, slashes at either end ignored): <path>.html, then
 * <path>/index.html; the root page for none. An address naming a page file itself ("blog.html",
 * "blog/index") is that page too, and `canonical` says the address it's
 * really at. Null if there's no such page.
 */
export function resolvePage(has: (path: string) => boolean, address: string, index = "index.html"): { file: string; canonical: string } | null {
  let rest: string;
  try { rest = decodeURIComponent(address); } catch { return null; }
  const parts = rest.split("/").filter(Boolean);
  if (parts.some((p) => p == ".." || p == "." || ignoredName(p))) return null;
  rest = parts.join("/");
  /** The page an address is by the rule above (no file names). */
  const byRule = (r: string): string | null => {
    if (!r) return has(index) ? index : has("index.html") ? "index.html" : null;
    for (const c of [`${r}.html`, `${r}/index.html`]) if (has(c)) return c;
    return null;
  };
  let file = byRule(rest);
  // A page by its file name, or ".../index": the same page, whose address is the shorter one.
  if (!file && isPage(rest) && has(rest)) file = rest;
  if (!file && (rest == "index" || rest.endsWith("/index"))) {
    const dir = rest.slice(0, -"index".length);
    file = has(`${dir}index.html`) ? `${dir}index.html` : null;
  }
  if (!file) return null;
  // Its own address, unless that's another page's (blog/index.html when there's a blog.html): then the one asked for.
  const own = pageAddress(file);
  return { file, canonical: byRule(own) == file ? own : rest };
}

/**
 * A page's title, as the list shows it: its first top-level heading (what
 * people edit on the page), else its <title>, else its first heading of any
 * level (a deck's slides have h2s). A <title> of "Untitled" is a blank
 * page's, not a name. Null if it has none.
 */
export function titleOf(text: string): string | null {
  const clean = (s: string) =>
    decodeEntities(s.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || null;
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(text),
    title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  const named = title && clean(title[1]),
    heading = /<h([2-6])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(text);
  return (h1 && clean(h1[1])) || (named && named.toLowerCase() != "untitled" ? named : null) || (heading && clean(heading[2])) || null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] == "#" ? String.fromCodePoint(parseInt(e[1] == "x" || e[1] == "X" ? e.slice(2) : e.slice(1), e[1] == "x" || e[1] == "X" ? 16 : 10)) : ENTITIES[e.toLowerCase()] ?? m);

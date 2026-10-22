// A document's pages, as a small tree: its folders, pages and
// other files, from GET /api/docs/<id>/tree, changed through POST to the same
// address (new_page, new_folder, move, delete). One component, in two places:
// the editor (a card under the document's title, top left: main.ts) and
// Documents (beneath a document's row: server/pages/docs.ts). It's built on its own
// and loaded only when someone opens it, so it costs the
// viewer nothing.
//
// index.html is the home page; the others sit under it. A document (one
// page) shows only that page, and Make a project at the foot: a project is a
// folder of pages, and only a project has more. A project's tree shows its
// pages, its other files (stylesheets, scripts, images, PDFs: each opens in
// the files view) and its folders. To an agent either is one folder of files. A page shows by its
// title when known, else by its name made readable ("spring-migration" is
// "Spring migration"; a folder's index is the folder's name), its file's name
// a quiet hint only where two would read the same. Clicking a page opens it,
// in the editor when you're editing, in the viewer otherwise, and the page
// you're on is marked. Editors add (New page, New folder: at the top level
// and in each folder), rename in place, move (drag and drop, or Move to…) and
// delete (a folder asks first); viewers only look. Errors from the server
// show where they happened, in its words.
//
// Keys, on the tree: ↑ ↓ move, → opens a folder (or goes into it), ← closes
// it (or goes up), Home and End, Enter opens a page or a folder, F2 renames,
// Delete deletes, and Shift-F10 (or the context-menu key) opens a row's menu.

export type EntryType = "page" | "folder" | "file";
export interface Entry { path: string; type: EntryType; title?: string }
export type DocKind = "document" | "project";
export interface TreeAnswer { entries: Entry[]; canEdit?: boolean; kind?: DocKind }

export interface TreeOptions {
  /** The document's id: its tree is /api/docs/<id>/tree. */
  id: string;
  /** Its address, /<owner>/<slug>: where its pages are (pageUrl). */
  base: string;
  /** Open pages in the editor (<address>?edit) rather than the viewer (<address>). */
  editing: boolean;
  /** Carried on every request and link (a local tab's ?user=). */
  query?: string;
  /** Show index.html as the root row, everything else under it (the editor). Off, the rows start at the top level (Documents, whose row is the root). */
  showRoot?: boolean;
  /** The document's title: index.html's name in the tree. */
  rootTitle?: string;
  /** A page's title, where the caller knows it (the editor reads them from the room). */
  titleOf?: (path: string) => string | null | undefined;
  /** The page you're on (its path), if any. */
  current?: string | null;
  /** Renaming the home page is renaming the document (its title and address): the caller's to do. */
  onRenameRoot?: () => void;
  /** Goes to a page (default: the browser goes there). `replace` when the page you were on moved; `path`, the page's, when one was picked. */
  navigate?: (url: string, opts: { replace?: boolean; path?: string }) => void;
  /** Whether a document links to other files by relative paths, where the caller knows: a move may break those (warnMoved). Unknown: assume it does. */
  hasRelativeLinks?: (path: string) => boolean | undefined;
  /** What the server answered last, for a caller that wants it (e.g. to count the pages). */
  onChange?: (answer: { entries: Entry[]; canEdit: boolean; kind: DocKind }) => void;
  /** The tree as the caller last saw it (Documents keeps each one's last answer): shown at once, then read again. */
  initial?: { entries: Entry[]; canEdit: boolean; kind?: DocKind } | null;
  /** Where to fetch from (tests stub it); default window.fetch. */
  fetch?: typeof fetch;
  /** The label for the tree, for screen readers. */
  label?: string;
}

export interface TreeHandle {
  readonly element: HTMLElement;
  /**
   * Reads the tree again (another tab or an agent changed it). `quiet`: a change from elsewhere, which waits
   * while someone is naming, asking, dragging or in a menu here, so it never pulls the rug from under them.
   */
  refresh(opts?: { quiet?: boolean }): Promise<void>;
  setCurrent(path: string | null): void;
  setRootTitle(title: string): void;
  setBase(base: string): void;
  /** Titles changed (the caller's titleOf answers differently now). */
  retitle(): void;
  /** Focuses the page you're on, else the first row. */
  focus(): void;
  destroy(): void;
}

const ROOT = "index.html";
/** A page's file: .html (or .htm). */
const PAGE_EXT = /\.html?$/i;
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** A page's address: /<owner>/<slug>/<path without .html, and without a trailing /index>. */
export function pageUrl(base: string, path: string): string {
  const rest = path.replace(PAGE_EXT, "").replace(/(^|\/)index$/, "");
  return base.replace(/\/+$/, "") + (rest ? "/" + rest.split("/").map(encodeURIComponent).join("/") : "");
}

/** The page at an address (the inverse of pageUrl, against the pages there are), or null. */
export function pageAt(entries: Entry[], base: string, pathname: string): string | null {
  const want = decodeURIComponent(pathname.replace(/\/+$/, ""));
  for (const e of entries) if (e.type == "page" && decodeURIComponent(pageUrl(base, e.path)) == want) return e.path;
  return null;
}

/** What's wrong with a name for something new (or renamed) in `dir`, or null. `taken` is what's there already. */
export function checkName(name: string, type: EntryType, taken: Set<string>, was?: string): string | null {
  if (!name || name == ".html") return type == "folder" ? "Give the folder a name." : "Give the page a name, with a letter or a digit in it.";
  if (/[\/\\]/.test(name)) return "A name can't have / or \\ in it.";
  if (name.startsWith(".")) return "A name can't start with a dot.";
  if (/[\x00-\x1f\x7f]/.test(name)) return "That name has characters it can't have.";
  if (name.length > 120) return "That name is too long.";
  if (name.toLowerCase() != was?.toLowerCase() && taken.has(name.toLowerCase())) return type == "folder" ? `There's already a folder called “${name}” here.` : `There's already a page called “${readable(name)}” here.`;
  return null;
}

/** A name as an address has it: lowercase letters, digits and dashes. */
export const slugify = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

/** A name as typed, as a file: a page's is its address's name, then .html; a folder's is as typed. */
export const fileName = (typed: string, type: EntryType) => {
  const name = typed.trim().replace(PAGE_EXT, "");
  return type == "page" ? (slugify(name) ? `${slugify(name)}.html` : "") : typed.trim();
};

/** A page's name made readable, from its file: "spring-migration.html" is "Spring migration". */
export function readable(path: string, folderTitle?: string): string {
  const stem = nameOf(path).replace(PAGE_EXT, "");
  const word = stem.toLowerCase() == "index" ? (parentOf(path) ? nameOf(parentOf(path)) : folderTitle || "Home") : stem;
  const spaced = word.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : word;
}

/** Whether an entry shows: in a project, all of them; in a document, only its page. */
export function shows(n: { type: EntryType; path: string }, kind: DocKind = "project"): boolean {
  return kind == "project" || n.path == ROOT;
}

interface Node { path: string; type: EntryType; title?: string; children: Node[] }

/** The entries as a tree: folders listed or not, every parent gets one. */
export function buildTree(entries: Entry[]): Node {
  const root: Node = { path: "", type: "folder", children: [] };
  const byPath = new Map<string, Node>([["", root]]);
  const ensure = (path: string, type: EntryType, title?: string): Node => {
    let node = byPath.get(path);
    if (node) { if (type != "folder" || node.type == "folder") { node.type = type; if (title) node.title = title; } return node; }
    node = { path, type, title, children: [] };
    byPath.set(path, node);
    ensure(parentOf(path), "folder").children.push(node);
    return node;
  };
  for (const e of entries) {
    const path = e.path.replace(/^\/+|\/+$/g, "");
    if (path) ensure(path, e.type, e.title);
  }
  return root;
}

const ICONS = {
  page: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.75h6.25L18 8.5v10.75a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1Z"/><path d="M13 3.9V8.75h4.85"/><path d="M9 12.75h6M9 16h4" class="et-lines"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.75 7a1.5 1.5 0 0 1 1.5-1.5h3.9l2 2.25h7.6a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5Z"/></svg>`,
  folderOpen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.75 17.25V7a1.5 1.5 0 0 1 1.5-1.5h3.9l2 2.25h6.6a1.5 1.5 0 0 1 1.5 1.5v1.5"/><path d="M3.9 18.1 6.4 11.6a1.5 1.5 0 0 1 1.4-.95h12.1a1 1 0 0 1 .93 1.36l-2.3 5.9a1.5 1.5 0 0 1-1.4.95H5.25a1.4 1.4 0 0 1-1.35-.76Z"/></svg>`,
  file: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.25h5l3.75 3.75v9.75H8Z"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.75 7.5 4.5 4.5-4.5 4.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5v11M6.5 12h11"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.5" cy="12" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="17.5" cy="12" r="1.25"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 18.5l.8-3.2 8.9-8.9a1.3 1.3 0 0 1 1.8 0l1.1 1.1a1.3 1.3 0 0 1 0 1.8l-8.9 8.9z"/></svg>`,
  newPage: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 20.25H7a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1h6.25L18 8.5V13"/><path d="M13 3.9V8.75h4.85M18 16v5M15.5 18.5h5"/></svg>`,
  newFolder: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.5 18.75H5.25a1.5 1.5 0 0 1-1.5-1.5V7a1.5 1.5 0 0 1 1.5-1.5h3.9l2 2.25h7.6a1.5 1.5 0 0 1 1.5 1.5v3.25"/><path d="M18 15v5.5M15.25 17.75h5.5"/></svg>`,
};

const STYLE = `
.et { position: relative; font: 13.5px/1.35 var(--font-text, "Inter", ui-sans-serif, system-ui, sans-serif); color: var(--fg); -webkit-font-smoothing: antialiased; }
.et [hidden] { display: none !important; }
.et-rows { display: flex; flex-direction: column; gap: 1px; }
.et-row { position: relative; display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 4px 0 calc(4px + var(--depth, 0) * 16px); border-radius: 7px;
  cursor: pointer; user-select: none; -webkit-user-select: none; outline: none; transition: background-color 120ms ease; }
.et-row:hover { background: color-mix(in srgb, var(--chrome) 11%, transparent); }
.et-row:focus-visible { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--caret) 70%, transparent); }
/* The guides: a hairline down each level, as the pages hang from their folder. */
.et-row::before { content: ""; position: absolute; top: 0; bottom: 0; left: calc(4px + var(--depth, 0) * 16px - 8.5px); border-left: 1px solid var(--rule); opacity: var(--guide, 0); pointer-events: none; }
.et-row[style*="--depth"] { --guide: 1; }
.et-twist { flex: none; display: grid; place-items: center; width: 16px; height: 16px; margin-right: -4px; color: var(--chrome); border-radius: 4px; transition: transform 140ms ease, color 120ms ease; }
.et-twist svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.et-row[aria-expanded="true"] > .et-twist { transform: rotate(90deg); }
.et-twist.none { visibility: hidden; }
.et-icon { flex: none; display: grid; place-items: center; width: 18px; height: 18px; color: var(--chrome); }
.et-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.et-icon .et-lines { opacity: 0.7; }
.et-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; text-decoration: none; }
.et-row.page .et-name { color: var(--fg-strong, var(--fg)); }
.et-row.root .et-name { font-weight: 600; }
.et-row.folder .et-name { color: var(--fg); }
/* Files that aren't pages (a stylesheet, a script, an image) are there, quietly. */
/* Two pages that read the same: which file each is, quietly. */
.et-ext { flex: none; color: var(--chrome); font-size: 12px; }
/* The page you're on. */
.et-row[aria-current="page"] { background: color-mix(in srgb, var(--caret) 10%, transparent); }
.et-row[aria-current="page"] .et-icon { color: var(--caret); }
.et-row[aria-current="page"]:hover { background: color-mix(in srgb, var(--caret) 14%, transparent); }
.et-row.dragging { opacity: 0.45; }
.et-row.drop { background: color-mix(in srgb, var(--caret) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--caret) 55%, transparent); }
.et-row.busy { opacity: 0.55; pointer-events: none; }
/* A row's buttons: on hover or focus, always on touch. */
.et-acts { flex: none; display: flex; gap: 0; margin-right: -2px; opacity: 0; transition: opacity 120ms ease; }
.et-row:hover .et-acts, .et-row:focus-within .et-acts, .et-row.menu-open .et-acts { opacity: 1; }
@media (hover: none) { .et-acts { opacity: 1; } }
.et-act { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--chrome); cursor: pointer; transition: color 120ms ease, background-color 120ms ease; }
.et-act:hover, .et-act[aria-expanded="true"] { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 16%, transparent); }
.et-act svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.et-act svg circle { fill: currentColor; stroke: none; }
/* Naming something new, or renaming. */
.et-row.editing { cursor: default; background: transparent; }
.et-input { flex: 1; min-width: 0; height: 24px; margin: 0 0 0 -3px; padding: 0 6px; border: 1px solid var(--caret); border-radius: 6px; outline: 2px solid color-mix(in srgb, var(--caret) 22%, transparent);
  background: var(--bg); color: var(--fg-strong, var(--fg)); font: inherit; }
.et-input::placeholder { color: var(--chrome); }
.et-msg { margin: 2px 4px 4px calc(4px + var(--depth, 0) * 16px + 22px); font-size: 12px; line-height: 1.4; color: var(--soft); }
.et-msg.error { color: #c2410c; }
.et-note { margin: 0; padding: 6px 4px 6px calc(4px + var(--depth, 0) * 16px + 26px); font-size: 12.5px; color: var(--soft); }
.et-banner { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 6px; padding: 7px 10px; border-radius: 8px; font-size: 12.5px; line-height: 1.4; color: #c2410c; background: color-mix(in srgb, #c2410c 9%, transparent); }
.et-banner span { flex: 1; }
.et-banner.note { color: var(--fg); background: color-mix(in srgb, var(--caret) 9%, transparent); }
.et-banner button { flex: none; padding: 0 2px; border: 0; background: none; color: inherit; font: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
/* Delete a folder? Asked in its row. */
.et-row.confirm { cursor: default; background: color-mix(in srgb, #c2410c 8%, transparent); }
.et-row.confirm { padding-top: 4px; padding-bottom: 4px; flex-wrap: wrap; row-gap: 4px; }
.et-confirm { flex: 1 1 140px; min-width: 0; font-size: 12.5px; line-height: 1.35; color: var(--fg); }
.et-btn { flex: none; height: 24px; padding: 0 9px; border: 1px solid var(--rule); border-radius: 6px; background: transparent; color: var(--fg); font: 550 12px var(--font-text, inherit); cursor: pointer; }
.et-btn.danger { border-color: #c2410c; background: #c2410c; color: #fff; }
.et-btn:focus-visible, .et-add:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
/* New page, New folder: at the top level, under the rows. */
.et-foot { display: flex; gap: 4px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--rule); }
.et-add { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 9px 0 6px; border: 0; border-radius: 7px; background: transparent; color: var(--soft); font: 500 12.5px var(--font-text, inherit); cursor: pointer; transition: color 120ms ease, background-color 120ms ease; }
.et-add:hover { color: var(--fg-strong, var(--fg)); background: color-mix(in srgb, var(--chrome) 12%, transparent); }
.et-add svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.et-foot.drop { background: color-mix(in srgb, var(--caret) 10%, transparent); border-radius: 7px; }
@media (pointer: coarse) { .et-row { min-height: 40px; } .et-act { width: 34px; height: 34px; } .et-add { height: 38px; } .et-input { height: 32px; font-size: 16px; } }
/* A row's menu: the avatar menu's look. */
.et-menu { position: fixed; z-index: 1000; min-width: 172px; max-width: min(280px, calc(100vw - 24px)); max-height: min(360px, calc(100vh - 24px)); overflow-y: auto; box-sizing: border-box; padding: 5px;
  font: 13px/1.3 var(--font-text, "Inter", ui-sans-serif, system-ui, sans-serif); color: var(--fg); background: var(--bg); border: 1px solid var(--panel-border, var(--rule)); border-radius: 11px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.05); animation: et-pop 120ms ease; }
@keyframes et-pop { from { opacity: 0; transform: translateY(-3px); } }
.et-menu [role="menuitem"] { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; padding: 6px 9px; padding-left: calc(9px + var(--depth, 0) * 14px); border: 0; border-radius: 7px; background: transparent; color: inherit; font: inherit; text-align: left; white-space: nowrap; cursor: pointer; outline: none; }
.et-menu [role="menuitem"] span { overflow: hidden; text-overflow: ellipsis; }
.et-menu [role="menuitem"]:hover, .et-menu [role="menuitem"]:focus-visible, .et-menu [role="menuitem"]:focus { background: color-mix(in srgb, var(--chrome) 14%, transparent); }
.et-menu [role="menuitem"].danger { color: #c2410c; }
.et-menu svg { flex: none; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; color: var(--chrome); }
.et-menu .danger svg { color: currentColor; }
.et-menu hr { margin: 4px 6px; border: 0; border-top: 1px solid var(--rule); }
.et-menu .et-menu-head { margin: 0; padding: 5px 9px 6px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.02em; color: var(--soft); }
@media (pointer: coarse) { .et-menu [role="menuitem"] { padding-top: 10px; padding-bottom: 10px; } }
@media (prefers-reduced-motion: reduce) { .et-menu { animation: none; } .et-twist { transition: none; } }
`;

function injectStyle() {
  if (document.getElementById("erga-tree-style")) return;
  const s = document.createElement("style");
  s.id = "erga-tree-style";
  s.textContent = STYLE;
  document.head.append(s);
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node_ | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k == "dataset") Object.assign(e.dataset, v);
    else if (k.startsWith("aria-") || k == "role" || k == "style") e.setAttribute(k, String(v));
    else (e as any)[k] = v;
  }
  e.append(...kids);
  return e;
};
type Node_ = globalThis.Node;
const svg = (html: string) => { const t = document.createElement("template"); t.innerHTML = html; return t.content.firstElementChild!; };

/** Plain words for whatever went wrong talking to the server. */
const plain = (e: unknown) => {
  if (e instanceof Error && e.name == "TimeoutError") return "The server didn't answer. Try again in a moment.";
  if (e instanceof Error && e.message) return e.message;
  return "Couldn't reach the server. Check your connection and try again.";
};

export function mountTree(container: HTMLElement, opts: TreeOptions): TreeHandle {
  injectStyle();
  const doFetch = opts.fetch ?? window.fetch.bind(window);
  const query = opts.query ?? "";
  const api = () => `/api/docs/${encodeURIComponent(opts.id)}/tree${query}`;
  const showRoot = opts.showRoot ?? false;
  let base = opts.base, rootTitle = opts.rootTitle ?? "", current = opts.current ?? null;
  let entries: Entry[] | null = null, canEdit = false, loadError: string | null = null, banner: string | null = null;
  let kind: DocKind = "project";
  let tree: Node = buildTree([]);
  // Which folders are open, remembered for this tab.
  const storeKey = `erga:tree:${opts.id}`;
  const open = new Set<string>((() => { try { return JSON.parse(sessionStorage.getItem(storeKey) || "[]") as string[]; } catch { return []; } })());
  const saveOpen = () => { try { sessionStorage.setItem(storeKey, JSON.stringify([...open])); } catch { /* private mode */ } };
  // What's being typed or asked in place: a new item in a folder, a rename, a folder's deletion.
  let editing: { kind: "new"; dir: string; type: EntryType; value: string; error?: string } | { kind: "rename"; path: string; value: string; error?: string } | null = null;
  let confirming: string | null = null;
  let busy: string | null = null;
  let focusPath: string | null = null;
  let menu: HTMLElement | null = null, menuButton: HTMLElement | null = null;
  let dragFrom: string | null = null;
  // Asked to focus before the first answer came: done once it has.
  let wantFocus = false;
  // A change from elsewhere came while someone was in the middle of something here: read again once they're done.
  let stale = false;
  const interacting = () => !!(editing || confirming || menu || dragFrom || busy);

  const root = el("div", { className: "et" });
  const bannerEl = el("div", { className: "et-banner", role: "alert", hidden: true });
  const rows = el("div", { className: "et-rows", role: "tree", "aria-label": opts.label ?? "Pages" });
  const foot = el("div", { className: "et-foot", hidden: true });
  const addPage = el("button", { type: "button", className: "et-add" }, svg(ICONS.newPage), "New page");
  const addFolder = el("button", { type: "button", className: "et-add" }, svg(ICONS.newFolder), "New folder");
  // A document's foot: it becomes a project (make_project), which can have more pages. It can't go back, so it asks once.
  const makeProject = el("button", { type: "button", className: "et-add" }, svg(ICONS.newFolder), "Make a project");
  foot.append(addPage, addFolder, makeProject);
  root.append(bannerEl, rows, foot);
  container.append(root);
  addPage.addEventListener("click", () => startNew("", "page"));
  addFolder.addEventListener("click", () => startNew("", "folder"));
  makeProject.addEventListener("click", async () => {
    if (makeProject.dataset.sure != "1") {
      makeProject.dataset.sure = "1";
      makeProject.lastChild!.textContent = "Make it a project: more pages, for good?";
      return;
    }
    delete makeProject.dataset.sure;
    makeProject.lastChild!.textContent = "Make a project";
    if (await change(null, { op: "make_project" })) say("It's a project now: add pages with New page.", true);
  });
  makeProject.addEventListener("blur", () => { if (makeProject.dataset.sure) { delete makeProject.dataset.sure; makeProject.lastChild!.textContent = "Make a project"; } });

  /** Where a page opens: its address, and ?edit in the editor (an address always names a page, so one may be called "edit"). */
  const href = (path: string) => pageUrl(base, path) + query + (opts.editing ? (query ? "&edit" : "?edit") : "");
  /** Where a file that isn't a page opens: the files view, with it selected. */
  const fileHref = (path: string) => base + query + (query ? "&" : "?") + "files=" + encodeURIComponent(path);
  const titleFor = (n: { path: string; title?: string }) => (n.path == ROOT && rootTitle) || opts.titleOf?.(n.path) || n.title || null;
  // A new page's template is titled "Untitled": that says nothing, so its name does instead.
  const known = (t: string | null | undefined) => (t && t.trim() && t.trim().toLowerCase() != "untitled" ? t.trim() : null);
  const label = (n: Node) => (n.type == "page" ? known(titleFor(n)) || readable(n.path, rootTitle) : nameOf(n.path));
  const sortKey = (n: Node) => `${n.type == "folder" ? 0 : n.type == "page" ? (nameOf(n.path).toLowerCase() == "index.html" ? 1 : 2) : 3}`;
  const sorted = (list: Node[]) => [...list].sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || label(a).localeCompare(label(b), undefined, { numeric: true, sensitivity: "base" }));
  const find = (path: string, at: Node = tree): Node | null => {
    if (at.path == path) return at;
    for (const c of at.children) { const f = find(path, c); if (f) return f; }
    return null;
  };
  const takenIn = (dir: string) => new Set((find(dir)?.children ?? []).map((c) => nameOf(c.path).toLowerCase()));
  const hasRoot = () => !!entries?.some((e) => e.path == ROOT);
  const say = (text: string | null, note = false) => { banner = text; bannerEl.hidden = !text; bannerEl.classList.toggle("note", note); bannerEl.replaceChildren(); if (text) bannerEl.append(el("span", {}, text)); };
  /** What a move can break: a page links its styles, scripts and images by where they are from it, and links to it name its old address. */
  function warnMoved(from: string, to: string, name: string, before: Node[]) {
    const n = find(to);
    if (!n || parentOf(from) == parentOf(to)) return;
    const docs: string[] = [];
    const walk = (x: Node) => { if (x.type == "page") docs.push(x.path); x.children.forEach(walk); };
    walk(n);
    // A folder moving to the same depth keeps its pages' links to things inside it, but not to things outside.
    const depth = (p: string) => p.split("/").length;
    if (n.type == "folder" && depth(from) == depth(to)) return;
    // Asked where each is now, else where it was (the room may not have caught up).
    const was = new Map(before.map((b) => [b.path.replace(from, to), b.path]));
    const relative = docs.map((p) => opts.hasRelativeLinks?.(p) ?? opts.hasRelativeLinks?.(was.get(p) ?? p));
    if (relative.length && relative.every((r) => r === false)) return;
    say(n.type == "folder"
      ? `Moved. The pages in “${name}” find their styles, images and links by where they were: check that they still look right, and fix what's missing (the agent can).`
      : `Moved. “${name}” finds its styles, images and links by where it was: check that it still looks right, and fix what's missing (the agent can).`, true);
  }

  // ------------------------------------------------------------ talking to the server

  async function load() {
    try {
      const r = await doFetch(api(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      const body = (await r.json().catch(() => ({}))) as Partial<TreeAnswer> & { error?: string };
      if (!r.ok) throw new Error(body.error || (r.status == 404 ? "This document's pages couldn't be found." : r.status == 403 ? "You can't see this document's pages." : `The server couldn't list the pages (${r.status}).`));
      set(body.entries ?? [], !!body.canEdit, body.kind);
      loadError = null;
    } catch (e) {
      loadError = plain(e);
    }
    render();
    if (wantFocus && entries) { wantFocus = false; focusFirst(); }
  }
  function focusFirst() {
    if (!entries) { wantFocus = true; return; }
    const t = rows.querySelector<HTMLElement>('[aria-current="page"]') ?? rows.querySelector<HTMLElement>(".et-row[data-path]");
    if (t) { setRoving(t); t.focus(); } else if (!foot.hidden) addPage.focus();
  }

  function set(list: Entry[], edit: boolean, k?: DocKind) {
    entries = list;
    canEdit = edit;
    if (k) kind = k;
    tree = buildTree(list);
    // The page you're on is in view.
    if (current) for (let d = parentOf(current); d; d = parentOf(d)) open.add(d);
    opts.onChange?.({ entries: list, canEdit: edit, kind });
  }

  /** A change, sent: the tree it answers, or the server's own words for why not (thrown). */
  async function send(op: Record<string, string>): Promise<void> {
    const r = await doFetch(api(), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(op), signal: AbortSignal.timeout(15_000) })
      .catch((e) => { throw new Error(plain(e)); });
    const body = (await r.json().catch(() => ({}))) as Partial<TreeAnswer> & { error?: string };
    if (!r.ok) throw new Error(body.error || (r.status == 403 ? "You can't change this document's pages." : `That didn't work (the server answered ${r.status}).`));
    let next = body.entries ?? entries ?? [];
    // A moved document keeps its title while the server catches up with its text at the new path.
    if (op.op == "move" && entries) {
      const was = new Map(entries.filter((e) => e.title).map((e) => [e.path, e.title!]));
      const back = (p: string) => (p == op.to ? op.from : p.startsWith(op.to + "/") ? op.from + p.slice(op.to.length) : null);
      next = next.map((e) => { const b = !e.title && back(e.path); return b && was.has(b) ? { ...e, title: was.get(b) } : e; });
    }
    set(next, body.canEdit ?? canEdit, body.kind);
  }

  /** Runs a change on a row, showing it busy; an error goes in the banner. */
  async function change(path: string | null, op: Record<string, string>): Promise<boolean> {
    say(null);
    busy = path;
    render();
    try { await send(op); return true; }
    catch (e) { say(plain(e)); return false; }
    finally { busy = null; render(); }
  }

  /** After the page you're on moved or went: follow it (or go to the home page). */
  function follow(from: string, to: string | null) {
    if (!current) return;
    const moved = current == from ? to : current.startsWith(from + "/") ? (to == null ? null : to + current.slice(from.length)) : undefined;
    if (moved === undefined) return;
    const target = moved ?? ROOT;
    current = moved ?? null;
    const url = href(target);
    (opts.navigate ?? ((u, o) => (o.replace ? location.replace(u) : location.assign(u))))(url, { replace: true });
  }

  // ------------------------------------------------------------ the actions

  function startNew(dir: string, type: EntryType) {
    closeMenu();
    confirming = null;
    if (dir) open.add(dir), saveOpen();
    editing = { kind: "new", dir, type, value: "" };
    render();
  }
  function startRename(path: string) {
    closeMenu();
    if (path == ROOT) { opts.onRenameRoot?.(); return; }
    const n = find(path);
    if (!n) return;
    confirming = null;
    editing = { kind: "rename", path, value: n.type == "page" ? readable(path, rootTitle) : nameOf(path) };
    render();
  }
  async function commitEdit() {
    const e = editing;
    if (!e) return;
    const typed = e.value.trim();
    if (e.kind == "new") {
      if (!typed) { editing = null; render(); return; }
      const name = fileName(typed, e.type);
      const problem = checkName(name, e.type, takenIn(e.dir));
      if (problem) { e.error = problem; render(); return; }
      const path = join(e.dir, name);
      editing = null;
      if (await change(null, e.type == "folder" ? { op: "new_folder", path } : { op: "new_page", path })) focusPath = path;
      else { editing = { ...e, error: banner ?? undefined }; say(null); }
      render();
    } else {
      const n = find(e.path);
      if (!n) { editing = null; render(); return; }
      const name = fileName(typed, n.type);
      if (!typed || name == nameOf(e.path) || (n.type == "page" && typed == readable(e.path, rootTitle))) { editing = null; focusPath = e.path; render(); return; }
      const problem = checkName(name, n.type, takenIn(parentOf(e.path)), nameOf(e.path));
      if (problem) { e.error = problem; render(); return; }
      const to = join(parentOf(e.path), name);
      editing = null;
      if (await change(e.path, { op: "move", from: e.path, to })) { focusPath = to; rekeyOpen(e.path, to); follow(e.path, to); }
      else { editing = { ...e, error: banner ?? undefined }; say(null); }
      render();
    }
  }
  async function move(from: string, dir: string) {
    if (from == ROOT || dir == parentOf(from) || dir == from || dir.startsWith(from + "/")) return;
    const to = join(dir, nameOf(from));
    const n = find(from);
    if (takenIn(dir).has(nameOf(from).toLowerCase())) { say(`There's already ${n?.type == "folder" ? `a folder called “${nameOf(from)}”` : `a page called “${n ? label(n) : nameOf(from)}”`} in ${dir ? `“${nameOf(dir)}”` : "the top level"}.`); return; }
    if (dir) open.add(dir);
    const name = n ? label(n) : nameOf(from), before: Node[] = [];
    const walk = (x: Node) => { if (x.type == "page") before.push(x); x.children.forEach(walk); };
    if (n) walk(n);
    if (await change(from, { op: "move", from, to })) { focusPath = to; rekeyOpen(from, to); warnMoved(from, to, name, before); follow(from, to); }
  }
  async function remove(path: string) {
    closeMenu();
    if (path == ROOT) return;
    const n = find(path);
    if (!n) return;
    if (n.type == "folder" && confirming != path) { confirming = path; editing = null; render(); return; }
    confirming = null;
    const next = neighbour(path);
    if (await change(path, { op: "delete", path })) { open.delete(path); saveOpen(); focusPath = next; follow(path, null); }
  }
  const rekeyOpen = (from: string, to: string) => {
    for (const p of [...open]) if (p == from || p.startsWith(from + "/")) { open.delete(p); open.add(to + p.slice(from.length)); }
    saveOpen();
  };
  function go(path: string, newTab = false) {
    const url = href(path);
    if (newTab) { window.open(url, "_blank", "noopener"); return; }
    if (path == current) return;
    (opts.navigate ?? ((u) => location.assign(u)))(url, { path });
  }
  function toggle(path: string, force?: boolean) {
    const on = force ?? !open.has(path);
    if (on) open.add(path); else open.delete(path);
    saveOpen();
    focusPath = path;
    render();
  }

  // ------------------------------------------------------------ rendering

  /** The rows in view, in order: [node, depth]. */
  function visible(): [Node, number][] {
    const out: [Node, number][] = [];
    const walk = (list: Node[], depth: number) => {
      for (const n of sorted(list.filter((n) => shows(n, kind)))) {
        out.push([n, depth]);
        if (n.type == "folder" && open.has(n.path)) walk(n.children, depth + 1);
      }
    };
    if (showRoot) {
      const r = tree.children.find((c) => c.path == ROOT);
      if (r) out.push([r, 0]);
      walk(tree.children.filter((c) => c.path != ROOT), r ? 1 : 0);
    } else walk(tree.children.filter((c) => c.path != ROOT), 0);
    return out;
  }

  function render() {
    const had = document.activeElement && root.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>("[data-path]")?.dataset.path ?? null : null;
    const want = focusPath ?? had;
    const typing = document.activeElement?.classList.contains("et-input");
    rows.replaceChildren();
    foot.hidden = !entries || !canEdit;
    addPage.hidden = addFolder.hidden = kind == "document";
    makeProject.hidden = kind != "document";
    if (!entries) {
      if (loadError) {
        say(null);
        bannerEl.hidden = false;
        const retry = el("button", { type: "button" }, "Try again");
        retry.addEventListener("click", () => { loadError = null; render(); load(); });
        bannerEl.replaceChildren(el("span", {}, loadError), retry);
      } else rows.append(el("p", { className: "et-note", style: "--depth: 0" }, "Loading…"));
      return;
    }
    if (!banner) bannerEl.hidden = true;
    const list = visible();
    const depthOfDir = (dir: string) => {
      if (!dir) return showRoot && hasRoot() ? 1 : 0;
      const i = list.findIndex(([n]) => n.path == dir);
      return i < 0 ? 0 : list[i][1] + 1;
    };
    const newRow = (e: Extract<typeof editing, { kind: "new" }>) => {
      const depth = depthOfDir(e.dir);
      return [editRow(depth, e.type, e.value, e.type == "folder" ? "Folder name" : "Page name", e.type == "page", e.error), ...(e.error ? [msg(depth, e.error)] : [])];
    };
    // A new item goes first in its folder (or at the top level, first after the root row).
    if (editing?.kind == "new" && !editing.dir && !(showRoot && hasRoot())) rows.append(...newRow(editing));
    const posTotal = new Map<string, number>();
    for (const [n] of list) posTotal.set(parentOf(n.path) + "|", (posTotal.get(parentOf(n.path) + "|") ?? 0) + 1);
    const pos = new Map<string, number>();
    for (const [n, depth] of list) {
      if (editing?.kind == "rename" && editing.path == n.path) {
        rows.append(editRow(depth, n.type, editing.value, "Name", n.type == "page", editing.error, n.path));
        if (editing.error) rows.append(msg(depth, editing.error));
      } else if (confirming == n.path) rows.append(confirmRow(n, depth));
      else {
        const key = parentOf(n.path) + "|";
        pos.set(key, (pos.get(key) ?? 0) + 1);
        rows.append(row(n, depth, pos.get(key)!, posTotal.get(key)!));
      }
      if (editing?.kind == "new" && ((n.path == ROOT && showRoot && !editing.dir) || (n.type == "folder" && n.path == editing.dir))) rows.append(...newRow(editing));
    }
    const peers = list.filter(([n]) => n.path != ROOT).length;
    if (!peers && !editing) rows.append(el("p", { className: "et-note", style: `--depth: ${showRoot && hasRoot() ? 1 : 0}` }, kind == "document" ? "A document has one page. A project has many." : canEdit ? "No other pages yet." : "No other pages."));
    // Focus where it was (or on what was just made), unless someone's typing.
    const input = rows.querySelector<HTMLInputElement>(".et-input");
    if (input) {
      if (!typing || document.activeElement != input) { input.focus(); const v = input.value; input.setSelectionRange(v.length, v.length); }
    } else if (want && root.isConnected) {
      const target = rows.querySelector<HTMLElement>(`[data-path="${CSS.escape(want)}"]`);
      if (target && (focusPath || had)) { setRoving(target); target.focus({ preventScroll: false }); }
    }
    focusPath = null;
    if (!rows.querySelector('[tabindex="0"]')) setRoving(rows.querySelector<HTMLElement>('[aria-current="page"]') ?? rows.querySelector<HTMLElement>(".et-row[data-path]"));
    if (stale && !interacting()) { stale = false; queueMicrotask(load); }
  }

  const setRoving = (target: HTMLElement | null) => {
    for (const r of rows.querySelectorAll<HTMLElement>(".et-row[data-path]")) r.tabIndex = r == target ? 0 : -1;
  };

  function row(n: Node, depth: number, pos: number, size: number): HTMLElement {
    const isRoot = n.path == ROOT && showRoot;
    const folder = n.type == "folder";
    const name = label(n);
    // Two pages side by side that read the same: each says which it is, quietly, by its file's name.
    const twins = n.type == "page" && (find(parentOf(n.path))?.children ?? []).filter((c) => c.type == "page" && c.path != n.path).some((c) => label(c).toLowerCase() == name.toLowerCase());
    const hint = twins ? nameOf(n.path) : "";
    const r = el("div", {
      className: `et-row ${n.type}${isRoot ? " root" : ""}${busy == n.path ? " busy" : ""}`,
      role: "treeitem", tabIndex: -1, dataset: { path: n.path, type: n.type },
      "aria-level": depth + 1, "aria-setsize": size, "aria-posinset": pos, "aria-label": name + (hint ? ` (${hint})` : ""),
      ...(depth ? { style: `--depth: ${depth}` } : {}),
    });
    if (folder) r.setAttribute("aria-expanded", String(open.has(n.path)));
    if (n.type == "page" && n.path == current) r.setAttribute("aria-current", "page");
    const twist = el("span", { className: `et-twist${folder ? "" : " none"}`, "aria-hidden": "true" }, svg(ICONS.chevron));
    const icon = el("span", { className: "et-icon", "aria-hidden": "true" }, svg(folder ? (open.has(n.path) ? ICONS.folderOpen : ICONS.folder) : n.type == "page" ? ICONS.page : ICONS.file));
    const text = n.type == "page"
      ? el("a", { className: "et-name", href: href(n.path), tabIndex: -1, draggable: false }, name)
      : n.type == "file" ? el("a", { className: "et-name", href: fileHref(n.path), tabIndex: -1, draggable: false }, name)
      : el("span", { className: "et-name" }, name);
    r.append(twist, icon, text);
    if (hint) r.append(el("span", { className: "et-ext", "aria-hidden": "true" }, hint));
    if (canEdit) {
      const acts = el("span", { className: "et-acts" });
      if (isRoot) {
        if (opts.onRenameRoot) acts.append(actButton("rename", ICONS.pencil, "Rename this document, or change its address"));
      } else {
        if (folder) acts.append(actButton("add", ICONS.plus, `New in ${name}`));
        acts.append(actButton("more", ICONS.more, `More for ${name}`));
      }
      if (acts.childElementCount) r.append(acts);
      if (!isRoot) r.draggable = true;
    }
    return r;
  }
  const actButton = (act: string, icon: string, label: string) => {
    const b = el("button", { type: "button", className: "et-act", tabIndex: -1, dataset: { act }, "aria-label": label, title: label }, svg(icon));
    if (act != "rename") b.setAttribute("aria-haspopup", "menu");
    return b;
  };

  function editRow(depth: number, type: EntryType, value: string, placeholder: string, ext: boolean, error?: string, path?: string): HTMLElement {
    const r = el("div", { className: "et-row editing", ...(depth ? { style: `--depth: ${depth}` } : {}) });
    const input = el("input", { className: "et-input", value, placeholder, spellcheck: false, autocomplete: "off", "aria-label": path ? (type == "folder" ? `Rename the folder ${nameOf(path)}` : `Rename the page ${value}`) : placeholder });
    input.setAttribute("autocapitalize", "off");
    if (error) input.setAttribute("aria-invalid", "true");
    r.append(el("span", { className: "et-twist none", "aria-hidden": "true" }), el("span", { className: "et-icon", "aria-hidden": "true" }, svg(type == "folder" ? ICONS.folder : type == "page" ? ICONS.page : ICONS.file)), input);
    input.addEventListener("input", () => {
      if (!editing) return;
      editing.value = input.value;
      if (editing.error) { editing.error = undefined; r.nextElementSibling?.classList.contains("et-msg") && r.nextElementSibling.remove(); input.removeAttribute("aria-invalid"); }
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key == "Enter") { e.preventDefault(); commitEdit(); }
      else if (e.key == "Escape") { e.preventDefault(); const back = editing?.kind == "rename" ? editing.path : editing?.kind == "new" ? editing.dir || null : null; editing = null; focusPath = back; render(); }
    });
    // Leaving the field keeps what was typed (as a file manager does); an empty one is dropped.
    input.addEventListener("blur", () => { setTimeout(() => { if (editing && document.activeElement != input && root.contains(input)) commitEdit(); }, 0); });
    return r;
  }
  const msg = (depth: number, text: string) => el("p", { className: "et-msg error", role: "alert", style: `--depth: ${depth}` }, text);

  function confirmRow(n: Node, depth: number): HTMLElement {
    const r = el("div", { className: "et-row confirm", role: "group", "aria-label": `Delete ${nameOf(n.path)}?`, ...(depth ? { style: `--depth: ${depth}` } : {}) });
    // Only what shows counts: the shared styles and images go with it, unmentioned.
    const docs = (x: Node): number => x.children.reduce((s, c) => s + (c.type == "page" ? 1 : 0) + docs(c), 0);
    const k = docs(n);
    const yes = el("button", { type: "button", className: "et-btn danger" }, "Delete");
    const no = el("button", { type: "button", className: "et-btn" }, "Cancel");
    r.append(el("span", { className: "et-icon", "aria-hidden": "true" }, svg(ICONS.folder)), el("span", { className: "et-confirm" }, `Delete the folder “${nameOf(n.path)}”${k ? ` and the ${k == 1 ? "page" : `${k} pages`} in it` : ""}?`), no, yes);
    yes.addEventListener("click", () => remove(n.path));
    no.addEventListener("click", () => { confirming = null; focusPath = n.path; render(); });
    r.addEventListener("keydown", (e) => { if (e.key == "Escape") { e.stopPropagation(); confirming = null; focusPath = n.path; render(); } });
    queueMicrotask(() => yes.focus());
    return r;
  }

  /** The row to focus once `path` is gone: the next one, else the one before. */
  function neighbour(path: string): string | null {
    const list = visible().map(([n]) => n.path).filter((p) => p != path && !p.startsWith(path + "/"));
    const all = visible().map(([n]) => n.path);
    const i = all.indexOf(path);
    for (let j = i + 1; j < all.length; j++) if (list.includes(all[j])) return all[j];
    for (let j = i - 1; j >= 0; j--) if (list.includes(all[j])) return all[j];
    return null;
  }

  // ------------------------------------------------------------ menus

  function closeMenu(refocus = false) {
    if (!menu) return;
    menu.remove();
    menu = null;
    if (stale && !interacting()) { stale = false; queueMicrotask(load); }
    menuButton?.setAttribute("aria-expanded", "false");
    menuButton?.closest(".et-row")?.classList.remove("menu-open");
    const row = menuButton?.closest<HTMLElement>(".et-row");
    menuButton = null;
    if (refocus && row?.isConnected) row.focus();
  }

  type Item = { label: string; icon?: string; run: () => void; danger?: boolean; depth?: number } | "-" | { head: string };
  function openMenu(anchor: HTMLElement, items: Item[]) {
    closeMenu();
    const m = el("div", { className: "et-menu", role: "menu" });
    // It hangs off the page's body (the card it's in may clip it), in the tree's own colours.
    const cs = getComputedStyle(root);
    for (const v of ["--bg", "--fg", "--fg-strong", "--soft", "--chrome", "--chrome-hover", "--rule", "--caret", "--panel-border", "--font-text"]) {
      const val = cs.getPropertyValue(v);
      if (val) m.style.setProperty(v, val);
    }
    for (const it of items) {
      if (it == "-") { m.append(el("hr")); continue; }
      if ("head" in it) { m.append(el("p", { className: "et-menu-head" }, it.head)); continue; }
      const b = el("button", { type: "button", role: "menuitem", tabIndex: -1, className: it.danger ? "danger" : "", ...(it.depth ? { style: `--depth: ${it.depth}` } : {}) }, ...(it.icon ? [svg(it.icon)] : []), el("span", {}, it.label));
      b.addEventListener("click", (e) => { e.stopPropagation(); const run = it.run; closeMenu(); run(); });
      m.append(b);
    }
    document.body.append(m);
    menu = m;
    menuButton = anchor;
    anchor.setAttribute("aria-expanded", "true");
    anchor.closest(".et-row")?.classList.add("menu-open");
    const a = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    const left = Math.max(12, Math.min(a.right - w, innerWidth - w - 12));
    const top = a.bottom + 4 + h > innerHeight - 12 ? Math.max(12, a.top - 4 - h) : a.bottom + 4;
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
    const first = m.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    m.addEventListener("keydown", (e) => {
      const items = [...m.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key == "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      else if (e.key == "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
      else if (e.key == "Home") { e.preventDefault(); items[0]?.focus(); }
      else if (e.key == "End") { e.preventDefault(); items.at(-1)?.focus(); }
      else if (e.key == "Escape" || e.key == "Tab") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    });
  }

  const addItems = (dir: string): Item[] => [
    { label: "New page", icon: ICONS.newPage, run: () => startNew(dir, "page") },
    { label: "New folder", icon: ICONS.newFolder, run: () => startNew(dir, "folder") },
  ];
  function moreMenu(anchor: HTMLElement, path: string) {
    const n = find(path);
    if (!n) return;
    openMenu(anchor, [
      ...(n.type == "folder" ? [...addItems(path), "-" as const] : []),
      ...(n.type == "page" ? [{ label: "Open in a new tab", run: () => go(path, true) }, "-" as const] : []),
      { label: n.type == "folder" ? "Rename folder" : "Rename page", run: () => startRename(path) },
      { label: n.type == "folder" ? "Move folder to…" : "Move page to…", run: () => moveMenu(anchor, path) },
      "-",
      { label: n.type == "folder" ? "Delete folder" : "Delete page", danger: true, run: () => remove(path) },
    ]);
  }
  /** Move to…: the top level and every folder it can go into. */
  function moveMenu(anchor: HTMLElement, path: string) {
    const folders: [string, number][] = [];
    const walk = (list: Node[], depth: number) => {
      for (const c of sorted(list)) if (c.type == "folder" && shows(c, kind) && c.path != path && !c.path.startsWith(path + "/")) { folders.push([c.path, depth]); walk(c.children, depth + 1); }
    };
    walk(tree.children, 1);
    const here = parentOf(path);
    const moving = find(path);
    const items: Item[] = [{ head: `Move “${moving ? label(moving) : nameOf(path)}” to` }];
    if (here) items.push({ label: showRoot ? "Top level (beside the home page)" : "Top level", icon: ICONS.page, run: () => move(path, "") });
    for (const [p, depth] of folders) if (p != here) items.push({ label: nameOf(p), icon: ICONS.folder, depth: depth - 1, run: () => move(path, p) });
    if (items.length == 1) items.push({ head: "There's nowhere else to move it: make a folder first." });
    const anchorNow = anchor.isConnected ? anchor : rows.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"] [data-act="more"]`) ?? anchor;
    openMenu(anchorNow, items);
  }

  // ------------------------------------------------------------ events

  rows.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const r = target.closest<HTMLElement>(".et-row[data-path]");
    if (!r || target.closest(".et-input, .et-btn")) return;
    const path = r.dataset.path!, type = r.dataset.type as EntryType;
    const act = target.closest<HTMLElement>("[data-act]");
    setRoving(r);
    if (act) {
      e.preventDefault();
      e.stopPropagation();
      if (menuButton == act) { closeMenu(); return; }
      if (act.dataset.act == "add") openMenu(act, addItems(path));
      else if (act.dataset.act == "more") moreMenu(act, path);
      else if (act.dataset.act == "rename") startRename(path);
      return;
    }
    if (type == "folder") { toggle(path); return; }
    if (type == "page") {
      const link = target.closest("a");
      // ⌘-click, Ctrl-click, middle-click on the name: the browser's own (a new tab).
      if (link && (e.metaKey || e.ctrlKey || e.shiftKey || e.button)) return;
      e.preventDefault();
      go(path);
    }
  });
  rows.addEventListener("contextmenu", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".et-row[data-path]");
    const more = r?.querySelector<HTMLElement>('[data-act="more"]');
    if (!r || !more || !canEdit) return;
    e.preventDefault();
    moreMenu(more, r.dataset.path!);
  });
  rows.addEventListener("keydown", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".et-row[data-path]");
    if (!r || (e.target as HTMLElement).closest(".et-input, .et-btn")) return;
    const all = [...rows.querySelectorAll<HTMLElement>(".et-row[data-path]")];
    const i = all.indexOf(r), path = r.dataset.path!, type = r.dataset.type as EntryType;
    const to = (t: HTMLElement | undefined) => { if (!t) return; e.preventDefault(); setRoving(t); t.focus(); };
    switch (e.key) {
      case "ArrowDown": return to(all[i + 1]);
      case "ArrowUp": return to(all[i - 1]);
      case "Home": return to(all[0]);
      case "End": return to(all.at(-1));
      case "ArrowRight":
        e.preventDefault();
        if (type == "folder" && !open.has(path)) toggle(path, true);
        else if (type == "folder" && all[i + 1] && parentOf(all[i + 1].dataset.path!) == path) to(all[i + 1]);
        else if (path == ROOT && showRoot) to(all[i + 1]);
        return;
      case "ArrowLeft": {
        e.preventDefault();
        if (type == "folder" && open.has(path)) { toggle(path, false); return; }
        const up = parentOf(path);
        const parent = up ? all.find((x) => x.dataset.path == up) : showRoot ? all.find((x) => x.dataset.path == ROOT) : undefined;
        return to(parent);
      }
      case "Enter": case " ":
        e.preventDefault();
        if (type == "folder") toggle(path);
        else if (type == "page") go(path, e.key == "Enter" && (e.metaKey || e.ctrlKey));
        else if (type == "file") location.assign(fileHref(path));
        return;
      case "F2":
        if (canEdit) { e.preventDefault(); startRename(path); }
        return;
      case "Delete": case "Backspace":
        if (canEdit && path != ROOT) { e.preventDefault(); remove(path); }
        return;
      case "ContextMenu":
      case "F10": {
        if (e.key == "F10" && !e.shiftKey) return;
        const more = r.querySelector<HTMLElement>('[data-act="more"], [data-act="rename"]');
        if (!more || !canEdit) return;
        e.preventDefault();
        if (more.dataset.act == "rename") startRename(path); else moreMenu(more, path);
        return;
      }
    }
  });
  rows.addEventListener("focusin", (e) => { const r = (e.target as HTMLElement).closest<HTMLElement>(".et-row[data-path]"); if (r) setRoving(r); });

  // Drag and drop: onto a folder (into it), onto a page or file (beside it), onto the root row or the foot (the top level).
  const dropDir = (target: HTMLElement): string | null => {
    if (target.closest(".et-foot")) return "";
    const r = target.closest<HTMLElement>(".et-row[data-path]");
    if (!r) return null;
    const p = r.dataset.path!;
    if (p == ROOT && showRoot) return "";
    return r.dataset.type == "folder" ? p : parentOf(p);
  };
  const okDrop = (dir: string | null) => dir != null && !!dragFrom && dir != parentOf(dragFrom) && dir != dragFrom && !dir.startsWith(dragFrom + "/");
  const clearDrop = () => root.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
  root.addEventListener("dragstart", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".et-row[data-path]");
    if (!r || !canEdit || r.dataset.path == ROOT) return;
    dragFrom = r.dataset.path!;
    e.dataTransfer?.setData("text/plain", dragFrom);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    closeMenu();
    requestAnimationFrame(() => r.classList.add("dragging"));
  });
  root.addEventListener("dragover", (e) => {
    const dir = dropDir(e.target as HTMLElement);
    clearDrop();
    if (!okDrop(dir)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const t = e.target as HTMLElement;
    const at = t.closest(".et-foot") ?? (dir ? rows.querySelector(`[data-path="${CSS.escape(dir)}"]`) : rows.querySelector(`[data-path="${ROOT}"]`) ?? foot);
    at?.classList.add("drop");
  });
  root.addEventListener("dragleave", (e) => { if (!root.contains(e.relatedTarget as globalThis.Node)) clearDrop(); });
  root.addEventListener("drop", (e) => {
    const dir = dropDir(e.target as HTMLElement);
    const from = dragFrom;
    clearDrop();
    if (!from || !okDrop(dir)) return;
    e.preventDefault();
    dragFrom = null;
    move(from, dir!);
  });
  root.addEventListener("dragend", () => {
    dragFrom = null; clearDrop(); root.querySelectorAll(".dragging").forEach((x) => x.classList.remove("dragging"));
    if (stale && !interacting()) { stale = false; load(); }
  });

  // The tree changed, anyone's doing: the editor says so with an "erga-tree" event on window ({ type: "tree", moved?, deleted? }:
  // main.ts, from the document's event channel). A folder that moved stays open where it went, and the page you're on, moved,
  // is still marked (the editor goes to its new address); then the tree is read again, if it's showing.
  const onTreeEvent = (e: Event) => {
    const d = (e as CustomEvent<{ moved?: { from: string; to: string }; deleted?: string }>).detail ?? {};
    const under = (p: string, dir: string) => p == dir || p.startsWith(dir + "/");
    if (d.moved) {
      const { from, to } = d.moved;
      rekeyOpen(from, to);
      if (current && under(current, from)) current = to + current.slice(from.length);
    }
    if (d.deleted && current && under(current, d.deleted)) current = null;
    if (root.offsetParent) refresh(true);
  };
  window.addEventListener("erga-tree", onTreeEvent);
  /** Reads it again; quietly (a change from elsewhere) waits while someone's in the middle of something here. */
  function refresh(quiet = false): Promise<void> {
    if (quiet && interacting()) { stale = true; return Promise.resolve(); }
    stale = false;
    return load();
  }

  const outside = (e: PointerEvent) => { if (menu && !menu.contains(e.target as globalThis.Node) && !(menuButton?.contains(e.target as globalThis.Node))) closeMenu(); };
  document.addEventListener("pointerdown", outside, true);
  const onScroll = (e: Event) => { if (menu && !menu.contains(e.target as globalThis.Node)) closeMenu(); };
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", () => closeMenu());

  if (opts.initial) set(opts.initial.entries, opts.initial.canEdit, opts.initial.kind);
  render();
  load();

  return {
    element: root,
    refresh: (o) => refresh(!!o?.quiet),
    setCurrent(path) { current = path; render(); },
    setRootTitle(title) { if (title == rootTitle) return; rootTitle = title; render(); },
    setBase(b) { if (b == base) return; base = b; render(); },
    retitle() { if (!editing) render(); },
    focus: focusFirst,
    destroy() {
      closeMenu();
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("erga-tree", onTreeEvent);
      root.remove();
    },
  };
}

declare global { interface Window { ergaTree?: { mountTree: typeof mountTree; pageUrl: typeof pageUrl; pageAt: typeof pageAt } } }
window.ergaTree = { mountTree, pageUrl, pageAt };

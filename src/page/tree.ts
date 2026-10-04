// A document's pages, as a small tree: its folders, documents (pages) and
// other files, from GET /api/docs/<id>/tree, changed through POST to the same
// address (new_page, new_folder, move, delete). One component, in two places:
// the editor (a card under the document's title, top left: main.ts) and
// Documents (beneath a document's row: front.ts). It's built on its own
// (build.sh: tree.js) and loaded only when someone opens it, so it costs the
// viewer nothing.
//
// index.html is the root document; everything beside it sits under it. A page
// shows as a document, by its title when known, else by its name; a folder
// opens and closes; other files are shown quietly. Clicking a page opens it,
// in the editor when you're editing, in the viewer otherwise, and the page
// you're on is marked. Editors add (New document, New folder: at the top level
// and in each folder), rename in place, move (drag and drop, or Move to…) and
// delete (a folder asks first); viewers only look. Errors from the server
// show where they happened, in its words.
//
// Keys, on the tree: ↑ ↓ move, → opens a folder (or goes into it), ← closes
// it (or goes up), Home and End, Enter opens a page or a folder, F2 renames,
// Delete deletes, and Shift-F10 (or the context-menu key) opens a row's menu.

export type EntryType = "page" | "folder" | "file";
export interface Entry { path: string; type: EntryType; title?: string }
export interface TreeAnswer { entries: Entry[]; canEdit?: boolean }

export interface TreeOptions {
  /** The document's id: its tree is /api/docs/<id>/tree. */
  id: string;
  /** Its address, /<owner>/<slug>: where its pages are (pageUrl). */
  base: string;
  /** Open pages in the editor (…/edit) rather than the viewer. */
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
  /** Renaming the root document is renaming the document (its title and address): the caller's to do. */
  onRenameRoot?: () => void;
  /** Goes to a page (default: the browser goes there). `replace` when the page you were on moved. */
  navigate?: (url: string, opts: { replace?: boolean }) => void;
  /** What the server answered last, for a caller that wants it (e.g. to count the pages). */
  onChange?: (answer: { entries: Entry[]; canEdit: boolean }) => void;
  /** Where to fetch from (tests stub it); default window.fetch. */
  fetch?: typeof fetch;
  /** The label for the tree, for screen readers. */
  label?: string;
}

export interface TreeHandle {
  readonly element: HTMLElement;
  /** Reads the tree again (another tab or an agent changed it). */
  refresh(): Promise<void>;
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
const isPage = (p: string) => /\.html?$/i.test(p);
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** A page's address: /<owner>/<slug>/<path without .html, and without a trailing /index>. */
export function pageUrl(base: string, path: string): string {
  const rest = path.replace(/\.html?$/i, "").replace(/(^|\/)index$/, "");
  return base.replace(/\/+$/, "") + (rest ? "/" + rest.split("/").map(encodeURIComponent).join("/") : "");
}

/** The page at an address (the inverse of pageUrl, against the pages there are), or null. */
export function pageAt(entries: Entry[], base: string, pathname: string): string | null {
  const want = decodeURIComponent(pathname.replace(/\/edit\/?$/, "").replace(/\/+$/, ""));
  for (const e of entries) if (e.type == "page" && decodeURIComponent(pageUrl(base, e.path)) == want) return e.path;
  return null;
}

/** What's wrong with a name for something new (or renamed) in `dir`, or null. `taken` is what's there already. */
export function checkName(name: string, type: EntryType, taken: Set<string>, was?: string): string | null {
  if (!name) return type == "folder" ? "Give the folder a name." : "Give the document a name.";
  if (/[\/\\]/.test(name)) return "A name can't have / or \\ in it.";
  if (name.startsWith(".")) return "A name can't start with a dot.";
  if (/[\x00-\x1f\x7f]/.test(name)) return "That name has characters it can't have.";
  if (name.length > 120) return "That name is too long.";
  if (name.toLowerCase() != was?.toLowerCase() && taken.has(name.toLowerCase())) return `There's already something called “${name}” here.`;
  return null;
}

/** A name as typed, as a file: documents get .html unless they say .html or .htm. */
export const fileName = (typed: string, type: EntryType) => {
  const name = typed.trim();
  return type == "page" && !/\.html?$/i.test(name) ? `${name}.html` : name;
};

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
.et-row.file { cursor: default; }
.et-row.file .et-name { color: var(--soft); font-size: 12.5px; }
.et-row.file .et-icon { opacity: 0.7; }
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
.et-banner button { flex: none; padding: 0 2px; border: 0; background: none; color: inherit; font: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
/* Delete a folder? Asked in its row. */
.et-row.confirm { cursor: default; background: color-mix(in srgb, #c2410c 8%, transparent); }
.et-confirm { flex: 1; min-width: 0; font-size: 12.5px; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.et-btn { flex: none; height: 24px; padding: 0 9px; border: 1px solid var(--rule); border-radius: 6px; background: transparent; color: var(--fg); font: 550 12px var(--font-text, inherit); cursor: pointer; }
.et-btn.danger { border-color: #c2410c; background: #c2410c; color: #fff; }
.et-btn:focus-visible, .et-add:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
/* New document, New folder: at the top level, under the rows. */
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

  const root = el("div", { className: "et" });
  const bannerEl = el("div", { className: "et-banner", role: "alert", hidden: true });
  const rows = el("div", { className: "et-rows", role: "tree", "aria-label": opts.label ?? "Pages" });
  const foot = el("div", { className: "et-foot", hidden: true });
  const addPage = el("button", { type: "button", className: "et-add" }, svg(ICONS.newPage), "New document");
  const addFolder = el("button", { type: "button", className: "et-add" }, svg(ICONS.newFolder), "New folder");
  foot.append(addPage, addFolder);
  root.append(bannerEl, rows, foot);
  container.append(root);
  addPage.addEventListener("click", () => startNew("", "page"));
  addFolder.addEventListener("click", () => startNew("", "folder"));

  const titleFor = (n: { path: string; title?: string }) => (n.path == ROOT && rootTitle) || opts.titleOf?.(n.path) || n.title || null;
  const label = (n: Node) => (n.type == "page" ? titleFor(n) || nameOf(n.path).replace(/\.html?$/i, "") : nameOf(n.path));
  const sortKey = (n: Node) => `${n.type == "folder" ? 0 : n.type == "page" ? (nameOf(n.path).toLowerCase() == "index.html" ? 1 : 2) : 3}`;
  const sorted = (list: Node[]) => [...list].sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || label(a).localeCompare(label(b), undefined, { numeric: true, sensitivity: "base" }));
  const find = (path: string, at: Node = tree): Node | null => {
    if (at.path == path) return at;
    for (const c of at.children) { const f = find(path, c); if (f) return f; }
    return null;
  };
  const takenIn = (dir: string) => new Set((find(dir)?.children ?? []).map((c) => nameOf(c.path).toLowerCase()));
  const hasRoot = () => !!entries?.some((e) => e.path == ROOT);
  const say = (text: string | null) => { banner = text; bannerEl.hidden = !text; bannerEl.replaceChildren(); if (text) bannerEl.append(el("span", {}, text)); };

  // ------------------------------------------------------------ talking to the server

  async function load() {
    try {
      const r = await doFetch(api(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      const body = (await r.json().catch(() => ({}))) as Partial<TreeAnswer> & { error?: string };
      if (!r.ok) throw new Error(body.error || (r.status == 404 ? "This document's pages couldn't be found." : r.status == 403 ? "You can't see this document's pages." : `The server couldn't list the pages (${r.status}).`));
      set(body.entries ?? [], !!body.canEdit);
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

  function set(list: Entry[], edit: boolean) {
    entries = list;
    canEdit = edit;
    tree = buildTree(list);
    // The page you're on is in view.
    if (current) for (let d = parentOf(current); d; d = parentOf(d)) open.add(d);
    opts.onChange?.({ entries: list, canEdit: edit });
  }

  /** A change, sent: the tree it answers, or the server's own words for why not (thrown). */
  async function send(op: Record<string, string>): Promise<void> {
    const r = await doFetch(api(), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(op), signal: AbortSignal.timeout(15_000) })
      .catch((e) => { throw new Error(plain(e)); });
    const body = (await r.json().catch(() => ({}))) as Partial<TreeAnswer> & { error?: string };
    if (!r.ok) throw new Error(body.error || (r.status == 403 ? "You can't change this document's pages." : `That didn't work (the server answered ${r.status}).`));
    set(body.entries ?? entries ?? [], body.canEdit ?? canEdit);
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

  /** After the page you're on moved or went: follow it (or go to the root document). */
  function follow(from: string, to: string | null) {
    if (!current) return;
    const moved = current == from ? to : current.startsWith(from + "/") ? (to == null ? null : to + current.slice(from.length)) : undefined;
    if (moved === undefined) return;
    const target = moved ?? ROOT;
    current = moved ?? null;
    const url = pageUrl(base, target) + (opts.editing ? "/edit" : "") + query;
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
    editing = { kind: "rename", path, value: n.type == "page" ? nameOf(path).replace(/\.html?$/i, "") : nameOf(path) };
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
      const name = fileName(typed, n.type == "page" ? "page" : n.type);
      if (!typed || name == nameOf(e.path)) { editing = null; focusPath = e.path; render(); return; }
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
    if (takenIn(dir).has(nameOf(from).toLowerCase())) { say(`There's already something called “${nameOf(from)}” in ${dir ? `“${nameOf(dir)}”` : "the top level"}.`); return; }
    if (dir) open.add(dir);
    if (await change(from, { op: "move", from, to })) { focusPath = to; rekeyOpen(from, to); follow(from, to); }
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
    const url = pageUrl(base, path) + (opts.editing ? "/edit" : "") + query;
    if (newTab) { window.open(url, "_blank", "noopener"); return; }
    if (path == current) return;
    (opts.navigate ?? ((u) => location.assign(u)))(url, {});
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
      for (const n of sorted(list)) {
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
      return [editRow(depth, e.type, e.value, e.type == "folder" ? "Folder name" : "Document name", e.type == "page", e.error), ...(e.error ? [msg(depth, e.error)] : [])];
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
    if (!peers && !editing) rows.append(el("p", { className: "et-note", style: `--depth: ${showRoot && hasRoot() ? 1 : 0}` }, canEdit ? "No other pages yet." : "No other pages."));
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
  }

  const setRoving = (target: HTMLElement | null) => {
    for (const r of rows.querySelectorAll<HTMLElement>(".et-row[data-path]")) r.tabIndex = r == target ? 0 : -1;
  };

  function row(n: Node, depth: number, pos: number, size: number): HTMLElement {
    const isRoot = n.path == ROOT && showRoot;
    const folder = n.type == "folder";
    const name = label(n);
    const r = el("div", {
      className: `et-row ${n.type}${isRoot ? " root" : ""}${busy == n.path ? " busy" : ""}`,
      role: "treeitem", tabIndex: -1, dataset: { path: n.path, type: n.type },
      "aria-level": depth + 1, "aria-setsize": size, "aria-posinset": pos, "aria-label": name + (n.type == "file" ? " (file)" : ""),
      ...(depth ? { style: `--depth: ${depth}` } : {}),
    });
    if (folder) r.setAttribute("aria-expanded", String(open.has(n.path)));
    if (n.type == "page" && n.path == current) r.setAttribute("aria-current", "page");
    const twist = el("span", { className: `et-twist${folder ? "" : " none"}`, "aria-hidden": "true" }, svg(ICONS.chevron));
    const icon = el("span", { className: "et-icon", "aria-hidden": "true" }, svg(folder ? (open.has(n.path) ? ICONS.folderOpen : ICONS.folder) : n.type == "page" ? ICONS.page : ICONS.file));
    const text = n.type == "page"
      ? el("a", { className: "et-name", href: pageUrl(base, n.path) + (opts.editing ? "/edit" : "") + query, tabIndex: -1, draggable: false, title: n.path }, name)
      : el("span", { className: "et-name", title: n.path }, name);
    r.append(twist, icon, text);
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
    const input = el("input", { className: "et-input", value, placeholder, spellcheck: false, autocomplete: "off", "aria-label": path ? `Rename ${nameOf(path)}` : placeholder });
    input.setAttribute("autocapitalize", "off");
    if (error) input.setAttribute("aria-invalid", "true");
    r.append(el("span", { className: "et-twist none", "aria-hidden": "true" }), el("span", { className: "et-icon", "aria-hidden": "true" }, svg(type == "folder" ? ICONS.folder : type == "page" ? ICONS.page : ICONS.file)), input);
    if (ext && !/\.html?$/i.test(value)) r.append(el("span", { className: "et-ext", "aria-hidden": "true" }, ".html"));
    input.addEventListener("input", () => {
      if (!editing) return;
      editing.value = input.value;
      const extEl = r.querySelector(".et-ext");
      if (ext) { if (/\.html?$/i.test(input.value)) extEl?.remove(); else if (!extEl) r.append(el("span", { className: "et-ext", "aria-hidden": "true" }, ".html")); }
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
    const count = (x: Node): number => x.children.reduce((s, c) => s + 1 + count(c), 0);
    const k = count(n);
    const yes = el("button", { type: "button", className: "et-btn danger" }, "Delete");
    const no = el("button", { type: "button", className: "et-btn" }, "Cancel");
    r.append(el("span", { className: "et-icon", "aria-hidden": "true" }, svg(ICONS.folder)), el("span", { className: "et-confirm" }, `Delete “${nameOf(n.path)}”${k ? ` and the ${k == 1 ? "item" : `${k} items`} in it` : ""}?`), no, yes);
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
    { label: "New document", icon: ICONS.newPage, run: () => startNew(dir, "page") },
    { label: "New folder", icon: ICONS.newFolder, run: () => startNew(dir, "folder") },
  ];
  function moreMenu(anchor: HTMLElement, path: string) {
    const n = find(path);
    if (!n) return;
    openMenu(anchor, [
      ...(n.type == "folder" ? [...addItems(path), "-" as const] : []),
      ...(n.type == "page" ? [{ label: "Open in a new tab", run: () => go(path, true) }, "-" as const] : []),
      { label: "Rename", run: () => startRename(path) },
      { label: "Move to…", run: () => moveMenu(anchor, path) },
      "-",
      { label: "Delete", danger: true, run: () => remove(path) },
    ]);
  }
  /** Move to…: the top level and every folder it can go into. */
  function moveMenu(anchor: HTMLElement, path: string) {
    const folders: [string, number][] = [];
    const walk = (list: Node[], depth: number) => {
      for (const c of sorted(list)) if (c.type == "folder" && c.path != path && !c.path.startsWith(path + "/")) { folders.push([c.path, depth]); walk(c.children, depth + 1); }
    };
    walk(tree.children, 1);
    const here = parentOf(path);
    const items: Item[] = [{ head: `Move “${nameOf(path)}” to` }];
    if (here) items.push({ label: showRoot ? "Top level (beside the document)" : "Top level", icon: ICONS.page, run: () => move(path, "") });
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
  rows.addEventListener("dblclick", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".et-row[data-path]");
    if (r && canEdit && r.dataset.type == "file") startRename(r.dataset.path!);
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
  root.addEventListener("dragend", () => { dragFrom = null; clearDrop(); root.querySelectorAll(".dragging").forEach((x) => x.classList.remove("dragging")); });

  const outside = (e: PointerEvent) => { if (menu && !menu.contains(e.target as globalThis.Node) && !(menuButton?.contains(e.target as globalThis.Node))) closeMenu(); };
  document.addEventListener("pointerdown", outside, true);
  const onScroll = (e: Event) => { if (menu && !menu.contains(e.target as globalThis.Node)) closeMenu(); };
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", () => closeMenu());

  render();
  load();

  return {
    element: root,
    refresh: load,
    setCurrent(path) { current = path; render(); },
    setRootTitle(title) { if (title == rootTitle) return; rootTitle = title; render(); },
    setBase(b) { if (b == base) return; base = b; render(); },
    retitle() { if (!editing) render(); },
    focus: focusFirst,
    destroy() {
      closeMenu();
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", onScroll, true);
      root.remove();
    },
  };
}

declare global { interface Window { ergaTree?: { mountTree: typeof mountTree; pageUrl: typeof pageUrl; pageAt: typeof pageAt } } }
window.ergaTree = { mountTree, pageUrl, pageAt };

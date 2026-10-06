// What a new document can start from: the templates the + button offers
// (the viewer's, the homepage's and the editor's), and /new?template=<id>
// makes. One registry, so a new template is one entry here (README, "New
// documents from a template"). No server code: the editor's bundle reads it too.

/** A template: what the picker shows, and the files a new document starts with. */
export interface Template {
  /** Its name in /new?template=<id>: lowercase letters, digits and dashes. Never changes once it's out (links name it). */
  id: string;
  /** What the picker calls it. */
  name: string;
  /** The group it's in, if any (one of TEMPLATE_GROUPS' names); else it stands on its own. */
  group?: string;
  /** A line under its name. */
  description: string;
  /**
   * The starting document: a folder of the repo, templates/<name>, copied
   * whole (text files only), whose page is its index.html (or index.md).
   */
  files: `templates/${string}`;
}

/** A group of templates in the picker, placed after the template `after` names (or first, without). Empty, it says so. */
export interface TemplateGroup {
  name: string;
  after?: string;
}

/** The templates, in the picker's order. The first is what /new makes when no template is named. */
export const TEMPLATES: Template[] = [
  { id: "page", name: "Page", description: "A blank document.", files: "templates/doc" },
  { id: "slides", name: "Slides", group: "Presentation", description: "16:9 slides you step through.", files: "templates/slides" },
];

export const TEMPLATE_GROUPS: TemplateGroup[] = [
  { name: "Presentation", after: "page" },
];

export const templateById = (id: string | null | undefined): Template | undefined => TEMPLATES.find((t) => t.id == id);

/** The picker's rows, in order: templates on their own, and each group with its templates (perhaps none). */
export function pickerRows(): ({ template: Template } | { group: string; templates: Template[] })[] {
  const group = (g: TemplateGroup) => ({ group: g.name, templates: TEMPLATES.filter((t) => t.group == g.name) });
  const rows: ReturnType<typeof pickerRows> = TEMPLATE_GROUPS.filter((g) => !templateById(g.after)).map(group);
  for (const t of TEMPLATES) {
    if (!t.group) rows.push({ template: t });
    rows.push(...TEMPLATE_GROUPS.filter((g) => g.after == t.id).map(group));
  }
  return rows;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const PLUS = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>`;

/** The + button: `cls` gives it the look of the controls it sits with (the viewer's erga-view-button, the editor's icon-btn). */
export const newDocButton = (cls: string) =>
  `<button type="button" class="${cls} erga-new-btn" aria-label="New document" data-tip="New document" aria-haspopup="menu" aria-expanded="false" aria-controls="erga-new-menu">${PLUS}</button>`;

/**
 * The picker, one on each page (or shadow root) whatever + buttons it has:
 * each template a link to /new?template=<id> (`href` adds what the page's
 * links keep, ?user=). /new asks someone signed out to sign in first, and
 * comes back to make it.
 */
export function newDocMenu(href: (path: string) => string, signedIn: boolean): string {
  const item = (t: Template) => `<a role="menuitem" href="${esc(href(`/new?template=${encodeURIComponent(t.id)}`))}" data-template="${esc(t.id)}"><b>${esc(t.name)}</b><span>${esc(t.description)}</span></a>`;
  const rows = pickerRows().map((r) => "group" in r
    ? `<div class="erga-new-group" role="group" aria-label="${esc(r.group)}"><p class="erga-new-group-name">${esc(r.group)}</p>${r.templates.length ? r.templates.map(item).join("") : `<p class="erga-new-empty">No templates here yet.</p>`}</div>`
    : item(r.template));
  return `<div class="erga-new-menu" id="erga-new-menu" role="menu" aria-label="New document" hidden><p class="erga-new-title">New document</p>${rows.join("")}${signedIn ? "" : `<p class="erga-new-note">You sign in first, then Erga makes the document.</p>`}</div>`;
}

export const NEW_DOC_STYLE = `<style>
  .erga-new-menu { --nm-bg: #fff; --nm-fg: #1c1c1f; --nm-soft: #6b6b73; --nm-ring: #e6e6ea; --nm-hover: rgba(161, 161, 169, .14);
    position: fixed; z-index: 2147483000; width: min(300px, calc(100vw - 24px)); max-height: calc(100vh - 80px); overflow: auto; box-sizing: border-box; padding: 6px;
    color: var(--nm-fg); background: var(--nm-bg); border: 1px solid var(--nm-ring); border-radius: 12px; text-align: left;
    box-shadow: 0 8px 30px rgba(0, 0, 0, .12), 0 1px 2px rgba(0, 0, 0, .05); font: 400 14px/1.35 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  html.page-dark .erga-new-menu { --nm-bg: #1f1f23; --nm-fg: #ececf1; --nm-soft: #8f8f99; --nm-ring: #2f2f35; --nm-hover: rgba(161, 161, 169, .16); }
  .erga-new-menu[hidden] { display: none; }
  /* One typeface throughout, the app's (Inter, which the script loads where the page hasn't it): every option and group
     heading in the same size and weight; the lines under them, smaller and quieter. */
  .erga-new-menu * { font: inherit; letter-spacing: normal; text-transform: none; }
  .erga-new-menu p { margin: 0; }
  .erga-new-title { padding: 6px 10px 6px; color: var(--nm-soft); font-size: 12.5px; }
  .erga-new-menu a { display: grid; gap: 1px; padding: 7px 10px; border-radius: 7px; color: var(--nm-fg); text-decoration: none; }
  .erga-new-menu a b, .erga-new-group-name { font-weight: 600; font-size: 14px; color: var(--nm-fg); }
  .erga-new-menu a span, .erga-new-empty, .erga-new-note { color: var(--nm-soft); font-size: 12.5px; }
  .erga-new-menu a:hover, .erga-new-menu a:focus-visible { background: var(--nm-hover); outline: none; }
  .erga-new-group { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--nm-ring); }
  .erga-new-group + a { margin-top: 4px; position: relative; }
  .erga-new-group + a::before { content: ""; position: absolute; top: -4px; left: 0; right: 0; border-top: 1px solid var(--nm-ring); }
  .erga-new-group-name { padding: 7px 10px 1px; }
  .erga-new-group a { padding-left: 18px; }
  .erga-new-empty { padding: 0 10px 8px; }
  .erga-new-note { margin-top: 4px !important; padding: 8px 10px 4px; border-top: 1px solid var(--nm-ring); }
  .erga-view-button.erga-new-btn { margin: 0; padding: 0; border: 0; background-color: transparent; font: inherit; cursor: pointer; }
  .erga-view-button.erga-new-btn:hover { background-color: color-mix(in srgb, var(--chrome) 12%, transparent); }
  .erga-new-btn:focus-visible { outline: 2px solid #3b7cf0; outline-offset: 1px; }
  .erga-new-btn svg { stroke-width: 1.7; }
  .erga-new-btn[aria-expanded="true"]::after, .erga-new-btn[aria-expanded="true"]::before { display: none; }
  @media (pointer: coarse) { .erga-new-menu a { padding: 10px 12px; } .erga-new-group a { padding-left: 20px; } }
</style>`;

/**
 * Opens and closes the picker: `ergaNewDoc(root)`, once for each page or
 * shadow root with a picker in it. Any + button in it opens it, under the
 * button, including ones added later (the editor's, page.html). Escape, a
 * click elsewhere, or leaving the window closes it; arrow keys move in it.
 */
export const NEW_DOC_SCRIPT = `window.ergaNewDoc = function (root) {
  const menu = root.querySelector(".erga-new-menu");
  if (!menu) return;
  let btn = null;
  const items = () => [...menu.querySelectorAll("a")];
  // The app's typeface, on a page that hasn't it (the viewer, the homepage): fetched as the pointer or focus comes to a + button.
  const font = () => {
    if (document.querySelector('link[rel="stylesheet"][href="/fonts/inter.css"]')) return;
    document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/fonts/inter.css" }));
  };
  for (const type of ["pointerover", "focusin"]) root.addEventListener(type, (e) => { if (e.target.closest && e.target.closest(".erga-new-btn")) font(); });
  const show = (b) => {
    if (b) font();
    if (btn) btn.setAttribute("aria-expanded", "false");
    btn = b;
    menu.hidden = !b;
    if (!b) return;
    b.setAttribute("aria-expanded", "true");
    const r = b.getBoundingClientRect(), w = menu.offsetWidth;
    menu.style.top = r.bottom + 8 + "px";
    menu.style.left = Math.max(12, Math.min(innerWidth - w - 12, r.right - w)) + "px";
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".erga-new-btn");
    if (!b) return;
    e.preventDefault();
    if (btn == b) { show(null); return; }
    show(b);
    items()[0]?.focus({ preventScroll: true });
  });
  document.addEventListener("pointerdown", (e) => {
    if (!btn) return;
    const path = e.composedPath();
    if (!path.includes(menu) && !path.includes(btn)) show(null);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!btn) return;
    if (e.key == "Escape") { const b = btn; show(null); b.focus(); return; }
    if (e.key != "ArrowDown" && e.key != "ArrowUp") return;
    e.preventDefault();
    const all = items(), at = all.indexOf(root.activeElement);
    all[(at + (e.key == "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
  });
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) show(null); });
  addEventListener("blur", () => show(null));
  addEventListener("resize", () => show(null));
  addEventListener("hashchange", () => show(null));
};`;

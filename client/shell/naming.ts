// The document's title and address, the naming card that renames it, and the pages card with its tree.

import type { DocName } from "../../document/api";
import { files } from "../../document/content";
import { pageUrl, slugify, titleOf } from "../../document/pages";
import { live } from "../live/client";
import { runTool } from "../common/tools";
import type { mountTree, TreeHandle } from "../pages/pages-tree";
import { BASE, $, editing, type Shell } from "./shell";

/** pages-tree.ts, once imported (a chunk of its own: pages-tree.js). */
type TreeModule = { mountTree: typeof mountTree };

export function mountNaming(shell: Shell) {

  // The document's title, top left after the Documents link, and its address
  // in the address bar. Whoever renames it (anyone, any agent, or the title
  // following its first heading), every tab hears of it on its socket
  // and follows: the title changes, and the address becomes the new one
  // (replaceState: the old one still leads here). The editor itself talks to
  // the host at /d/<id> (BASE), which a rename never changes.
  const titleBtn = $("doc-title"), naming = $("naming");
  // The pages card (below: togglePages) and its tree, once opened.
  const pagesCard = $("pages");
  let tree: TreeHandle | null = null;
  const namingForm = $("naming-form") as HTMLFormElement, namingStatus = $("naming-status");
  const titleIn = $("naming-title") as HTMLInputElement, slugIn = $("naming-slug") as HTMLInputElement;
  function showName(n: DocName) {
    shell.docName = n;
    $("doc-title-text").textContent = n.title;
    titleBtn.hidden = false;
    titleBtn.setAttribute("aria-label", shell.docKind == "project" ? `${n.title}: its pages` : `${n.title}: rename`);
    titleBtn.title = `${location.host}${n.address}`;
    document.title = n.title;
    tree?.setRootTitle(n.title);
    if (n.address) tree?.setBase(n.address);
    // The editor's own address is the page's, with ?edit (without, it's the viewer, which the pencil, blue while editing, goes back to).
    if (!n.address) return;
    const at = viewHref(n.address);
    document.querySelector<HTMLMetaElement>('meta[name="erga-address"]')?.setAttribute("content", n.address);
    // At the homepage's address (/), it stays there.
    const here = location.pathname == "/" ? "/" : at;
    if (location.pathname != here) window.history.replaceState(window.history.state, "", here + location.search + location.hash);
  }
  /** The pencil, blue while editing, goes to this page in the viewer: its address (answered without the query). */
  function viewHref(address: string) {
    const view = $("btn-edit") as HTMLAnchorElement;
    const at = pageUrl(address, shell.pagePath);
    view.href = at + shell.as;
    view.hidden = false;
    return at;
  }
  if (shell.info.docName) showName(shell.info.docName);
  let slugTouched = false;
  const sayNaming = (text: string, error = false) => { namingStatus.textContent = text; namingStatus.classList.toggle("error", error); };
  const namingHint = () => sayNaming(!titleIn.value.trim() ? "Empty, the title follows the page's first heading."
    : !slugIn.value.trim() ? "Empty, the address follows the title."
    : !shell.docName?.titleSet && titleIn.value.trim() == shell.docName?.title ? "The title follows the page's first heading until you change it." : "");
  function toggleNaming(force?: boolean) {
    const open = typeof force == "boolean" ? force : naming.hidden;
    if (open && !shell.docName) return;
    naming.hidden = !open;
    titleBtn.setAttribute("aria-expanded", String(open || !pagesCard.hidden));
    if (!open) return;
    togglePages(false);
    shell.chrome.showChrome();
    shell.chrome.toggleHelp(false);
    shell.sharing.toggleSharing(false);
    shell.people.toggleAccount(false);
    shell.docSettings?.toggle(false);
    slugTouched = false;
    $("naming-prefix").textContent = `/${shell.docName!.owner}/`;
    titleIn.value = shell.docName!.title;
    slugIn.value = shell.docName!.slug;
    namingHint();
    titleIn.focus();
    titleIn.select();
  }
  // A project's title opens its pages; a document's (one page: nothing to open) its name, to rename it.
  titleBtn.addEventListener("click", () => (!naming.hidden ? toggleNaming(false) : shell.docKind == "project" ? togglePages() : toggleNaming(true)));
  /**
   * The kind as the host says it now (the hello, or a "tree" event: the settings' switch in any tab, or an agent):
   * a project's title has the caret and opens its pages, a document's has none. At once, with no reload.
   */
  function applyKind(kind: "document" | "project" | undefined) {
    if (!kind) return;
    shell.docKind = kind;
    const project = kind == "project";
    titleBtn.classList.toggle("project", project);
    titleBtn.setAttribute("aria-controls", project ? "pages" : "naming");
    if (shell.docName) titleBtn.setAttribute("aria-label", project ? `${shell.docName.title}: its pages` : `${shell.docName.title}: rename`);
    if (!project && !pagesCard.hidden) togglePages(false);
  }
  applyKind(shell.docKind);
  $("naming-cancel").addEventListener("click", () => toggleNaming(false));
  // An address that follows the title follows it here too, until it's typed in.
  titleIn.addEventListener("input", () => { if (!shell.docName!.slugSet && !slugTouched) slugIn.value = slugify(titleIn.value) || shell.docName!.slug; namingHint(); });
  slugIn.addEventListener("input", () => { slugTouched = true; namingHint(); });
  document.addEventListener("pointerdown", (e) => { if (!naming.hidden && !naming.contains(e.target as Node) && !titleBtn.contains(e.target as Node)) toggleNaming(false); });
  namingForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!shell.docName) return;
    // Only what changed: a title left as it was keeps following the heading, if it did.
    const patch: { title?: string; slug?: string } = {};
    if (titleIn.value.trim() != shell.docName.title) patch.title = titleIn.value.trim();
    if (slugTouched && slugIn.value.trim() != shell.docName.slug) patch.slug = slugIn.value.trim();
    if (!("title" in patch) && !("slug" in patch)) return toggleNaming(false);
    sayNaming("Saving…");
    const r = await runTool<DocName>("rename_document", { document: shell.docName.id, ...patch }).then(
      (name) => ({ name }),
      (err: Error) => ({ error: err.message })
    );
    if ("error" in r) return sayNaming(r.error ?? "Couldn't rename it.", true);
    showName(r.name);
    toggleNaming(false);
  });


  // The document's pages: the title opens them, as a tree (pages-tree.ts, built on
  // its own as pages-tree.js, so viewing never pays for it), the same tree as on
  // Documents and in the viewer. Its first row is index.html, whose pencil renames
  // the document (the naming card above); the rest are its folders, pages and files. Pages open in the editor; the
  // tree follows changes from other tabs and agents (a "tree" event, or a file
  // coming or going in the room) and the titles of the pages as they're edited.
  // So the title opens it at once, the editor loads the script and mounts the
  // tree, still closed, once it's up and the tab is idle (or sooner, as the
  // pointer heads for the title); and it keeps the tree's last answer for the
  // tab, as Documents does (the same key), so the next page shows it straight
  // away and reads it again behind.
  let treeScript: Promise<TreeModule> | null = null;
  const loadTree = () =>
    (treeScript ??= import("../pages/pages-tree").then(
      (m): TreeModule => m,
      () => {
        treeScript = null;
        // (A chunk that isn't there any more is a new release: the page asks the server, and reloads: live.ts.)
        live((l) => l.check("a request failed"));
        throw new Error("Couldn't load the pages: check your connection and try again.");
      }
    ));
  const keptKey = () => `erga:docs-tree:${shell.docName!.id}`;
  const kept = () => { try { return JSON.parse(sessionStorage.getItem(keptKey()) || "null") as Parameters<typeof mountTree>[1]["initial"]; } catch { return null; } };
  const keep = (a: { entries: unknown[]; canEdit: boolean; kind: string }) => { try { sessionStorage.setItem(keptKey(), JSON.stringify({ entries: a.entries, canEdit: a.canEdit, kind: a.kind })); } catch { /* private mode */ } };
  /** The tree, mounted (closed or open) once its script is in: what opening it waits for, if anything. */
  let treeReady: Promise<TreeHandle> | null = null;
  const slot = $("pages-tree");
  function prepareTree(): Promise<TreeHandle> {
    if (!shell.docName) return Promise.reject(new Error("no document"));
    return (treeReady ??= loadTree().then((t) => {
      if (tree) return tree;
      slot.replaceChildren();
      return (tree = t.mountTree(slot, {
        id: shell.docName!.id,
        base: shell.docName!.address,
        editing: true,
        query: shell.as,
        label: "Pages",
        rootTitle: shell.docName!.title,
        titleOf: pageTitle,
        current: shell.info!.path,
        hasRelativeLinks,
        initial: kept(),
        onChange: keep,
        onRenameRoot: () => toggleNaming(true),
        navigate: (url, o) => { if (o.replace || !o.path || !shell.swapPage(o.path)) shell.goTo(url, o.replace); },
      }));
    }, (e: Error) => { treeReady = null; throw e; }));
  }
  const ready = () => { prepareTree().catch(() => {}); };
  if (editing()) (window.requestIdleCallback ?? setTimeout)(ready);
  titleBtn.addEventListener("pointerenter", ready);
  titleBtn.addEventListener("focus", ready);
  titleBtn.addEventListener("pointerdown", ready);
  /** A page's title from its text, as the room has it, by the document's title rule (titleOf). */
  function pageTitle(path: string): string | null {
    const text = files(shell.collab.doc).get(path)?.toString();
    return text ? titleOf(text) : null;
  }
  /** Whether a document links to its styles, scripts or images by relative paths (a move may break those): read from the room. */
  function hasRelativeLinks(path: string): boolean | undefined {
    const text = files(shell.collab.doc).get(path)?.toString();
    if (text == null) return undefined;
    const refs = [...text.matchAll(/\b(?:src|href|poster|data)\s*=\s*["']?([^"'\s>]+)|url\(\s*["']?([^"')]+)/gi)].map((m) => m[1] ?? m[2]);
    return refs.some((r) => !/^(?:[a-z][a-z0-9+.-]*:|\/|#|\{)/i.test(r));
  }
  function togglePages(force?: boolean) {
    const open = typeof force == "boolean" ? force : pagesCard.hidden;
    // A document has one page: no pages to open.
    if (open && (!shell.docName || shell.docKind != "project")) return;
    if (open != pagesCard.hidden) return;
    pagesCard.hidden = !open;
    titleBtn.setAttribute("aria-expanded", String(open || !naming.hidden));
    if (!open) return;
    shell.chrome.showChrome();
    shell.chrome.toggleHelp(false);
    shell.sharing.toggleSharing(false);
    shell.people.toggleAccount(false);
    toggleNaming(false);
    shell.docSettings?.toggle(false);
    if (tree) { tree.refresh(); tree.focus(); return; }
    // Its script isn't in yet (the tab wasn't idle, or it failed before): a quiet line until it is.
    slot.replaceChildren(Object.assign(document.createElement("p"), { className: "naming-status", textContent: "Loading pages…" }));
    prepareTree().then((t) => { if (!pagesCard.hidden) t.focus(); }, (e: Error) => {
      slot.replaceChildren(Object.assign(document.createElement("p"), { className: "naming-status error", textContent: e.message }));
      pagesCard.hidden = true; pagesCard.hidden = false;
    });
  }
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Element;
    if (!pagesCard.hidden && !pagesCard.contains(t) && !titleBtn.contains(t) && !t.closest?.(".et-menu")) togglePages(false);
  });
  // A file coming or going in the room (another tab, an agent) reads the tree again; a page's text changing may change its title.
  let treeTimer = 0, treeStale = false;
  files(shell.collab.doc).observeDeep((events) => {
    if (!tree || pagesCard.hidden) return;
    treeStale ||= events.some((ev) => ev.target == files(shell.collab.doc) && [...ev.changes.keys.values()].some((c) => c.action != "update"));
    clearTimeout(treeTimer);
    treeTimer = window.setTimeout(() => { if (treeStale) tree?.refresh({ quiet: true }); else tree?.retitle(); treeStale = false; }, treeStale ? 150 : 600);
  });
  // ?pages opens it straight away (a link to "this document's pages"), as does following this page to where it moved
  // while it was open (goTo): it stays open across the move.
  const reopen = (() => { try { const v = sessionStorage.getItem("erga:pages-open"); sessionStorage.removeItem("erga:pages-open"); return v == BASE; } catch { return false; } })();
  if ((reopen || new URLSearchParams(location.search).has("pages")) && editing()) requestAnimationFrame(() => togglePages(true));
  pagesCard.addEventListener("keydown", (e) => { if (e.key == "Escape" && !e.defaultPrevented) { e.preventDefault(); togglePages(false); titleBtn.focus(); } });
  return { showName, viewHref, toggleNaming, togglePages, applyKind, tree: () => tree };
}

export type Naming = ReturnType<typeof mountNaming>;

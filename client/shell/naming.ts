// The document's title and address, the naming card that renames it, and the pages card with its tree.

import { treeFiles } from "./tree-files";
import type { Hello } from "../../document/api/api";
import type { DocName } from "../../document/model/names";
import { pageUrl, slugify } from "../../document/model/pages";
import { keepWrite } from "../common/offline";
import { live } from "../live/client";
import { runTool } from "../common/tools";
import type { mountTree, TreeHandle } from "../pages/pages-tree";
import { BASE, $, type Shell } from "./shell";

/** pages-tree.ts, once imported (a chunk of its own: pages-tree.js). */
type TreeModule = { mountTree: typeof mountTree };

export function mountNaming(shell: Shell) {

  // The document's title, top left after the Documents link, and its address
  // in the address bar. Whoever renames it (anyone, any agent, or the title
  // following its first heading), every tab hears of it on its socket
  // and follows: the title changes, and the address becomes the new one
  // (replaceState: the old one still leads here). The editor itself talks to
  // the host at /d/<id> (BASE), which a rename never changes.
  //
  // A title submitted here shows at once, is kept in localStorage until rename_document succeeds (surviving offline
  // reloads, cleared on sign-out in client/common/offline.ts), and flushes as soon as the socket is up.
  const titleBtn = $("doc-title"), naming = $("naming");
  // The pages card (below: togglePages) and its tree, once opened.
  const pagesCard = $("pages");
  let tree: TreeHandle | null = null;
  const namingForm = $("naming-form") as HTMLFormElement, namingStatus = $("naming-status");
  const titleIn = $("naming-title") as HTMLInputElement, slugIn = $("naming-slug") as HTMLInputElement;
  const TITLE_KEY = `erga:title:${BASE}${shell.as}`;
  type PendingTitle = { title: string; docId: string };
  let signedOut = false;
  let pending: PendingTitle | null = (() => {
    try {
      const v = JSON.parse(localStorage.getItem(TITLE_KEY) ?? "null") as PendingTitle | null;
      return v && typeof v.title == "string" && typeof v.docId == "string" ? v : null;
    } catch {
      return null;
    }
  })();
  let inflight: Promise<boolean> | null = null;
  function savePending(p: PendingTitle | null) {
    const clear = () => {
      try {
        localStorage.removeItem(TITLE_KEY);
      } catch {
        /* no storage */
      }
    };
    if (!p) {
      clear();
      return;
    }
    if (signedOut) return;
    // Write synchronously so an immediate reload before the server answers never loses the new title;
    // keepWrite still verifies this origin is not signed out and deletes it if sign-out happened elsewhere.
    try {
      localStorage.setItem(TITLE_KEY, JSON.stringify(p));
    } catch {
      /* no storage */
    }
    void keepWrite(
      async () => {},
      async () => clear()
    ).then((kept) => {
      if (!kept) clear();
    });
  }
  async function flushTitle(): Promise<boolean> {
    if (!pending) return true;
    if (!shell.socket.connected) return false;
    if (inflight) return inflight;
    const sending = pending;
    const run = shell.socket.sendTitle(sending.title).then(
      (ok) => {
        if (ok && pending === sending) {
          pending = null;
          savePending(null);
        }
        return pending === null;
      },
      () => false
    );
    inflight = run.finally(() => {
      if (inflight === run) inflight = null;
    });
    return inflight;
  }
  function showName(n: DocName) {
    if (pending) n = { ...n, title: pending.title || n.title, titleSet: !!pending.title };
    shell.docName = n;
    $("doc-title-text").textContent = n.title;
    titleBtn.hidden = false;
    titleBtn.setAttribute("aria-label", `${n.title}: its pages`);
    titleBtn.title = `${location.host}${n.address}`;
    // The tab's title is the page's own, if it has one (client/viewer/nav.ts); else the document's.
    document.querySelector<HTMLMetaElement>('meta[name="erga-title"]')?.setAttribute("content", n.title);
    document.title = document.documentElement.dataset.pageTitle || n.title;
    tree?.setRootTitle(n.title);
    if (n.address) tree?.setBase(n.address);
    // The editor's own address is the page's, with ?edit (without, it's the viewer, which the pencil, blue while editing, goes back to).
    if (!n.address) return;
    const at = viewHref(n.address);
    document.querySelector<HTMLMetaElement>('meta[name="erga-address"]')?.setAttribute("content", n.address);
    if (location.pathname != at) window.history.replaceState(window.history.state, "", at + location.search + location.hash);
  }
  /** This page's address in the viewer (without the query): the pencil goes there, or to its editor while viewing (client/viewer/edit-boot.ts). */
  function viewHref(address: string) {
    const at = pageUrl(address, shell.pagePath);
    $("btn-edit").setAttribute("href", ergaWithEdit(at, !document.body.classList.contains("erga-editing")));
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
    shell.chrome.cardOpened("naming");
    slugTouched = false;
    // The address as the server gives it, its slug in the field; the default homepage's (/_home) has no slug to change.
    const n = shell.docName!,
      free = n.address.endsWith(`/${n.slug}`);
    $("naming-prefix").textContent = free ? n.address.slice(0, -n.slug.length) : n.address;
    slugIn.hidden = !free;
    titleIn.value = shell.docName!.title;
    slugIn.value = shell.docName!.slug;
    namingHint();
    titleIn.focus();
    titleIn.select();
  }
  // The title always opens the document's files (unless the rename card is open, which it closes).
  titleBtn.addEventListener("click", () => (!naming.hidden ? toggleNaming(false) : togglePages()));
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
    // The new title goes in the room, as an edit: it shows at once (an empty one follows the page's heading: the server
    // says which), and the card closes. The address is the server's to give: it follows with its answer.
    const was = shell.docName,
      typed = { title: titleIn.value, slug: slugIn.value, slugTouched };
    if ("title" in patch) {
      pending = { title: patch.title!, docId: was.id };
      savePending(pending);
      showName(was);
      shell.unsaved.edit();
      void flushTitle();
    }
    toggleNaming(false);
    if (!("slug" in patch)) return;
    const r = await runTool<DocName>("rename_document", { document: was.id, slug: patch.slug }).then(
      (name) => ({ name }),
      (err: Error) => ({ error: err.message })
    );
    if ("name" in r) return showName(r.name);
    // Refused: the card says why, with what was typed.
    toggleNaming(true);
    titleIn.value = typed.title;
    slugIn.value = typed.slug;
    slugTouched = typed.slugTouched;
    sayNaming(r.error ?? "Couldn't rename it.", true);
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
  const kept = () => {
    try {
      return JSON.parse(sessionStorage.getItem(keptKey()) || "null") as Parameters<typeof mountTree>[1]["initial"];
    } catch {
      return null;
    }
  };
  const keep = (a: { entries: unknown[]; canEdit: boolean }) => {
    try {
      sessionStorage.setItem(keptKey(), JSON.stringify({ entries: a.entries, canEdit: a.canEdit }));
    } catch {
      /* private mode */
    }
  };
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
        current: shell.pagePath,
        hasRelativeLinks,
        initial: kept(),
        onChange: (a) => {
          keep(a);
          shell.treeEntries = a.entries as Hello["tree"]["entries"];
        },
        onRenameRoot: () => toggleNaming(true),
        files: treeFiles(shell, () => tree),
        navigate: (url, o) => { if (o.replace || !o.path || !shell.swapPage(o.path)) shell.goTo(url, o.replace); },
      }));
      },
      (e: Error) => {
        treeReady = null;
        throw e;
      }
    ));
  }
  // Made once the editor is idle; read again behind as the pointer or focus comes to the title.
  let readAt = Date.now();
  const ready = () => {
    if (tree && Date.now() - readAt > 2000 && pagesCard.hidden) {
      readAt = Date.now();
      tree.refresh({ quiet: true });
    }
    prepareTree().catch(() => {});
  };
  if (shell.editor.state.editing) (window.requestIdleCallback ?? setTimeout)(ready);
  titleBtn.addEventListener("pointerenter", ready);
  titleBtn.addEventListener("focus", ready);
  titleBtn.addEventListener("pointerdown", ready);
  /** A page's title from the last tree snapshot. */
  function pageTitle(path: string): string | null {
    return shell.treeEntries.find((e) => e.path == path)?.title ?? null;
  }
  /** Whether a document links to its styles, scripts or images by relative paths (a move may break those), from tree entries. */
  function hasRelativeLinks(path: string): boolean | undefined {
    return shell.treeEntries.find((e) => e.path == path)?.relative;
  }
  function togglePages(force?: boolean) {
    const open = typeof force == "boolean" ? force : pagesCard.hidden;
    if (open && !shell.docName) return;
    if (open != pagesCard.hidden) return;
    pagesCard.hidden = !open;
    titleBtn.setAttribute("aria-expanded", String(open || !naming.hidden));
    if (!open) {
      tree?.closeMenu();
      return;
    }
    shell.chrome.cardOpened("pages");
    // The tree was made, and read, once the editor was idle (ready): it shows at once, and is read again behind.
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
  // ?pages opens it straight away (a link to "this document's pages"), as does following this page to where it moved
  // while it was open (goTo): it stays open across the move.
  const reopen = (() => { try { const v = sessionStorage.getItem("erga:pages-open"); sessionStorage.removeItem("erga:pages-open"); return v == BASE; } catch { return false; } })();
  if ((reopen || new URLSearchParams(location.search).has("pages")) && shell.editor.state.editing)
    requestAnimationFrame(() => togglePages(true));
  pagesCard.addEventListener("keydown", (e) => { if (e.key == "Escape" && !e.defaultPrevented) { e.preventDefault(); togglePages(false); titleBtn.focus(); } });
  return {
    showName,
    viewHref,
    toggleNaming,
    togglePages,
    flushTitle,
    hasPending: () => !!pending,
    signedOut: () => {
      signedOut = true;
    },
    tree: () => tree,
  };
}

export type Naming = ReturnType<typeof mountNaming>;

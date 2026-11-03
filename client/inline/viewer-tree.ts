// A project's tree in the viewer (server/pages/viewer.ts): its crumb (viewCrumbs) opens the card below it with the
// same tree as the editor's crumb and Documents show (client/pages/pages-tree.ts, loaded as pages-tree.js once the page
// is idle, and read then, so a click opens it whole on the next frame). Pages open in the viewer, files as themselves in a new
// tab. A click outside, or Escape, closes it. The tree's last answer is kept for the tab (the key Documents and the
// editor use), so it shows at once and is read again behind.

import type { mountTree, TreeHandle } from "../pages/pages-tree";

type Initial = Parameters<typeof mountTree>[1]["initial"];

export default function viewerTree(script: string, id: string, base: string, title: string, query: string): void {
  const button = document.querySelector<HTMLButtonElement>(".erga-tree-btn");
  const card = document.getElementById("erga-tree");
  if (!button || !card) return;
  const key = "erga:docs-tree:" + id;
  let tree: TreeHandle | null = null;
  // The tree's script, and its answer kept for the tab (key): both read once the page is idle, the answer again
  // behind as the pointer or focus comes to the crumb. A click mounts the tree from them, whole, in its own task.
  let scriptIn = false;
  let loading: Promise<void> | null = null;
  const load = () =>
    (loading ??= import(script).then(
      () => {
        scriptIn = true;
      },
      () => {
        loading = null;
        throw new Error("Couldn't load the pages: check your connection and try again.");
      }
    ));
  let readAt = 0;
  const read = () => {
    if (tree || Date.now() - readAt < 2000) return;
    readAt = Date.now();
    fetch("/api/tools/ls" + query, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: id }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const a = b?.result;
        if (a?.entries) sessionStorage.setItem(key, JSON.stringify({ entries: a.entries, canEdit: !!a.canEdit, kind: a.kind }));
      })
      .catch(() => {
        readAt = 0;
      });
  };
  function mount() {
    const t = window.ergaTree!;
    let initial: Initial = null;
    try {
      initial = JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {}
    card!.replaceChildren();
    tree = t.mountTree(card!, {
      id,
      base,
      editing: false,
      query,
      rootTitle: title,
      label: "Pages of " + title,
      initial,
      onChange: (a) => {
        try {
          sessionStorage.setItem(key, JSON.stringify({ entries: a.entries, canEdit: a.canEdit, kind: a.kind }));
        } catch {}
        tree?.setCurrent(t.pageAt(a.entries, base, window.ergaPageAddress()));
      },
    });
    return tree;
  }
  function toggle(open: boolean) {
    if (open == !card!.hidden) return;
    card!.hidden = !open;
    button!.setAttribute("aria-expanded", String(open));
    if (!open) return;
    if (tree) {
      tree.refresh();
      tree.focus();
      return;
    }
    if (scriptIn) {
      mount().focus();
      return;
    }
    card!.replaceChildren(Object.assign(document.createElement("p"), { className: "erga-tree-wait", textContent: "Loading pages…" }));
    load().then(
      () => {
        if (!card!.hidden) mount().focus();
      },
      (e: Error) =>
        card!.replaceChildren(Object.assign(document.createElement("p"), { className: "erga-tree-wait", textContent: e.message }))
    );
  }
  (window.requestIdleCallback ?? setTimeout)(() => {
    load().catch(() => {});
    read();
  });
  for (const type of ["pointerenter", "focus"])
    button.addEventListener(type, () => {
      load().catch(() => {});
      read();
    });
  button.addEventListener("click", () => toggle(card.hidden !== false));
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Element;
    if (!card.hidden && !card.contains(t) && !button.contains(t) && !t.closest?.(".et-menu")) toggle(false);
  });
  // A click in the page's frame never reaches this document: the window losing the focus to it says so.
  addEventListener("blur", () =>
    setTimeout(() => {
      if (document.activeElement?.id == "frame") toggle(false);
    })
  );
  card.addEventListener("keydown", (e) => {
    if (e.key == "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      toggle(false);
      button.focus();
    }
  });
}

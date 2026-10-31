// A project's tree in the viewer (server/pages/viewer.ts): its crumb (viewCrumbs) opens the card below it with the
// same tree as the editor's crumb and Documents show (client/pages/pages-tree.ts, loaded as pages-tree.js on the first
// hover or click, so a reader who never opens it pays nothing). Pages open in the viewer, files as themselves in a new
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
  let loading: Promise<void> | null = null;
  const load = () =>
    (loading ??= import(script).then(
      () => {
        const t = window.ergaTree!;
        let initial: Initial = null;
        try {
          initial = JSON.parse(sessionStorage.getItem(key) || "null");
        } catch {}
        card.replaceChildren();
        tree = t.mountTree(card, {
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
      },
      () => {
        loading = null;
        throw new Error("Couldn't load the pages: check your connection and try again.");
      }
    ));
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
    card!.replaceChildren(Object.assign(document.createElement("p"), { className: "erga-tree-wait", textContent: "Loading pages…" }));
    load().then(
      () => tree?.focus(),
      (e: Error) =>
        card!.replaceChildren(Object.assign(document.createElement("p"), { className: "erga-tree-wait", textContent: e.message }))
    );
  }
  button.addEventListener("pointerenter", () => load().catch(() => {}));
  button.addEventListener("focus", () => load().catch(() => {}));
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

// Files dragged from the computer onto the editor's file tree (client/pages/pages-tree.ts calls these): while they are
// over a folder, the folder's row lights and a label beside it says what a drop does ("Add 2 files to images/"). Dropped,
// they go into that folder of the document's files, each under its own name (the uploads' owner sends them:
// uploads.ts); no page changes. Each file has its row in the tree at once, pale, with how far it is, until its bytes
// are there. A file on its way from anywhere else (a drop on the page, an agent) has its row the same way.

import { droppedFiles } from "../common/dropped";
import type { TreeHandle, TreeOptions } from "../pages/pages-tree";
import type { Shell } from "./shell";

const FOLDER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>`;

/** What the tree needs for files (TreeOptions.files); `tree`: the tree, once it is mounted. */
export function treeFiles(shell: Shell, tree: () => TreeHandle | null): NonNullable<TreeOptions["files"]> {
  let chip: HTMLElement | null = null,
    hide = 0;
  /** The label beside the row, while the drag is over it (a dragover comes every few ms: with none, the drag left). */
  function say(row: Element | null, count: number, dir: string) {
    if (!chip) {
      chip = document.createElement("div");
      chip.className = "drop-chip";
      document.body.append(chip);
    }
    const what = `Add ${count} file${count == 1 ? "" : "s"}`,
      where = dir ? `to ${dir}/` : "to the top folder";
    if (chip.dataset.says != what + where) {
      chip.dataset.says = what + where;
      chip.innerHTML = FOLDER;
      chip.append(what, Object.assign(document.createElement("span"), { textContent: where }));
    }
    const r = row?.getBoundingClientRect();
    chip.hidden = !r;
    if (r) chip.style.cssText = `left:${r.right + 14}px;top:${r.top + r.height / 2 - 12}px`;
    window.clearTimeout(hide);
    hide = window.setTimeout(() => chip && (chip.hidden = true), 300);
  }

  // The uploads changed: a new file, or one that is over, is a new tree; else only the numbers on the rows.
  let known = "";
  window.addEventListener("erga-uploads", () => {
    const pending = shell.uploads.pending(),
      paths = Object.keys(pending).sort().join("\n");
    if (paths != known) {
      known = paths;
      void tree()?.refresh({ quiet: true });
      return;
    }
    for (const row of tree()?.element.querySelectorAll<HTMLElement>(".et-row.pending") ?? []) paint(row, pending[row.dataset.path!] ?? 0);
  });
  const paint = (row: HTMLElement, p: number) => {
    row.style.setProperty("--p", String(p));
    row.querySelector(".et-pct")!.textContent = `${Math.round(p * 100)}%`;
  };

  return {
    over(dir, row, e) {
      e.dataTransfer!.dropEffect = "copy";
      say(row, [...e.dataTransfer!.items].filter((i) => i.kind == "file").length || 1, dir);
    },
    drop(dir, e) {
      if (chip) chip.hidden = true;
      const { plain, all } = droppedFiles(e.dataTransfer);
      void (all ?? Promise.resolve(plain)).then((files) => shell.uploads.addIn(dir, files));
    },
    with(list) {
      const have = new Set(list.map((e) => e.path));
      return [
        ...list,
        ...Object.keys(shell.uploads.pending())
          .filter((p) => !have.has(p))
          .map((path) => ({ path, type: "file" as const })),
      ];
    },
    mark(row, path) {
      const p = shell.uploads.pending()[path];
      if (p == null) return;
      row.classList.add("pending");
      row.draggable = false;
      row.append(
        Object.assign(document.createElement("span"), { className: "et-pct" }),
        Object.assign(document.createElement("i"), { className: "et-track" })
      );
      paint(row, p);
    },
  };
}

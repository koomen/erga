// The quick search: ⌘K (Ctrl+K off a Mac) on every page of the site for someone signed in, the editor's too, and from inside a
// document's frame (it says so: client/inline/reader.ts, the editor's bridge). A pane to find a document you may open
// (list_documents) or a page of Erga itself you may use (site_pages: the admin sections only for an admin), by typing
// part of its name; ↑ ↓ choose, Enter opens (⌘Enter in a new tab), Esc closes. One pane per page: the first script to
// install it owns window.ergaQuickSearch, and the editor's shell calls that.

import { esc } from "../../shared/html";
import { runTool } from "./tools";

interface Found {
  group: string;
  label: string;
  path: string;
  hint?: string;
}

declare global {
  interface Window {
    /** Opens the quick search (client/common/quick-search.ts). */
    ergaQuickSearch?: () => void;
  }
}

const CSS = `
.erga-qs { --qs-bg: #fff; --qs-fg: #1c1c1f; --qs-soft: #6b6b73; --qs-ring: #e6e6ea; --qs-pick: rgba(59, 124, 240, .1);
  position: fixed; inset: 0; z-index: 2147483647; display: flex; justify-content: center; align-items: flex-start; padding: 14vh 16px 16px;
  background: rgba(0, 0, 0, .18); font: 400 14px/1.4 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { .erga-qs { --qs-bg: #1f1f23; --qs-fg: #ececf1; --qs-soft: #8f8f99; --qs-ring: #2f2f35; --qs-pick: rgba(59, 124, 240, .22); background: rgba(0, 0, 0, .4); } }
.erga-qs[hidden] { display: none; }
.erga-qs-card { width: min(560px, 100%); max-height: 70vh; display: flex; flex-direction: column; overflow: hidden; color: var(--qs-fg); background: var(--qs-bg);
  border: 1px solid var(--qs-ring); border-radius: 14px; box-shadow: 0 18px 50px rgba(0, 0, 0, .18), 0 1px 2px rgba(0, 0, 0, .06); }
.erga-qs-input { margin: 0; padding: 14px 16px; border: 0; border-bottom: 1px solid var(--qs-ring); outline: none; background: transparent; color: inherit; font: inherit; font-size: 15px; }
.erga-qs-input::placeholder { color: var(--qs-soft); }
.erga-qs-list { margin: 0; padding: 6px; overflow-y: auto; list-style: none; }
.erga-qs-group { padding: 8px 10px 4px; color: var(--qs-soft); font-size: 12px; }
.erga-qs-item { display: flex; align-items: baseline; gap: 10px; padding: 7px 10px; border-radius: 8px; cursor: pointer; }
.erga-qs-item[aria-selected="true"] { background: var(--qs-pick); }
.erga-qs-item b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.erga-qs-item span { margin-left: auto; color: var(--qs-soft); font-size: 12px; white-space: nowrap; }
.erga-qs-empty { padding: 12px 10px; color: var(--qs-soft); }`;

/** The entries whose label and hint (an address) hold every word of `query`, those whose label starts with it first; all of them for an empty one. */
export function match(all: Found[], query: string): Found[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return all;
  const hits = all.filter((f) => words.every((w) => `${f.label} ${f.hint ?? ""}`.toLowerCase().includes(w)));
  const starts = (f: Found) => (f.label.toLowerCase().startsWith(words[0]) ? 0 : 1);
  return hits
    .map((f, i) => ({ f, i }))
    .sort((a, b) => starts(a.f) - starts(b.f) || a.i - b.i)
    .map((x) => x.f);
}

/** ⌘K on this page, and the document frame's message for it (`fromFrame`: whether a message came from the frame). */
export function installQuickSearch(fromFrame: (e: MessageEvent) => boolean = () => false): void {
  if (window.ergaQuickSearch) return;
  let root: HTMLElement | null = null;
  let entries: Promise<Found[]> | null = null;
  let shown: Found[] = [];
  let at = 0;
  // In local development the page's ?user= says who is signed in: the pages it opens keep it.
  const user = new URLSearchParams(location.search).get("user");
  // "#settings" opens the Settings dialog on this page (client/agent/settings-dialog.ts): it keeps the page's address.
  const href = (path: string) =>
    path.startsWith("#") || !user ? path : `${path}${path.includes("?") ? "&" : "?"}user=${encodeURIComponent(user)}`;

  const load = () =>
    (entries ??= Promise.all([
      runTool<{ title: string; address: string }[]>("list_documents").catch(() => []),
      runTool<{ group: string; label: string; path: string }[]>("site_pages").catch(() => []),
    ]).then(([docs, pages]) => [
      ...docs.map((d) => ({ group: "Documents", label: d.title || d.address, path: d.address, hint: d.address })),
      ...pages.map((p) => ({ ...p, hint: p.path })),
    ]));

  function build(): HTMLElement {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    const el = document.createElement("div");
    el.className = "erga-qs";
    el.hidden = true;
    el.innerHTML =
      '<div class="erga-qs-card" role="dialog" aria-label="Quick search">' +
      '<input class="erga-qs-input" type="text" placeholder="Go to a document or page…" aria-label="Go to a document or page" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="erga-qs-list">' +
      '<ul class="erga-qs-list" id="erga-qs-list" role="listbox"></ul></div>';
    document.body.append(el);
    const input = el.querySelector("input")!;
    input.addEventListener("input", () => void render(input.value));
    el.addEventListener("keydown", (e) => {
      // The pane's keys are its own: not the editor's, nor the page's.
      e.stopPropagation();
      if (e.key == "Escape") return close();
      if (e.key == "ArrowDown" || e.key == "ArrowUp") {
        e.preventDefault();
        if (shown.length) pick((at + (e.key == "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
      } else if (e.key == "Enter" && shown[at]) {
        e.preventDefault();
        go(shown[at], e.metaKey || e.ctrlKey);
      }
    });
    el.addEventListener("pointerdown", (e) => {
      const item = (e.target as Element).closest<HTMLElement>(".erga-qs-item");
      if (item) {
        e.preventDefault();
        go(shown[Number(item.dataset.i)], e.metaKey || e.ctrlKey);
      } else if (!(e.target as Element).closest(".erga-qs-card")) close();
    });
    return el;
  }

  async function render(query: string) {
    const list = root!.querySelector("ul")!;
    const all = await load();
    if (root!.querySelector("input")!.value != query) return;
    shown = match(all, query).slice(0, 30);
    at = 0;
    let html = "",
      group = "";
    shown.forEach((f, i) => {
      if (f.group != group) html += `<li class="erga-qs-group" role="presentation">${esc((group = f.group))}</li>`;
      html += `<li class="erga-qs-item" role="option" id="erga-qs-${i}" data-i="${i}" aria-selected="${i == 0}"><b>${esc(f.label)}</b>${f.hint ? `<span>${esc(f.hint)}</span>` : ""}</li>`;
    });
    list.innerHTML = html || '<li class="erga-qs-empty">Nothing found.</li>';
    if (shown.length) pick(0);
  }

  function pick(i: number) {
    root!.querySelector(`#erga-qs-${at}`)?.setAttribute("aria-selected", "false");
    at = i;
    const item = root!.querySelector(`#erga-qs-${at}`)!;
    item.setAttribute("aria-selected", "true");
    item.scrollIntoView({ block: "nearest" });
    root!.querySelector("input")!.setAttribute("aria-activedescendant", item.id);
  }

  function go(f: Found, tab: boolean) {
    close();
    if (tab) window.open(href(f.path), "_blank", "noopener");
    else location.href = href(f.path);
  }

  function close() {
    if (root) root.hidden = true;
  }

  function open() {
    root ??= build();
    const input = root.querySelector("input")!;
    if (root.hidden) {
      root.hidden = false;
      input.value = "";
      void render("");
    }
    input.focus();
    // From a key in the document's frame, the focus goes back there as that key ends: take it after.
    setTimeout(() => input.focus());
  }

  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  window.ergaQuickSearch = open;
  addEventListener(
    "keydown",
    (e) => {
      // On a Mac, Ctrl+K stays the editor's (it deletes to the end of the line).
      if ((mac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() == "k") {
        e.preventDefault();
        e.stopPropagation();
        open();
      }
    },
    true
  );
  addEventListener("message", (e) => {
    if (e.data?.type == "erga-quick-search" && fromFrame(e)) open();
  });
}


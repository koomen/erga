// The quick search: ⌘K (Ctrl+K off a Mac) on every page of the site for someone signed in, the editor's too, and from inside a
// document's frame (it says so: client/inline/reader.ts, the editor's bridge). A pane to find a page of the project you're
// in (ls), a document you may open (list_documents: a scratch document isn't on it) or a page of Erga itself you may use
// (whoami's pages: the admin sections only for an admin), by typing part of its name; ↑ ↓ choose, Enter opens (⌘Enter in
// a new tab), Esc closes. One pane per page: the first script to install it owns window.ergaQuickSearch, and the editor's
// shell calls that. The account menus' "Go to…" opens it too (quickLink), with the key beside it.
// It opens at once: with the lists it read last (this browser keeps them: KEPT), read again behind each time it opens,
// and filtered here. Before anything is typed it shows where to go from here (start): a few of the open project's
// pages, the documents opened last, and Erga's pages. Its list is never empty under the line: it has no line then.

import { readable } from "../../document/model/pages";
import { esc } from "../../shared/html";
import { isMac } from "./app-keys";
import { asUser, runTool, WHOLE_LIST } from "./tools";

interface Found {
  group: string;
  label: string;
  path: string;
  hint?: string;
  /** A document's id. */
  id?: string;
}

/** What the pane finds in: the open project's pages, the person's documents (the last edited first) and Erga's pages. */
interface Lists {
  own: Found[];
  docs: Found[];
  site: Found[];
}

/**
 * This browser's record of the pane (localStorage): the lists as it read them last (`of`: the document whose pages `own`
 * has), so that it opens with them on the next page too; and the documents opened here (their ids, the last one first).
 * The sign-out page deletes it (client/inline/sign-out.ts).
 */
export const KEPT = "erga:quick-search:v1";
type Kept = Partial<Lists> & { of?: string; visits?: string[] };
/** As whoever this tab is: local development's ?user= has a record of its own. */
const keptKey = () => asUser(KEPT);
const kept = (): Kept => {
  try {
    return JSON.parse(localStorage.getItem(keptKey()) ?? "{}") as Kept;
  } catch {
    return {};
  }
};
const keep = (more: Kept) => {
  try {
    localStorage.setItem(keptKey(), JSON.stringify({ ...kept(), ...more }));
  } catch {
    /* no storage: the pane reads its lists each time */
  }
};
/** How many of the project's pages, and how many documents, the pane starts with. */
const FEW = 5;

declare global {
  interface Window {
    /** Opens the quick search (client/common/quick-search.ts). */
    ergaQuickSearch?: () => void;
  }
}

const CSS = `
.erga-qs { --qs-bg: #fff; --qs-fg: #1c1c1f; --qs-soft: #6b6b73; --qs-ring: #e6e6ea; --qs-pick: rgba(59, 124, 240, .1);
  position: fixed; inset: 0; z-index: 2147483647; display: flex; justify-content: center; align-items: flex-start; padding: 14vh 16px 16px;
  background: rgba(0, 0, 0, .18); font: 400 14px/1.4 "Erga Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { .erga-qs { --qs-bg: #1f1f23; --qs-fg: #ececf1; --qs-soft: #8f8f99; --qs-ring: #2f2f35; --qs-pick: rgba(59, 124, 240, .22); background: rgba(0, 0, 0, .4); } }
.erga-qs[hidden] { display: none; }
.erga-qs-card { width: min(560px, 100%); max-height: 70vh; display: flex; flex-direction: column; overflow: hidden; color: var(--qs-fg); background: var(--qs-bg);
  border: 1px solid var(--qs-ring); border-radius: 14px; box-shadow: 0 18px 50px rgba(0, 0, 0, .18), 0 1px 2px rgba(0, 0, 0, .06); }
.erga-qs-input { margin: 0; padding: 14px 16px; border: 0; outline: none; background: transparent; color: inherit; font: inherit; font-size: 15px; }
.erga-qs-input::placeholder { color: var(--qs-soft); }
.erga-qs-list { margin: 0; padding: 6px; border-top: 1px solid var(--qs-ring); overflow-y: auto; list-style: none; }
.erga-qs-list:empty { display: none; }
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

/**
 * What the pane shows before anything is typed: the first few of the open project's pages; the documents opened last in
 * this browser (`visits`), then those edited last, but never the open one (`here`); and Erga's pages.
 */
export function start(all: Lists, visits: string[], here?: string): Found[] {
  const rank = (d: Found) => visits.indexOf(d.id!) + 1 || visits.length + 1;
  const recent = all.docs.filter((d) => d.id != here).sort((a, b) => rank(a) - rank(b));
  return [...all.own.slice(0, FEW), ...recent.slice(0, FEW).map((d) => ({ ...d, group: "Recent documents" })), ...all.site];
}

/** An account menu's "Go to…" (`a`, with a <kbd> for the key): it shows this system's key, and a click opens the pane after `close` closes the menu. */
export function quickLink(a: HTMLElement | null | undefined, close: () => void): void {
  if (!a) return;
  const kbd = a.querySelector("kbd");
  if (kbd) kbd.textContent = isMac ? "⌘K" : "Ctrl K";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    close();
    window.ergaQuickSearch?.();
  });
}

/** ⌘K on this page, and the document frame's message for it (`fromFrame`: whether a message came from the frame). */
export function installQuickSearch(fromFrame: (e: MessageEvent) => boolean = () => false): void {
  if (window.ergaQuickSearch) return;
  let root: HTMLElement | null = null;
  // The lists as they were read last (shown at once), and the read under way.
  let entries: Lists | null = null;
  let reading: Promise<void> | null = null;
  let shown: Found[] = [];
  let at = 0;
  // The documents opened in this browser, as the pane opened.
  let visits: string[] = [];
  // What had the focus as the pane opened (the document's frame, a button): it gets the focus back as the pane closes.
  let before: Element | null = null;
  // The pages it opens keep local development's ?user=. "#settings" and "#shortcuts" open a dialog on this page
  // (client/agent/person-agent.ts, DIALOGS): it keeps the page's address.
  const href = (path: string) => (path.startsWith("#") ? path : asUser(path));

  // On a document's page: the document (its project's pages come first).
  const doc = document.querySelector<HTMLMetaElement>('meta[name="erga-doc"]')?.content;
  if (doc) keep({ visits: [doc, ...(kept().visits ?? []).filter((v) => v != doc)].slice(0, FEW + 1) });
  type Ls = { title?: string; index?: string; entries?: { type: string; path: string; title?: string; address?: string }[] };
  const read = () =>
    (reading ??= Promise.all([
      doc ? runTool<Ls>("ls", { document: doc }).catch(() => null) : null,
      runTool<{ documents: { id: string; title: string; address: string }[] }>("list_documents", WHOLE_LIST).then(
        (l) => l.documents,
        () => null
      ),
      runTool<{ pages?: { group: string; label: string; path: string }[] }>("whoami").then(
        (w) => w.pages ?? [],
        () => null
      ),
    ]).then(([ls, docs, pages]) => {
      reading = null;
      // A list it could not read (the network is gone, or the page is going: Enter, before the answer) stays as it was.
      const was = entries;
      // The open document's pages, when it has more than one: its own page first, then as its tree has them.
      const own = (ls?.entries ?? []).filter((e) => e.type == "page" && e.address);
      entries = {
        own:
          doc && !ls
            ? (was?.own ?? [])
            : (own.length > 1 ? own : [])
                .sort((a, b) => Number(b.path == ls!.index) - Number(a.path == ls!.index))
                .map((e) => ({ group: `Pages of ${ls!.title}`, label: e.title || readable(e.path), path: e.address!, hint: e.address })),
        docs:
          docs?.map((d) => ({ group: "Documents", label: d.title || d.address, path: d.address, hint: d.address, id: d.id })) ??
          was?.docs ??
          [],
        site: pages?.map((p) => ({ ...p, hint: p.path })) ?? was?.site ?? [],
      };
      if (docs && pages && (ls || !doc)) keep({ ...entries, of: doc });
      if (root && !root.hidden) void render(root.querySelector("input")!.value, true);
    }));
  const load = async () => entries ?? (await read(), entries!);

  function build(): HTMLElement {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    const el = document.createElement("div");
    el.className = "erga-qs";
    el.hidden = true;
    el.innerHTML =
      '<div class="erga-qs-card" role="dialog" aria-label="Quick search">' +
      '<input class="erga-qs-input" type="text" placeholder="Go to a document or page…" aria-label="Go to a document or page" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore spellcheck="false" role="combobox" aria-expanded="true" aria-controls="erga-qs-list">' +
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

  /** `keep`: the list was read again: the row chosen stays chosen, if it's still there. */
  async function render(query: string, keep = false) {
    const list = root!.querySelector("ul")!;
    const all = await load();
    if (root!.querySelector("input")!.value != query) return;
    const was = keep ? shown[at]?.path : undefined;
    shown = (query.trim() ? match([...all.own, ...all.docs, ...all.site], query) : start(all, visits, doc)).slice(0, 30);
    at = Math.max(0, was ? shown.findIndex((f) => f.path == was) : 0);
    let html = "",
      group = "";
    shown.forEach((f, i) => {
      if (f.group != group) html += `<li class="erga-qs-group" role="presentation">${esc((group = f.group))}</li>`;
      html += `<li class="erga-qs-item" role="option" id="erga-qs-${i}" data-i="${i}" aria-selected="${i == at}"><b>${esc(f.label)}</b>${f.hint ? `<span>${esc(f.hint)}</span>` : ""}</li>`;
    });
    list.innerHTML = html || '<li class="erga-qs-empty">Nothing found.</li>';
    if (shown.length) pick(at);
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
    if (!root || root.hidden) return;
    root.hidden = true;
    (before as HTMLElement | null)?.focus();
  }

  function open() {
    root ??= build();
    const input = root.querySelector("input")!;
    if (root.hidden) {
      before = document.activeElement;
      root.hidden = false;
      input.value = "";
      // This browser's record, as it is now: another tab, or this one before it came back, may have changed it.
      const { own, of, docs, site, visits: last = [] } = kept();
      visits = last;
      if (docs && site) entries ??= { own: (of == doc && own) || [], docs, site };
      void render("");
      // (The first time, render's own read is this one.)
      if (entries) void read();
    }
    input.focus();
    // From a key in the document's frame, the focus goes back there as that key ends: take it after.
    setTimeout(() => input.focus());
  }

  window.ergaQuickSearch = open;
  // (window's own: the unit tests check this file with Bun's types too, where the bare global takes a plain Event.)
  window.addEventListener(
    "keydown",
    (e) => {
      // On a Mac, Ctrl+K stays the editor's (it deletes to the end of the line).
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() == "k") {
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

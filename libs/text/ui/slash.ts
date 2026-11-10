// The "/" menu: "/" typed at the start of an empty paragraph opens a small menu of blocks at the caret (a heading, a
// list, a to-do, a quote, a code block, a table, an image, a divider). The letters typed after the "/" filter it, the
// arrow keys and Enter (or a click) choose, and Esc closes it: the "/" stays as text, and the menu stays closed until
// the paragraph is no longer a "/" and letters alone. The editor says what the paragraph holds (EditorMarkdown.slashText)
// and makes the block (slashBlock); this draws the menu, in a shadow root of its own on the page, in the controls' look.
// Each item shows its Markdown at the right, for the next time.

import { KEPT, LOOK } from "./controls";

export type SlashKind = "heading" | "list" | "todo" | "quote" | "code" | "table" | "image" | "divider";

export const SLASH_ITEMS: readonly { kind: SlashKind; label: string; hint: string }[] = [
  { kind: "heading", label: "Heading", hint: "##" },
  { kind: "list", label: "List", hint: "-" },
  { kind: "todo", label: "To-do", hint: "[ ]" },
  { kind: "quote", label: "Quote", hint: ">" },
  { kind: "code", label: "Code", hint: "```" },
  { kind: "table", label: "Table", hint: "3 × 3" },
  { kind: "image", label: "Image", hint: "file" },
  { kind: "divider", label: "Divider", hint: "---" },
];

/** The items whose name starts with the letters typed after the "/". */
export const slashItems = (filter: string) =>
  SLASH_ITEMS.filter((i) => i.label.toLowerCase().replace("-", "").startsWith(filter.toLowerCase().replace("-", "")));

const STYLE = `
:host { all: initial; }
${LOOK}
[hidden] { display: none !important; }
ul { position: fixed; z-index: 2147483646; list-style: none; margin: 0; padding: 4px; width: 190px; box-sizing: border-box; background: var(--bg);
  border: 1px solid var(--panel-border); border-radius: 10px; box-shadow: var(--shadow); font: 13px/1.3 var(--font); color: var(--fg); }
li { display: flex; justify-content: space-between; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; }
li.on { background: color-mix(in srgb, var(--chrome) 18%, transparent); }
li span { color: var(--soft); font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

/** The menu on the page in `win`. `choose`: the item chosen. `zoom`: the level the viewer draws the page at. */
export function mountSlash(win: Window, o: { zoom: () => number; choose: (kind: SlashKind) => void }) {
  const doc = win.document;
  const host = doc.createElement("erga-slash");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}</style><div class="c" id="c"><ul id="menu" role="listbox" aria-label="Insert a block" hidden></ul></div>`;
  doc.documentElement.append(host);
  for (const type of KEPT) root.addEventListener(type, (e) => e.stopPropagation());
  const box = root.getElementById("c")!,
    menu = root.getElementById("menu")!;
  /** What shows: the items, and which is chosen; null while closed. `dismissed`: Esc closed it for this "/". */
  let shown: { items: typeof SLASH_ITEMS; at: number } | null = null,
    dismissed = false;

  function draw() {
    menu.hidden = !shown;
    if (!shown) return;
    menu.replaceChildren(
      ...shown.items.map((item, i) => {
        const li = doc.createElement("li");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i == shown!.at));
        li.dataset.kind = item.kind;
        li.classList.toggle("on", i == shown!.at);
        li.append(item.label, Object.assign(doc.createElement("span"), { textContent: item.hint }));
        return li;
      })
    );
    // Under the caret, or above it where there is no room below.
    const z = o.zoom();
    host.style.zoom = String(1 / z);
    const sel = doc.getSelection();
    const r = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    if (!r) return;
    const height = menu.offsetHeight,
      below = r.bottom * z + 6;
    menu.style.left = Math.max(8, Math.min(win.innerWidth * z - 198, r.left * z)) + "px";
    menu.style.top = (below + height > win.innerHeight * z - 8 && r.top * z - height - 6 > 0 ? r.top * z - height - 6 : below) + "px";
  }

  function pick(kind: SlashKind) {
    shown = null;
    draw();
    o.choose(kind);
  }
  menu.addEventListener("mousedown", (e) => e.preventDefault());
  menu.addEventListener("click", (e) => {
    const kind = (e.target as Element).closest<HTMLElement>("li")?.dataset.kind as SlashKind | undefined;
    if (kind) pick(kind);
  });

  return {
    /** The paragraph at the caret now: the letters after its "/", or null when it is not a "/" and letters alone. */
    update(filter: string | null) {
      if (filter == null) dismissed = false;
      const items = filter == null || dismissed ? [] : slashItems(filter);
      shown = items.length ? { items, at: Math.min(shown?.at ?? 0, items.length - 1) } : null;
      draw();
    },
    /** A key pressed on the page: the menu's own (the arrows, Enter, Tab, Esc) while it is open. Whether it took it. */
    key(e: KeyboardEvent): boolean {
      if (!shown || e.metaKey || e.ctrlKey || e.altKey) return false;
      const n = shown.items.length;
      if (e.key == "ArrowDown" || e.key == "ArrowUp") shown = { ...shown, at: (shown.at + (e.key == "ArrowDown" ? 1 : n - 1)) % n };
      else if (e.key == "Enter" || e.key == "Tab") return (pick(shown.items[shown.at].kind), true);
      else if (e.key == "Escape") {
        dismissed = true;
        shown = null;
      } else return false;
      draw();
      return true;
    },
    dark(on: boolean) {
      box.classList.toggle("dark", on);
    },
    remove() {
      host.remove();
    },
  };
}

export type Slash = ReturnType<typeof mountSlash>;

/** Asks the person for image files (the browser's own picker): the files chosen, or none. */
export function pickImages(doc: Document): Promise<File[]> {
  return new Promise((resolve) => {
    const input = Object.assign(doc.createElement("input"), { type: "file", accept: "image/*", multiple: true });
    input.addEventListener("change", () => resolve([...(input.files ?? [])]));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

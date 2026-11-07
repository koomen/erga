// Find as you type on a list of documents (/docs, and each page made the same way): each key hides the rows whose title
// and address don't hold every word typed, in the browser, at once. A row that comes in later (a live row,
// client/common/live-rows.ts) obeys the same words: the page calls `apply` from its `wire`.

/** The words a row is found by, in lower case: its title and its address. A replaced row is a new element, so read again. */
const known = new WeakMap<HTMLElement, string>();
const words = (row: HTMLElement) => {
  let w = known.get(row);
  if (w == null) {
    const a = row.querySelector<HTMLAnchorElement>("a.doc");
    w = `${a?.textContent ?? ""} ${a ? decodeURIComponent(new URL(a.href).pathname) : ""}`.toLowerCase();
    known.set(row, w);
  }
  return w;
};

export interface Finder {
  /** Hides `row` if it doesn't match the words typed now: each row as the page loads, and each that comes in. */
  apply(row: HTMLElement): void;
  /** The words typed now, trimmed ("": none). */
  query(): string;
}

/**
 * Filters `list`'s rows (`:scope > li[data-live]`) by what `input` holds; `shown` runs after each change. A row that
 * doesn't match gets the class `miss` (its pages beneath it hide with it: the page's CSS). Escape clears the words; with
 * none, it leaves the box.
 */
export function findRows(input: HTMLInputElement, list: HTMLElement, shown: () => void): Finder {
  let terms: string[] = [];
  const read = () => {
    terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
  };
  const apply = (row: HTMLElement) => {
    const w = terms.length ? words(row) : "";
    row.classList.toggle(
      "miss",
      terms.some((t) => !w.includes(t))
    );
  };
  const all = () => {
    read();
    for (const row of list.querySelectorAll<HTMLElement>(":scope > li[data-live]")) apply(row);
    shown();
  };
  input.addEventListener("input", all);
  input.addEventListener("keydown", (e) => {
    if (e.key != "Escape" || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    if (input.value) {
      input.value = "";
      all();
    } else input.blur();
  });
  return { apply, query: () => input.value.trim() };
}

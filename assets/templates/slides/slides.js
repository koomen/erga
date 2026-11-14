// The deck: each <section class="slide"> is a 16:9 slide (index.html's style), shown one at a time, the slide in the
// address (#3). It gives Erga its steps (window.ergaSteps: erga/steps draws back, forward and the list of slides,
// each drawn small). In the editor, a bar over the slide adds, moves, lays out and deletes slides (⌘⇧Enter adds one),
// with the deck's own edits (api.js). An image dropped on a slide fits its free space (window.ergaDrop, add_image).

const slides = () => [...document.querySelectorAll("body > section.slide")];
let at = Math.max(0, (Number.parseInt(location.hash.slice(1), 10) || 1) - 1);
/** The slide to show after the next change to the slides: one the bar just added or moved. */
let next = null;

/** Shows slide `i` (from 0), and only it. */
function show(i) {
  const all = slides();
  at = Math.max(0, Math.min(all.length - 1, i));
  all.forEach((s, k) => {
    if (s.hidden != (k != at)) s.hidden = k != at;
  });
  if (location.hash != `#${at + 1}`) history.replaceState(history.state, "", `#${at + 1}`);
  dispatchEvent(new Event("ergastep"));
}

/** A slide drawn small, for the list of slides: a copy of it with the page's styles, at that size, as an SVG picture. */
function picture(slide, { width, height }) {
  if (!slide) return null;
  const w = Math.round(Math.min(width, (height * 16) / 9)),
    h = Math.round((w * 9) / 16);
  const copy = slide.cloneNode(true);
  for (const e of [copy, ...copy.querySelectorAll("*")]) {
    if (e.localName.startsWith("erga-")) {
      e.remove();
      continue;
    }
    for (const a of [...e.attributes])
      if (a.name.startsWith("data-erga") || a.name == "contenteditable" || a.name == "hidden") e.removeAttribute(a.name);
  }
  const box = document.createElement("div");
  const css = document.createElement("style");
  css.textContent =
    [...document.querySelectorAll("head style")].map((s) => s.textContent).join("\n") +
    `\nsection.slide { width: ${w}px !important; height: ${h}px !important; }`;
  box.append(css, copy);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%">` +
    new XMLSerializer().serializeToString(box) +
    `</foreignObject></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

window.ergaSteps = {
  count: () => slides().length,
  current: () => at,
  go: show,
  label: (i) => slides()[i]?.querySelector("h1, h2")?.textContent?.trim() || `Slide ${i + 1}`,
  image: (i, size) => picture(slides()[i], size),
};
show(at);
// A slide added, removed or moved (by anyone): still one at a time, the same one, or the one the bar asked for.
new MutationObserver(() => {
  show(next ?? at);
  next = null;
}).observe(document.body, { childList: true });

// Where a dropped image lands. Erga asks while files are dragged over the deck, and one more time at the drop (when it
// knows the image's size): the answer is the box the image will have, the slide that takes it, a few words, and the
// deck's own edit that puts it there (api.js, add_image). The image fits the free space under the slide's text, so a
// slide never overflows; with less than a fifth of the slide free, it goes on a new slide after it. Any other file:
// Erga's own rule (null).
window.ergaDrop = ({ files, final }) => {
  const file = files[0],
    slide = slides()[at];
  if (file?.kind != "image" || !slide) return null;
  const r = slide.getBoundingClientRect(),
    cs = getComputedStyle(slide),
    px = (v) => Number.parseFloat(v) || 0;
  const last = slide.lastElementChild?.getBoundingClientRect();
  const top = last ? last.bottom + px(cs.rowGap) : r.top + px(cs.paddingTop),
    free = r.bottom - px(cs.paddingBottom) - top,
    wide = r.width - px(cs.paddingLeft) - px(cs.paddingRight);
  const ratio = (file.width ?? 3) / (file.height ?? 2);
  if (free < r.height / 5) {
    // A slide of its own: the image under a heading, in the space a new slide has for it.
    const h = Math.min(wide * 0.36, wide / ratio);
    if (final) next = at + 1;
    return {
      box: { x: r.left + px(cs.paddingLeft), y: r.bottom - px(cs.paddingBottom) - h, width: h * ratio, height: h },
      into: slide,
      label: `on a new slide after slide ${at + 1}`,
      edit: "add_image",
      input: { slide: at + 1, fresh: true, height: Math.round((h / wide) * 1000) / 10 },
    };
  }
  const h = Math.min(free, wide / ratio);
  return {
    box: { x: r.left + px(cs.paddingLeft), y: top, width: h * ratio, height: h },
    into: slide,
    label: `on slide ${at + 1}, in its free space`,
    edit: "add_image",
    // (Its height in cqw, hundredths of the width of the slide's text: it scales with the slide.)
    input: { slide: at + 1, height: Math.round((h / wide) * 1000) / 10 },
  };
};

// ---------------------------------------------------------------- in the editor

const editing = () => document.documentElement.hasAttribute("data-erga-editing");
const slideOf = (n) => (n && (n.nodeType == 1 ? n : n.parentElement))?.closest("body > section.slide") ?? null;

// The slide with the caret shows after a change to the slides: after an undo or a redo, the caret is where the change
// was. Not when the editor only puts its caret back (the page takes the focus again after a step).
let changed = -Infinity;
new MutationObserver((records) => {
  if (
    records.some(
      (r) => slideOf(r.target) || [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType == 1 && n.matches?.("section.slide"))
    )
  )
    changed = performance.now();
}).observe(document.body, { childList: true, characterData: true, subtree: true });
document.addEventListener("selectionchange", () => {
  const slide = slideOf(document.getSelection()?.focusNode);
  if (editing() && slide?.hidden && performance.now() - changed < 100) show(slides().indexOf(slide));
});

// The bar: over the slide while the caret is in one, in a shadow root of its own on <html>, outside the deck's text.
const host = document.createElement("slide-bar");
const root = host.attachShadow({ mode: "open" });
root.innerHTML = `<style>
:host { all: initial; }
.bar { position: fixed; z-index: 2147483646; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 2px;
  padding: 4px; border-radius: 10px; background: #fff; border: 1px solid #e6e6ea; box-shadow: 0 8px 30px rgba(0, 0, 0, .08), 0 1px 2px rgba(0, 0, 0, .04);
  font: 13px/1 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #3f3f46; }
.bar[hidden] { display: none; }
button { height: 28px; padding: 0 9px; border: 0; border-radius: 7px; background: transparent; color: inherit; font: inherit; white-space: nowrap; cursor: pointer; }
button:hover { background: rgba(161, 161, 169, .14); }
button:focus-visible { outline: 2px solid #3b7cf0; outline-offset: -2px; }
.sep { width: 1px; height: 16px; margin: 0 2px; background: #e6e6ea; }
</style><div class="bar" hidden role="toolbar" aria-label="Slides">
<button type="button" data-act="add" title="New slide  ⌘⇧Enter">+ Slide</button>
<button type="button" data-act="title" title="New title slide">+ Title</button>
<span class="sep" aria-hidden="true"></span>
<button type="button" data-act="up" title="Move up" aria-label="Move up">↑</button>
<button type="button" data-act="down" title="Move down" aria-label="Move down">↓</button>
<button type="button" data-act="layout" title="Change the layout"></button>
<span class="sep" aria-hidden="true"></span>
<button type="button" data-act="delete" title="Delete this slide">Delete</button>
</div>`;
document.documentElement.append(host);
const bar = root.querySelector(".bar"),
  layoutButton = root.querySelector('[data-act="layout"]');

/** Shows the bar while the editor is on and the caret is in a slide. */
function place() {
  bar.hidden = !editing() || !slideOf(document.getSelection()?.anchorNode);
  layoutButton.textContent = slides()[at]?.dataset.layout == "title" ? "Title layout" : "Content layout";
}
document.addEventListener("selectionchange", place);
addEventListener("erga-editing", place);

/** One of the deck's edits (api.js) on the slide that shows (n, from 1); then slide `then` (from 0) shows. */
function act(name) {
  const n = at + 1,
    count = slides().length;
  const edits = {
    add: ["add_slide", { after: n, layout: "content" }, n],
    title: ["add_slide", { after: n, layout: "title" }, n],
    up: n > 1 && ["move_slide", { slide: n, to: n - 1 }, n - 2],
    down: n < count && ["move_slide", { slide: n, to: n + 1 }, n],
    delete: ["delete_slide", { slide: n }, Math.max(0, n - 2)],
    layout: ["set_layout", { slide: n, layout: slides()[at]?.dataset.layout == "title" ? "content" : "title" }, null],
  };
  const e = edits[name];
  if (!e) return;
  if (e[2] != null) next = e[2];
  ergaEditor.call(e[0], e[1]);
}
// The bar's presses keep the caret where it is (in the slide).
host.addEventListener("mousedown", (e) => e.preventDefault());
root.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (b) act(b.dataset.act);
});
// ⌘⇧Enter (Ctrl+Shift+Enter elsewhere): a new slide after this one, its title selected to type over. The key goes no
// further than the document. The editor must see it first, as the person's own key (it makes the page's edits only
// after one), so this listens after the editor's listeners, each time the editor comes on.
const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function onKey(e) {
  if (e.key != "Enter" || !e.shiftKey || e.altKey || !(mac ? e.metaKey : e.ctrlKey) || bar.hidden) return;
  e.preventDefault();
  e.stopPropagation();
  act("add");
}
addEventListener("erga-editing", () =>
  setTimeout(() => {
    document.removeEventListener("keydown", onKey, true);
    if (editing()) document.addEventListener("keydown", onKey, true);
  })
);
place();

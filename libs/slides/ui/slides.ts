// erga/slides, in a deck's page (slides.js, at /erga/slides/editor.js: the page imports it itself). For everyone, it
// shows the deck: each <section class="slide"> a 16:9 slide, scaled to the window, one at a time, and the page's steps
// (window.ergaSteps: Erga's arrows, its step list with each slide drawn small, the hash). A deck needs no script of its own. In the editor (the viewer's word, edit, which the page's
// first script keeps: client/inline/reader.ts), it loads erga/text's editor for the slides' text, and its own bar for
// the slides (bar.ts). A deck's style is its own to change: this one comes first in its <head>.

import type {} from "../../../client/common/reader-api";

declare global {
  interface Window {
    ergaSteps?: unknown;
  }
}

/** A deck's look: the page's own styles win over it (it comes first, and :where() gives it no weight). A hidden slide stays hidden. */
const STYLE = `
:where(html) { height: 100%; overflow: hidden; background: #18181b; font-size: calc(min(100vw, 100vh * 16 / 9) / 48); }
:where(body) { margin: 0; height: 100%; display: grid; place-items: center; }
:where(section.slide) { box-sizing: border-box; width: min(100vw, 100vh * 16 / 9); aspect-ratio: 16 / 9; overflow: hidden;
  display: flex; flex-direction: column; justify-content: flex-start; padding: 4rem 4.5rem;
  background: #fff; color: #1c1c1f; font: 1.6rem/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
section.slide[hidden] { display: none; }
:where(section.slide[data-layout="title"]) { justify-content: center; align-items: center; text-align: center; }
:where(section.slide h1) { font-size: 4.4rem; line-height: 1.1; margin: 0 0 1.4rem; letter-spacing: -0.02em; }
:where(section.slide h2) { font-size: 3rem; line-height: 1.15; margin: 0 0 1.8rem; letter-spacing: -0.015em; }
:where(section.slide p, section.slide li) { margin: 0.4rem 0; }
`;

const style = document.createElement("style");
style.setAttribute("data-erga", "slides");
style.textContent = STYLE;
document.head.prepend(style);

const slides = () => [...document.querySelectorAll<HTMLElement>("section.slide")];
let at = Math.max(0, (Number.parseInt(location.hash.slice(1), 10) || 1) - 1);
/** The slide to show once it's there: one the bar just added or moved (bar.ts). */
let next: number | null = null;

/** Shows slide `i` (from 0), and only it. */
function show(i: number) {
  const all = slides();
  at = Math.max(0, Math.min(all.length - 1, i));
  all.forEach((s, k) => {
    if (s.hidden != (k != at)) s.hidden = k != at;
  });
  if (location.hash != `#${at + 1}`) history.replaceState(history.state, "", `#${at + 1}`);
  dispatchEvent(new Event("ergastep"));
}

/**
 * A slide drawn small, for Erga's list of steps: a copy of it without the editor's marks, with the page's styles (this
 * one's too), at that size, in an SVG picture. The picture's root is its <svg>, so its font size is the deck's rem.
 */
function picture(slide: HTMLElement | undefined, { width, height }: { width: number; height: number }): string | null {
  if (!slide) return null;
  const w = Math.round(Math.min(width, (height * 16) / 9)),
    h = Math.round((w * 9) / 16);
  const copy = slide.cloneNode(true) as HTMLElement;
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
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" style="font-size: ${w / 48}px"><foreignObject width="100%" height="100%">` +
    new XMLSerializer().serializeToString(box) +
    `</foreignObject></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

const steps = {
  count: () => slides().length,
  current: () => at,
  go: show,
  label: (i: number) => slides()[i]?.querySelector("h1, h2")?.textContent?.trim() || `Slide ${i + 1}`,
  image: (i: number, size: { width: number; height: number }) => picture(slides()[i], size),
  /** The slide to show after the next change to the slides (bar.ts). */
  showNext: (i: number) => {
    next = i;
  },
};
export type Steps = typeof steps;
window.ergaSteps = steps;
show(at);
// A slide added, removed or moved (by anyone): still one at a time, the same one, or the one the bar asked for.
new MutationObserver(() => {
  show(next ?? at);
  next = null;
}).observe(document.body, { childList: true });

// The editor, once the viewer says edit: erga/text's for the text, and the slide bar.
let editing = false;
function edit() {
  if (editing || (window.__ergaReader?.mode as { mode?: string } | undefined)?.mode != "edit") return;
  editing = true;
  // The slide with the caret shows after a change to the slides: after an undo or a redo, the caret is where the change
  // was. Not when the editor only puts its caret back (the page takes the focus again after Erga's arrows stepped).
  let changed = -Infinity;
  const inSlide = (n: Node) => !!(n.nodeType == 1 ? (n as Element) : n.parentElement)?.closest("section.slide");
  new MutationObserver((records) => {
    if (records.some((r) => inSlide(r.target) || [...r.addedNodes, ...r.removedNodes].some(inSlide))) changed = performance.now();
  }).observe(document.body, { childList: true, characterData: true, subtree: true });
  document.addEventListener("selectionchange", () => {
    const n = document.getSelection()?.focusNode;
    const slide = n && (n.nodeType == 1 ? (n as Element) : n.parentElement)?.closest<HTMLElement>("section.slide");
    if (slide?.hidden && performance.now() - changed < 100) show(slides().indexOf(slide));
  });
  void import("../../text/ui/frame");
  void import("./bar").then((b) => b.mountBar(steps));
}
addEventListener("message", (e) => {
  if (e.data?.type == "erga-mode") queueMicrotask(edit);
});
edit();

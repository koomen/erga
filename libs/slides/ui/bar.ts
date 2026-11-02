// The slide bar, in a deck's page in the editor: add a slide after this one (a content slide, ⌘⇧Enter; or a title
// slide), move it up or down, change its layout, delete it. It shows while the caret is in a slide, drawn as the
// editor's own controls are (libs/text/ui/controls.ts: a shadow root of its own on the page's <html>). Each button runs
// one of erga/slides' edits (libs/slides/api/slides.ts) on the editor's text, and the editor makes it as the person's
// own edit (PageEditor.make): one undo step, sent to the room as any typing is.

import { addSlide, deleteSlide, LAYOUTS, moveSlide, setLayout, slidesOf, type Layout } from "../api/slides";
import type { EditResult } from "../../text/api/edits";
import { STYLE } from "../../text/ui/controls";
import type { Steps } from "./slides";

type Change = { from: number; to: number; insert: string };
/** The text after the changes (sorted, apart: an edit's). */
const applied = (src: string, changes: Change[]) => changes.reduceRight((s, c) => s.slice(0, c.from) + c.insert + s.slice(c.to), src);

/** What the bar needs of the editor (libs/text/ui/frame.ts: window.ergaFrame, while editing). */
interface Frame {
  page: {
    state: { doc: { toString(): string } };
    make(changes: Change[], userEvent?: string, caret?: { at: number; select: boolean }): void;
  };
  controls: { explain(message: string): void } | null;
}
const frame = () => (window as Window & { ergaFrame?: Frame }).ergaFrame ?? null;

const BAR = `
.bar { top: 12px; left: 50%; transform: translateX(-50%); padding: 4px; border-radius: 10px; display: flex; align-items: center; gap: 2px; }
.bar button { width: auto; padding: 0 9px; white-space: nowrap; }
`;

export function mountBar(steps: Steps) {
  const doc = document;
  const host = doc.createElement("erga-slide-bar");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}${BAR}</style><div class="c"><div class="card bar" id="bar" hidden role="toolbar" aria-label="Slides">
    <button type="button" data-act="add" title="New slide  ⌘⇧Enter">+ Slide</button>
    <button type="button" data-act="title" title="New title slide">+ Title</button>
    <span class="sep" aria-hidden="true"></span>
    <button type="button" data-act="up" title="Move up" aria-label="Move up">↑</button>
    <button type="button" data-act="down" title="Move down" aria-label="Move down">↓</button>
    <button type="button" data-act="layout" title="Change the layout"></button>
    <span class="sep" aria-hidden="true"></span>
    <button type="button" data-act="delete" title="Delete this slide">Delete</button>
  </div></div>`;
  doc.documentElement.append(host);
  const bar = root.getElementById("bar")!;
  const layoutButton = root.querySelector<HTMLElement>('[data-act="layout"]')!;
  const current = () => doc.querySelectorAll("section.slide")[steps.current()] as HTMLElement | undefined;

  /** Shows the bar while the editor is on and the caret is in a slide. */
  const place = () => {
    const anchor = doc.getSelection()?.anchorNode;
    const slide = anchor && (anchor.nodeType == 1 ? (anchor as Element) : anchor.parentElement)?.closest("section.slide");
    bar.hidden = !frame() || !slide;
    const layout = current()?.dataset.layout ?? "content";
    layoutButton.textContent = layout == "title" ? "Title layout" : "Content layout";
  };
  doc.addEventListener("selectionchange", place);
  addEventListener("erga-editing", place);

  /**
   * Runs an edit on the editor's text; the slide to show after it (from 0), if not this one. The caret goes to the end
   * of that slide's first text, so typing goes on there; a new slide's text is selected instead, to type over.
   */
  function run(edit: (src: string, n: number) => EditResult, then?: (n: number) => number, select = false) {
    const f = frame();
    if (!f) return;
    const n = steps.current() + 1;
    const src = f.page.state.doc.toString();
    const r = edit(src, n);
    if ("refused" in r) return f.controls?.explain(r.refused);
    const show = then ? then(n) : n - 1;
    if (then) steps.showNext(show);
    const slides = slidesOf(applied(src, r.changes));
    const at = slides[Math.max(0, Math.min(slides.length - 1, show))]?.from ?? 0;
    f.page.make(r.changes, "input.slide", { at, select });
  }
  const act = (name: string) => {
    if (name == "add")
      run(
        (src, n) => addSlide(src, n, "content"),
        (n) => n,
        true
      );
    if (name == "title")
      run(
        (src, n) => addSlide(src, n, "title"),
        (n) => n,
        true
      );
    if (name == "up")
      run(
        (src, n) => moveSlide(src, n, n - 1),
        (n) => n - 2
      );
    if (name == "down")
      run(
        (src, n) => moveSlide(src, n, n + 1),
        (n) => n
      );
    if (name == "delete")
      run(
        (src, n) => deleteSlide(src, n),
        (n) => Math.max(0, n - 2)
      );
    if (name == "layout") {
      const was = (current()?.dataset.layout ?? "content") as Layout;
      run((src, n) => setLayout(src, n, LAYOUTS[(LAYOUTS.indexOf(was) + 1) % LAYOUTS.length]));
    }
    place();
  };
  // The bar's presses keep the caret where it is (in the slide), and its events stay its own.
  host.addEventListener("mousedown", (e) => e.preventDefault());
  root.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("button[data-act]");
    if (b) act(b.dataset.act!);
  });
  // ⌘⇧Enter (Ctrl+Shift+Enter elsewhere): a new slide after this one, its title selected to type over.
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  addEventListener(
    "keydown",
    (e) => {
      if (e.key != "Enter" || !e.shiftKey || e.altKey || !(isMac ? e.metaKey : e.ctrlKey) || bar.hidden) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      act("add");
    },
    { capture: true }
  );
  place();
}

// A presentation's steps, in its own page: the bar under the page (the list, back, the step it's at, forward), and the
// list of the steps that opens over its right side, with each step drawn small where the page draws them. The arrow keys
// step too, except in text. A page with window.ergaSteps imports erga/steps (library.ts). It draws in a shadow root of
// its own on the page's <html> (an erga- element: the editor's walks and the steps' pictures pass it by), in Erga's
// viewer (window.__ergaReader) and in a page opened outside Erga alike. It shows the step the agent asks for
// (window.ergaStepTo); the agent's pictures leave the bar out (client/page-tools/capture.ts). Full screen is the
// viewer's (client/inline/viewer-full.ts): it says when it's on, and the bar's way out asks it to leave.

import type {} from "../../../client/common/reader-api";
import type { StepShown } from "../../../shared/view-page";
import { goToStep, labelOf, slidesOf, STEP_MAX, stepNumber, type Steps, whole } from "../api/steps";

declare global {
  interface Window {
    /** The page's steps (Steps, the contract), which the page defines. */
    ergaSteps?: unknown;
    /** The steps library's answer to the agent's render (client/page-tools/capture.ts): the step a spec names, shown. */
    ergaStepTo?: (spec: string) => StepShown | string;
  }
}

/** What the bar shows: the page's steps, read. */
type Shown = { count: number; current: number; labels: string[]; images: boolean; slides: number[] | null };

const slideCount = (s: Shown) => (s.slides ? s.slides[s.count - 1] + 1 : s.count);

const STYLE = `
:host { all: initial; }
.bar, .panel { --bg: rgba(255, 255, 255, .95); --fg: #3f3f46; --soft: #8a8a94; --hover: rgba(161, 161, 169, .18);
  position: fixed; z-index: 2147483646; box-sizing: border-box; background: var(--bg); color: var(--fg);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .06), 0 4px 18px rgba(0, 0, 0, .14); font: 500 13px/1 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.dark :is(.bar, .panel) { --bg: rgba(31, 31, 35, .95); --fg: #e4e4e9; --soft: #8f8f99; --hover: rgba(161, 161, 169, .2);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .08), 0 4px 18px rgba(0, 0, 0, .4); }
[hidden] { display: none !important; }
/* (In the part of the window that Erga's bars and its agent's panel leave clear, on a page that has the whole window: client/common/top-room.ts.) */
.bar { left: calc(50% + (var(--erga-inset-left, 0px) - var(--erga-inset-right, 0px)) / 2); bottom: 14px; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 10px; transform: translateX(-50%); }
.bar button { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; }
.bar button:hover:not(:disabled) { background: var(--hover); }
.bar button:disabled { opacity: .3; cursor: default; }
:is(.bar button, .step):focus-visible { outline: 2px solid #3b7cf0; outline-offset: -2px; }
.bar button[aria-expanded="true"] { color: #3b7cf0; }
.bar svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.at { min-width: 54px; padding: 0 2px; text-align: center; font-variant-numeric: tabular-nums; }
.panel { top: calc(12px + var(--erga-inset-top, 0px)); right: calc(12px + var(--erga-inset-right, 0px)); display: flex; flex-direction: column; width: min(208px, 55vw);
  max-height: max(80px, calc(100vh - 76px - var(--erga-inset-top, 0px))); overflow: hidden; border-radius: 12px; }
.head { flex: none; padding: 10px 12px 2px; color: var(--soft); font-size: 12px; font-weight: 600; }
ol { flex: 1 1 auto; min-height: 0; margin: 0; padding: 6px; list-style: none; overflow-y: auto; overscroll-behavior: contain; }
.step { display: block; width: 100%; padding: 5px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.step:hover { background: var(--hover); }
/* The first step of a slide after another, where the page groups its steps by slide (a slide that builds up in parts). */
.first { margin-top: 5px; padding-top: 5px; border-top: 1px solid var(--hover); }
.pic { display: grid; place-items: center; width: 100%; aspect-ratio: var(--ar, 16 / 9); overflow: hidden; border-radius: 5px;
  background: var(--hover); color: var(--soft); font-size: 22px; font-weight: 600; }
.pic img { display: block; width: 100%; height: 100%; object-fit: contain; }
.step[aria-current="step"] .pic { outline: 2px solid #3b7cf0; outline-offset: 1px; }
.name { display: flex; gap: 6px; margin-top: 6px; font-size: 12px; font-weight: 400; line-height: 1.3; }
.name b { color: var(--soft); font-weight: 500; font-variant-numeric: tabular-nums; }
.name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plain .pic { display: none; }
.plain .name { margin: 0; }
.plain .step[aria-current="step"] { color: #3b7cf0; }
.plain .step[aria-current="step"] b { color: inherit; }
/* Full screen: no list, but a way out; gone while the pointer is still. */
.bar.full { transition: opacity 400ms ease; }
.full .toggle, .bar:not(.full) .exit { display: none; }
.full.still { opacity: 0; cursor: none; }
/* (It moves aside with the agent's panel, on the panel's curve: once the page has started, not as it does.) */
.bar.live:not(.full) { transition: left 560ms cubic-bezier(0.45, 0, 0.15, 1); }
@media (prefers-reduced-motion: reduce) { .bar:is(.full, .live) { transition: none; } }
`;

const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

let mounted = false;

/** Shows the page's steps (window.ergaSteps) with Erga's bar and list, once; and answers the agent's render. */
export function mountSteps(): void {
  if (mounted) return;
  mounted = true;
  const page = () => {
    const p = window.ergaSteps as Steps | undefined;
    return p && typeof p.count == "function" && typeof p.go == "function" && typeof p.current == "function" ? p : null;
  };
  window.ergaStepTo = (spec) => {
    const p = page();
    return p ? goToStep(p, spec) : "The page loads a steps library, but has no window.ergaSteps (count, go and current).";
  };
  // In Erga's viewer: its words come from the viewer (`shell`), and full screen is its own. Outside Erga: none.
  const reader = window.__ergaReader;
  const shell = reader?.config.shell;
  const host = document.createElement("erga-steps");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}</style><div class="c">
<div class="bar" hidden>
<button type="button" class="toggle" aria-label="Steps" aria-expanded="false">${svg("M5 6.5h14M5 12h14M5 17.5h14")}</button>
<button type="button" class="back" aria-label="Back">${svg("M14.5 6.5L9 12l5.5 5.5")}</button>
<span class="at" aria-live="polite"></span>
<button type="button" class="next" aria-label="Forward">${svg("M9.5 6.5L15 12l-5.5 5.5")}</button>
<button type="button" class="exit" aria-label="Leave full screen">${svg(
    "M9.25 4.75v3.5a1 1 0 0 1-1 1h-3.5M19.25 9.25h-3.5a1 1 0 0 1-1-1v-3.5M14.75 19.25v-3.5a1 1 0 0 1 1-1h3.5M4.75 14.75h3.5a1 1 0 0 1 1 1v3.5"
  )}</button>
</div>
<div class="panel" hidden role="region" aria-label="Steps"><div class="head">Steps</div><ol></ol></div></div>`;
  document.documentElement.append(host);
  const $ = <T extends Element>(s: string) => root.querySelector<T>(s)!;
  const box = $<HTMLElement>(".c"),
    bar = $<HTMLElement>(".bar"),
    panel = $<HTMLElement>(".panel"),
    list = $<HTMLElement>("ol"),
    at = $<HTMLElement>(".at"),
    toggle = $<HTMLButtonElement>(".toggle"),
    back = $<HTMLButtonElement>(".back"),
    next = $<HTMLButtonElement>(".next");
  // (The bar's place has its transition two frames after the page loaded: the inset is on the page by then.)
  const live = () => requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add("live")));
  if (document.readyState == "complete") live();
  else addEventListener("load", live, { once: true });

  /** The page's steps, read (null: none, or they threw). */
  function read(): Shown | null {
    const p = page();
    if (!p) return null;
    try {
      const count = whole(p.count(), STEP_MAX),
        labels = Array.from({ length: count }, (_, i) => labelOf(p, i)),
        slides = slidesOf(p, count);
      return count ? { count, current: whole(p.current(), count - 1), labels, images: typeof p.image == "function", slides } : null;
    } catch {
      return null;
    }
  }

  // What the bar shows (null: no steps), the list's shape it was built for, the pictures (step -> blob: address) and which are
  // of the page as it is now (an edit makes them old: they stay up until the new ones come).
  let steps: Shown | null = null,
    shape = "",
    timer = 0;
  const pics = new Map<number, string>(),
    fresh = new Set<number>();
  const open = () => !panel.hidden;
  const items = () => list.querySelectorAll<HTMLElement>(".step");
  const drop = () => {
    for (const url of pics.values()) URL.revokeObjectURL(url);
    pics.clear();
    fresh.clear();
  };

  function picture(i: number) {
    const pic = items()[i]?.querySelector(".pic"),
      url = pics.get(i);
    if (!pic || !steps) return;
    if (url) {
      let img = pic.querySelector("img");
      if (!img) {
        pic.textContent = "";
        img = pic.appendChild(document.createElement("img"));
        img.alt = "";
      }
      if (img.src != url) img.src = url;
    } else if (pic.querySelector("img") || !pic.textContent) pic.textContent = stepNumber(i, steps.slides);
  }
  /** Step i's picture from the page, whatever kind its image() answers, as a blob: address of its own (each drawing a new one). */
  async function draw(i: number, size: { width: number; height: number }): Promise<string | null> {
    const r = (await page()?.image?.(i, size)) as
      | { toBlob?: (done: (b: Blob | null) => void, type: string) => void }
      | Blob
      | string
      | null;
    const blob: Blob | null = !r
      ? null
      : typeof r == "string"
        ? await (await fetch(r)).blob()
        : "toBlob" in r && typeof r.toBlob == "function"
          ? await new Promise<Blob | null>((done) => r.toBlob!(done, "image/png"))
          : r instanceof Blob
            ? r
            : null;
    return blob && /^image\//.test(blob.type) ? URL.createObjectURL(blob) : null;
  }
  // The pictures of the steps in sight in the list that aren't of the page as it is: drawn once it has stopped changing.
  function ask() {
    clearTimeout(timer);
    if (!steps?.images || !open()) return;
    timer = window.setTimeout(
      () => {
        const width = 384,
          size = { width, height: Math.round(width * (innerHeight / innerWidth || 9 / 16)) },
          view = list.getBoundingClientRect();
        items().forEach((el, i) => {
          const b = el.getBoundingClientRect();
          if (b.bottom < view.top - 200 || b.top > view.bottom + 200 || fresh.has(i)) return;
          fresh.add(i);
          const was = shape;
          draw(i, size).then(
            (url) => {
              if (shape != was) {
                if (url) URL.revokeObjectURL(url);
                return;
              }
              const old = pics.get(i);
              if (old) URL.revokeObjectURL(old);
              if (url) pics.set(i, url);
              else pics.delete(i);
              picture(i);
            },
            () => {}
          );
        });
      },
      pics.size ? 400 : 0
    );
  }
  function build(s: Shown) {
    list.textContent = "";
    panel.classList.toggle("plain", !s.images);
    s.labels.forEach((label, i) => {
      const li = list.appendChild(document.createElement("li")),
        b = li.appendChild(document.createElement("button")),
        n = stepNumber(i, s.slides);
      // A line between slides, where the page groups its steps by slide.
      if (s.slides && i && s.slides[i] != s.slides[i - 1]) li.className = "first";
      b.type = "button";
      b.className = "step";
      b.dataset.step = String(i);
      b.setAttribute("aria-label", (label ? label + ", " : "") + "step " + n + " of " + slideCount(s));
      b.appendChild(document.createElement("span")).className = "pic";
      const name = b.appendChild(document.createElement("span"));
      name.className = "name";
      name.appendChild(document.createElement("b")).textContent = n;
      name.appendChild(document.createElement("span")).textContent = label || "Step " + n;
      picture(i);
    });
  }
  /** Marks the current step in the list; scrolls the list to it when it's another step, or `always` (the list opens). */
  let marked = -1;
  function current(always = false) {
    if (!steps) return;
    const now = steps.current;
    items().forEach((el, i) => {
      if (i == now) el.setAttribute("aria-current", "step");
      else el.removeAttribute("aria-current");
    });
    if (open() && (always || now != marked)) items()[now]?.scrollIntoView({ block: "nearest" });
    marked = now;
  }
  /** The viewer hears whether the bar shows: its alerts sit over it (client/shell/page-frame.ts). */
  const tellBar = () => shell && parent.postMessage({ type: "erga-steps", on: !!steps }, shell);
  /** Reads the page's steps again, and shows them. */
  function update() {
    const had = !!steps;
    steps = read();
    bar.hidden = !steps;
    if (had != !!steps) tellBar();
    if (!steps) {
      show(false);
      shape = "";
      drop();
      return;
    }
    // Other steps: the old pictures may be of other steps.
    const now = steps.count + "\n" + steps.labels.join("\n") + "\n" + steps.images + "\n" + steps.slides;
    if (now != shape) {
      shape = now;
      drop();
      build(steps);
      marked = -1;
      ask();
    }
    at.textContent = stepNumber(steps.current, steps.slides) + " / " + slideCount(steps);
    bar.title = steps.labels[steps.current] || "";
    back.disabled = steps.current == 0;
    next.disabled = steps.current == steps.count - 1;
    current();
    look();
  }
  /** Goes a step back or forward, or to step `to`. */
  function go(m: { by?: number; to?: number }) {
    const p = page();
    if (!p || !steps) return;
    try {
      const count = whole(p.count(), STEP_MAX),
        now = whole(p.current(), STEP_MAX),
        n = m.by ? now + (m.by > 0 ? 1 : -1) : whole(m.to, STEP_MAX);
      if (n >= 0 && n < count && n != now) p.go(n);
    } catch {}
    update();
  }
  function show(on: boolean) {
    panel.hidden = !on;
    toggle.setAttribute("aria-expanded", String(on));
    if (on) {
      current(true);
      ask();
    }
  }
  /** The look that follows the page: dark on a dark page, the viewer's zoom undone (the shell scales the frame), the pictures' shape. */
  function look() {
    const m = reader?.mode as { mode?: string; zoom?: number } | undefined;
    const z = String(m?.mode == "edit" && m.zoom ? 1 / m.zoom : 1);
    if (host.style.zoom != z) host.style.zoom = z;
    box.classList.toggle("dark", dark());
    panel.style.setProperty("--ar", innerWidth && innerHeight ? innerWidth + " / " + innerHeight : "16 / 9");
  }

  // Full screen (the viewer's word): back, the step and forward over the page, out of sight while the pointer is still,
  // as a presenter expects. No list, but a way out.
  let still = 0;
  function wake() {
    if (!bar.classList.contains("full")) return;
    bar.classList.remove("still");
    clearTimeout(still);
    still = window.setTimeout(() => bar.classList.toggle("still", !bar.matches(":hover")), 2000);
  }
  function full(on: boolean) {
    if (on == bar.classList.contains("full")) return;
    bar.classList.toggle("full", on);
    clearTimeout(still);
    bar.classList.remove("still");
    if (on) {
      show(false);
      wake();
    }
  }

  // The page's events: its word that the steps changed, an edit (the pictures are old), the viewer's words.
  addEventListener("ergastep", update);
  addEventListener("ergaedit", () => {
    fresh.clear();
    ask();
  });
  addEventListener("message", (e) => {
    if (!shell || e.source != parent || e.origin != shell || !e.data) return;
    if (e.data.type == "erga-full") full(e.data.on === true);
    // (The editor's shell starts after the page: it hears of the bar with its first word.)
    else if (e.data.type == "erga-mode") {
      look();
      tellBar();
    }
    // An arrow pressed in the viewer, outside its text (client/inline/viewer-full.ts): as if pressed here.
    else if (e.data.type == "erga-arrow" && steps) go({ by: e.data.key == "ArrowLeft" ? -1 : 1 });
  });
  addEventListener("resize", look);
  document.addEventListener("pointermove", wake, { passive: true });
  back.addEventListener("click", () => go({ by: -1 }));
  next.addEventListener("click", () => go({ by: 1 }));
  toggle.addEventListener("click", () => show(!open()));
  $(".exit").addEventListener("click", () => shell && parent.postMessage({ type: "erga-full", on: false }, shell));
  panel.addEventListener("click", (e) => {
    const b = (e.target as Element | null)?.closest?.<HTMLElement>(".step");
    if (b) go({ to: Number(b.dataset.step) });
  });
  list.addEventListener("scroll", ask, { passive: true });
  // ← and → step, except in text, or when the page's own handler took the key (it runs after this one, or before).
  addEventListener("keydown", (e) => {
    if (!steps || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key == "Escape" && open()) {
      show(false);
      return;
    }
    if (e.key != "ArrowLeft" && e.key != "ArrowRight") return;
    const t = e.composedPath()[0] as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
    setTimeout(() => {
      if (!e.defaultPrevented) go({ by: e.key == "ArrowLeft" ? -1 : 1 });
    });
  });
  (function poll() {
    update();
    setTimeout(poll, 300);
  })();
  // The viewer may say full screen before this page came (another page in the frame): it says it again on its hello.
  if (shell) parent.postMessage({ type: "erga-full-ask" }, shell);
}

/** Whether the page is dark: its background's, or its body's, lightness. */
function dark() {
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    const rgb = getComputedStyle(el)
      .backgroundColor.match(/[\d.]+/g)
      ?.map(Number);
    if (!rgb || rgb.length < 3 || rgb[3] === 0) continue;
    return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.45;
  }
  return false;
}

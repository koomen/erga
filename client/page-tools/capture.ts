// The agent's look at the page (view_page, eval_in_page), in the page itself: the server's browser (cloudflare/render.ts)
// opens the page and runs this in it (client/inline/page-render.ts). It waits for the page's fonts and images, shows a
// step, holds the page's animations at a time while the browser takes its picture, measures the part to take, runs an
// expression, and says which fonts the text rendered in. The browser draws the picture itself.

import { evaluateIn } from "./evaluate";
import type { Clip, PageRender, RenderedFont, StepShown } from "../../shared/agent-log";
import { findStep, stepNumber } from "../../shared/steps";
import { sleep } from "../../shared/time";
import { topRoom } from "../common/top-room";

const MAX_SHOT = 4000;
const LOAD_WAIT = 5000;
/** How long the render waits for a presentation's window.ergaSteps after the page loaded. */
const STEPS_WAIT = 3000;

/** The page's render tools, for the server's browser. */
export function pageRender(win: Window & typeof globalThis): PageRender {
  const d = win.document;
  // The room a scrolling page keeps at its top for the bars, as the person's view has it (client/common/top-room.ts).
  topRoom(d).update();
  let clock = animationClock(d);
  let running: Animation[] = [];
  let from = 0;
  return {
    settle: () => settle(d, Date.now() + LOAD_WAIT),
    async step(spec) {
      const s = await goToStep(win, spec, Date.now() + STEPS_WAIT);
      clock = animationClock(d);
      return s;
    },
    async hold(t, selector, fullPage) {
      const at = await clock.until(t);
      running = clock.pause(t);
      from = performance.now();
      const shown = measure(d, selector, fullPage);
      return { at, ...shown };
    },
    release() {
      clock.resume(running, performance.now() - from);
      running = [];
    },
    async evaluate(expr, timeoutMs, t) {
      const at = await clock.until(t);
      const r = await evaluateIn(win, expr, timeoutMs);
      return { at, ...r };
    },
    fonts(selector) {
      const el = selector ? d.querySelector(selector) : null;
      return renderedFonts(d, el ?? d.documentElement);
    },
  };
}

/** The part of the page a picture takes: the screenful (no clip), the whole page (up to MAX_SHOT tall), or one element. */
function measure(d: Document, selector: string | null, fullPage: boolean): { clip?: Clip; note?: string; error?: string } {
  const w = d.defaultView!;
  if (selector) {
    let el: Element | null = null;
    try {
      el = d.querySelector(selector);
    } catch {
      return { error: `${selector} isn't a valid CSS selector` };
    }
    if (!el) return { error: `Nothing on the page matches ${selector}` };
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1)
      return { error: `${selector} has no size (${Math.round(r.width)}×${Math.round(r.height)}); it may not have rendered` };
    const height = Math.min(MAX_SHOT, Math.ceil(r.height));
    return {
      clip: { x: Math.max(0, r.left + w.scrollX), y: Math.max(0, r.top + w.scrollY), width: Math.ceil(r.width), height },
      ...(r.height > MAX_SHOT ? { note: `${selector} is ${Math.round(r.height)}px tall; this shows the top ${MAX_SHOT}px.` } : {}),
    };
  }
  if (!fullPage) return {};
  const full = Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0);
  return {
    clip: { x: 0, y: 0, width: d.documentElement.clientWidth || w.innerWidth, height: Math.min(MAX_SHOT, full) },
    ...(full > MAX_SHOT ? { note: `The page is ${full}px tall; this shows the top ${MAX_SHOT}px.` } : {}),
  };
}

type Steps = { count(): number; current(): number; go(i: number): void; label?(i: number): unknown; slide?(i: number): unknown };

/**
 * Shows the step the agent asked for: by the page's window.ergaSteps (client/inline/reader.ts, Steps),
 * which a page may define after it loads, so this waits for it until `deadline`. A hash (the frame opened at it) needs
 * none. A page without ergaSteps goes to the step's number as its hash, as a link to it would. Answers the step shown,
 * a note, or why it can't.
 */
async function goToStep(win: Window, spec: string, deadline: number): Promise<StepShown | { note: string } | string> {
  const steps = () => {
    const s = (win as Window & { ergaSteps?: Steps }).ergaSteps;
    return s && typeof s.go == "function" && typeof s.count == "function" ? s : null;
  };
  const asHash = spec.startsWith("#");
  while (!steps() && !asHash && Date.now() < deadline) await sleep(50);
  const s = steps();
  try {
    if (!s) {
      if (asHash) return { note: `Opened at ${spec} (the page has no window.ergaSteps).` };
      win.location.hash = "#" + spec;
      return {
        note: `The page has no window.ergaSteps (after ${STEPS_WAIT / 1000} s): its address went to #${spec}, as a link to that part would.`,
      };
    }
    const count = Math.max(0, Math.floor(Number(s.count())) || 0);
    if (!count) return "The page's ergaSteps.count() answered no steps.";
    // The slide each step is on, never one before the step before's (as the steps' list reads it: client/inline/reader.ts).
    let slides: number[] | null = null;
    if (typeof s.slide == "function") {
      slides = [];
      for (let i = 0; i < count; i++) slides.push(Math.max(i ? slides[i - 1] : 0, Math.floor(Number(s.slide(i))) || 0));
    }
    const i = asHash ? Math.floor(Number(s.current())) || 0 : findStep(spec, count, slides);
    if (typeof i == "string") return i;
    if (!asHash) s.go(i);
    const label = typeof s.label == "function" ? s.label(i) : undefined;
    return {
      index: i,
      number: stepNumber(i, slides),
      count,
      ...(typeof label == "string" && label.trim() ? { label: label.replace(/\s+/g, " ").trim().slice(0, 200) } : {}),
    };
  } catch (e) {
    return `The page's ergaSteps threw: ${(e as Error)?.message ?? String(e)}`;
  }
}

/**
 * Time since the step (or the load), for the frames. The CSS transitions and animations the step started (all of
 * document.getAnimations() then) are set to each frame's time while it is taken, and the others held still: a frame
 * at 600 ms shows them 600 ms in, however long the picture takes. The time a picture takes is left out of the clock.
 * Animation by script (requestAnimationFrame, timers) keeps running on its own time.
 */
function animationClock(d: Document) {
  const begun = new Map<Animation, number>();
  for (const a of d.getAnimations()) begun.set(a, Number(a.currentTime ?? 0));
  const start = performance.now();
  let held = 0;
  const now = () => performance.now() - start - held;
  return {
    async until(t: number): Promise<number> {
      if (t > now()) await sleep(t - now());
      return Math.round(now());
    },
    pause(t: number): Animation[] {
      const running = d.getAnimations().filter((a) => a.playState == "running");
      for (const a of running) {
        a.pause();
        if (begun.has(a)) a.currentTime = begun.get(a)! + t;
      }
      return running;
    },
    resume(running: Animation[], took: number) {
      held += took;
      for (const a of running) a.play();
    },
  };
}

/**
 * Waits until the page's fonts and images have loaded, or `deadline`.
 * A web font loads only once some text needs it, so this lays the page out
 * first; lazy images load at once, since a whole-page picture shows them.
 * Answers what still hadn't loaded.
 */
async function settle(d: Document, deadline: number): Promise<string[]> {
  const imgs = [...d.images];
  for (const img of imgs) if (img.loading == "lazy") img.loading = "eager";
  const loading = () => [
    ...[...d.fonts]
      .filter((f) => f.status == "loading")
      .map((f) => ({
        what: `font ${f.family.replace(/^["']|["']$/g, "")} ${f.weight} ${f.style}`,
        done: f.loaded.then(
          () => {},
          () => {}
        ),
      })),
    ...imgs.filter((i) => i.src && !i.complete).map((i) => ({ what: `image ${i.getAttribute("src")}`, done: i.decode().catch(() => {}) })),
  ];
  // Text laid out in a newly loaded font can need another (a bold or an italic): look again until nothing loads.
  for (let round = 0; round < 5; round++) {
    void d.documentElement.getBoundingClientRect();
    await sleep(50);
    const now = loading();
    if (!now.length) {
      await Promise.race([d.fonts.ready, sleep(deadline - Date.now())]);
      if (!loading().length) break;
      continue;
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await Promise.race([Promise.all(now.map((l) => l.done)), sleep(left)]);
  }
  return [...new Set(loading().map((l) => l.what))];
}

const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "math",
  "emoji",
  "fangsong",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
]);

/**
 * The fonts the text under `root` rendered in: for each element with text of
 * its own, the first family in its font-family that the browser could use
 * (a web font that loaded, a font on this computer, or a generic one).
 */
function renderedFonts(d: Document, root: Element): RenderedFont[] {
  const win = d.defaultView!;
  const faces = new Map<string, FontFace[]>();
  for (const f of d.fonts) {
    const k = unquote(f.family).toLowerCase();
    faces.set(k, [...(faces.get(k) ?? []), f]);
  }
  const ctx = d.createElement("canvas").getContext("2d");
  const installed = new Map<string, boolean>();
  const isInstalled = (family: string) => {
    if (!installed.has(family)) {
      // A font the computer has changes how wide text is, from at least one of two different fallbacks.
      const probe = "mmmmmmmmmmlli WQ@#0123456789";
      const width = (font: string) => {
        ctx!.font = font;
        return ctx!.measureText(probe).width;
      };
      installed.set(family, !!ctx && ["monospace", "serif"].some((g) => width(`72px "${family}", ${g}`) != width(`72px ${g}`)));
    }
    return installed.get(family)!;
  };
  const resolve = (stack: string): { family: string; wanted?: string } => {
    const families = stack
      .split(",")
      .map((f) => unquote(f.trim()))
      .filter(Boolean);
    for (const family of families) {
      const key = family.toLowerCase();
      if (GENERIC.has(key)) return { family, ...(family != families[0] ? { wanted: families[0] } : {}) };
      const own = faces.get(key);
      if (own ? own.some((f) => f.status == "loaded") : isInstalled(family))
        return { family, ...(family != families[0] ? { wanted: families[0] } : {}) };
    }
    return { family: "the browser's default font", wanted: families[0] };
  };
  const by = new Map<string, RenderedFont>();
  const seen = new Set<Element>();
  const walk = d.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.nodeValue?.trim() || el.closest("script, style, noscript, template, title")) continue;
    seen.add(el);
    const cs = win.getComputedStyle(el);
    if (cs.display == "none" || cs.visibility == "hidden") continue;
    const r = resolve(cs.fontFamily);
    const key = `${r.family}|${r.wanted ?? ""}`;
    const f = by.get(key) ?? { family: r.family, ...(r.wanted ? { wanted: r.wanted } : {}), elements: 0, tags: [] };
    f.elements++;
    const tag = el.tagName.toLowerCase();
    if (f.tags.length < 5 && !f.tags.includes(tag)) f.tags.push(tag);
    by.set(key, f);
  }
  return [...by.values()].sort((a, b) => b.elements - a.elements).slice(0, 10);
}
const unquote = (s: string) => s.replace(/^["']|["']$/g, "");

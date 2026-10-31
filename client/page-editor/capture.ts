// The agent's look at the page (view_page, evaluate_page): the page editor's frame renders the latest version in a
// hidden frame of its own, at a step and a time if asked, and answers with a picture or an expression's result.

import { evaluateIn } from "./evaluate";
import {
  evalTimeout,
  FRAMES,
  type ColorScheme,
  type RenderedFont,
  type StepShown,
  type ViewRequest,
  type ViewResult,
} from "../../shared/agent-log";
import { findStep, stepNumber, stepSpec } from "../../shared/steps";
import { FRAMES_BY_CLOCK, frames, wait } from "./clock";

// The agent asks to see the page. This frame renders the latest version
// (edits still waiting for the end of the agent's turn included) in a
// hidden frame and draws it to an image, which the browser renders itself
// (modern-screenshot: the DOM through an SVG foreignObject), with any
// errors the page's scripts threw. No server-side browser: whoever has the
// editor open is the agent's eyes. It renders at the user's size and in
// their light or dark mode unless the agent asks for others, waits (up to
// LOAD_WAIT) for the page's web fonts and images, and says which fonts the
// text rendered in, so a fallback font shows as one.
const CATCH_ERRORS = `<script>window.__ergaErrors=[];addEventListener("error",function(e){__ergaErrors.push(String(e.message))});addEventListener("unhandledrejection",function(e){__ergaErrors.push("Unhandled rejection: "+String(e.reason&&e.reason.message||e.reason))});(function(){var ce=console.error;console.error=function(){__ergaErrors.push("console.error: "+[].map.call(arguments,String).join(" "));return ce.apply(console,arguments)}})()</script>`;
/**
 * The hidden frame is about:srcdoc, its <base> the page's real address: a
 * hash-only address ("#3", rule 14 of the agents' guide) would resolve
 * against the base, another address, and replaceState would throw. Here a
 * hash-only address is the frame's own, in replaceState, pushState and a
 * link, as it is for the page anywhere else. The frame opens at the page's
 * hash, so a deck renders at the slide the person sees.
 */
const ownHash = (hash: string) =>
  `<script>(function(){var h=history,own=function(u){return typeof u=="string"&&u.charAt(0)=="#"?location.href.split("#")[0]+u:u};["pushState","replaceState"].forEach(function(m){var f=h[m];h[m]=function(s,t,u){return arguments.length>2?f.call(h,s,t,own(u)):f.call(h,s,t)}});${hash ? `h.replaceState(null,"",${JSON.stringify(hash)});` : ""}addEventListener("click",function(e){var a=!e.defaultPrevented&&e.target.closest&&e.target.closest("a[href^='#']");if(a&&!a.target&&!a.hasAttribute("download")){e.preventDefault();location.hash=a.getAttribute("href")}})})()</script>`;
/**
 * Light or dark mode for the hidden frame, when the agent asks for the one
 * the browser doesn't prefer (a frame can't be given its own preference):
 * every prefers-color-scheme query the page can reach, in its stylesheets,
 * its elements' media attributes and its scripts' matchMedia, answers for
 * `scheme` instead.
 */
const schemeQuery = (scheme: ColorScheme, media: string) =>
  media.replace(/\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi, (_, s: string) =>
    s.toLowerCase() == scheme ? "(min-width: 0px)" : "(min-width: 1000000px)"
  );
const forceSchemeScript = (scheme: ColorScheme) =>
  `<script>(function(){var mm=window.matchMedia;window.matchMedia=function(q){return mm.call(window,String(q).replace(/\\(\\s*prefers-color-scheme\\s*:\\s*(light|dark)\\s*\\)/gi,function(_,s){return s.toLowerCase()==${JSON.stringify(scheme)}?"(min-width: 0px)":"(min-width: 1000000px)"}))}})()</script>`;
function forceScheme(d: Document, scheme: ColorScheme) {
  const w = d.defaultView as Window & typeof globalThis; // the page's own classes: instanceof is per window
  const rewrite = (rules: CSSRuleList) => {
    for (const r of rules) {
      if ((r instanceof w.CSSMediaRule || r instanceof w.CSSImportRule) && /prefers-color-scheme/i.test(r.media.mediaText))
        r.media.mediaText = schemeQuery(scheme, r.media.mediaText);
      if (r instanceof w.CSSImportRule) {
        try {
          if (r.styleSheet) rewrite(r.styleSheet.cssRules);
        } catch {
          /* another site's */
        }
      } else if ("cssRules" in r) rewrite((r as CSSGroupingRule).cssRules);
    }
  };
  for (const s of d.styleSheets) {
    try {
      rewrite(s.cssRules);
    } catch {
      /* another site's: out of reach */
    }
  }
  for (const el of d.querySelectorAll<HTMLElement>("[media]")) {
    const m = el.getAttribute("media")!;
    if (/prefers-color-scheme/i.test(m)) el.setAttribute("media", schemeQuery(scheme, m));
  }
  // A page that lets the browser choose (color-scheme: light dark) gets the one asked for.
  const root = d.documentElement,
    cs = d.defaultView!.getComputedStyle(root).colorScheme;
  if (/light/.test(cs) && /dark/.test(cs)) root.style.setProperty("color-scheme", scheme);
}
const MAX_SHOT = 4000;
const LOAD_WAIT = 5000;
/** How long the render waits for a presentation's window.ergaSteps after the page loaded. */
const STEPS_WAIT = 3000;

/**
 * Renders the page's `html` in a hidden frame of its own (never the person's view) and answers the agent's request:
 * a picture, or the expression's result; at a step and a time, or at several times (`frames`). `hash` is the page's
 * own, where a deck opens unless the request names a step.
 */
export async function captureView(req: ViewRequest, html: string, hash: string): Promise<ViewResult> {
  const width = Math.round(Math.max(320, Math.min(2400, req.width ?? (innerWidth || 1280))));
  const viewport = Math.round(Math.max(200, Math.min(MAX_SHOT, req.height ?? (innerHeight || 800))));
  const prefers: ColorScheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const scheme = req.colorScheme ?? prefers;
  const forced = scheme != prefers;
  const times = req.frames?.length ? req.frames : [req.atMs ?? (req.step != null ? FRAMES.afterStep : FRAMES.afterLoad)];
  if (times.length > FRAMES.count || times.some((t) => !Number.isFinite(t) || t < 0 || t > FRAMES.max))
    return { width: 0, height: 0, errors: [], error: `Give at most ${FRAMES.count} times, each from 0 to ${FRAMES.max} ms.` };
  const spec = req.step == null ? null : stepSpec(req.step);
  const asHash = spec?.startsWith("#") ? spec : null;
  const shot = document.createElement("iframe");
  shot.setAttribute("sandbox", "allow-scripts allow-same-origin");
  shot.setAttribute("aria-hidden", "true");
  // (The editor's own, in the page: data-erga, which its patch leaves be.)
  shot.setAttribute("data-erga", "");
  shot.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${viewport}px;border:0;`;
  const head = CATCH_ERRORS + FRAMES_BY_CLOCK + ownHash(asHash ?? hash) + (forced ? forceSchemeScript(scheme) : "");
  shot.srcdoc = /<head(\s[^>]*)?>/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (m) => m + head) : head + html;
  document.body.append(shot);
  const drawing = frames(shot);
  try {
    // The load event comes once the page's scripts ran (inline, deferred, modules) and its images loaded.
    await new Promise<void>((resolve, reject) => {
      shot.onload = () => resolve();
      void wait(10_000).then(() => reject(new Error("the page took more than 10 s to load, so nothing ran in it")));
    });
    const d = shot.contentDocument!,
      win = shot.contentWindow as (Window & { __ergaErrors?: string[] }) | null;
    const errors = () => [...(win?.__ergaErrors ?? [])];
    if (forced) forceScheme(d, scheme);
    const unread = await embeddableFonts(d);
    const pending = await settle(d, Date.now() + LOAD_WAIT);
    const notes: string[] = [];
    if (pending.length && req.evaluate != null) notes.push(`Still loading when the expression ran: ${pending.join(", ")}.`);
    let step: StepShown | undefined;
    if (spec != null) {
      const s = await goToStep(win!, spec, Date.now() + STEPS_WAIT);
      if (typeof s == "string") return { width: 0, height: 0, errors: errors(), error: s };
      if ("note" in s) notes.push(s.note);
      else step = s;
    }
    const clock = animationClock(d);
    if (req.evaluate != null) {
      const runs: { at: number; r: Awaited<ReturnType<typeof evaluateIn>> }[] = [];
      for (const t of times) {
        const { at, value: r } = await clock.at(t, () => evaluateIn(win!, String(req.evaluate), evalTimeout(req)));
        runs.push({ at, r });
      }
      const failed = runs.find((x) => x.r.error);
      const value = !req.frames?.length
        ? runs[0].r.value
        : failed
          ? undefined
          : `[${runs.map((x) => `{"at_ms":${x.at},"value":${x.r.value}}`).join(",")}]`;
      const note = [...notes, ...runs.map((x) => x.r.note).filter((n): n is string => !!n)].join("\n");
      return {
        width,
        height: viewport,
        errors: errors(),
        ...(value != null ? { value } : {}),
        ...(failed ? { error: (req.frames?.length ? `At ${failed.at} ms: ` : "") + failed.r.error } : {}),
        ...(note ? { note } : {}),
        ...(step ? { step } : {}),
      };
    }
    const root = win!.getComputedStyle(d.documentElement),
      body = d.body ? win!.getComputedStyle(d.body) : null;
    const clear = (c: string) => /^(transparent|rgba\([^)]*,\s*0\))$/.test(c);
    const bg = !clear(root.backgroundColor)
      ? root.backgroundColor
      : body && !clear(body.backgroundColor)
        ? body.backgroundColor
        : scheme == "dark" && /dark/.test(root.colorScheme)
          ? "#121212"
          : "#ffffff";
    if (unread.length)
      notes.push(
        `The picture may show fallback fonts where the page uses fonts from ${unread.join(", ")}: that stylesheet can't be read from the page (no CORS), so its fonts can't go into the picture.`
      );
    // (The screenshots' code loads the first time the agent asks for one.)
    const { domToPng } = await import("modern-screenshot");
    /** One picture of the page as it is now: the screenful, the whole page, or one element. */
    const picture = async (): Promise<{ png: string; w: number; h: number; target: Element; note?: string } | string> => {
      let target: Element = d.documentElement,
        w = width,
        h = viewport,
        note: string | undefined;
      if (req.selector) {
        let el: Element | null = null;
        try {
          el = d.querySelector(req.selector);
        } catch {
          return `${req.selector} isn't a valid CSS selector`;
        }
        if (!el) return `Nothing on the page matches ${req.selector}`;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1)
          return `${req.selector} has no size (${Math.round(r.width)}×${Math.round(r.height)}); it may not have rendered`;
        target = el;
        w = Math.ceil(r.width);
        h = Math.min(MAX_SHOT, Math.ceil(r.height));
        if (r.height > MAX_SHOT) note = `${req.selector} is ${Math.round(r.height)}px tall; this shows the top ${MAX_SHOT}px.`;
      } else if (req.fullPage) {
        const full = Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0);
        h = Math.min(MAX_SHOT, full);
        if (full > MAX_SHOT) note = `The page is ${full}px tall; this shows the top ${MAX_SHOT}px.`;
      }
      // An element is drawn at its own size, without the margins around it (they'd shift it inside the image).
      const url = await domToPng(
        target,
        target == d.documentElement
          ? { width: w, height: h, backgroundColor: bg, scale: 1 }
          : { backgroundColor: bg, scale: 1, style: { margin: "0" } }
      );
      return { png: url.slice(url.indexOf(",") + 1), w, h, target, ...(note ? { note } : {}) };
    };
    const shots: { at: number; p: Exclude<Awaited<ReturnType<typeof picture>>, string> }[] = [];
    for (const t of times) {
      const { at, value } = await clock.at(t, picture);
      if (typeof value == "string")
        return { width: 0, height: 0, errors: errors(), error: req.frames?.length ? `At ${at} ms: ${value}` : value };
      shots.push({ at, p: value });
    }
    const last = shots[shots.length - 1].p;
    if (last.note) notes.push(last.note);
    return {
      png: shots[0].p.png,
      width: last.w,
      height: last.h,
      errors: errors(),
      viewport: { width, height: viewport },
      colorScheme: scheme,
      fonts: renderedFonts(d, last.target),
      ...(req.frames?.length ? { shots: shots.map((s) => ({ at: s.at, png: s.p.png })) } : {}),
      ...(step ? { step } : {}),
      ...(pending.length ? { pending } : {}),
      ...(notes.length ? { note: notes.join("\n") } : {}),
    };
  } finally {
    drawing.stop();
    shot.remove();
  }
}

type Steps = { count(): number; current(): number; go(i: number): void; label?(i: number): unknown; slide?(i: number): unknown };

/**
 * Shows the step the agent asked for: by the page's window.ergaSteps (agents/document/PROMPT.md, "Presentations"),
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
  while (!steps() && !asHash && Date.now() < deadline) await wait(50);
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
 * Time since the step, for the frames. The CSS transitions and animations the step started (all of
 * document.getAnimations() then) are set to each frame's time while it is taken, and the others held still: a frame
 * at 600 ms shows them 600 ms in, however slowly the browser draws the hidden frame. The time a picture takes is left
 * out of the clock. Animation by script (requestAnimationFrame, run by clock.ts, and timers) keeps running on its own time.
 */
function animationClock(d: Document) {
  const begun = new Map<Animation, number>();
  for (const a of d.getAnimations()) begun.set(a, Number(a.currentTime ?? 0));
  const start = performance.now();
  let held = 0;
  const now = () => performance.now() - start - held;
  return {
    async at<T>(t: number, take: () => Promise<T>): Promise<{ at: number; value: T }> {
      if (t > now()) await wait(t - now());
      const at = Math.round(now());
      const running = d.getAnimations().filter((a) => a.playState == "running");
      for (const a of running) {
        a.pause();
        if (begun.has(a)) a.currentTime = begun.get(a)! + t;
      }
      const from = performance.now();
      try {
        return { at, value: await take() };
      } finally {
        held += performance.now() - from;
        for (const a of running) a.play();
      }
    },
  };
}

/**
 * Stylesheets from other sites (Google Fonts, say) can't be read by the
 * page's scripts, so modern-screenshot can't put their fonts in the picture
 * and draws their text in a fallback. Their @font-face rules are fetched
 * (most font services allow it: CORS) and added to the page as its own.
 * Answers the ones that couldn't be read.
 */
async function embeddableFonts(d: Document): Promise<string[]> {
  const sheets = [...d.styleSheets].filter((s) => {
    try {
      void s.cssRules;
      return false;
    } catch {
      return !!s.href;
    }
  });
  const unread: string[] = [];
  await Promise.all(
    sheets.map(async (s) => {
      const href = s.href!;
      try {
        const res = await fetch(href, { mode: "cors", credentials: "omit", signal: AbortSignal.timeout(LOAD_WAIT) });
        if (!res.ok) throw new Error(String(res.status));
        const css = (await res.text()).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_, _q, u: string) => `url("${new URL(u, href).href}")`);
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        const faces = [...sheet.cssRules].filter((r) => r instanceof CSSFontFaceRule).map((r) => r.cssText);
        if (!faces.length) return;
        const style = d.createElement("style");
        style.dataset.ergaFonts = href;
        style.textContent = faces.join("\n");
        d.head.append(style);
      } catch {
        unread.push(new URL(href).host);
      }
    })
  );
  return [...new Set(unread)];
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
    await wait(50);
    const now = loading();
    if (!now.length) {
      await Promise.race([d.fonts.ready, wait(deadline - Date.now())]);
      if (!loading().length) break;
      continue;
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await Promise.race([Promise.all(now.map((l) => l.done)), wait(left)]);
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

// One load of a document, in a real browser, and what it costs: how soon the
// document shows, how soon the editor takes a typed character, how soon the
// server stores it, and the requests on the way. Also the time from a key
// press to the character on screen.
//
// Every signal is something a person sees, not a frame's address or an
// element's id, so the measurements hold while the viewer and the editor
// change shape:
//
//   visible    the document's heading (MARK) painted, in whatever frame shows it
//              (the Element Timing API; or else, the first paint after the
//              typing line is in the page)
//   editable   a click at the end of the typing line (LINE) and a typed "q"
//              changed the line on screen. The bench tries each 25 ms from the
//              start of the load, so this is when the editor first takes input
//              (25 ms late at most)
//   saved      the server stores the page with that "q" (it writes the room's
//              text to storage a moment after the last edit: 400 ms now)
//
// A script in every frame (PROBE) reports paints, key presses and changes of
// the line's text to the bench. Times are ms from the start of the
// navigation (the top page's performance.timeOrigin); `saved` is on the
// bench's clock, from just before the navigation.

import type { BrowserContext, Page } from "playwright-core";
import { LINE, lineLength, type Docs } from "./docs";
import type { Hit, Proxy } from "./proxy";

export interface Load {
  /** The first byte of the top page's HTML. */
  ttfb: number;
  /** The top page's first contentful paint. */
  fcp: number;
  /** The document's heading on screen. */
  visible: number;
  /** The top page's load event. */
  load: number;
  /** The editor took a typed character (editor loads only). */
  editable?: number;
  /** The server stored the typed character (editor loads only). */
  saved?: number;
  /** Requests that reached the network (the cache answered the rest), WebSockets included. */
  reqs: number;
  /** kB over the wire, compressed. */
  kB: number;
  /** HTML documents loaded (pages and frames, redirects included). */
  docs: number;
  /** The longest chain of document loads, each one after the one before had finished. */
  docChain: number;
  /** The longest chain of requests, each one after the one before, that finished before the document showed (the editor: before it took input). */
  chain: number;
  /** WebSockets opened. */
  ws: number;
}

export interface Keys {
  /** ms from each key press to the paint that shows its character. */
  samples: number[];
  /** Keys whose character didn't show within 2 s. */
  lost: number;
}

type Report =
  | { kind: "nav"; origin: number; href: string }
  | { kind: "fcp"; t: number; origin: number }
  | { kind: "load"; t: number; ttfb: number; origin: number }
  | { kind: "visible"; t: number }
  | { kind: "text"; len: number; t: number }
  | { kind: "key"; key: string; t: number };

/** Runs in every frame before its own scripts. Reports through the binding __benchReport. */
const PROBE = (LINE: string) => {
  const send = (m: unknown) => { try { (window as any).__benchReport(m); } catch { /* no binding */ } };
  const wall = (t: number) => performance.timeOrigin + t;
  const afterPaint = (f: (t: number) => void) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => f(wall(performance.now())); c.port2.postMessage(0); });
  if (window.top == window) {
    send({ kind: "nav", origin: performance.timeOrigin, href: location.href });
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name == "first-contentful-paint") send({ kind: "fcp", t: wall(e.startTime), origin: performance.timeOrigin }); }).observe({ type: "paint", buffered: true }); } catch { /* old browser */ }
    addEventListener("load", () => setTimeout(() => {
      const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      send({ kind: "load", t: wall(n?.loadEventStart || performance.now()), ttfb: n ? wall(n.responseStart) : 0, origin: performance.timeOrigin });
    }));
  }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as any[]) if (e.identifier == "erga-bench") send({ kind: "visible", t: wall(e.renderTime || e.loadTime) });
    }).observe({ type: "element", buffered: true });
  } catch { /* no Element Timing: the line's first paint stands in */ }
  // The typing line's text: each change, at the paint that shows it.
  let last = -1;
  const check = () => {
    let p = document.querySelector('p[data-bench="type"]');
    if (!p) for (const el of document.querySelectorAll("p")) if (el.textContent?.startsWith(LINE)) { p = el; break; }
    if (!p) return;
    const len = p.textContent!.length;
    if (len == last) return;
    last = len;
    afterPaint((t) => send({ kind: "text", len, t }));
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
  addEventListener("keydown", (e) => { const k = e as KeyboardEvent; if (k.isTrusted && k.key.length == 1) send({ kind: "key", key: k.key, t: wall(k.timeStamp) }); }, true);
};

/** A tab in a fresh browser profile (nothing cached, no storage, no connection), with the probe in every frame. */
export class Tab {
  reports: Report[] = [];
  private constructor(readonly context: BrowserContext, readonly page: Page) {}

  static async open(newContext: () => Promise<BrowserContext>, proxy: Proxy): Promise<Tab> {
    proxy.reset();
    const context = await newContext();
    const page = await context.newPage();
    const tab = new Tab(context, page);
    await context.exposeBinding("__benchReport", (_source, m: Report) => { tab.reports.push(m); });
    await context.addInitScript(PROBE, LINE);
    return tab;
  }
  close() { return this.context.close(); }
}

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => Bun.sleep(ms);

/** In a frame: the typing line, if the frame shows it. */
const LINE_IN = (LINE: string) => {
  const marked = document.querySelector('p[data-bench="type"]');
  for (const el of marked ? [marked] : document.querySelectorAll("p")) if (el == marked || el.textContent?.startsWith(LINE)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
};

/** Clicks at the end of the typing line, in whichever frame shows it (the last such frame: the one on top). False if none does yet. */
async function clickLineEnd(page: Page): Promise<boolean> {
  let box: { x: number; y: number; width: number; height: number } | null = null;
  for (const f of page.frames()) {
    const h = await f.evaluateHandle(LINE_IN, LINE).catch(() => null);
    const el = h?.asElement();
    if (!el) { await h?.dispose(); continue; }
    const b = await el.boundingBox().catch(() => null);
    await h!.dispose();
    if (b && b.width > 0 && b.height > 0) box = b;
  }
  if (!box) return false;
  // The line's first row, just inside its right edge: the caret goes to the end of the text.
  await page.mouse.click(box.x + box.width - 3, box.y + Math.min(box.height / 2, 12));
  return true;
}

/**
 * Loads `url` in the tab and measures it. `edit`: the editor's address; the
 * bench types "q" at the end of the typing line until the line shows it, then
 * waits for the server to store it.
 */
export async function load(tab: Tab, proxy: Proxy, docs: Docs, doc: { id: string; url: string }, opts: { edit: boolean }): Promise<Load & { requests: Hit[] }> {
  const { page } = tab;
  // The line's length now, as the server stores it (an earlier load may have typed in it).
  const before = lineLength(await docs.stored(doc.id));
  tab.reports = [];
  const first = proxy.hits.length;
  const startNode = now();
  const nav = page.goto(doc.url, { waitUntil: "commit", timeout: 60_000 }).catch((e) => e as Error);
  const deadline = startNode + 60_000;
  const find = <K extends Report["kind"]>(kind: K, f: (r: Extract<Report, { kind: K }>) => boolean = () => true) =>
    tab.reports.find((r) => r.kind == kind && f(r as any)) as Extract<Report, { kind: K }> | undefined;
  // The top page's start (about:blank's reports aside). Not by its address: the page may change its own.
  const origin = () => find("nav", (r) => r.href.startsWith("http"))?.origin;
  /** A report from this load's top page. */
  const top = (r: { origin: number }) => r.origin == origin();

  let editable: number | undefined, saved: number | undefined;
  if (opts.edit) {
    // Click and type until the line changes on screen: a try each 25 ms at most.
    let changed: Extract<Report, { kind: "text" }> | undefined, tries = 0;
    while (!(changed = find("text", (r) => r.len > before)) && now() < deadline) {
      const t = now();
      if (await clickLineEnd(page).catch(() => false)) { await page.keyboard.type("q").catch(() => {}); tries++; }
      await sleep(Math.max(1, 25 - (now() - t)));
    }
    if (!changed) throw new Error(`${doc.url}: the editor took no input within 60 s (the line: ${before} characters; seen: ${JSON.stringify(tab.reports.filter((r) => r.kind == "text"))})`);
    if (process.env.BENCH_DEBUG) console.error(`  ${doc.url}: ${tries} tries`);
    while (!origin() && now() < deadline) await sleep(10);
    editable = changed.t - origin()!;
    // Stored on the server: the line with at least one more "q".
    for (;;) {
      if (lineLength(await docs.stored(doc.id)) > before) { saved = now() - startNode; break; }
      if (now() > deadline) throw new Error(`${doc.url}: the server didn't store the typed character within 60 s`);
      await sleep(15);
    }
  }
  while (!(find("visible") || find("text")) && now() < deadline) await sleep(10);
  while (!find("load", top) && now() < deadline) await sleep(10);
  const navError = await nav;
  if (navError instanceof Error) throw navError;

  // Settled: every request finished (WebSockets aside) and none new for 1 s (at most 15 s more).
  const settleBy = now() + 15_000;
  let count = -1, quietSince = now();
  while (now() < settleBy) {
    const mine = proxy.hits.slice(first);
    if (mine.length != count || mine.some((h) => !h.end && h.dest != "websocket")) { count = mine.length; quietSince = now(); }
    else if (now() - quietSince > 1000) break;
    await sleep(50);
  }

  const o = origin()!;
  const at = (t: number | undefined) => (t ? Math.round(t - o) : NaN);
  const visibleAt = find("visible")?.t ?? find("text")?.t;
  const hits = proxy.hits.slice(first);
  const milestone = opts.edit ? o + editable! : visibleAt ?? Infinity;
  const loaded = find("load", top);
  return {
    ttfb: at(loaded?.ttfb), fcp: at(find("fcp", top)?.t), visible: at(visibleAt), load: at(loaded?.t),
    ...(opts.edit ? { editable: Math.round(editable!), saved: Math.round(saved!) } : {}),
    reqs: hits.length,
    kB: Math.round(hits.reduce((n, h) => n + h.bytes, 0) / 102.4) / 10,
    docs: hits.filter(isDoc).length,
    docChain: longestChain(hits.filter(isDoc)),
    chain: longestChain(hits.filter((h) => h.end && h.end <= milestone && h.dest != "websocket")),
    ws: hits.filter((h) => h.dest == "websocket").length,
    requests: hits,
  };
}

const isDoc = (h: Hit) => h.dest == "document" || h.dest == "iframe" || h.dest == "frame";

/** The longest chain of requests where each starts after the one before has finished: round trips one after another. */
function longestChain(hits: Hit[]): number {
  const done = hits.filter((h) => h.end).sort((a, b) => a.start - b.start);
  const depth: number[] = [];
  done.forEach((h, i) => { depth[i] = 1 + Math.max(0, ...done.slice(0, i).map((p, j) => (p.end <= h.start ? depth[j] : 0))); });
  return Math.max(0, ...depth);
}

/**
 * Types `n` characters at the end of the typing line, one each `gapMs` (a
 * fast typist), in an editor that is loaded and ready: for each, the time
 * from the key press to the paint that shows it on the page.
 */
export async function keystrokes(tab: Tab, docs: Docs, id: string, n: number, gapMs: number): Promise<Keys> {
  const { page } = tab;
  const start = lineLength(await docs.stored(id));
  if (!(await clickLineEnd(page))) throw new Error("no line to type in");
  await sleep(300);
  tab.reports = [];
  for (let i = 0; i < n; i++) {
    const t = now();
    await page.keyboard.type("abcdefghijklmnopqrstuvwxyz"[i % 26]);
    await sleep(Math.max(0, gapMs - (now() - t)));
  }
  const until = now() + 2000;
  while (now() < until && !tab.reports.some((r) => r.kind == "text" && r.len >= start + n)) await sleep(20);
  const keys = tab.reports.filter((r) => r.kind == "key") as Extract<Report, { kind: "key" }>[];
  const texts = tab.reports.filter((r) => r.kind == "text") as Extract<Report, { kind: "text" }>[];
  const samples: number[] = [];
  let lost = n - keys.length;
  keys.forEach((k, i) => {
    const shown = texts.find((r) => r.len >= start + i + 1 && r.t >= k.t);
    if (shown) samples.push(Math.round((shown.t - k.t) * 10) / 10);
    else lost++;
  });
  return { samples, lost };
}

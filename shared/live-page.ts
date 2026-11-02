// The live page, for the agents: what the person's open editor tab can tell
// about the page as it runs there (not view_page's throwaway render), and do
// in it. The tab keeps three logs, each a ring with a cap:
//
//   the console    errors, warnings and logs from the editor's windows and the page's frames; identical
//                  messages collapse into one entry with a count and the first and last time
//   the network    each request of the page's frames: Resource Timing, what the page's fetch and XHR
//                  sent and got (method, Range, Content-Range), and what Erga's server added (Server-Timing)
//   the events     each pointer and key event on the page, and who consumed it (preventDefault,
//                  stopPropagation): the editor or the page
//
// page_console, page_network and page_events read them; page_inspect reads the
// page itself; page_click and page_key act on it, through the editor's own
// handlers. The host asks the person's tabs over the same path
// view_page uses (POST /api/agent/view): a ViewRequest with `live`.
//
// Pure: the logs and the words for the agent are here, tested in tests/live-page.test.ts;
// the tab's side is libs/text/ui/live-page-tab.ts.

import { plural } from "./time";

export type ConsoleLevel = "error" | "warn" | "info" | "log" | "debug";
export const CONSOLE_LEVELS: ConsoleLevel[] = ["error", "warn", "info", "log", "debug"];

/** The agent's request to the live page, by tool. */
export type LiveRequest =
  | { kind: "console"; levels?: ConsoleLevel[]; pattern?: string; since?: number; limit?: number }
  | { kind: "network"; pattern?: string; since?: number; limit?: number; failed?: boolean }
  | { kind: "events"; since?: number; limit?: number }
  | { kind: "inspect"; expression?: string; frame?: string; timeout?: number }
  | { kind: "click"; selector?: string; x?: number; y?: number; frame?: string }
  | { kind: "key"; key: string; selector?: string; frame?: string; shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean };

/** page_click and page_key act; the rest only read. */
export const actsOnPage = (r: LiveRequest) => r.kind == "click" || r.kind == "key";
/** page_inspect, page_click and page_key show a line in the tab each time (the person sees what the agent does there). */
export const shownInTab = (r: LiveRequest) => r.kind == "inspect" || actsOnPage(r);

// ------------------------------------------------------------------ the console

export interface ConsoleEntry {
  level: ConsoleLevel;
  text: string;
  /** Where: "editor" (the editor's own window), "page" (the page's frame), "page frame <src>" (a frame inside it). */
  source: string;
  count: number;
  /** When it was first and last logged (ms since the epoch). */
  first: number;
  last: number;
}

/** The longest message kept: a message longer than this is cut (and collapses with the others cut the same). */
export const CONSOLE_TEXT_MAX = 2000;

/**
 * The console, as a ring of distinct messages: an identical message (same
 * level, source and text) adds to its entry's count and moves it to the end.
 * Past `max` distinct messages, the oldest goes (and counts as dropped).
 */
export class ConsoleLog {
  private readonly byKey = new Map<string, ConsoleEntry>();
  total = 0;
  dropped = 0;
  constructor(readonly max = 500) {}

  add(level: ConsoleLevel, text: string, source: string, at = Date.now()): void {
    const t = text.length > CONSOLE_TEXT_MAX ? text.slice(0, CONSOLE_TEXT_MAX) + "…" : text;
    const key = `${level}\u0000${source}\u0000${t}`;
    this.total++;
    const e = this.byKey.get(key);
    if (e) {
      e.count++;
      e.last = Math.max(e.last, at);
      this.byKey.delete(key);
      this.byKey.set(key, e);
      return;
    }
    this.byKey.set(key, { level, text: t, source, count: 1, first: at, last: at });
    if (this.byKey.size > this.max) {
      const oldest = this.byKey.keys().next().value!;
      this.dropped += this.byKey.get(oldest)!.count;
      this.byKey.delete(oldest);
    }
  }

  /** Every entry, oldest last-seen first. */
  entries(): ConsoleEntry[] { return [...this.byKey.values()].map((e) => ({ ...e })); }
}

/** A pattern as the agent gives it: a regular expression (case-insensitive), or, if it isn't one, plain text. */
export function matcher(pattern: string | undefined): (s: string) => boolean {
  if (!pattern) return () => true;
  try { const re = new RegExp(pattern, "i"); return (s) => re.test(s); } catch {
    const p = pattern.toLowerCase();
    return (s) => s.toLowerCase().includes(p);
  }
}

/**
 * The entries a page_console request asks for: by level, pattern and time
 * (an entry seen at or after `since`), the last `limit` of them. Entries from
 * several logs (the editor's, the page's) go together, by when last seen.
 */
export function queryConsole(entries: ConsoleEntry[], q: { levels?: ConsoleLevel[]; pattern?: string; since?: number; limit?: number }): { entries: ConsoleEntry[]; matched: number } {
  const levels = q.levels?.length ? new Set(q.levels) : null;
  const test = matcher(q.pattern);
  const found = entries
    .filter((e) => (!levels || levels.has(e.level)) && (q.since == null || e.last >= q.since) && (test(e.text) || test(e.source)))
    .sort((a, b) => a.last - b.last);
  const limit = clampLimit(q.limit, 50, 200);
  return { entries: found.slice(-limit), matched: found.length };
}

const clampLimit = (n: number | undefined, dflt: number, max: number) => Math.max(1, Math.min(max, Math.floor(Number(n) || dflt)));

// ------------------------------------------------------------------ the network

/** The fields of a PerformanceResourceTiming the log reads (any browser may lack some). */
export interface TimingLike {
  name: string;
  initiatorType?: string;
  startTime: number;
  duration: number;
  responseStatus?: number;
  contentType?: string;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  workerStart?: number;
  deliveryType?: string;
  serverTiming?: readonly { name: string; description: string; duration?: number }[];
}

/** What the page's own fetch or XHR saw of one request: the headers Resource Timing can't show. */
export interface HookedRequest {
  url: string;
  method: string;
  /** The request's Range header. */
  range?: string;
  status?: number;
  type?: string;
  contentRange?: string;
  length?: number;
  error?: string;
  /** When it started (ms since the epoch). */
  at: number;
  via: "fetch" | "xhr";
}

export interface NetworkEntry {
  url: string;
  method?: string;
  status?: number;
  type?: string;
  /** Bytes: over the wire (0 from a cache), and the body before and after decoding. */
  transfer?: number;
  size?: number;
  /** The request's Range, and the response's Content-Range (from the page's fetch or XHR, or Erga's Server-Timing). */
  range?: string;
  contentRange?: string;
  /** When it started (ms since the epoch) and how long it took (ms). */
  at: number;
  duration: number;
  /** Who asked: "audio", "img", "script", "fetch", "xmlhttprequest", "navigation"... */
  initiator?: string;
  /** "erga": one of the document's files, from Erga's server; "service worker"; "cache"; "network". */
  via: string;
  /** What Erga's server said of it (its Server-Timing: which store, the bytes it sent). */
  erga?: string;
  error?: string;
  /** Which frame: "page", or "page frame <src>". */
  frame: string;
}

/**
 * One Resource Timing entry as a log line: `origin` is the frame's
 * performance.timeOrigin, `docBase` the address of the document's files
 * (".../doc/"), so a file from Erga's server says so.
 */
export function fromTiming(t: TimingLike, origin: number, docBase: string, frame: string): NetworkEntry {
  const erga = t.serverTiming?.find((s) => s.name == "file");
  const ours = t.name.startsWith(docBase);
  const via = t.workerStart && t.workerStart > 0 ? "service worker"
    : ours ? "erga"
    : t.deliveryType == "cache" || (t.transferSize === 0 && (t.decodedBodySize ?? 0) > 0) ? "cache"
    : "network";
  const e: NetworkEntry = { url: t.name, at: Math.round(origin + t.startTime), duration: Math.round(t.duration), via, frame };
  if (t.initiatorType) e.initiator = t.initiatorType;
  if (t.responseStatus) e.status = t.responseStatus;
  if (t.contentType) e.type = t.contentType;
  if (t.transferSize != null) e.transfer = t.transferSize;
  if (t.decodedBodySize) e.size = t.decodedBodySize;
  if (erga?.description) {
    e.erga = erga.description;
    const bytes = /\bbytes (\d+-\d+\/(?:\d+|\*))/.exec(erga.description);
    if (bytes) e.contentRange = `bytes ${bytes[1]}`;
    const type = /\btype ([\w.+-]+\/[\w.+-]+)/.exec(erga.description);
    if (type && !e.type) e.type = type[1];
  }
  return e;
}

/** Adds what the page's own fetch or XHR saw to the timing entry for the same request: the nearest in time, same URL. */
export function mergeHooked(entries: NetworkEntry[], hooked: HookedRequest[]): NetworkEntry[] {
  const out = entries.map((e) => ({ ...e }));
  const used = new Set<NetworkEntry>();
  for (const h of hooked) {
    let best: NetworkEntry | null = null;
    for (const e of out) {
      if (used.has(e) || e.url != h.url || Math.abs(e.at - h.at) > 2000) continue;
      if (!best || Math.abs(e.at - h.at) < Math.abs(best.at - h.at)) best = e;
    }
    const e = best ?? { url: h.url, at: h.at, duration: 0, via: "network", frame: "page", initiator: h.via == "xhr" ? "xmlhttprequest" : "fetch" } as NetworkEntry;
    if (!best) out.push(e);
    used.add(e);
    e.method = h.method;
    if (h.range) e.range = h.range;
    if (h.status != null && h.status > 0) e.status = h.status;
    if (h.type) e.type = h.type;
    if (h.contentRange) e.contentRange = h.contentRange;
    if (h.error) e.error = h.error;
  }
  return out;
}

/** The entries a page_network request asks for: by pattern (on the URL, the type and the error), time, and failures only. */
export function queryNetwork(entries: NetworkEntry[], q: { pattern?: string; since?: number; limit?: number; failed?: boolean }): { entries: NetworkEntry[]; matched: number } {
  const test = matcher(q.pattern);
  const failed = (e: NetworkEntry) => !!e.error || (e.status != null && e.status >= 400);
  const found = entries
    .filter((e) => (q.since == null || e.at >= q.since) && (!q.failed || failed(e)) && (test(e.url) || test(e.type ?? "") || test(e.error ?? "")))
    .sort((a, b) => a.at - b.at);
  const limit = clampLimit(q.limit, 50, 300);
  return { entries: found.slice(-limit), matched: found.length };
}

// ------------------------------------------------------------------ the events

/** Who stopped an event: what they called, whose code it was, and on which element their listener was. */
export interface Consumer {
  how: "preventDefault" | "stopPropagation" | "stopImmediatePropagation";
  by: "editor" | "page";
  /** The element (or "document", "window") whose listener called it, and the phase. */
  on: string;
  phase: "capture" | "target" | "bubble" | "none";
  /** The page's script and line, when the page's code did it. */
  where?: string;
}

export interface EventEntry {
  at: number;
  type: string;
  target: string;
  trusted: boolean;
  /** Sent by page_click or page_key. */
  agent?: boolean;
  defaultPrevented: boolean;
  consumed: Consumer[];
  frame: string;
}

export const EVENT_TYPES = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keydown", "keyup", "touchstart", "touchend"];

/** The event log's entries since `since`, the last `limit`. */
export function queryEvents(entries: EventEntry[], q: { since?: number; limit?: number }): { entries: EventEntry[]; matched: number } {
  const found = entries.filter((e) => q.since == null || e.at >= q.since).sort((a, b) => a.at - b.at);
  const limit = clampLimit(q.limit, 40, 200);
  return { entries: found.slice(-limit), matched: found.length };
}

/** A ring: the newest `max` items. */
export class Ring<T> {
  private items: T[] = [];
  dropped = 0;
  constructor(readonly max: number) {}
  push(item: T): void { this.items.push(item); if (this.items.length > this.max) { this.items.shift(); this.dropped++; } }
  all(): T[] { return [...this.items]; }
}

// ------------------------------------------------------------------ times

/**
 * The agent's `since`: an ISO time, ms since the epoch, or how long ago
 * ("30s", "5m", "2h"). Null when there's none; throws when it can't be read.
 */
export function parseSince(raw: string | number | undefined | null, now = Date.now()): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw == "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim();
  const ago = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)(?:\s*ago)?$/i.exec(s);
  if (ago) return now - Number(ago[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[ago[2].toLowerCase() as "ms" | "s" | "m" | "h"];
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  throw new Error(`since "${s}" isn't a time: give an ISO time, or how long ago ("30s", "5m", "2h").`);
}

/** A time as the agent reads it: the clock time to the millisecond (UTC), short. */
export const clock = (ms: number) => new Date(ms).toISOString().slice(11, 23);

// ------------------------------------------------------------------ the tab's answer

/** What a tab answers: the request's result (by kind), where it came from, or why it couldn't. */
export interface LiveResult {
  /** Which page the tab has open, and whether it's in sight and focused. */
  tab?: { page: string; visible: boolean; focused: boolean };
  console?: { entries: ConsoleEntry[]; matched: number; total: number; dropped: number };
  network?: { entries: NetworkEntry[]; matched: number; dropped: number; note?: string };
  events?: { entries: EventEntry[]; matched: number };
  inspect?: { value?: string; note?: string; error?: string; facts?: unknown };
  act?: ActResult;
  error?: string;
}

/** What page_click and page_key did. */
export interface ActResult {
  /** What the event reached (the element at the point, or the selector's), and what is on top there if something else is. */
  target: string;
  covered?: string;
  at?: { x: number; y: number };
  events: string[];
  /** Always false for an event a script sends: the browser marks it untrusted. */
  trusted: boolean;
  activation: { before: Activation; after: Activation };
  consumed: Consumer[];
  defaultPrevented: boolean;
  /** The page's media after the event (each element's state). */
  media?: unknown[];
  /** The console's new entries in the moment after. */
  console?: ConsoleEntry[];
}

export interface Activation { isActive: boolean; hasBeenActive: boolean }

// ------------------------------------------------------------------ the words for the agent


export function describeConsole(r: NonNullable<LiveResult["console"]>): string {
  if (!r.entries.length) return r.total ? `No console messages match (the tab has logged ${plural(r.total, "message")}).` : "The console is empty: nothing logged since the page loaded in this tab.";
  const lines = r.entries.map((e) => `${e.count > 1 ? `[×${e.count}, ${clock(e.first)}–${clock(e.last)}]` : `[${clock(e.last)}]`} ${e.level} (${e.source}): ${e.text}`);
  const head = `${plural(r.matched, "distinct message")} match${r.matched > r.entries.length ? `; the last ${r.entries.length} shown` : ""}. ${plural(r.total, "message")} logged in all${r.dropped ? `; ${r.dropped} older ones dropped from the ring` : ""}.`;
  return `${head}\n${lines.join("\n")}`;
}

const bytes = (n: number) => n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

export function describeNetwork(r: NonNullable<LiveResult["network"]>): string {
  if (!r.entries.length) return `No requests match.${r.note ? `\n${r.note}` : ""}`;
  const lines = r.entries.map((e) => {
    const parts = [
      `[${clock(e.at)}]`, e.method ?? "GET", e.url,
      e.error ? `failed: ${e.error}` : e.status ? String(e.status) : "status unknown",
      e.type ?? "", e.size != null ? bytes(e.size) : "",
      e.range ? `Range: ${e.range}` : "", e.contentRange ? `Content-Range: ${e.contentRange}` : "",
      `${e.duration} ms`, `(${[e.initiator, `via ${e.via}`, e.frame != "page" ? e.frame : ""].filter(Boolean).join(", ")})`,
      e.erga ? `Erga: ${e.erga}` : "",
    ];
    return parts.filter(Boolean).join("  ");
  });
  return `${plural(r.matched, "request")} match${r.matched > r.entries.length ? `; the last ${r.entries.length} shown` : ""}${r.dropped ? `; ${r.dropped} older dropped` : ""}.\n${lines.join("\n")}${r.note ? `\n${r.note}` : ""}`;
}

export const describeConsumer = (c: Consumer) => `the ${c.by} called ${c.how} (its listener on ${c.on}, ${c.phase} phase${c.where ? `, ${c.where}` : ""})`;

export function describeEvents(r: NonNullable<LiveResult["events"]>): string {
  if (!r.entries.length) return "No pointer or key events on the page yet.";
  const lines = r.entries.map((e) => {
    const who = e.consumed.length ? e.consumed.map(describeConsumer).join("; ") : "nobody consumed it";
    return `[${clock(e.at)}] ${e.type} on ${e.target}${e.frame != "page" ? ` (${e.frame})` : ""}, ${e.agent ? "sent by the agent, " : ""}${e.trusted ? "trusted" : "untrusted"}: ${who}${e.defaultPrevented && !e.consumed.some((c) => c.how == "preventDefault") ? " (default prevented)" : ""}`;
  });
  return `${plural(r.matched, "event")}${r.matched > r.entries.length ? `; the last ${r.entries.length} shown` : ""}.\n${lines.join("\n")}`;
}

const act = (a: Activation) => `isActive ${a.isActive}, hasBeenActive ${a.hasBeenActive}`;

export function describeAct(kind: "click" | "key", a: ActResult): string {
  const out = [
    `${kind == "click" ? "Clicked" : "Pressed a key on"} ${a.target}${a.at ? ` at (${Math.round(a.at.x)}, ${Math.round(a.at.y)})` : ""}: ${a.events.join(", ")}.`,
    ...(a.covered ? [`Note: at that point the page shows ${a.covered} on top, so a person's click there would reach it instead.`] : []),
    `Trusted: ${a.trusted} (the browser marks every event a script sends untrusted, so it gives no user activation of its own).`,
    `User activation in the page's frame: before ${act(a.activation.before)}; after ${act(a.activation.after)}.`,
    a.consumed.length ? `Consumed: ${a.consumed.map(describeConsumer).join("; ")}.` : "Nobody called preventDefault or stopPropagation on it.",
  ];
  if (a.media?.length) out.push(`The page's media after: ${JSON.stringify(a.media)}`);
  if (a.console?.length) out.push(`The console right after:\n${a.console.map((e) => `${e.level} (${e.source}): ${e.text}${e.count > 1 ? ` [×${e.count}]` : ""}`).join("\n")}`);
  return out.join("\n");
}

/** Where the answer came from, in words: which page, and the tab's state. */
export const describeTab = (t: LiveResult["tab"]) => t ? `(From ${t.page} in the person's ${t.focused ? "focused" : t.visible ? "visible" : "background"} tab.)` : "";

/**
 * The page's first script (a function, as its text goes into the page, so
 * it refers to nothing outside itself). `o.events` and `o.net` turn the event
 * and request watches on (off for the editor's own window, which only logs).
 */
export function liveWatch(o: { events: boolean; net: boolean; types: string[] }): void {
  // (The page's window, loosely typed: this module is the server's too, which has no DOM types.)
  const w = globalThis as any;
  if (w.__ergaLiveInstalled) return;
  w.__ergaLiveInstalled = true;
  let q: [string, unknown][] = [];
  const send = (kind: string, data: unknown) => {
    const s = w.__ergaLiveSink;
    if (s) { try { s(kind, data); } catch { /* the editor's to handle */ } }
    else if (q.length < 5000) q.push([kind, data]);
  };
  w.__ergaLiveTake = (sink: (k: string, d: unknown) => void) => { w.__ergaLiveSink = sink; const held = q; q = []; for (const [k, d] of held) sink(k, d); };
  const text = (x: unknown): string => {
    if (typeof x == "string") return x;
    if (x instanceof Error) return `${x.name}: ${x.message}`;
    if (x && typeof x == "object") {
      if ((x as { nodeType?: number }).nodeType == 1) { const el = x as { localName: string; id: string }; return `<${el.localName}${el.id ? "#" + el.id : ""}>`; }
      try { const j = JSON.stringify(x); if (j !== undefined) return j.length > 500 ? j.slice(0, 500) + "…" : j; } catch { /* a cycle */ }
    }
    return String(x);
  };
  const con = w.console as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const level of ["error", "warn", "info", "log", "debug"]) {
    const orig = con[level];
    if (typeof orig != "function") continue;
    con[level] = function (this: unknown, ...args: unknown[]) {
      try {
        // console.log("%c styled", "css"): the format's %c parts are the page's styling, not its words.
        let a = args;
        if (typeof a[0] == "string" && a[0].includes("%c")) { const n = (a[0].match(/%c/g) ?? []).length; a = [a[0].replace(/%c/g, ""), ...a.slice(1 + n)]; }
        send("console", { level, text: a.map(text).join(" "), at: Date.now() });
      } catch { /* never in the page's way */ }
      return orig.apply(this, args);
    };
  }
  const MEDIA_ERR = ["", "MEDIA_ERR_ABORTED", "MEDIA_ERR_NETWORK", "MEDIA_ERR_DECODE", "MEDIA_ERR_SRC_NOT_SUPPORTED"];
  w.addEventListener("error", (e: any) => {
    const t = e.target as any;
    if (t && (t as unknown) !== w && t.nodeType == 1) {
      const media = t.localName == "audio" || t.localName == "video";
      const src = t.getAttribute("src") || t.getAttribute("href") || (media ? t.currentSrc : "") || "";
      const why = media && t.error ? ` (${MEDIA_ERR[t.error.code] ?? t.error.code}${t.error.message ? `: ${t.error.message}` : ""})` : "";
      send("console", { level: "error", text: `<${t.localName}${t.id ? "#" + t.id : ""}> failed to load ${src || "its source"}${why}`, at: Date.now() });
    } else {
      const ev = e;
      send("console", { level: "error", text: `Uncaught ${ev.error instanceof Error ? `${ev.error.name}: ${ev.error.message}` : ev.message}${ev.filename ? ` (${ev.filename}${ev.lineno ? `:${ev.lineno}` : ""})` : ""}`, at: Date.now() });
    }
  }, true);
  w.addEventListener("unhandledrejection", (e: any) => send("console", { level: "error", text: `Unhandled rejection: ${text(e.reason)}`, at: Date.now() }));
  if (o.net) {
    try { w.performance.setResourceTimingBufferSize(2000); } catch { /* not here */ }
    const of = w.fetch;
    if (typeof of == "function") {
      w.fetch = function (this: unknown, input: any, init?: any) {
        const at = Date.now();
        let url = "", method = "GET", range: string | undefined;
        try {
          const req = input instanceof w.Request ? input : null;
          url = new URL(req ? req.url : String(input), w.location.href).href;
          method = (init?.method ?? req?.method ?? "GET").toUpperCase();
          range = new w.Headers(init?.headers ?? req?.headers).get("range") ?? undefined;
        } catch { /* the request will say what's wrong */ }
        const p = of.call(this, input, init);
        p.then((r: any) => send("request", { url, method, range, status: r.status, type: r.headers.get("content-type") ?? undefined, contentRange: r.headers.get("content-range") ?? undefined, length: Number(r.headers.get("content-length")) || undefined, at, via: "fetch" }),
          (err: unknown) => send("request", { url, method, range, error: text(err), at, via: "fetch" }));
        return p;
      };
    }
    const X = w.XMLHttpRequest?.prototype;
    if (X) {
      const open = X.open, setHeader = X.setRequestHeader, sendX = X.send;
      type Rec = { url: string; method: string; range?: string; at: number };
      const recs = new WeakMap<object, Rec>();
      X.open = function (this: any, method: string, url: unknown, ...rest: unknown[]) {
        try { recs.set(this, { url: new URL(String(url), w.location.href).href, method: String(method).toUpperCase(), at: 0 }); } catch { /* as the browser will say */ }
        return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
      };
      X.setRequestHeader = function (this: any, name: string, value: string) {
        const r = recs.get(this);
        if (r && name.toLowerCase() == "range") r.range = value;
        return setHeader.call(this, name, value);
      };
      X.send = function (this: any, body?: unknown) {
        const r = recs.get(this);
        if (r) {
          r.at = Date.now();
          this.addEventListener("loadend", () => {
            const failed = this.status == 0;
            send("request", { url: r.url, method: r.method, range: r.range, at: r.at, via: "xhr", ...(failed ? { error: "the request failed (network error, CORS, or aborted)" } : { status: this.status, type: this.getResponseHeader("content-type") ?? undefined, contentRange: this.getResponseHeader("content-range") ?? undefined }) });
          });
        }
        return sendX.call(this, body);
      };
    }
  }
  if (o.events) {
    const watched = new Set(o.types);
    const P = w.Event.prototype as Record<string, (...a: unknown[]) => unknown>;
    for (const how of ["preventDefault", "stopPropagation", "stopImmediatePropagation"]) {
      const orig = P[how];
      P[how] = function (this: any, ...a: unknown[]) {
        try { if (watched.has(this.type)) send("consume", { ev: this, how, phase: this.eventPhase, on: this.currentTarget, stack: String(new Error().stack ?? "") }); } catch { /* never in the page's way */ }
        return orig.apply(this, a);
      };
    }
    // At the window, in the capture phase, before anyone else's listener: every event, consumed or not.
    for (const type of o.types) w.addEventListener(type, (e: unknown) => send("event", e), true);
  }
}

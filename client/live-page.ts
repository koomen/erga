// The live page, in the editor's frame (frame.ts, on the document's own
// origin): the logs the agent's page_console, page_network and page_events
// read, page_inspect's run in the page as it is, and page_click and page_key
// (shared/live-page.ts says what each one is).
//
// The page's frame is on this origin too, so the editor reaches into it. Its
// first script (LIVE_WATCH, before the page's own) catches what happens from
// the start: console calls, errors, the page's fetch and XHR, and who calls
// preventDefault or stopPropagation on a pointer or key event. It keeps them
// until the editor takes them (`__ergaLiveTake`), and hands each over as it
// comes after. A frame inside the page, on this origin, gets the same once it
// loads (what it logged before is missed); one on another origin is out of
// reach, and the answers say so.
//
// Whose code consumed an event is read from the stack: a frame of the
// editor's own script (frame.js) is the editor's, anything else the page's.

import {
  ConsoleLog, EVENT_TYPES, Ring, fromTiming, mergeHooked, queryConsole, queryEvents, queryNetwork,
  type ActResult, type Activation, type ConsoleLevel, type Consumer, type EventEntry, type HookedRequest, type LiveRequest, type LiveResult, type NetworkEntry,
} from "../shared/live-page";
import { evaluateIn, toJSON } from "./evaluate";
import { EVAL_MAX_JSON, evalTimeout } from "../shared/agent-log";

type LiveWindow = Window & typeof globalThis & { __ergaLiveInstalled?: boolean; __ergaLiveTake?: (sink: Sink) => void };
type Sink = (kind: string, data: unknown) => void;

/**
 * The page's first script (a function, as its text goes into the page, so
 * it refers to nothing outside itself). `o.events` and `o.net` turn the event
 * and request watches on (off for the editor's own window, which only logs).
 */
export function liveWatch(o: { events: boolean; net: boolean; types: string[] }): void {
  const w = window as Window & typeof globalThis & { __ergaLiveInstalled?: boolean; __ergaLiveTake?: (s: (k: string, d: unknown) => void) => void; __ergaLiveSink?: (k: string, d: unknown) => void };
  if (w.__ergaLiveInstalled) return;
  w.__ergaLiveInstalled = true;
  let q: [string, unknown][] = [];
  const send = (kind: string, data: unknown) => {
    const s = w.__ergaLiveSink;
    if (s) { try { s(kind, data); } catch { /* the editor's to handle */ } }
    else if (q.length < 5000) q.push([kind, data]);
  };
  w.__ergaLiveTake = (sink) => { w.__ergaLiveSink = sink; const held = q; q = []; for (const [k, d] of held) sink(k, d); };
  const text = (x: unknown): string => {
    if (typeof x == "string") return x;
    if (x instanceof Error) return `${x.name}: ${x.message}`;
    if (x && typeof x == "object") {
      if ((x as Element).nodeType == 1) { const el = x as Element; return `<${el.localName}${el.id ? "#" + el.id : ""}>`; }
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
  w.addEventListener("error", (e) => {
    const t = e.target as (Element & { error?: MediaError | null; currentSrc?: string }) | null;
    if (t && (t as unknown) !== w && t.nodeType == 1) {
      const media = t.localName == "audio" || t.localName == "video";
      const src = t.getAttribute("src") || t.getAttribute("href") || (media ? t.currentSrc : "") || "";
      const why = media && t.error ? ` (${MEDIA_ERR[t.error.code] ?? t.error.code}${t.error.message ? `: ${t.error.message}` : ""})` : "";
      send("console", { level: "error", text: `<${t.localName}${t.id ? "#" + t.id : ""}> failed to load ${src || "its source"}${why}`, at: Date.now() });
    } else {
      const ev = e as ErrorEvent;
      send("console", { level: "error", text: `Uncaught ${ev.error instanceof Error ? `${ev.error.name}: ${ev.error.message}` : ev.message}${ev.filename ? ` (${ev.filename}${ev.lineno ? `:${ev.lineno}` : ""})` : ""}`, at: Date.now() });
    }
  }, true);
  w.addEventListener("unhandledrejection", (e) => send("console", { level: "error", text: `Unhandled rejection: ${text((e as PromiseRejectionEvent).reason)}`, at: Date.now() }));
  if (o.net) {
    try { w.performance.setResourceTimingBufferSize(2000); } catch { /* not here */ }
    const of = w.fetch;
    if (typeof of == "function") {
      w.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        const at = Date.now();
        let url = "", method = "GET", range: string | undefined;
        try {
          const req = input instanceof w.Request ? input : null;
          url = new URL(req ? req.url : String(input), w.location.href).href;
          method = (init?.method ?? req?.method ?? "GET").toUpperCase();
          range = new w.Headers(init?.headers ?? req?.headers).get("range") ?? undefined;
        } catch { /* the request will say what's wrong */ }
        const p = of.call(this, input as RequestInfo, init);
        p.then((r: Response) => send("request", { url, method, range, status: r.status, type: r.headers.get("content-type") ?? undefined, contentRange: r.headers.get("content-range") ?? undefined, length: Number(r.headers.get("content-length")) || undefined, at, via: "fetch" }),
          (err: unknown) => send("request", { url, method, range, error: text(err), at, via: "fetch" }));
        return p;
      } as typeof fetch;
    }
    const X = w.XMLHttpRequest?.prototype;
    if (X) {
      const open = X.open, setHeader = X.setRequestHeader, sendX = X.send;
      type Rec = { url: string; method: string; range?: string; at: number };
      const recs = new WeakMap<XMLHttpRequest, Rec>();
      X.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        try { recs.set(this, { url: new URL(String(url), w.location.href).href, method: String(method).toUpperCase(), at: 0 }); } catch { /* as the browser will say */ }
        return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
      } as typeof X.open;
      X.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
        const r = recs.get(this);
        if (r && name.toLowerCase() == "range") r.range = value;
        return setHeader.call(this, name, value);
      };
      X.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
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
    const P = w.Event.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const how of ["preventDefault", "stopPropagation", "stopImmediatePropagation"]) {
      const orig = P[how];
      P[how] = function (this: Event, ...a: unknown[]) {
        try { if (watched.has(this.type)) send("consume", { ev: this, how, phase: this.eventPhase, on: this.currentTarget, stack: String(new Error().stack ?? "") }); } catch { /* never in the page's way */ }
        return orig.apply(this, a);
      };
    }
    // At the window, in the capture phase, before anyone else's listener: every event, consumed or not.
    for (const type of o.types) w.addEventListener(type, (e) => send("event", e), true);
  }
}

/** LIVE_WATCH: the page's first script (editor.ts puts it in the page's <head>, after PROBLEM_WATCH). */
export const LIVE_WATCH = `<script data-erga>(${liveWatch.toString()})(${JSON.stringify({ events: true, net: true, types: EVENT_TYPES })})</script>`;

const describeEl = (x: unknown): string => {
  if (!x || typeof x != "object") return String(x);
  const n = x as Node & { localName?: string; id?: string; classList?: DOMTokenList };
  if ((x as Window).window === x) return "window";
  if (n.nodeType == 9) return "document";
  if (n.nodeType != 1) return n.nodeName ?? "?";
  const cls = n.classList ? [...n.classList].slice(0, 3).map((c) => `.${c}`).join("") : "";
  return `<${n.localName}${n.id ? `#${n.id}` : ""}${cls}>`;
};
const PHASE = ["none", "capture", "target", "bubble"] as const;
const READY = ["HAVE_NOTHING", "HAVE_METADATA", "HAVE_CURRENT_DATA", "HAVE_FUTURE_DATA", "HAVE_ENOUGH_DATA"];
const NETWORK = ["NETWORK_EMPTY", "NETWORK_IDLE", "NETWORK_LOADING", "NETWORK_NO_SOURCE"];
const MEDIA_ERR = ["", "MEDIA_ERR_ABORTED", "MEDIA_ERR_NETWORK", "MEDIA_ERR_DECODE", "MEDIA_ERR_SRC_NOT_SUPPORTED"];

/** One frame the editor watches: the page's own, or one inside it. */
interface Watched { win: LiveWindow; label: string; el: HTMLIFrameElement }

export class LivePage {
  readonly console = new ConsoleLog(500);
  private readonly timings = new Ring<NetworkEntry>(1500);
  private readonly hooked = new Ring<HookedRequest>(500);
  private readonly events = new Ring<EventEntry>(300);
  private readonly pending = new WeakMap<Event, EventEntry>();
  private readonly agentEvents = new WeakSet<Event>();
  private readonly attached = new WeakSet<Window>();
  private frames: Watched[] = [];
  /** Frames inside the page on another origin: the answers name them, as out of reach. */
  private foreign = new Set<string>();
  /** Whether the person has turned on agent control in this tab (the shell says). */
  control = false;
  private pageWin: LiveWindow | null = null;

  /** `editorScript`: the editor's own script's address (frame.js), how a stack shows the editor's code. */
  /** The address of the document's files (".../doc/"): a request there went to Erga's server. */
  private readonly docUrl: string;
  constructor(docBase: string, private readonly editorScript: string) { this.docUrl = new URL(docBase, location.href).href; }

  /** The editor's own window: its console, as "editor frame". */
  watchEditor(win: Window): void {
    liveWatch({ events: false, net: false, types: [] });
    (win as LiveWindow).__ergaLiveTake?.((kind, data) => { if (kind == "console") this.log(data, "editor frame"); });
  }

  /** The page's frame, after each render (a render puts the page in a new frame). */
  attach(el: HTMLIFrameElement): void {
    const win = el.contentWindow as LiveWindow | null;
    if (!win) return;
    this.pageWin = win;
    // The frames inside the last page went with it; this page's are found afresh.
    this.frames = [];
    this.foreign.clear();
    this.watch(win, "page", el);
  }

  private watch(win: LiveWindow, label: string, el: HTMLIFrameElement): void {
    let d: Document;
    try { d = win.document; } catch { this.foreign.add(label); return; }
    if (!this.frames.some((f) => f.win == win)) this.frames.push({ win, label, el });
    if (this.attached.has(win)) return;
    this.attached.add(win);
    // A frame inside the page, loaded without the editor's first script: it gets it now (it missed what came before).
    if (!win.__ergaLiveInstalled) {
      try { new win.Function(`(${liveWatch.toString()})(${JSON.stringify({ events: true, net: true, types: EVENT_TYPES })})`)(); } catch { /* a page that forbids it */ }
    }
    win.__ergaLiveTake?.((kind, data) => this.take(kind, data, label));
    const origin = win.performance.timeOrigin;
    try {
      const add = (list: PerformanceEntryList) => { for (const t of list) this.timings.push(fromTiming(t as unknown as PerformanceResourceTiming, origin, this.docUrl, label)); };
      const obs = new win.PerformanceObserver((l) => add(l.getEntries()));
      obs.observe({ type: "resource", buffered: true });
    } catch { /* no Resource Timing here */ }
    // Frames inside this one, now and as they come (and each time one loads another page).
    const look = (f: HTMLIFrameElement) => {
      const name = `${label == "page" ? "" : label + " > "}page frame ${f.getAttribute("src") ?? (f.hasAttribute("srcdoc") ? "(srcdoc)" : "(no src)")}`;
      const go = () => { const cw = f.contentWindow as LiveWindow | null; if (cw) this.watch(cw, name, f); };
      if (!(f as HTMLIFrameElement & { ergaLive?: boolean }).ergaLive) { (f as HTMLIFrameElement & { ergaLive?: boolean }).ergaLive = true; f.addEventListener("load", go); }
      go();
    };
    for (const f of d.querySelectorAll("iframe")) look(f);
    try {
      new win.MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if ((n as Element).localName == "iframe") look(n as HTMLIFrameElement); else if ((n as Element).querySelectorAll) for (const f of (n as Element).querySelectorAll("iframe")) look(f); })
        .observe(d.documentElement, { childList: true, subtree: true });
    } catch { /* gone */ }
  }

  private log(data: unknown, source: string): void {
    const c = data as { level?: string; text?: string; at?: number };
    if (typeof c?.text != "string") return;
    const level = (["error", "warn", "info", "log", "debug"].includes(String(c.level)) ? c.level : "log") as ConsoleLevel;
    this.console.add(level, c.text, source, Number(c.at) || Date.now());
  }

  private take(kind: string, data: unknown, frame: string): void {
    if (kind == "console") return this.log(data, frame);
    if (kind == "request") { this.hooked.push({ ...(data as HookedRequest) }); return; }
    if (kind == "event") { this.entryFor(data as Event, frame); return; }
    if (kind == "consume") {
      const c = data as { ev: Event; how: Consumer["how"]; phase: number; on: unknown; stack: string };
      const e = this.entryFor(c.ev, frame);
      const lines = c.stack.split("\n").slice(2).filter((l) => /\w/.test(l));
      const editor = lines.some((l) => l.includes(this.editorScript));
      const pageLine = lines.find((l) => !l.includes(this.editorScript) && /(https?:|about:srcdoc)/.test(l));
      const where = !editor && pageLine ? /(?:at\s+)?(?:.*?\()?((?:https?:|about:srcdoc)[^)\s]*)/.exec(pageLine)?.[1]?.replace(location.origin, "") : undefined;
      e.consumed.push({ how: c.how, by: editor ? "editor" : "page", on: describeEl(c.on), phase: PHASE[c.phase] ?? "none", ...(where ? { where } : {}) });
    }
  }

  /** The log's entry for an event: made as the event starts out, and finished (defaultPrevented) once it's been dispatched. */
  private entryFor(ev: Event, frame: string): EventEntry {
    let e = this.pending.get(ev);
    if (e) return e;
    e = { at: Date.now(), type: ev.type, target: describeEl(ev.target), trusted: ev.isTrusted, defaultPrevented: false, consumed: [], frame, ...(this.agentEvents.has(ev) ? { agent: true } : {}) };
    this.pending.set(ev, e);
    this.events.push(e);
    const entry = e;
    setTimeout(() => { entry.defaultPrevented = ev.defaultPrevented; }, 0);
    return e;
  }

  // ------------------------------------------------------------ answers

  /**
   * The answer to the agent's request, with the address of the document's files (which carries the token that opens
   * them) as doc/ wherever it appears.
   */
  async answer(req: LiveRequest): Promise<LiveResult> {
    const r = await this.result(req);
    return JSON.parse(JSON.stringify(r).split(this.docUrl).join("doc/")) as LiveResult;
  }

  private async result(req: LiveRequest): Promise<LiveResult> {
    switch (req.kind) {
      case "console": {
        // More than asked: the shell adds its own window's and takes the last `limit` of both.
        const r = queryConsole(this.console.entries(), { ...req, limit: 200 });
        return { console: { ...r, total: this.console.total, dropped: this.console.dropped } };
      }
      case "network": {
        const all = mergeHooked(this.timings.all(), this.hooked.all());
        const r = queryNetwork(all, req);
        const notes = [
          "doc/... is one of the document's own files, from Erga's server. Resource Timing shows no headers: a request's Range is known only for the page's own fetch and XHR; a response's Content-Range for those, and for the document's files (Erga's server says what it sent).",
          ...(this.foreign.size ? [`Out of reach (another origin): ${[...this.foreign].join(", ")}.`] : []),
        ];
        return { network: { ...r, dropped: this.timings.dropped, note: notes.join("\n") } };
      }
      case "events": return { events: queryEvents(this.events.all(), req) };
      case "inspect": return { inspect: await this.inspect(req) };
      case "click": case "key": {
        if (!this.control) return { error: "The person hasn't turned on \"Allow the agent to control this page\" in this tab. Ask them to turn it on (in the agent panel), then try again." };
        return await this.act(req);
      }
    }
  }

  /** The frame `which` names: "page" (the default), an iframe's CSS selector inside the page, or a label from the answers. */
  private frameFor(which: string | undefined): Watched | string {
    const page = this.frames.find((f) => f.win == this.pageWin);
    if (!page) return "The page isn't open in the editor in this tab.";
    if (!which || which == "page") return page;
    const byLabel = this.frames.find((f) => f.label == which);
    if (byLabel) return byLabel;
    let el: Element | null = null;
    try { el = page.win.document.querySelector(which); } catch { return `${which} isn't a valid CSS selector.`; }
    if (!el || el.localName != "iframe") return `Nothing on the page matches ${which} as an iframe. The frames: ${this.frames.map((f) => f.label).join(", ")}.`;
    const f = this.frames.find((x) => x.el == el);
    return f ?? `${which} is a frame on another origin: out of reach.`;
  }

  private async inspect(req: Extract<LiveRequest, { kind: "inspect" }>): Promise<NonNullable<LiveResult["inspect"]>> {
    const f = this.frameFor(req.frame);
    if (typeof f == "string") return { error: f };
    if (req.expression?.trim()) return await evaluateIn(f.win, req.expression, evalTimeout(req), { live: true });
    const facts = this.frames.filter((x) => x.el.isConnected || x.win == this.pageWin).map((x) => this.facts(x));
    const json = toJSON(facts, f.win);
    return { facts: JSON.parse(json.length > EVAL_MAX_JSON ? JSON.stringify(facts.map((x) => ({ ...x, media: `${(x.media as unknown[]).length} elements (too long to show)` }))) : json) };
  }

  /** The fixed facts of one frame: its sandbox and allow, its user activation, the autoplay policy, and each media element. */
  private facts(f: Watched): Record<string, unknown> {
    const w = f.win, d = w.document;
    const nav = w.navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean }; getAutoplayPolicy?: (t: string) => string };
    const policy = (d as Document & { permissionsPolicy?: { allowsFeature(f: string): boolean }; featurePolicy?: { allowsFeature(f: string): boolean } });
    const pp = policy.permissionsPolicy ?? policy.featurePolicy;
    return {
      frame: f.label,
      url: w.location.href,
      sandbox: f.el.getAttribute("sandbox"),
      allow: f.el.getAttribute("allow"),
      userActivation: nav.userActivation ? { isActive: nav.userActivation.isActive, hasBeenActive: nav.userActivation.hasBeenActive } : "not supported here",
      autoplay: {
        allowsFeature: pp ? pp.allowsFeature("autoplay") : "permissionsPolicy not supported here",
        fullscreen: pp ? pp.allowsFeature("fullscreen") : undefined,
        mediaelement: nav.getAutoplayPolicy ? nav.getAutoplayPolicy("mediaelement") : "getAutoplayPolicy not supported here",
        audiocontext: nav.getAutoplayPolicy ? nav.getAutoplayPolicy("audiocontext") : undefined,
      },
      media: mediaState(d),
    };
  }

  /** The page's user activation, as its frame sees it. */
  private activation(w: Window): Activation {
    const ua = (w.navigator as Navigator & { userActivation?: Activation }).userActivation;
    return { isActive: !!ua?.isActive, hasBeenActive: !!ua?.hasBeenActive };
  }

  /** page_click and page_key: the events a person's click or key makes, sent through the page (the editor's listeners on it, then the page's). */
  private async act(req: Extract<LiveRequest, { kind: "click" | "key" }>): Promise<LiveResult> {
    const f = this.frameFor(req.frame);
    if (typeof f == "string") return { error: f };
    const w = f.win, d = w.document;
    let target: Element | null = null, x = 0, y = 0;
    if (req.selector) {
      try { target = d.querySelector(req.selector); } catch { return { error: `${req.selector} isn't a valid CSS selector.` }; }
      if (!target) return { error: `Nothing on the page matches ${req.selector}.` };
      if (req.kind == "click") {
        target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        const r = target.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return { error: `${req.selector} has no size (${Math.round(r.width)}×${Math.round(r.height)}): it can't be clicked.` };
        x = r.left + r.width / 2; y = r.top + r.height / 2;
      }
    } else if (req.kind == "click") {
      if (!Number.isFinite(req.x) || !Number.isFinite(req.y)) return { error: "Give a selector, or x and y (the point in the page's window, in CSS pixels)." };
      x = req.x!; y = req.y!;
      target = d.elementFromPoint(x, y);
      if (!target) return { error: `Nothing is at (${x}, ${y}) in the page's window (${w.innerWidth}×${w.innerHeight}).` };
    } else target = d.activeElement ?? d.body;
    const top = req.kind == "click" ? d.elementFromPoint(x, y) : null;
    const covered = req.kind == "click" && top && top != target && !target!.contains(top) ? describeEl(top) : undefined;
    const before = this.activation(w);
    const since = Date.now();
    const sent: Event[] = [];
    const fire = (e: Event) => { this.agentEvents.add(e); sent.push(e); target!.dispatchEvent(e); };
    if (req.kind == "click") {
      const common = { bubbles: true, cancelable: true, composed: true, view: w, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
      fire(new w.PointerEvent("pointerdown", { ...common, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      fire(new w.MouseEvent("mousedown", { ...common, buttons: 1, detail: 1 }));
      if (target instanceof w.HTMLElement && target.tabIndex >= 0 && d.activeElement != target) target.focus({ preventScroll: true });
      fire(new w.PointerEvent("pointerup", { ...common, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      fire(new w.MouseEvent("mouseup", { ...common, buttons: 0, detail: 1 }));
      fire(new w.MouseEvent("click", { ...common, buttons: 0, detail: 1 }));
    } else {
      const key = String(req.key);
      const code = key.length == 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : key == " " ? "Space" : "") : key;
      const init = { bubbles: true, cancelable: true, composed: true, view: w, key, code, shiftKey: !!req.shift, altKey: !!req.alt, ctrlKey: !!req.ctrl, metaKey: !!req.meta };
      fire(new w.KeyboardEvent("keydown", init));
      fire(new w.KeyboardEvent("keyup", init));
    }
    // The page's handlers have run; what they started (a play(), a fetch) gets a moment to say how it went.
    await new Promise((r) => setTimeout(r, 400));
    const consumed = sent.flatMap((e) => (this.pending.get(e)?.consumed ?? []).map((c) => ({ ...c, on: `${c.on} (${e.type})` })));
    const act: ActResult = {
      target: describeEl(target),
      ...(covered ? { covered } : {}),
      ...(req.kind == "click" ? { at: { x, y } } : {}),
      events: sent.map((e) => e.type + (e.defaultPrevented ? " (default prevented)" : "")),
      trusted: sent.every((e) => e.isTrusted),
      activation: { before, after: this.activation(w) },
      consumed,
      defaultPrevented: sent.some((e) => e.defaultPrevented),
    };
    const media = mediaState(d);
    if (media.length) act.media = media;
    const fresh = queryConsole(this.console.entries(), { since, limit: 20 }).entries;
    if (fresh.length) act.console = fresh;
    return { act };
  }
}

/** Each audio and video element's state, in words the agent can read at once. */
export function mediaState(d: Document): Record<string, unknown>[] {
  return [...d.querySelectorAll<HTMLMediaElement>("audio, video")].slice(0, 20).map((m) => {
    const sources = [...m.querySelectorAll("source")].map((s) => ({ src: s.getAttribute("src"), type: s.getAttribute("type") }));
    const type = m.getAttribute("type") ?? sources[0]?.type ?? null;
    const buffered: string[] = [];
    for (let i = 0; i < m.buffered.length && i < 5; i++) buffered.push(`${m.buffered.start(i).toFixed(2)}-${m.buffered.end(i).toFixed(2)}`);
    return {
      element: describeEl(m),
      src: m.currentSrc || m.getAttribute("src") || null,
      ...(sources.length ? { sources } : {}),
      type,
      ...(type ? { canPlayType: m.canPlayType(type) || "no" } : {}),
      readyState: `${m.readyState} ${READY[m.readyState] ?? ""}`.trim(),
      networkState: `${m.networkState} ${NETWORK[m.networkState] ?? ""}`.trim(),
      paused: m.paused,
      ended: m.ended,
      currentTime: Math.round(m.currentTime * 1000) / 1000,
      duration: Number.isFinite(m.duration) ? Math.round(m.duration * 1000) / 1000 : String(m.duration),
      muted: m.muted,
      volume: m.volume,
      autoplay: m.autoplay,
      error: m.error ? { code: m.error.code, name: MEDIA_ERR[m.error.code] ?? "", message: m.error.message } : null,
      buffered,
    };
  });
}

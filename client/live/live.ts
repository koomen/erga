// Open pages across a redeploy, the page's side. The Worker adds this script
// to every page of the site's own: the editor,
// Documents, the admin pages, settings, the homepage. A document's own frame never gets it.
//
// A redeploy (or a restart of the dev server) drops every live connection:
// each script reconnects by itself and reads again what it shows
// and tells this
// one (live-client.ts: `connection`). If a connection stays down for a while,
// a small "Reconnecting…" note shows in a corner, and nothing else does.
//
// Then, the page's code. The server knows its release: the address of each
// of the editor's files, named by its content's hash (client/build.ts), at
// GET /api/release; and each
// page the Worker makes says which inline code it carries (its meta
// erga-build, a digest of its inline scripts: server/live.ts), which a GET of
// the page with X-Erga-Check: build answers in a header, without the page.
// This page asks after a connection comes back, after a request fails as a
// server going away fails, when the tab is shown again, and every
// minute. If none of the files it uses changed (it has each at the address the
// server names now), nothing happens. If only style.css did, the page takes
// the new one in place. Otherwise it reloads
// itself at a safe moment: not while you type, compose, drag or hold the
// mouse button, once what it holds is on the server (each script's `flush`),
// and at once if the tab is hidden. Before it reloads it keeps what it shows:
// the scroll of the page and of every panel, the form fields,
// the focus and the caret in them, and what each script keeps for itself
// (`keep`: the editor's caret and view, the open task on the board, the files
// attached to the agent's next message). The reloaded page puts it all back.
// A page that keeps reloading (two versions answering at once, while a
// deploy rolls out) waits longer each time.

import { RESTORE_KEY, restored, type Saved } from "./restore";
import type { ConnectionState, Live } from "./client";
import {
  CHECK_START,
  checkStep,
  isStrong,
  reloadStep,
  type CheckEvent,
  type CheckState,
  type ReloadEvent,
  type ReloadState,
} from "./release-state";
import { ASSET_PREFIX, stemOf } from "../../shared/assets";

declare global {
  /** The editor's files a page uses that its elements don't name, by name ("frame.js": the address it loaded): the viewer's, once editing. */
  interface Window { ergaBuilt?: Record<string, string> }
}

const KEYS = { last: "erga:live:reloads" };
const now = () => Date.now();
const nativeFetch = window.fetch.bind(window);
const session = {
  get(k: string) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { sessionStorage.setItem(k, v); return true; } catch { return false; } },
};

// ------------------------------------------------------------------ what the page tells us

const keepers = new Map<string, { save: () => unknown; everyReload: boolean }>();
const holds: (() => string | null)[] = [];
const flushes: (() => Promise<boolean>)[] = [];
let lastActivity = 0, pointerHeld = false, composing = false;
const connections = new Map<string, { state: ConnectionState; since: number; wasUp: boolean; note?: string | null }>();

const api: Live = {
  keep(name, save, opts) { keepers.set(name, { save, everyReload: !!opts?.everyReload }); },
  hold(why) { holds.push(why); },
  flush(fn) { flushes.push(fn); },
  activity() { lastActivity = now(); },
  connection(name, state, note) {
    if (state == null) {
      connections.delete(name);
      showNote();
      return;
    }
    const c = connections.get(name);
    if (c && c.state == state) return;
    // A connection first heard of as down was up before (only a page that connected reports a loss).
    connections.set(name, { state, since: now(), wasUp: c ? c.state == "up" : state != "up", note });
    // Back after being down: the server may be a new one. (The first connection is no news.)
    if (state == "up" && c && c.state == "down") {
      check("reconnected");
      recheckSoon();
    }
    showNote();
  },
  check: (why) => check(why),
  signedOut(fn) {
    if (out) fn();
    else outHeard.push(fn);
  },
};

// ------------------------------------------------------------------ signed out

// The server answers 401 to this page's own request, made as the person the page was made for: they are signed out
// (a sign-out on another device ends every session; a session ends after 30 days). Before, each loop of the page asked
// on, every few seconds, for as long as the tab was open. Now each stops (Live.signedOut), and the note says "Sign in".
let out = false;
const outHeard: (() => void)[] = [];
function signedOut() {
  if (out) return;
  out = true;
  for (const fn of outHeard.splice(0))
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  showNote();
}
/** A request of this page's own, as the person it was made for: with their cookie, and no token. */
function asMe(input: RequestInfo | URL, init?: RequestInit): boolean {
  const req = input instanceof Request ? input : null;
  const headers = new Headers(init?.headers ?? req?.headers);
  return (
    new URL(req ? req.url : String(input), location.href).origin == location.origin &&
    !headers.has("authorization") &&
    (init?.credentials ?? req?.credentials) != "omit" &&
    !!document.querySelector('[data-erga-account="in"]')
  );
}

for (const type of ["keydown", "input", "pointerdown", "wheel", "touchmove"]) addEventListener(type, () => { lastActivity = now(); }, { capture: true, passive: true });
addEventListener("pointerdown", () => { pointerHeld = true; }, true);
for (const type of ["pointerup", "pointercancel", "blur"]) addEventListener(type, () => { pointerHeld = false; }, true);
addEventListener("compositionstart", () => { composing = true; }, true);
addEventListener("compositionend", () => { composing = false; lastActivity = now(); }, true);

// ------------------------------------------------------------------ the note

// One quiet line at the foot of the window while a connection is down: after a few seconds (a restart passes unseen), at once when
// the browser itself says it's offline. A connection that is gone (its document was deleted) says so at once, and stays. It says what the connection asked it to (the editor's room: that the edits sync
// later), and goes when every connection is back. In the editor's colours where the page has them (client/style.css,
// client/styles/editor.css).
const NOTE_AFTER_MS = 4000;
let note: HTMLElement | null = null, noteTimer = 0;
function showNote() {
  clearTimeout(noteTimer);
  const gone = [...connections.values()].filter((c) => c.state == "gone");
  // (A connection with the note null says nothing while it's down: the editor's room, whose own note tells of edits not saved.)
  const down = gone.length ? gone : [...connections.values()].filter((c) => c.state == "down" && c.wasUp && c.note !== null);
  if (!out && !down.length) {
    note?.remove();
    note = null;
    return;
  }
  const left = !out && navigator.onLine && !gone.length ? Math.min(...down.map((c) => c.since)) + NOTE_AFTER_MS - now() : 0;
  if (left > 0) { noteTimer = window.setTimeout(showNote, left); return; }
  if (!note) {
    note = document.createElement("div");
    note.className = "erga-live-note";
    note.setAttribute("role", "status");
    note.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483646;white-space:nowrap;" +
      "font:500 12px/1.2 Inter,ui-sans-serif,system-ui,sans-serif;color:var(--soft,#6b6b73);background:var(--panel-bg,rgba(255,255,255,.92));" +
      "padding:6px 10px;border-radius:999px;box-shadow:0 0 0 1px var(--panel-border,rgba(0,0,0,.06)),0 2px 8px rgba(0,0,0,.08);pointer-events:none";
    document.body.append(note);
  }
  // Signed out: the note says so, with the way back in, to this page. It stays.
  if (out) {
    if (note.querySelector("a")) return;
    const a = Object.assign(document.createElement("a"), { textContent: "Sign in", href: "/auth/sign-in" });
    a.style.cssText = "color:var(--fg-strong,#1c1c1f);font-weight:600";
    a.addEventListener("click", () => {
      a.href = `/auth/sign-in?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
    });
    note.setAttribute("role", "alert");
    note.style.pointerEvents = "auto";
    note.replaceChildren("You are signed out. ", a);
    return;
  }
  note.textContent = down.find((c) => c.note)?.note ?? "Reconnecting…";
}
for (const type of ["online", "offline"]) addEventListener(type, () => showNote());

// ------------------------------------------------------------------ is this page current?

/**
 * The editor's files this page uses, as it has them: their addresses, by their stems ("/_erga/main": the same for every
 * build of a file). Its scripts and stylesheets, and the editor's page and frame once it's open (window.ergaBuilt).
 */
function inUse(): Map<string, string> {
  const out = new Map<string, string>();
  const add = (u: string | null | undefined) => {
    try { const path = u ? new URL(u, location.href).pathname : ""; if (path.startsWith(ASSET_PREFIX)) out.set(stemOf(path), path); } catch { /* not an address */ }
  };
  for (const s of document.querySelectorAll<HTMLScriptElement>("script[src]")) add(s.getAttribute("src"));
  for (const l of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) add(l.getAttribute("href"));
  for (const u of Object.values(window.ergaBuilt ?? {})) add(u);
  return out;
}

// Asks the server about this page's code: at most every few seconds; asked again meanwhile, once more after
// (release-state.ts, checkStep).
let checking: CheckState = CHECK_START,
  checkTimer = 0;
function checkGo(e: CheckEvent): void {
  const next = checkStep(checking, e);
  checking = next.state;
  for (const f of next.effects) {
    if (f.do == "wait") {
      clearTimeout(checkTimer);
      checkTimer = window.setTimeout(() => checkGo({ type: "timer", now: now() }), f.ms);
    } else
      run(f.why).then(
        () => checkGo({ type: "done", now: now() }),
        () => checkGo({ type: "failed" })
      );
  }
}
const check = (why: string) => checkGo({ type: "ask", why, now: now() });

/** While a deploy rolls out, the first answer may come from the old version: ask again a little later. */
let recheck: number[] = [];
function recheckSoon() {
  for (const t of recheck) clearTimeout(t);
  recheck = [10_000, 60_000].map((ms) => window.setTimeout(() => check("later"), ms));
}

/** The server's release when this page last asked (a deploy's version; the dev server's start). */
let release: string | null = null;

async function run(why: string): Promise<void> {
  const r = await nativeFetch("/api/release", { cache: "no-store", credentials: "same-origin" });
  if (!r.ok) throw new Error(`release: ${r.status}`);
  const { files, version } = await r.json() as { files: Record<string, string>; version?: string };
  const changed: string[] = [];
  const have = inUse();
  for (const [n, url] of Object.entries(files)) {
    const mine = have.get(stemOf(url));
    if (mine && mine != url) changed.push(n);
  }
  // The page's own inline code: the same page, as the server makes it now. Asked only when the server is another release
  // than last time, or when something went wrong (a request failed, a connection broke), not as it loads (the server
  // just made it) nor every minute (that would make the page again and again for nothing).
  const mine = document.querySelector<HTMLMetaElement>('meta[name="erga-build"]')?.content;
  const another = release != null && version != release;
  if (mine && why != "loaded" && (another || isStrong(why))) {
    const p = await nativeFetch(location.pathname + location.search, { headers: { "X-Erga-Check": "build" }, cache: "no-store", credentials: "same-origin", redirect: "manual" });
    const theirs = p.headers.get("x-erga-build");
    if (p.status >= 500) throw new Error(`page: ${p.status}`);
    if (theirs && theirs != mine) changed.push("page");
  }
  release = version ?? null;
  if (!changed.length) return;
  if (changed.every((n) => n == "style.css")) { restyle(files["style.css"]); return; }
  console.info(`erga: a new release (${changed.join(", ")}): this page reloads at the next quiet moment`);
  reloadSoon();
}

/** Only the stylesheet changed: the new one (at `url`) in place, the old one gone once it's in. */
function restyle(url: string) {
  for (const old of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const u = new URL(old.href, location.href);
    if (u.origin != location.origin || stemOf(u.pathname) != stemOf(url) || u.pathname == url) continue;
    const fresh = old.cloneNode() as HTMLLinkElement;
    fresh.href = url;
    fresh.onload = () => old.remove();
    old.after(fresh);
  }
}

// ------------------------------------------------------------------ reloading, at a safe moment

const QUIET_MS = 2500;


function blocker(): string | null {
  if (document.visibilityState == "hidden") return null;
  if (composing) return "composing";
  if (pointerHeld) return "pointer";
  if (now() - lastActivity < QUIET_MS) return "active";
  for (const h of holds) { try { const why = h(); if (why) return why; } catch { /* a broken hold doesn't hold */ } }
  return null;
}

/** A page that reloaded for a release a moment ago and is stale again waits: 0 s, 20 s, 40 s, 80 s... up to 10 minutes. */
function loopDelay(): number {
  let past: number[] = [];
  try { past = (JSON.parse(session.get(KEYS.last) || "[]") as number[]).filter((t) => now() - t < 15 * 60_000); } catch { /* none */ }
  return past.length ? Math.min(600_000, 10_000 * 2 ** past.length) - (now() - past[past.length - 1]) : 0;
}

// The reload, at a safe moment (release-state.ts, reloadStep).
let reloading: ReloadState = "current",
  reloadTimer = 0;
function reloadGo(e: ReloadEvent): void {
  const next = reloadStep(reloading, e);
  reloading = next.state;
  for (const f of next.effects) {
    if (f.do == "wait") {
      clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => reloadGo({ type: "timer", blocked: !!blocker() }), f.ms);
    } else if (f.do == "whenIdle") {
      const idle = () => reloadGo({ type: "idle", blocked: !!blocker() });
      if (document.visibilityState == "hidden" || !("requestIdleCallback" in window)) idle();
      else requestIdleCallback(idle, { timeout: 1000 });
    } else if (f.do == "flush") {
      void Promise.all(
        flushes.map((fn) => Promise.race([fn().catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]))
      ).then((flushed) => reloadGo({ type: "flushed", ok: !flushed.includes(false), blocked: !!blocker() }));
    } else reload();
  }
}
const reloadSoon = () => reloadGo({ type: "stale", delay: loopDelay() });

function reload() {
  checkGo({ type: "reloading" });
  keepAll([...keepers.keys()], false);
  let past: number[] = [];
  try { past = JSON.parse(session.get(KEYS.last) || "[]"); } catch { /* none */ }
  session.set(KEYS.last, JSON.stringify([...past.slice(-5), now()]));
  location.reload();
}

/** Keeps what the page shows and what the keepers named keep, for the reloaded page; `hand`: a reload by hand. */
function keepAll(names: string[], hand: boolean) {
  const keep: Record<string, unknown> = {};
  for (const name of names) { try { keep[name] = keepers.get(name)!.save(); } catch (e) { console.error(e); } }
  const saved: Saved = { url: location.pathname + location.search, at: now(), page: savePage(), keep, ...(hand ? { hand } : {}) };
  if (!session.set(RESTORE_KEY, JSON.stringify(saved))) {
    // Too much to keep (files attached to a draft, say): keep the rest.
    for (const [name, v] of Object.entries(keep)) if (JSON.stringify(v ?? null).length > 200_000) delete keep[name];
    session.set(RESTORE_KEY, JSON.stringify(saved));
  }
}

// A reload by hand, or the page left any other way: what the keepers that asked keep (everyReload), in case it's a reload.
// (Not on the way out of a reload for a release, which kept everything already.)
addEventListener("pagehide", () => {
  const names = [...keepers].filter(([, k]) => k.everyReload).map(([name]) => name);
  if (reloading != "reloading" && names.length) keepAll(names, true);
});

// ------------------------------------------------------------------ the page's own state

interface PageState {
  scroll: [string, number, number][];
  fields: [string, string | boolean][];
  details: [string, boolean][];
  focus?: { key: string; start?: number | null; end?: number | null };
}

/** An element's address in the page: its id, else its parent's address and its place there. */
function keyOf(el: Element): string | null {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e != document.documentElement; e = e.parentElement) {
    if (e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length == 1) { parts.unshift(`#${CSS.escape(e.id)}`); return parts.join(">"); }
    const p = e.parentElement;
    if (!p) return null;
    parts.unshift(`${e.tagName.toLowerCase()}:nth-child(${[...p.children].indexOf(e) + 1})`);
  }
  return parts.length ? `:root>${parts.join(">")}` : null;
}
const find = (key: string) => { try { return document.querySelector(key); } catch { return null; } };
const isField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
  el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && !["password", "file", "hidden", "submit", "button", "reset", "image"].includes(el.type));
const valueOf = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string | boolean =>
  el instanceof HTMLInputElement && (el.type == "checkbox" || el.type == "radio") ? el.checked : el.value;
const isDefault = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean =>
  el instanceof HTMLSelectElement ? [...el.options].every((o) => o.selected == o.defaultSelected)
    : el instanceof HTMLInputElement && (el.type == "checkbox" || el.type == "radio") ? el.checked == el.defaultChecked : el.value == el.defaultValue;

function savePage(): PageState {
  const s: PageState = { scroll: [], fields: [], details: [] };
  if (scrollX || scrollY) s.scroll.push(["", scrollX, scrollY]);
  for (const el of document.body.querySelectorAll("*")) {
    if ((el.scrollTop || el.scrollLeft) && el.scrollHeight > el.clientHeight - 1) { const k = keyOf(el); if (k) s.scroll.push([k, el.scrollLeft, el.scrollTop]); }
    if (isField(el) && !isDefault(el) && !el.closest("[data-live-skip]")) { const k = keyOf(el); if (k) s.fields.push([k, valueOf(el)]); }
    if (el instanceof HTMLDetailsElement) { const k = keyOf(el); if (k) s.details.push([k, el.open]); }
  }
  const a = document.activeElement;
  if (a && a != document.body && a.tagName != "IFRAME") {
    const k = keyOf(a);
    if (k) s.focus = { key: k, ...(a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement ? (() => { try { return { start: a.selectionStart, end: a.selectionEnd }; } catch { return {}; } })() : {}) };
  }
  return s;
}

/**
 * Puts the page's state back as the page comes up: each part as soon as its element is there (a list read from the server
 * may take a moment), for up to 8 seconds, and never over what the person has done since (a field typed in, a scroll).
 */
function restorePage(s: PageState) {
  const scrolls = new Map(s.scroll.map(([k, x, y]) => [k, [x, y] as const]));
  const fields = new Map(s.fields), details = new Map(s.details);
  let focus = s.focus, touched = false;
  const until = now() + 8000;
  for (const type of ["keydown", "pointerdown", "wheel", "touchmove"]) addEventListener(type, () => { touched = true; }, { capture: true, once: true, passive: true });
  const step = () => {
    const last = now() >= until;
    for (const [k, v] of fields) {
      const el = find(k);
      if (!el || !isField(el)) continue;
      fields.delete(k);
      if (!isDefault(el) && valueOf(el) != v) continue;
      if (typeof v == "boolean" && el instanceof HTMLInputElement) el.checked = v; else if (typeof v == "string") el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    for (const [k, open] of details) { const el = find(k); if (el instanceof HTMLDetailsElement) { el.open = open; details.delete(k); } }
    if (!touched) for (const [k, [x, y]] of scrolls) {
      const el = k ? find(k) : document.scrollingElement;
      if (!el) continue;
      // Only once there's room to scroll that far (its content may still be loading), or at the end.
      if (el.scrollHeight - el.clientHeight + 1 < y && !last) continue;
      if (k) { el.scrollLeft = x; el.scrollTop = y; } else scrollTo(x, y);
      if (Math.abs(el.scrollTop - y) <= 2 || last) scrolls.delete(k);
    }
    if (focus && !touched) {
      const el = find(focus.key) as HTMLElement | null;
      if (el && el.offsetParent !== null) {
        el.focus({ preventScroll: true });
        if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && focus.start != null) try { el.setSelectionRange(focus.start, focus.end ?? focus.start); } catch { /* not a text field */ }
        if (document.activeElement == el) focus = undefined;
      }
    }
    if (!last && (fields.size || details.size || (scrolls.size && !touched) || (focus && !touched))) setTimeout(step, 100);
  };
  if (document.readyState == "loading") addEventListener("DOMContentLoaded", step, { once: true }); else step();
}

const back = restored();
if (back?.page) restorePage(back.page as PageState);

// ------------------------------------------------------------------ when to ask

// A request that fails as a server going away fails (no answer, a gateway's error, an API that's no longer there): ask.
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    const r = await nativeFetch(input, init);
    if (r.status == 401 && asMe(input, init)) signedOut();
    // (An API that answers 400 or 404 may be one this page's code calls the old way.)
    if (r.status >= 500 || ((r.status == 404 || r.status == 400) && /\/api\//.test(typeof input == "string" ? input : input instanceof URL ? input.href : input.url))) check("a request failed");
    return r;
  } catch (e) {
    if ((e as Error).name != "AbortError" && (e as Error).name != "TimeoutError") check("a request failed");
    throw e;
  }
}) as typeof fetch;
// The tab shown again after a while; and every minute while it's shown.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState == "hidden") { hiddenAt = now(); return; }
  if (now() - hiddenAt > 30_000) check("shown");
});
// (Every minute: one small answer, the files' builds and the release; the page itself only when the release changed.)
const POLL_MS = (window as { __ergaLivePoll?: number }).__ergaLivePoll ?? 60_000;
setInterval(() => { if (document.visibilityState == "visible") check("every minute"); }, POLL_MS);
// The first look: the builds of the files this page uses, before any redeploy could change them.
check("loaded");

// The page's calls from before this loaded (live-client.ts), now that all of this is set up: a connection that went down
// and came back meanwhile rechecks (recheck, above), which wasn't there yet when they ran mid-way.
window.ergaLive = api;
for (const fn of window.ergaLiveQueue?.splice(0) ?? []) try { fn(api); } catch (e) { console.error(e); }
window.ergaLiveQueue = { push: (fn: (l: Live) => void) => { try { fn(api); } catch (e) { console.error(e); } return 0; } } as unknown as ((l: Live) => void)[];

// Erga's service worker, at /erga-sw.js on the app's origin and on a document's pages origin (server/pages/worker.ts):
// the editor's pages open with no connection. It asks the network first, and keeps each good answer in the browser's
// copy; when the network fails, the copy answers. So, online, it never gives an old file. It never answers the API,
// the sign-in or the build check (live.ts). The editor's built files (/_erga/, named by their content's hash) come
// from the copy first: they never change.
//
// The pages that register it (client/common/offline.ts) ask it to keep what they loaded before it was theirs, and the
// page's editor puts the page made from its own text in the copy (libs/text/ui/offline-page.ts): an edit made offline
// is in the page that a reload offline opens.
//
// After sign-out it keeps nothing, and answers from the network alone: it reads the "signed out" mark before each
// write, so a restart of the worker doesn't forget it (client/common/offline.ts, keepWrite).
//
// Trap: the worker answers the frame's page on the pages origin. Its own fetch doesn't say it's for a frame (Sec-
// Fetch-Dest), and the pages origin would answer with the file as it is, with no reader script and no editor: the
// worker adds `x-erga-page` (shared/offline.ts). e2e/smoke/editor.e2e.ts (the editor in a second tab) loads a frame
// through the worker.

import { KEPT_AT, keptAddress, OFFLINE_CACHE, PAGE_HEADER } from "../../shared/offline";
import { keepWrite } from "../common/offline";

/** What this script uses of the worker's scope. */
interface Scope {
  addEventListener(type: "install" | "activate" | "fetch" | "message", f: (e: Ev) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
}
interface Ev {
  request: Request;
  data?: { type?: string; urls?: unknown; page?: unknown };
  respondWith(r: Promise<Response>): void;
  waitUntil(p: Promise<unknown>): void;
}

/** How long a copy is kept after its last good answer: a pages origin's files change address with its token's day. */
const KEEP_MS = 14 * 24 * 3600_000;

export default function offlineWorker(): void {
  const sw = self as unknown as Scope;
  let pruned = 0;

  /** How a request is answered: null, by the network alone. */
  function kind(r: Request): "page" | "built" | "file" | null {
    if (r.method != "GET" || r.headers.has("range") || r.headers.has("x-erga-check")) return null;
    const u = new URL(r.url);
    if (u.origin == location.origin && /^\/(api|auth|mcp|oauth|tokens|__erga)(\/|$)|^\/erga-sw\.js$/.test(u.pathname)) return null;
    if (r.mode == "navigate") return "page";
    if (u.pathname.startsWith("/_erga/")) return "built";
    return u.origin == location.origin || r.mode == "cors" ? "file" : null;
  }

  async function keep(key: string, res: Response): Promise<void> {
    if (res.status != 200 || res.redirected || res.type == "opaque") return;
    const headers = new Headers(res.headers);
    headers.set(KEPT_AT, String(Date.now()));
    const body = await res.blob();
    const put = async () =>
      (await caches.open(OFFLINE_CACHE)).put(key, new Response(body, { status: 200, statusText: res.statusText, headers }));
    if ((await keepWrite(put, () => caches.delete(OFFLINE_CACHE))) && Date.now() - pruned > 3600_000) await prune();
  }

  /** Forgets the copies that no good answer renewed for a while. */
  async function prune(): Promise<void> {
    pruned = Date.now();
    const copy = await caches.open(OFFLINE_CACHE);
    for (const req of await copy.keys()) {
      const at = Number((await copy.match(req))?.headers.get(KEPT_AT) ?? 0);
      if (Date.now() - at > KEEP_MS) await copy.delete(req);
    }
  }

  /**
   * The request as the network gets it. A frame's page on a pages origin: with the header that asks for it as a page
   * (server/documents/pages-origin.ts), since the worker's own fetch doesn't say it's for a frame.
   */
  function asked(r: Request): Request {
    if (r.mode != "navigate" || !/^i?frame$/.test(r.destination)) return r;
    const headers = new Headers(r.headers);
    headers.set(PAGE_HEADER, "1");
    return new Request(r.url, { headers, credentials: r.credentials, redirect: "manual", referrerPolicy: r.referrerPolicy });
  }

  async function answer(r: Request, how: "page" | "built" | "file", e: Ev): Promise<Response> {
    const key = how == "page" ? keptAddress(r.url) : r.url;
    // (A read never makes the copy again: caches.open would, after sign-out.)
    const kept = () => caches.match(key, { cacheName: OFFLINE_CACHE });
    if (how == "built" || !navigator.onLine) {
      const hit = await kept();
      if (hit) return hit;
    }
    try {
      const res = await fetch(asked(r));
      e.waitUntil(keep(key, res.clone()).catch(() => {}));
      return res;
    } catch (err) {
      const hit = await kept();
      if (hit) return hit;
      throw err;
    }
  }

  sw.addEventListener("install", () => void sw.skipWaiting());
  sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim().then(prune)));
  sw.addEventListener("fetch", (e) => {
    const how = kind(e.request);
    if (how) e.respondWith(answer(e.request, how, e));
  });
  // A page asks it to keep what it loaded before the worker was its own: its address (`page`), and its files.
  sw.addEventListener("message", (e) => {
    const d = e.data;
    if (d?.type != "erga-keep") return;
    const urls = Array.isArray(d.urls) ? d.urls.filter((u): u is string => typeof u == "string").slice(0, 200) : [];
    const page = typeof d.page == "string" ? d.page : null;
    const one = async (url: string, isPage: boolean) => {
      const r = new Request(url, { credentials: "same-origin", mode: new URL(url).origin == location.origin ? "same-origin" : "cors" });
      if (!isPage && !kind(r)) return;
      if (isPage && new URL(url).origin != location.origin) return;
      const key = isPage ? keptAddress(url) : url;
      if (!isPage && (await caches.match(key, { cacheName: OFFLINE_CACHE }))) return;
      await keep(key, await fetch(r));
    };
    e.waitUntil(Promise.all([...(page ? [one(page, true)] : []), ...urls.map((u) => one(u, false))].map((p) => p.catch(() => {}))));
  });
}

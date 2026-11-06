// The page in the browser's copy, as its editor's text has it (Erga's service worker answers with it when the network
// fails: client/inline/offline-sw.ts). The pages origin makes a page from its text, and the editor starts only on a page
// made from the text it has (else it loads the page again): so for a reload offline, the copy must hold the page made
// from the replica's text, with the edits that wait for the room. The editor makes it as the server does
// (shared/page-html.ts, pageAgain), with Erga's head of this page as the server makes it, and puts it in after each
// change: the changes that come while it puts one in go in together, next (no timer: a frame's can wait long).

import { headIn, pageAgain } from "../../../shared/page-html";
import { KEPT_AT, keptAddress, OFFLINE_CACHE, PAGE_HEADER } from "../../../shared/offline";

/** Keeps this page in the copy, made from `text()` each time it changes (`changed`). `shell`: the viewer's origin. */
export function keepPage(shell: string, text: () => string) {
  const at = keptAddress(location.href);
  // Erga's head of this page: as the pages origin makes it now, else (offline) as the copy has it.
  const head = (async () => {
    const r =
      (await fetch(location.pathname, { headers: { [PAGE_HEADER]: "1" }, cache: "no-store" }).catch(() => null)) ??
      (await caches.match(at).catch(() => undefined));
    return r?.ok ? headIn(await r.text()) : null;
  })();
  let last = "",
    going: Promise<void> | null = null,
    again = false;
  const put = async () => {
    const t = text(),
      h = await head;
    if (t == last || h == null) return;
    const page = pageAgain(h, t, shell);
    if (page == null) return;
    last = t;
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `frame-ancestors ${shell}`,
      "Referrer-Policy": "no-referrer",
      [KEPT_AT]: String(Date.now()),
    };
    try {
      await (await caches.open(OFFLINE_CACHE)).put(at, new Response(page, { headers }));
    } catch {
      last = "";
    }
  };
  /** Puts the page in (again, if the text changed meanwhile): resolves once it's in. */
  const changed = (): Promise<void> => {
    if (typeof caches == "undefined") return Promise.resolve();
    if (going) {
      again = true;
      return going;
    }
    going = (async () => {
      do {
        again = false;
        await put();
      } while (again);
      going = null;
    })();
    return going;
  };
  return {
    changed,
    /** Once the page in the copy has the text as it is (before the page loads again: offline, it comes from the copy). */
    now: changed,
  };
}

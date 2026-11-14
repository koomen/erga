// What Erga's service worker (client/inline/offline-sw.ts, at /erga-sw.js on the app's origin and on a document's pages
// origin) and the pages that write into its copy agree on: the copy's name, and the address an answer is kept under.

/** The browser's copy (Cache Storage) of what the editor's pages loaded. */
export const OFFLINE_CACHE = "erga-offline-v1";
/** The worker's one address, on each origin. */
export const WORKER_PATH = "/erga-sw.js";
/** The page on a pages origin that deletes its offline copies, for sign-out (client/inline/offline-clear.ts). */
export const CLEAR_PATH = "/erga-clear";
/** The IndexedDB database of the replicas this origin keeps (libs/text/ui/kept.ts). */
export const KEPT_DB = "erga-replicas";
/** The "signed out" mark (an empty IndexedDB database): while it is there, nothing more goes into this origin's copies. */
export const SIGNED_OUT = "erga-signed-out";
/** Where the app's origin lists the pages origins that keep copies (localStorage): sign-out clears each. */
export const ORIGINS_KEY = "erga:offline-origins";

/** The header that asks a pages origin for a file as a page (with Erga's head), as a frame gets it: the editor's own fetch. */
export const PAGE_HEADER = "x-erga-page";
/** The header that says when an answer went into the copy (ms): the worker forgets the old ones. */
export const KEPT_AT = "x-erga-kept";

/**
 * The address a page (a navigation) is kept under: without the viewer's own marks in its query (?erga-edit, erga-keep) or
 * its hash, and with a mark of its own, so a script's fetch of the same file (the file as it is) is kept apart.
 */
export function keptAddress(url: string): string {
  const u = new URL(url);
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (k.startsWith("erga-")) u.searchParams.delete(k);
  u.searchParams.set("erga-page", "");
  return u.href;
}

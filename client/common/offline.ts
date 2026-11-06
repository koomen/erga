// Erga's service worker (client/inline/offline-sw.ts), for a page of the editor's: it registers it, and asks it to keep
// what the page loaded before the worker was its own (the first time, the page came before the worker), so a reload
// with no connection opens it as it was.

import { KEPT_DB, OFFLINE_CACHE, ORIGINS_KEY, WORKER_PATH } from "../../shared/offline";

/**
 * Registers the worker, and has it keep the files this page loaded, and the page itself at `page` (the shell's address;
 * not the editor's page, which puts its own in: libs/text/ui/offline-page.ts). Whether this origin has the worker.
 */
export async function keepOffline(page: string | null): Promise<boolean> {
  const sw = navigator.serviceWorker;
  if (!sw) return false;
  const got = await sw.register(WORKER_PATH, { scope: "/" }).catch(() => sw.getRegistration("/"));
  if (!got) return false;
  void sw.ready.then((r) => r.active?.postMessage({ type: "erga-keep", urls: loaded(), page }));
  return true;
}

/** Notes a pages origin that keeps copies (the shell's document's), for sign-out to clear (client/inline/sign-out.ts). */
export function rememberOrigin(origin: string): void {
  try {
    const all = new Set<string>(JSON.parse(localStorage.getItem(ORIGINS_KEY) ?? "[]"));
    if (all.has(origin)) return;
    all.add(origin);
    localStorage.setItem(ORIGINS_KEY, JSON.stringify([...all]));
  } catch {
    /* no storage */
  }
}

/** Deletes what this origin keeps for offline: the replicas, the worker's copy, and the worker. */
export async function clearOffline(): Promise<void> {
  // (The worker serves this page until it goes, unregistered or not: it keeps nothing more from now on.)
  const regs = (await navigator.serviceWorker?.getRegistrations().catch(() => null)) ?? [];
  for (const r of regs) r.active?.postMessage({ type: "erga-forget" });
  await Promise.all([
    new Promise<void>((resolve) => {
      try {
        const r = indexedDB.deleteDatabase(KEPT_DB);
        r.onsuccess = r.onerror = r.onblocked = () => resolve();
      } catch {
        resolve();
      }
    }),
    typeof caches == "undefined" ? null : caches.delete(OFFLINE_CACHE).catch(() => false),
    navigator.serviceWorker
      ?.getRegistrations()
      .then((rs) =>
        Promise.all(rs.filter((r) => (r.active ?? r.waiting ?? r.installing)?.scriptURL.endsWith(WORKER_PATH)).map((r) => r.unregister()))
      )
      .catch(() => null),
  ]);
}

/** The files this page loaded (not what its script fetched, nor its media). */
function loaded(): string[] {
  return (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((e) => !/^(xmlhttprequest|fetch|beacon|video|audio|other)$/.test(e.initiatorType))
    .map((e) => e.name)
    .filter((u) => u.startsWith("http"));
}

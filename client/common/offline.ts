// Erga's service worker (client/inline/offline-sw.ts), for a page of the editor's: it registers it, and asks it to keep
// what the page loaded before the worker was its own (the first time, the page came before the worker), so a reload
// with no connection opens it as it was.

import { KEPT_DB, OFFLINE_CACHE, ORIGINS_KEY, SIGNED_OUT, WORKER_PATH } from "../../shared/offline";
import { type Offline, type OfflineEffect, type OfflineEvent, offlineStep } from "./offline-state";

/** This page's sign-in (keepOffline): the writers of this page wait for it. */
let signedIn: Promise<void> = Promise.resolve();

/**
 * Registers the worker, and has it keep the files this page loaded, and the page itself at `page` (the shell's address;
 * not the editor's page, which puts its own in: libs/text/ui/offline-page.ts). Whether this origin has the worker. The
 * page that calls it is signed in: first it takes away the "signed out" mark of an earlier sign-out.
 */
export async function keepOffline(page: string | null): Promise<boolean> {
  await (signedIn = offlineEvent("sign-in"));
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

/** Sign-out: marks this origin signed out, then deletes what it keeps for offline: the replicas, the copy, the worker. */
export function clearOffline(): Promise<void> {
  return offlineEvent("sign-out");
}

/**
 * This origin's state: signed out while the mark (an empty IndexedDB database) is there. The worker reads it too. (Not
 * in Cache Storage: a read there waits behind the copy's large writes, and the editor's start waits for the read.)
 */
async function offlineState(): Promise<Offline> {
  const names = await (async () => indexedDB.databases())().catch(() => []);
  return names.some((d) => d.name == SIGNED_OUT) ? "signed-out" : "keeping";
}

async function offlineEvent(event: "sign-in" | "sign-out"): Promise<void> {
  for (const effect of offlineStep(await offlineState(), event).effects) await EFFECTS[effect]?.();
}

/** What sign-in and sign-out do (a writer does `write` and `undo`: keepWrite). */
const EFFECTS: Partial<Record<OfflineEffect, () => Promise<unknown>>> = {
  mark: () =>
    idb(
      () => indexedDB.open(SIGNED_OUT),
      (r) => r.result.close()
    ),
  unmark: () => idb(() => indexedDB.deleteDatabase(SIGNED_OUT)),
  clear: () =>
    Promise.all([
      deleteKept(),
      typeof caches == "undefined" ? null : caches.delete(OFFLINE_CACHE).catch(() => false),
      navigator.serviceWorker
        ?.getRegistrations()
        .then((rs) =>
          Promise.all(rs.filter((r) => (r.active ?? r.waiting ?? r.installing)?.scriptURL.endsWith(WORKER_PATH)).map((r) => r.unregister()))
        )
        .catch(() => null),
    ]),
};

/**
 * A writer's write into what this origin keeps (the replicas, the copy): only while signed in. If sign-out came while
 * it wrote, `undo` deletes what it wrote. Whether it wrote.
 */
export async function keepWrite(write: () => Promise<unknown>, undo: () => Promise<unknown>): Promise<boolean> {
  await signedIn;
  const step = async (event: OfflineEvent) => offlineStep(await offlineState(), event).effects;
  if (!(await step("write")).includes("write")) return false;
  await write();
  if ((await step("wrote")).includes("undo")) await undo();
  return true;
}

/** Deletes the replicas this origin keeps (libs/text/ui/kept.ts). */
export function deleteKept(): Promise<void> {
  return idb(() => indexedDB.deleteDatabase(KEPT_DB));
}

/** Once an IndexedDB request is done, failed or blocked (`then`: on success). */
function idb<R extends IDBRequest>(ask: () => R, then?: (r: R) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    let r: R;
    try {
      r = ask();
    } catch {
      return resolve();
    }
    r.onsuccess = () => {
      then?.(r);
      resolve();
    };
    r.onerror = () => resolve();
    if (r instanceof IDBOpenDBRequest) r.onblocked = () => resolve();
  });
}

/** The files this page loaded (not what its script fetched, nor its media). */
function loaded(): string[] {
  return (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((e) => !/^(xmlhttprequest|fetch|beacon|video|audio|other)$/.test(e.initiatorType))
    .map((e) => e.name)
    .filter((u) => u.startsWith("http"));
}

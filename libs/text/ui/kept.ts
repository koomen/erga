// A replica of the room, kept in this browser (IndexedDB), so a tab can open the document with no connection and no
// edit is lost when the tab closes before its edits reach the room (collab.ts, `keep`). Each update of the replica's
// Yjs doc is added as it comes (those that come while one goes in, together, next); reading the replica merges them
// into one again. A merge of the same update twice changes nothing, so a replica that two tabs keep under one name
// stays whole.
//
// Beside it, the text of each file as the room last had it (`base`): if the room loses its history (a new epoch), the
// replica can't merge into it, and its files' text goes in as edits instead, against that base (collab.ts, `adopt`).
//
// One database per origin: the viewer's (erga.dev) keeps the shell's replica, a document's pages origin its page's.
// Sign-out deletes it, and nothing opens it again until the next sign-in (client/common/offline.ts, keepWrite).

import * as Y from "yjs";
import { KEPT_DB } from "../../../shared/offline";
import { deleteKept, keepWrite } from "../../../client/common/offline";
import { type Keeping, keepStep } from "./keeper-state";

/** What the browser keeps of a replica: the room's history it is of (its epoch), and everything in it. */
export interface Kept {
  epoch: string;
  update: Uint8Array;
  /** What the replica's owner keeps beside it (the shell: the host's hello). */
  extra?: unknown;
  /** Each file's text as the room last had it, if it was ever written. */
  base?: Record<string, string>;
}

const ROOMS = "rooms",
  UPDATES = "updates";

let opened: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  opened ??= new Promise((resolve) => {
    try {
      const r = indexedDB.open(KEPT_DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(ROOMS, { keyPath: "name" });
        r.result.createObjectStore(UPDATES, { autoIncrement: true }).createIndex("name", "name");
      };
      r.onsuccess = () => {
        // (Sign-out deletes the database: this tab lets go of it.)
        r.result.onversionchange = () => {
          r.result.close();
          opened = null;
        };
        resolve(r.result);
      };
      r.onerror = r.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opened;
}

const done = (tx: IDBTransaction) =>
  new Promise<boolean>((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = tx.onabort = () => resolve(false);
  });
const result = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

type Room = { name: string; epoch: string; extra?: unknown; base?: Record<string, string>; at: number };

/** `f` on the database, while signed in (else, or if it fails: null). */
async function withDb<T>(f: (d: IDBDatabase) => Promise<T>): Promise<T | null> {
  let got: T | null = null;
  await keepWrite(async () => {
    const d = await db();
    if (d) got = await f(d).catch(() => null);
  }, deleteKept);
  return got;
}

/** The replica kept under `name`, its updates merged into one (and kept so), or null. */
export function readKept(name: string): Promise<Kept | null> {
  return withDb(async (d) => {
    const tx = d.transaction([ROOMS, UPDATES], "readwrite");
    const rooms = tx.objectStore(ROOMS),
      updates = tx.objectStore(UPDATES);
    const room = (await result(rooms.get(name))) as Room | undefined;
    const keys = await result(updates.index("name").getAllKeys(name));
    const parts = ((await result(updates.index("name").getAll(name))) as { update: Uint8Array }[]).map((u) => u.update);
    if (!room || !parts.length) return null;
    const update = parts.length == 1 ? parts[0] : Y.mergeUpdates(parts);
    if (parts.length > 1) {
      for (const k of keys) updates.delete(k);
      updates.add({ name, update });
    }
    await done(tx);
    return { epoch: room.epoch, update, extra: room.extra, base: room.base };
  });
}

/**
 * Takes the replica kept under `name` of history `epoch` out of the browser, for this tab alone to merge (another tab
 * that asks after gets false): whether this tab has it.
 */
export async function claimKept(name: string, epoch: string): Promise<boolean> {
  return !!(await withDb(async (d) => {
    const tx = d.transaction([ROOMS, UPDATES], "readwrite");
    const room = (await result(tx.objectStore(ROOMS).get(name))) as Room | undefined;
    if (room?.epoch != epoch) return (await done(tx)) && false;
    tx.objectStore(ROOMS).delete(name);
    for (const k of await result(tx.objectStore(UPDATES).index("name").getAllKeys(name))) tx.objectStore(UPDATES).delete(k);
    return await done(tx);
  }));
}

/** What keeps a replica: `base` writes the room's text of each file; `stop` ends it (`save`: with what waits). */
export interface Keeper {
  base(texts: Record<string, string>): void;
  stop(save?: boolean): Promise<void>;
}

/**
 * Keeps `doc` under `name` from now on, as a replica of history `epoch`: its whole state now, then each update as it
 * comes. A replica of another history kept there before is replaced; if another replaces this one, it stops
 * (keeper-state.ts).
 */
export function keepReplica(name: string, doc: Y.Doc, epoch: string, extra?: unknown): Keeper {
  let pending: Uint8Array[] = [Y.encodeStateAsUpdate(doc)],
    base: Record<string, string> | null = null,
    state: Keeping = "fresh",
    going: Promise<void> | null = null;
  const write = async () => {
    const parts = pending,
      texts = base;
    pending = [];
    base = null;
    await withDb(async (d) => {
      const tx = d.transaction([ROOMS, UPDATES], "readwrite");
      const rooms = tx.objectStore(ROOMS),
        updates = tx.objectStore(UPDATES);
      const was = (await result(rooms.get(name))) as Room | undefined;
      const step = keepStep(state, epoch, was?.epoch ?? null, !!texts);
      for (const effect of step.effects) {
        if (effect == "clear") for (const k of await result(updates.index("name").getAllKeys(name))) updates.delete(k);
        if (effect == "record")
          rooms.put({ name, epoch, extra, base: texts ?? (was?.epoch == epoch ? was.base : undefined), at: Date.now() });
        if (effect == "add" && parts.length) updates.add({ name, update: parts.length == 1 ? parts[0] : Y.mergeUpdates(parts) });
      }
      // (Storage full or off: the replica stays in this tab only.)
      if (await done(tx)) state = step.state;
    });
    if (state == "refused") stopKeeping();
  };
  /** What waits goes in (no timer: a frame's can wait long), and what comes meanwhile right after. */
  const flush = (): Promise<void> =>
    (going ??= (async () => {
      while (pending.length || base) await write();
      going = null;
    })());
  const onUpdate = (u: Uint8Array) => {
    pending.push(u);
    void flush();
  };
  // (The tab going away: what waits goes now; IndexedDB finishes a transaction it has begun.)
  const away = () => void flush();
  const stopKeeping = () => {
    doc.off("update", onUpdate);
    removeEventListener("pagehide", away);
    pending = [];
    base = null;
  };
  doc.on("update", onUpdate);
  addEventListener("pagehide", away);
  void flush();
  return {
    base(texts) {
      if (state == "refused") return;
      base = texts;
      void flush();
    },
    async stop(save = true) {
      doc.off("update", onUpdate);
      removeEventListener("pagehide", away);
      if (save) await flush();
      else pending = [];
    },
  };
}

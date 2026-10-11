// Copying documents' Durable Objects from one server to another: how staging
// gets production's documents when it copies its data (the pipeline's "documents"
// step, deploy/pipeline.ts). The database is copied by D1 itself (export
// and import); a Durable Object's storage can only be read from inside the
// Worker that owns it, so production serves a read-only snapshot endpoint and
// staging an import one, both behind a shared bearer token (SNAPSHOT_TOKEN,
// set on both Workers by deploy/setup.ts). With it staging can read every
// production document, so it is at least 32 characters, compared in constant time:
//
//   POST /api/snapshot/docs          {ids, after?}  → {docs: [{id, entries, alarm, more?}], done, failed}
//                                                     any server with SNAPSHOT_TOKEN: read-only
//   POST /api/snapshot/docs/import   {docs, wipe}   → {imported, wiped}   only with SNAPSHOT_IMPORT=1 and never on production
//
// A document's snapshot is every key in its storage (its files, folders,
// meta, its versions and the room's Yjs state: cloudflare/document-object.ts) and its
// alarm (when an unedited one expires). Values go as JSON, bytes as base64.
// The export only reads (DocumentObject.exportStorage: storage.list and getAlarm,
// nothing opened); the import empties the document's storage and writes the
// snapshot in.
//
// A document can hold far more than one answer can carry: its versions keep
// every file it ever had, and a value passed to or from a Durable Object is
// at most 32 MiB (RPC_LIMIT). So an answer carries at most SNAPSHOT_BUDGET
// characters of entries: the documents of `ids` in order, the last one maybe
// in part (`more`: the key its next part starts after, asked for as
// `after`). `done` says how many of `ids` it finished, `failed` which ones
// couldn't be read (and why): the others are still copied. A part after the
// first is imported with `append`: added to the earlier ones, nothing emptied.
//
// The same handler runs in the Worker and in the mock
// Cloudflare's pretend servers, so the tests exercise it.

import { DeployError, type Fetch } from "./pipeline";

export type Encoded = { b: string } | { j: unknown };
/** A document's storage, or a part of it: `more` on export (another part follows), `append` on import (a part after the first). */
export interface DocSnapshot { id: string; entries: [string, Encoded][]; alarm: number | null; more?: string; append?: boolean }
/** Which part of a document's storage: the entries after the key `after` (null: from the first), as many as fit in `budget` characters. */
export interface Page { after: string | null; budget: number }

/** Where documents' storage is, as the snapshot endpoints reach it. */
export interface DocStore {
  /** One part of the document's storage (at least one entry, if any are left), or null if there's no such document. */
  export(id: string, page: Page): Promise<DocSnapshot | null>;
  import(snap: DocSnapshot): Promise<void>;
  wipe(id: string): Promise<void>;
}

/** The most a value passed to or from a Durable Object may be: workerd refuses more ("Serialized RPC ... limited to 32MiB"). */
export const RPC_LIMIT = 32 * 1024 * 1024;
/** The most one value in a Durable Object's (SQLite) storage may be. */
export const VALUE_LIMIT = 2 * 1024 * 1024;
/**
 * Characters of entries in one answer. An answer stops after the entry that
 * reaches it, so it can be one value (VALUE_LIMIT as base64) longer: still
 * far below RPC_LIMIT, and little for the Worker's 128 MB to hold twice.
 */
export const SNAPSHOT_BUDGET = 8 * 1024 * 1024;

export const encodeValue = (v: unknown): Encoded =>
  v instanceof Uint8Array ? { b: b64(v) } : v instanceof ArrayBuffer ? { b: b64(new Uint8Array(v)) } : { j: v };
export const decodeValue = (e: Encoded): unknown => ("b" in e ? Uint8Array.from(atob(e.b), (c) => c.charCodeAt(0)) : e.j);

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** About how many characters an entry takes in an answer. */
const sizeOf = ([key, e]: [string, Encoded]) => key.length + 16 + ("b" in e ? e.b.length : (JSON.stringify(e.j) ?? "").length);

/**
 * One part of a document's storage, read from `list` (the keys after
 * `after`, in order, at most `limit` of them) until it holds `budget`
 * characters: DocumentObject's export and the in-memory store's.
 */
export async function exportPage(id: string, page: Page, alarm: number | null, list: (after: string | null, limit: number) => Promise<Map<string, unknown>>): Promise<DocSnapshot> {
  const entries: [string, Encoded][] = [];
  let after = page.after, size = 0;
  for (;;) {
    const got = await list(after, 16);
    for (const [k, v] of got) {
      const entry: [string, Encoded] = [k, encodeValue(v)];
      entries.push(entry);
      after = k;
      if ((size += sizeOf(entry)) >= page.budget) return { id, entries, alarm, more: k };
    }
    if (got.size < 16) return { id, entries, alarm };
  }
}

/** The same strings, compared in time that doesn't depend on where they differ. */
function same(a: string, b: string): boolean {
  if (a.length != b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d == 0;
}

/**
 * The snapshot endpoints, or null for any other path. `token`: this server's
 * SNAPSHOT_TOKEN (none: the endpoints aren't there). `importAllowed`: this
 * server takes snapshots in (staging); production never does.
 */
export async function snapshotDoor(request: Request, o: { token?: string; importAllowed: boolean; store: DocStore; budget?: number }): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path != "/api/snapshot/docs" && path != "/api/snapshot/docs/import") return null;
  const notFound = () => Response.json({ error: "Not found" }, { status: 404 });
  const token = o.token?.trim();
  if (!token || token.length < 32) return notFound();
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!same(bearer, token)) return Response.json({ error: "Not allowed" }, { status: 403 });
  if (request.method != "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const body = (await request.json().catch(() => null)) as { ids?: unknown; after?: unknown; docs?: unknown; wipe?: unknown } | null;
  if (path == "/api/snapshot/docs") {
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id == "string" && ID.test(id)) : [];
    if (ids.length > 50) return Response.json({ error: "At most 50 documents at a time" }, { status: 400 });
    // One at a time, each in what's left of the budget; the first continues after `after`.
    const docs: DocSnapshot[] = [], failed: { id: string; error: string }[] = [];
    let left = o.budget ?? SNAPSHOT_BUDGET, done = 0;
    for (const id of ids) {
      if (left <= 0) break;
      try {
        const doc = await o.store.export(id, { after: done == 0 && typeof body?.after == "string" ? body.after : null, budget: left });
        if (doc) {
          docs.push(doc);
          left -= doc.entries.reduce((n, e) => n + sizeOf(e), 0);
          if (doc.more !== undefined) break;
        }
      } catch (e) {
        failed.push({ id, error: (e as Error).message || String(e) });
      }
      done++;
    }
    return Response.json({ docs, done, failed });
  }
  if (!o.importAllowed) return notFound();
  const docs = Array.isArray(body?.docs) ? (body.docs as DocSnapshot[]) : [];
  const wipe = Array.isArray(body?.wipe) ? body.wipe.filter((id): id is string => typeof id == "string" && ID.test(id)) : [];
  for (const d of docs) if (!d || typeof d.id != "string" || !ID.test(d.id) || !Array.isArray(d.entries)) return Response.json({ error: "Bad snapshot" }, { status: 400 });
  for (const d of docs) await o.store.import({ id: d.id, entries: d.entries, alarm: d.alarm ?? null, ...(d.append === true ? { append: true } : {}) });
  for (const id of wipe) await o.store.wipe(id);
  return Response.json({ imported: docs.length, wiped: wipe.length });
}

/**
 * Copies documents' storage from the server at `from` to the one at `to`:
 * up to `batch` documents at a time (fewer, or part of one, when they're
 * large: SNAPSHOT_BUDGET), read from one and written to the other; `wipe`
 * empties documents the target had that the source doesn't. A document the
 * source couldn't read is `failed` (its id and why) and emptied on the
 * target; the others are still copied. `unsupported`: the source has no
 * snapshot endpoint (an older version, or no SNAPSHOT_TOKEN).
 */
export async function copyDocuments(o: { ids: string[]; wipe: string[]; from: string; to: string; token: string; fetch: Fetch; batch?: number }): Promise<{ copied: number; missing: number; wiped: number; failed: { id: string; error: string }[]; unsupported: boolean }> {
  const headers = { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" };
  const size = o.batch ?? 25;
  const put = async (docs: DocSnapshot[], wipe: string[]) => {
    const r = await o.fetch(`${o.to}/api/snapshot/docs/import`, { method: "POST", headers, body: JSON.stringify({ docs, wipe }) }).catch((e) => { throw new DeployError(`Couldn't reach ${o.to} to copy documents in: ${(e as Error).message}`); });
    if (!r.ok) throw new DeployError(`${o.to} didn't take the documents' copy (it answered ${r.status}${r.status == 404 ? ": it needs SNAPSHOT_IMPORT=1 and SNAPSHOT_TOKEN" : ""}).`);
  };
  // Documents with a part copied, those that failed, and those the source didn't have.
  const started = new Set<string>(), failed = new Map<string, string>();
  let missing = 0, queue = o.ids, after: string | null = null, first = true;
  while (queue.length) {
    const ids = queue.slice(0, size);
    const r = await o.fetch(`${o.from}/api/snapshot/docs`, { method: "POST", headers, body: JSON.stringify(after == null ? { ids } : { ids, after }) }).catch((e) => { throw new DeployError(`Couldn't reach ${o.from} to read its documents: ${(e as Error).message}`); });
    if (r.status == 404 && first) {
      if (o.wipe.length) await put([], o.wipe);
      return { copied: 0, missing: 0, wiped: o.wipe.length, failed: [], unsupported: true };
    }
    first = false;
    if (!r.ok) throw new DeployError(`${o.from} didn't give its documents' snapshot (it answered ${r.status}${r.status == 403 ? ": the two servers' SNAPSHOT_TOKEN differ" : ""}).`);
    const answer = (await r.json()) as { docs: DocSnapshot[]; done?: number; failed?: { id: string; error: string }[] };
    // An older source sends each document whole, and no `done`.
    const done = answer.done ?? ids.length;
    const docs = answer.docs.map((d) => ({ id: d.id, entries: d.entries, alarm: d.alarm, ...(started.has(d.id) ? { append: true } : {}) }));
    if (docs.length) await put(docs, []);
    for (const d of docs) started.add(d.id);
    for (const f of answer.failed ?? []) failed.set(f.id, f.error);
    for (const id of ids.slice(0, done)) if (!started.has(id) && !failed.has(id)) missing++;
    const last = answer.docs.at(-1);
    const next = last?.more ?? null;
    if (next != null && (last!.id != ids[done] || next === after)) throw new DeployError(`${o.from} gave a part of ${last!.id} it can't continue from.`);
    if (done == 0 && next == null) throw new DeployError(`${o.from} gave nothing of ${ids[0]}.`);
    after = next;
    queue = queue.slice(done);
  }
  // A failed document may be in part on the target: emptied, as the source has it unread.
  const wipe = [...new Set([...o.wipe, ...failed.keys()])];
  if (wipe.length) await put([], wipe);
  return { copied: [...started].filter((id) => !failed.has(id)).length, missing, wiped: o.wipe.length, failed: [...failed].map(([id, error]) => ({ id, error })), unsupported: false };
}

/**
 * An in-memory DocStore: the mock's servers, and the tests'. Like a Durable
 * Object, it refuses to pass a value larger than `rpcLimit` (as JSON).
 */
export function memoryStore(docs: Map<string, { entries: Map<string, unknown>; alarm: number | null }> = new Map()): DocStore & { docs: typeof docs; rpcLimit: number } {
  const store = {
    docs,
    rpcLimit: RPC_LIMIT,
    async export(id: string, page: Page) {
      const d = docs.get(id);
      if (!d) return null;
      const keys = [...d.entries.keys()].sort();
      const snap = await exportPage(id, page, d.alarm, async (after, limit) => {
        const from = after == null ? 0 : keys.findIndex((k) => k > after);
        return new Map(from < 0 ? [] : keys.slice(from, from + limit).map((k) => [k, d.entries.get(k)]));
      });
      return rpc(snap);
    },
    async import(snap: DocSnapshot) {
      rpc(snap);
      const d = snap.append ? docs.get(snap.id) : undefined;
      const entries = d?.entries ?? new Map<string, unknown>();
      for (const [k, e] of snap.entries) entries.set(k, decodeValue(e));
      docs.set(snap.id, { entries, alarm: snap.alarm ?? d?.alarm ?? null });
    },
    async wipe(id: string) { docs.delete(id); },
  };
  const rpc = <T>(value: T): T => {
    const size = JSON.stringify(value).length;
    if (size > store.rpcLimit) throw new Error(`Serialized RPC arguments or return values are limited to ${store.rpcLimit} bytes, but the size of this value was: ${size} bytes.`);
    return value;
  };
  return store;
}
